/**
 * Command line for the Swiss Company Resolver and the SwissVR eligibility check.
 *
 *   pnpm cli check "Hans Muster, Beispiel AG, Bern"
 *   pnpm cli batch personen.csv -o ergebnis.csv
 *   pnpm cli eval sample.csv -o eval.csv
 *   pnpm cli resolve "Muehlemann und Pop Zuerich"
 *
 * Progress goes to stderr, results to stdout (or the -o file).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Command, Option } from "commander";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { resolveCompany, type AgentEvent } from "./lib/agent";
import { formatDuration, formatUsd, isModelId, type ModelId } from "./lib/cost";
import { formatEmployees } from "./lib/employees";
import { DEFAULT_ASSESS_MODEL, assessPerson, parseQuery, type AssessOptions } from "./lib/swissvr/assess";
import type { AssessEvent, Assessment, CriterionStatus, MandateAssessment, Mode, PersonQuery } from "./lib/swissvr/types";
import { SIDES, agreement, pct, runMetrics, stability, type Side } from "./lib/swissvr/metrics";
import { renderReport } from "./lib/swissvr/report";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Keys may come from the environment instead.
}

const MODEL_ALIASES: Record<string, ModelId> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  jev: "jev-latest",
};

function model(value: string): ModelId {
  const id = MODEL_ALIASES[value] ?? value;
  if (!isModelId(id)) throw new Error(`Unknown model "${value}" (opus | sonnet | jev)`);
  return id;
}

const log = (line: string) => process.stderr.write(line + "\n");

function progress(verbose: boolean) {
  return (e: AssessEvent) => {
    if (e.type === "step") log(`  · ${e.message}`);
    else if (verbose && e.type === "tool_call") log(`    → ${e.tool} ${JSON.stringify(e.input).slice(0, 140)}`);
    else if (verbose && e.type === "tool_result") log(`    ← ${e.summary}`);
    else if (verbose && e.type === "thinking") log(`    … ${e.text.replace(/\s+/g, " ").slice(0, 160)}`);
  };
}

const ICON: Record<CriterionStatus, string> = { erfüllt: "✔", "nicht erfüllt": "✘", "nicht ermittelbar": "?" };
const LABEL = {
  k1_mandat: "1 VR-Mandat",
  k2_rechtsform: "2 Rechtsform",
  k3_mitarbeitende: "3 Mitarbeitende",
  k4_sitz: "4 Sitz/Wohnsitz",
} as const;

function printAssessment(a: Assessment) {
  const out: string[] = [];
  out.push("", `${a.query.person} - ${a.query.company}${a.query.town ? `, ${a.query.town}` : ""}`);
  out.push(`Empfehlung: ${a.verdict.toUpperCase()}${a.uncertain.length ? "  (UNSICHER)" : ""}`);
  for (const u of a.uncertain) out.push(`  ⚠ unsichere Quelle - ${u}`);
  out.push("");
  for (const m of a.mandates) {
    const mark = m === a.decisive ? "▶" : " ";
    out.push(`${mark} ${m.company.name} ${m.company.uid ?? ""} (${m.origin === "input" ? "angegeben" : "weiteres Mandat"}) → ${m.verdict}`);
    for (const [key, label] of Object.entries(LABEL)) {
      const c = m.criteria[key as keyof typeof LABEL];
      out.push(`    ${ICON[c.status]} ${label.padEnd(16)} ${c.reason}${c.certain ? "" : "  ⚠ unsicher"}`);
      if (c.source) out.push(`      ${" ".repeat(16)} ${c.source}`);
    }
    for (const n of m.notes) out.push(`    ${n}`);
    out.push("");
  }
  if (a.mandates.length === 0) out.push("  Kein Mandat gefunden.", "");
  out.push(`Kosten ${formatUsd(a.cost.total_usd)} (Modell ${formatUsd(a.cost.model_usd)}, Firecrawl ${formatUsd(a.cost.firecrawl_usd)}) · ${formatDuration(a.cost.duration_ms)}`);
  console.log(out.join("\n"));
}

/** Accepts our own columns (person, company, town / input) and the SwissVR sample layout. */
function rowToQuery(row: Record<string, string>): PersonQuery | null {
  const get = (...keys: string[]) => {
    for (const k of Object.keys(row)) {
      if (keys.some((key) => k.trim().toLowerCase() === key.toLowerCase())) return (row[k] ?? "").trim();
    }
    return "";
  };
  if (get("input")) return parseQuery(get("input"));
  const person = get("person", "name") || [get("vorname"), get("nachname")].filter(Boolean).join(" ");
  const companyField = get("company", "firma", "Verwaltungsratsmandat (Firma)");
  if (!person || !companyField) return null;
  const [company, ...rest] = companyField.split(",").map((s) => s.trim());
  const town = get("town", "ort") || rest.join(", ").replace(/\s*\([A-Z]{2}\)\s*$/, "");
  return { person, company, town };
}

/** CSV or XLSX (first sheet, first row = header) as one record per row. */
async function readRows(file: string): Promise<Record<string, string>[]> {
  if (!/\.xlsx$/i.test(file)) {
    return parse(readFileSync(file, "utf8"), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true });
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const text = (v: ExcelJS.CellValue): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object" && "richText" in v) return v.richText.map((t) => t.text).join("");
    if (typeof v === "object" && "result" in v) return String(v.result ?? "");
    if (typeof v === "object" && "text" in v) return String(v.text);
    return String(v);
  };
  const header: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => (header[col - 1] = text(cell.value)));
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const record: Record<string, string> = {};
    header.forEach((h, i) => (record[h] = text(row.getCell(i + 1).value)));
    if (Object.values(record).some((v) => v.trim())) rows.push(record);
  });
  return rows;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

async function safeAssess(q: PersonQuery, opts: AssessOptions, verbose: boolean): Promise<Assessment | Error> {
  try {
    return await assessPerson(q, verbose ? progress(true) : () => {}, opts);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function mandateColumns(m: MandateAssessment | null | undefined) {
  const c = m?.criteria;
  return {
    firma: m?.company.name ?? "",
    uid: m?.company.uid ?? "",
    rechtsform: m?.company.legal_form ?? "",
    sitz: m?.company.seat ?? "",
    funktion: m?.role_text ?? "",
    wohnort: m?.residence ?? "",
    mitarbeitende: formatEmployees(m?.company.employees),
    k1_mandat: c?.k1_mandat.status ?? "",
    k1_begruendung: c?.k1_mandat.reason ?? "",
    k2_rechtsform: c?.k2_rechtsform.status ?? "",
    k2_begruendung: c?.k2_rechtsform.reason ?? "",
    k3_mitarbeitende: c?.k3_mitarbeitende.status ?? "",
    k3_begruendung: c?.k3_mitarbeitende.reason ?? "",
    k4_sitz: c?.k4_sitz.status ?? "",
    k4_begruendung: c?.k4_sitz.reason ?? "",
    quellen: m ? [...new Set([m.company.register_source, ...m.company.sources].filter(Boolean))].join(" ") : "",
  };
}

const program = new Command()
  .name("swissvr")
  .description("Swiss Company Resolver + SwissVR-Eignungsprüfung")
  .showHelpAfterError();

const modelOption = () => new Option("-m, --model <model>", "opus | sonnet").default(DEFAULT_ASSESS_MODEL, "sonnet").argParser(model);
const modeOption = () =>
  new Option("--mode <mode>", "neuaufnahme | bestand").choices(["neuaufnahme", "bestand"]).default("neuaufnahme");

program
  .command("check")
  .description('Eine Person prüfen: "Vorname Name, Firma[, Ort]"')
  .argument("<input...>", '"Vorname Name, Firma[, Ort]" (Anführungszeichen optional)')
  .addOption(modelOption())
  .addOption(modeOption())
  .option("--no-further", "keine weiteren Mandate suchen")
  .option("--thorough", "Mitarbeitende auch recherchieren, wenn das Mandat schon scheitert")
  .option("--json", "Ergebnis als JSON")
  .option("-v, --verbose", "Tool-Calls und Denkschritte anzeigen")
  .action(async (words: string[], o) => {
    const q = parseQuery(words.join(" "));
    if (!q.person || !q.company) throw new Error('Format: "Vorname Name, Firma[, Ort]"');
    const a = await assessPerson(q, progress(Boolean(o.verbose)), {
      model: o.model ?? DEFAULT_ASSESS_MODEL,
      mode: o.mode as Mode,
      further: o.further,
      thorough: Boolean(o.thorough),
    });
    if (o.json) console.log(JSON.stringify(a, null, 2));
    else printAssessment(a);
  });

program
  .command("batch")
  .description("CSV/XLSX prüfen (Spalten person,company[,town] | input | Vorname,Nachname,Firma)")
  .argument("<input.csv|xlsx>")
  .requiredOption("-o, --out <file>", "Ergebnis-CSV")
  .addOption(modelOption())
  .addOption(modeOption())
  .option("-c, --concurrency <n>", "parallele Prüfungen", (v) => parseInt(v, 10), 3)
  .option("--no-further", "keine weiteren Mandate suchen")
  .option("--thorough", "Mitarbeitende immer recherchieren")
  .option("-v, --verbose", "Fortschritt jeder Prüfung anzeigen")
  .action(async (file: string, o) => {
    const queries = (await readRows(file)).map(rowToQuery).filter((q): q is PersonQuery => q !== null);
    log(`${queries.length} Personen, ${o.concurrency} parallel`);
    let done = 0;
    let total = 0;
    const results = await pool(queries, o.concurrency, async (q) => {
      const r = await safeAssess(q, { model: o.model, mode: o.mode, further: o.further, thorough: Boolean(o.thorough) }, o.verbose);
      done += 1;
      if (!(r instanceof Error)) total += r.cost.total_usd;
      log(`[${done}/${queries.length}] ${q.person}, ${q.company}: ${r instanceof Error ? `FEHLER ${r.message}` : r.verdict}`);
      return { q, r };
    });
    const rows = results.map(({ q, r }) => ({
      person: q.person,
      firma_input: q.company,
      ort_input: q.town,
      empfehlung: r instanceof Error ? "fehler" : r.verdict,
      unsicher: r instanceof Error ? "" : r.uncertain.join("; "),
      zusammenfassung: r instanceof Error ? r.message : r.summary,
      ...mandateColumns(r instanceof Error ? null : r.decisive),
      weitere_mandate: r instanceof Error ? "" : r.mandates.filter((m) => m.origin === "further").map((m) => `${m.company.name}: ${m.verdict}`).join("; "),
      kosten_usd: r instanceof Error ? "" : r.cost.total_usd.toFixed(4),
      dauer_s: r instanceof Error ? "" : (r.cost.duration_ms / 1000).toFixed(1),
    }));
    writeFileSync(o.out, stringify(rows, { header: true }));
    log(`→ ${o.out} · Total ${formatUsd(total)}`);
  });

const TO_LABEL: Record<CriterionStatus, string> = { erfüllt: "ja", "nicht erfüllt": "nein", "nicht ermittelbar": "unbekannt" };
const EVAL_COLUMNS = [
  { key: "k1_mandat", header: /vr mandat/i },
  { key: "k2_rechtsform", header: /^kriterium\s+gesellschaftsform/i },
  { key: "k3_mitarbeitende", header: /^kriterium\s+anzahl mitarbeitende/i },
  { key: "k4_sitz", header: /^kriterium\s+firmensitz/i },
] as const;

/** Verdict implied by the four expected labels, with the same precedence as the rules. */
function expectedVerdict(labels: string[]): string {
  if (labels.includes("nein")) return "qualifiziert nicht";
  if (labels.some((l) => l !== "ja")) return "nicht beurteilbar";
  return "qualifiziert";
}

program
  .command("eval")
  .description("Gegen ein Testset laufen (SwissVR-Sample als CSV/XLSX mit Ja/Nein/Unbekannt pro Kriterium)")
  .argument("<testset.csv|xlsx>")
  .option("-o, --out <file>", "Detail-CSV mit Soll/Ist pro Kriterium")
  .addOption(modelOption())
  .option("-c, --concurrency <n>", "parallele Prüfungen", (v) => parseInt(v, 10), 4)
  .option("-n, --limit <n>", "nur die ersten n Zeilen", (v) => parseInt(v, 10))
  .option("--rerun <previous.csv>", "nur die Fälle neu prüfen, die im früheren Lauf (eval -o) abwichen; der Rest wird übernommen")
  .action(async (file: string, o) => {
    const rows = (await readRows(file)).slice(0, o.limit ?? undefined);
    const headers = Object.keys(rows[0] ?? {});
    const col = (re: RegExp) => headers.find((h) => re.test(h.replace(/\s+/g, " ").trim()));
    const cols = EVAL_COLUMNS.map((c) => ({ ...c, column: col(c.header) }));
    const missing = cols.filter((c) => !c.column).map((c) => c.key);
    if (missing.length) throw new Error(`Spalten nicht gefunden: ${missing.join(", ")}`);

    // A previous run: rows without any deviation are carried over unchanged.
    const previous = new Map<string, Record<string, string>>();
    if (o.rerun) for (const p of await readRows(o.rerun)) previous.set(`${p.person}|${p.firma}`, p);
    // Expected labels always come from the current test set (it may have been corrected since);
    // only the system's answers are taken from the previous run.
    const wantOf = (row: Record<string, string>) => cols.map((c) => (row[c.column!] ?? "").trim().toLowerCase());
    const deviates = (p: Record<string, string>, row: Record<string, string>) => {
      const want = wantOf(row);
      const wantVerdict = want.every(Boolean) ? expectedVerdict(want) : "";
      return (
        Boolean(p.fehler) ||
        cols.some((c, i) => want[i] && want[i] !== p[`${c.key}_ist`]) ||
        Boolean(wantVerdict && wantVerdict !== p.empfehlung_ist)
      );
    };

    const items = rows.map((row) => ({ row, q: rowToQuery(row) })).filter((x): x is { row: Record<string, string>; q: PersonQuery } => x.q !== null);
    const carried = (q: PersonQuery, row: Record<string, string>) => {
      const p = previous.get(`${q.person}|${q.company}`);
      return p && !deviates(p, row) ? p : null;
    };
    const todo = items.filter((x) => !carried(x.q, x.row));
    log(o.rerun ? `${todo.length} von ${items.length} Fällen wichen ab und werden neu geprüft, ${o.concurrency} parallel` : `${items.length} Fälle, ${o.concurrency} parallel`);

    type EvalRow = {
      q: PersonQuery;
      crit: { key: string; want: string; got: string; certain: boolean; reason: string; source: string }[];
      wantVerdict: string;
      gotVerdict: string;
      found: string;
      costUsd: number;
      durationMs: number;
      error: string;
      rerun: boolean;
      before: string;
    };
    const opts: AssessOptions = { model: o.model, mode: "neuaufnahme", further: false, thorough: true };
    let done = 0;
    const results: EvalRow[] = await pool(items, o.concurrency, async ({ row, q }): Promise<EvalRow> => {
      const p = carried(q, row);
      if (p) {
        const want = wantOf(row);
        return {
          q,
          crit: cols.map((c, i) => ({
            key: c.key,
            want: want[i],
            got: p[`${c.key}_ist`] ?? "",
            certain: p[`${c.key}_sicher`] !== "nein",
            reason: p[`${c.key}_begruendung`] ?? "",
            source: p[`${c.key}_quelle`] ?? "",
          })),
          wantVerdict: want.every(Boolean) ? expectedVerdict(want) : "",
          gotVerdict: p.empfehlung_ist ?? "",
          found: p.firma_gefunden ?? "",
          costUsd: 0,
          durationMs: 0,
          error: "",
          rerun: false,
          before: "",
        };
      }
      const r = await safeAssess(q, opts, false);
      const input = r instanceof Error ? null : (r.mandates.find((m) => m.origin === "input") ?? null);
      const crit = cols.map((c) => {
        const want = (row[c.column!] ?? "").trim().toLowerCase();
        const got = input ? TO_LABEL[input.criteria[c.key].status] : r instanceof Error ? "fehler" : "unbekannt";
        const k = input?.criteria[c.key];
        return { key: c.key, want, got, certain: k ? k.certain : true, reason: k?.reason ?? "", source: k?.source ?? "" };
      });
      const wantVerdict = crit.every((c) => c.want) ? expectedVerdict(crit.map((c) => c.want)) : "";
      const gotVerdict = r instanceof Error ? "fehler" : (input?.verdict ?? "nicht beurteilbar");
      const prev = previous.get(`${q.person}|${q.company}`);
      const before = prev ? `${prev.empfehlung_ist} (${prev.firma_gefunden})` : "";
      done += 1;
      const misses = crit.filter((c) => c.want && c.want !== c.got).map((c) => `${c.key.slice(0, 2)} ${c.want}→${c.got}`);
      log(
        `[${done}/${todo.length}] ${q.person}, ${q.company}: ${misses.length ? misses.join(", ") : "ok"}` +
          `${prev ? ` · vorher ${before}` : ""}${r instanceof Error ? ` (${r.message})` : ""}`,
      );
      return {
        q,
        crit,
        wantVerdict,
        gotVerdict,
        found: input?.company.name ?? "",
        costUsd: r instanceof Error ? 0 : r.cost.total_usd,
        durationMs: r instanceof Error ? 0 : r.cost.duration_ms,
        error: r instanceof Error ? r.message : "",
        rerun: true,
        before,
      };
    });

    // Per criterion: accuracy over the rows that have a label.
    const lines = ["", "Kriterium          Treffer   falsch+sicher  Abweichungen (Soll→Ist, ⚠ = als unsicher markiert)"];
    for (const c of cols) {
      const labelled = results.map((x) => x.crit.find((k) => k.key === c.key)!).filter((k) => k.want);
      const hits = labelled.filter((k) => k.want === k.got).length;
      const confusion = new Map<string, number>();
      // The costly error: a definite answer that is wrong and not flagged as uncertain.
      const wrongCertain = labelled.filter((k) => k.want !== k.got && k.got !== "unbekannt" && k.certain).length;
      for (const k of labelled.filter((k) => k.want !== k.got)) {
        const key = `${k.want}→${k.got}${k.certain || k.got === "unbekannt" ? "" : "⚠"}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
      }
      lines.push(
        `${c.key.padEnd(18)} ${`${hits}/${labelled.length}`.padEnd(9)} ${String(wrongCertain).padEnd(14)} ${[...confusion].map(([k, n]) => `${k} ×${n}`).join(", ")}`,
      );
    }
    const withVerdict = results.filter((x) => x.wantVerdict);
    const verdictHits = withVerdict.filter((x) => x.wantVerdict === x.gotVerdict).length;
    const ran = results.filter((x) => x.rerun);
    const cost = ran.reduce((sum, x) => sum + x.costUsd, 0);
    const ms = ran.reduce((sum, x) => sum + x.durationMs, 0);
    lines.push(`${"Empfehlung".padEnd(18)} ${`${verdictHits}/${withVerdict.length}`.padEnd(9)}`);
    if (o.rerun) lines.push("", `${ran.length} neu geprüft, ${results.length - ran.length} aus ${o.rerun} übernommen`);
    lines.push("", `Kosten ${formatUsd(cost)} (Ø ${formatUsd(cost / Math.max(ran.length, 1))}) · Ø ${formatDuration(ms / Math.max(ran.length, 1))} pro geprüfter Person`);
    console.log(lines.join("\n"));

    if (o.out) {
      const out = results.map((x) => ({
        person: x.q.person,
        firma: x.q.company,
        ...Object.fromEntries(
          x.crit.flatMap((k) => [
            [`${k.key}_soll`, k.want],
            [`${k.key}_ist`, k.got],
            [`${k.key}_sicher`, k.certain ? "ja" : "nein"],
            [`${k.key}_begruendung`, k.reason],
            [`${k.key}_quelle`, k.source],
          ]),
        ),
        empfehlung_soll: x.wantVerdict,
        empfehlung_ist: x.gotVerdict,
        firma_gefunden: x.found,
        kosten_usd: x.rerun ? x.costUsd.toFixed(4) : "",
        neu_geprueft: x.rerun ? "ja" : "nein",
        vorher: x.before,
        fehler: x.error,
      }));
      writeFileSync(o.out, stringify(out, { header: true }));
      log(`→ ${o.out}`);
    }
  });

program
  .command("metrics")
  .description("Falsch-sicher-Rate, Automatisierungsquote und (ab 2 Läufen) Stabilität aus eval-Ergebnissen")
  .argument("<eval.csv...>", "eine oder mehrere Ergebnis-CSVs von eval -o (gleiches Testset)")
  .action(async (files: string[]) => {
    const runs = await Promise.all(files.map((f) => readRows(f)));
    const out: string[] = [];
    runs.forEach((rows, i) => {
      const m = runMetrics(rows);
      const wrong = m.wrongYes.length + m.wrongNo.length;
      out.push(
        "",
        `${files[i]}  (${m.persons} Personen, ${m.labelled} mit eindeutigem Soll)`,
        `  Falsch-sicher-Rate        ${pct(wrong, m.labelled).padEnd(8)} ${wrong} von ${m.labelled}` +
          ` · fälschlich qualifiziert ${m.wrongYes.length} · fälschlich abgelehnt ${m.wrongNo.length}`,
        `  Automatisierungsquote     ${pct(m.sure, m.persons).padEnd(8)} ${m.sure} sicher · ${m.unsure} unsicher · ${m.open} nicht beurteilbar`,
        `  Präzision sichere Entsch. ${pct(m.sureLabelled - wrong, m.sureLabelled).padEnd(8)} ${m.sureLabelled - wrong} von ${m.sureLabelled}`,
      );
      const a = agreement(rows);
      const cell = (t: Side, sys: Side) => String(a.matrix.get(`${t}|${sys}`) ?? 0).padStart(9);
      out.push(
        `  Übereinstimmung Testset   ${pct(a.agree, rows.length).padEnd(8)} ${a.agree} von ${rows.length} (beide sicher gleich, oder beide offen)`,
        `                          System:  qualif.  q. nicht     offen`,
        ...SIDES.map((t) => `    Testset ${t.padEnd(19)}${SIDES.map((sys) => cell(t, sys)).join(" ")}`),
      );
      for (const r of [...m.wrongYes, ...m.wrongNo]) out.push(`    ✘ ${r.person}, ${r.firma}: Soll ${r.empfehlung_soll}, System ${r.empfehlung_ist}`);
      if (m.sureOpenInTestset.length) {
        out.push(`  System sicher, Testset offen (zum Kontrollieren, nicht als Fehler gezählt): ${m.sureOpenInTestset.length}`);
        for (const r of m.sureOpenInTestset) out.push(`    ? ${r.person}, ${r.firma}: System ${r.empfehlung_ist}`);
      }
    });

    if (runs.length > 1) {
      const st = stability(runs);
      out.push(
        "",
        `Stabilität über ${runs.length} Läufe (${st.persons} Personen)`,
        `  gleiche Empfehlung              ${pct(st.sameVerdict, st.persons).padEnd(8)} ${st.sameVerdict} von ${st.persons}`,
        `  gleiche Empfehlung + Sicherheit ${pct(st.sameDecision, st.persons).padEnd(8)} ${st.sameDecision} von ${st.persons}`,
      );
      for (const f of st.flips) out.push(`    ↻ ${f.key.replace("|", ", ")}: ${f.verdicts.join(" | ")}`);
    }
    console.log(out.join("\n"));
  });

program
  .command("report")
  .description("Lesbare HTML-Auswertung aus eval-Ergebnissen (der erste Lauf füllt die Personentabelle)")
  .argument("<eval.csv...>", "eine oder mehrere Ergebnis-CSVs von eval -o (gleiches Testset)")
  .requiredOption("-o, --out <file>", "HTML-Datei")
  .option("-t, --testset <name>", "Name des Testsets für die Überschrift", "SwissVR-Testset")
  .action(async (files: string[], o) => {
    const runs = await Promise.all(files.map((f) => readRows(f)));
    const date = new Date().toLocaleDateString("de-CH", { day: "numeric", month: "long", year: "numeric" });
    writeFileSync(o.out, renderReport({ runs, files, testset: o.testset, date }));
    log(`→ ${o.out}`);
  });

program
  .command("resolve")
  .description("Firmenname → UID (bestehender Resolver)")
  .argument("<company...>")
  .addOption(new Option("-m, --model <model>", "opus | sonnet | jev").default("claude-opus-5", "opus").argParser(model))
  .option("--json", "Ergebnis als JSON")
  .option("-v, --verbose", "Agent-Schritte anzeigen")
  .action(async (companies: string[], o) => {
    for (const company of companies) {
      const result = await resolveCompany(
        company,
        (e: AgentEvent) => {
          if (!o.verbose) return;
          if (e.type === "tool_call") log(`  → ${e.tool} ${JSON.stringify(e.input).slice(0, 140)}`);
          if (e.type === "tool_result") log(`  ← ${e.summary}`);
        },
        o.model,
      );
      if (o.json) console.log(JSON.stringify({ company, ...result }, null, 2));
      else
        console.log(
          `${company}\n  ${result.uid ?? "nicht gefunden"} ${result.official_name} ${result.domicile} · conf. ${result.confidence.toFixed(2)}` +
            ` · MA ${formatEmployees(result.employees) || "-"} · ${formatUsd(result.cost.total_usd)}\n  ${result.reasoning}`,
        );
    }
  });

program.parseAsync().catch((err) => {
  log(`Fehler: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
