/**
 * Human-readable evaluation report (one self-contained HTML page) from one or more eval runs.
 * The first run feeds the person table; all runs feed the metrics and the stability section.
 * m+p brand: mustard accent, grays, Manrope / Source Serif 4.
 */

import { nameTokens } from "./match";
import { KEYS, SIDES, agreement, decision, pct, runMetrics, stability, type EvalRow, type Side } from "./metrics";

const LABEL: Record<(typeof KEYS)[number], string> = {
  k1_mandat: "VR-Mandat",
  k2_rechtsform: "Rechtsform",
  k3_mitarbeitende: "≥ 10 MA",
  k4_sitz: "Sitz / Wohnsitz",
};
const SHORT_VERDICT: Record<string, string> = {
  qualifiziert: "qualifiziert",
  "qualifiziert nicht": "qualif. nicht",
  "nicht beurteilbar": "nicht beurteilbar",
};

const e = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const srclink = (url: string, label?: string) =>
  url ? `<a class="src" href="${e(url)}" target="_blank" rel="noopener">${e(label ?? domain(url))} ↗</a>` : "";

type CellClass = "hit" | "na" | "cautious" | "flagged" | "wrong";

function cellClass(r: EvalRow, k: string): CellClass {
  const want = r[`${k}_soll`];
  const got = r[`${k}_ist`];
  if (!want) return "na";
  if (want === got) return "hit";
  if (got === "unbekannt") return "cautious";
  return r[`${k}_sicher`] === "nein" ? "flagged" : "wrong";
}

const SEV: Partial<Record<CellClass, number>> = { wrong: 3, flagged: 2, cautious: 1 };

function severity(r: EvalRow) {
  const classes = KEYS.map((k) => cellClass(r, k));
  const worst = Math.max(0, ...classes.map((c) => SEV[c] ?? 0));
  const count = classes.filter((c) => SEV[c]).length;
  const verdictMiss = Boolean(r.empfehlung_soll) && r.empfehlung_soll !== r.empfehlung_ist;
  return { worst, count, verdictMiss };
}

const LEGAL = new Set(["ag", "sa", "gmbh", "sarl", "sagl", "holding", "group", "genossenschaft"]);

/**
 * The register company found does not carry the name the test set gives. Abbreviations are not
 * flagged: "SDS Group AG" for "Swiss Dental Solutions (SDS) Group AG", or an acronym like "LLB".
 */
export function firmDiffers(input: string, found: string): boolean {
  if (!found) return false;
  if (/^[A-ZÄÖÜ]{2,5}$/.test(input.trim())) return false;
  const want = nameTokens(input).filter((t) => !LEGAL.has(t));
  const have = nameTokens(found).filter((t) => !LEGAL.has(t));
  const covered = (a: string[], b: string[]) => a.every((t) => b.some((h) => h.includes(t) || t.includes(h)));
  if (want.length === 0 || have.length === 0) return false;
  return !covered(want, have) && !covered(have, want);
}

function cell(r: EvalRow, k: string): string {
  const c = cellClass(r, k);
  const want = r[`${k}_soll`] === "unbekannt" ? "?" : r[`${k}_soll`];
  const got = r[`${k}_ist`] === "unbekannt" ? "?" : r[`${k}_ist`];
  const title = e(r[`${k}_begruendung`] ?? "");
  if (c === "hit") return `<td class="c hit" title="${title}"><span class="ok">✓</span> <span class="val">${e(got)}</span></td>`;
  if (c === "na") return `<td class="c na" title="${title}"><span class="val">${e(got)}</span><span class="pair-l">kein Testset-Wert</span></td>`;
  const source = r[`${k}_quelle`];
  return (
    `<td class="c ${c}" title="${title}"><span class="pair-l">Testset</span><span class="pair-v">${e(want)}</span>` +
    `<span class="pair-l">System</span><span class="pair-v sys">${e(got)}${c === "flagged" ? " ⚠" : ""}</span>` +
    (source ? srclink(source, "Quelle") : `<span class="pair-l">keine Quelle</span>`) +
    `</td>`
  );
}

function verdictCell(r: EvalRow, runsVerdicts: string[] | null): string {
  const want = r.empfehlung_soll;
  const got = r.empfehlung_ist;
  const runs = runsVerdicts
    ? `<span class="runs" title="Empfehlung pro Lauf">↻ ${runsVerdicts.map((v) => e(SHORT_VERDICT[v] ?? v)).join(" · ")}</span>`
    : "";
  const flag = decision(r) === "unsicher" ? " ⚠" : "";
  if (!want) return `<td class="v na"><span class="val">${e(SHORT_VERDICT[got] ?? got)}${flag}</span><span class="pair-l">kein Testset-Wert</span>${runs}</td>`;
  if (want === got) return `<td class="v hit"><span class="ok">✓</span> <span class="val">${e(SHORT_VERDICT[got] ?? got)}${flag}</span>${runs}</td>`;
  return (
    `<td class="v miss"><span class="pair-l">Testset</span><span class="pair-v">${e(SHORT_VERDICT[want] ?? want)}</span>` +
    `<span class="pair-l">System</span><span class="pair-v sys">${e(SHORT_VERDICT[got] ?? got)}${flag}</span>${runs}</td>`
  );
}

function range(values: number[], fmt: (v: number) => string): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}

export function renderReport(options: { runs: EvalRow[][]; files: string[]; testset: string; date: string }): string {
  const { runs, files, testset, date } = options;
  const rows = runs[0] ?? [];
  const metrics = runs.map(runMetrics);
  const agreements = runs.map(agreement);
  const st = runs.length > 1 ? stability(runs) : null;
  const flipMap = new Map(st?.flips.map((f) => [f.key, f.verdicts]) ?? []);
  const keyOf = (r: EvalRow) => `${r.person}|${r.firma}`;
  const n = rows.length;
  const cost = runs.map((rs) => rs.reduce((s, r) => s + Number(r.kosten_usd || 0), 0));
  const pctNum = (num: number, den: number) => (den ? (100 * num) / den : 0);
  const fmtPct = (v: number) => `${Math.round(v)} %`;

  const wrongRates = metrics.map((m) => pctNum(m.wrongYes.length + m.wrongNo.length, m.labelled));
  const autoRates = metrics.map((m) => pctNum(m.sure, m.persons));
  const agreeRates = agreements.map((a, i) => pctNum(a.agree, runs[i].length));

  // --- per-run metrics table ---------------------------------------------
  const runHead = runs.map((_, i) => `<th class="num">Lauf ${i + 1}</th>`).join("");
  const metricRow = (label: string, cells: string[], target: string) =>
    `<tr><th scope="row">${label}</th>${cells.map((c) => `<td class="num">${c}</td>`).join("")}<td class="num target">${target}</td></tr>`;
  const metricRows = [
    metricRow(
      "Falsch-sicher-Rate",
      metrics.map((m) => `${pct(m.wrongYes.length + m.wrongNo.length, m.labelled)}<small>${m.wrongYes.length + m.wrongNo.length} von ${m.labelled}</small>`),
      "≤ 1 %",
    ),
    metricRow("Automatisierungsquote", metrics.map((m) => `${pct(m.sure, m.persons)}<small>${m.sure} von ${m.persons}</small>`), "≥ 70 %"),
    metricRow(
      "Übereinstimmung Testset",
      agreements.map((a, i) => `${pct(a.agree, runs[i].length)}<small>${a.agree} von ${runs[i].length}</small>`),
      "",
    ),
    metricRow("Präzision sicherer Entscheide", metrics.map((m) => {
      const w = m.wrongYes.length + m.wrongNo.length;
      return `${pct(m.sureLabelled - w, m.sureLabelled)}<small>${m.sureLabelled - w} von ${m.sureLabelled}</small>`;
    }), ""),
    metricRow("Kosten", cost.map((c) => `$${c.toFixed(2)}`), ""),
  ].join("");

  // --- agreement matrix (run 1) -------------------------------------------
  const a0 = agreements[0];
  const sideLabel: Record<Side, string> = { qualifiziert: "qualifiziert", "qualifiziert nicht": "qualifiziert nicht", offen: "offen" };
  const matrixRows = SIDES.map(
    (t) =>
      `<tr><th scope="row">${sideLabel[t]}</th>${SIDES.map((s) => {
        const v = a0?.matrix.get(`${t}|${s}`) ?? 0;
        const cls = t === s ? "agree" : (t !== "offen" && s !== "offen") ? "contra" : "gap";
        return `<td class="num m ${cls}">${v}</td>`;
      }).join("")}</tr>`,
  ).join("");

  // --- per criterion (run 1) ---------------------------------------------
  const tot = { hit: 0, cautious: 0, flagged: 0, wrong: 0, n: 0 };
  const critRows = KEYS.map((k) => {
    const c = { hit: 0, cautious: 0, flagged: 0, wrong: 0, n: 0 };
    for (const r of rows) {
      const x = cellClass(r, k);
      if (x === "na") continue;
      c[x] += 1;
      c.n += 1;
      tot[x] += 1;
      tot.n += 1;
    }
    return `<tr><th scope="row">${LABEL[k]}</th><td class="num">${c.hit}/${c.n}</td><td class="num">${c.cautious}</td><td class="num">${c.flagged}</td><td class="num ${c.wrong ? "bad" : ""}">${c.wrong}</td></tr>`;
  }).join("");

  // --- things to check ----------------------------------------------------
  const findings: string[] = [];
  const wrongSure = new Map<string, string[]>();
  metrics.forEach((m, i) => {
    for (const r of [...m.wrongYes, ...m.wrongNo]) {
      wrongSure.set(keyOf(r), [...(wrongSure.get(keyOf(r)) ?? []), `Lauf ${i + 1}`]);
    }
  });
  for (const [k, inRuns] of wrongSure) {
    const r = rows.find((x) => keyOf(x) === k);
    if (!r) continue;
    findings.push(
      `<li class="sev3"><b>${e(r.person)}, ${e(r.firma)}: falsch und sicher.</b> Testset ${e(r.empfehlung_soll)}, System ${e(r.empfehlung_ist)} (${inRuns.join(", ")}).</li>`,
    );
  }
  const sureOpen = new Map<string, number>();
  metrics.forEach((m) => m.sureOpenInTestset.forEach((r) => sureOpen.set(keyOf(r), (sureOpen.get(keyOf(r)) ?? 0) + 1)));
  for (const [k, count] of sureOpen) {
    const r = runs.flat().find((x) => keyOf(x) === k && decision(x) === "sicher")!;
    const decided = KEYS.filter((c) => r[`${c}_soll`] !== r[`${c}_ist`] && r[`${c}_ist`] !== "unbekannt");
    const why = decided.map((c) => `${LABEL[c]}: ${e(r[`${c}_begruendung`])} ${srclink(r[`${c}_quelle`])}`).join("; ");
    findings.push(
      `<li class="sev2"><b>${e(r.person)}, ${e(r.firma)}: System sicher «${e(r.empfehlung_ist)}», Testset offen</b> (in ${count} von ${runs.length} Läufen). ${why}. Möglicherweise fehlt die Angabe im Testset.</li>`,
    );
  }
  for (const r of rows) {
    if (firmDiffers(r.firma, r.firma_gefunden)) {
      findings.push(
        `<li><b>${e(r.person)}: andere Firma gefunden.</b> Im Testset «${e(r.firma)}», das System prüfte «${e(r.firma_gefunden)}». ${srclink(r.k1_mandat_quelle, "Registerauszug")}</li>`,
      );
    }
  }
  for (const f of st?.flips ?? []) {
    const [person, firma] = f.key.split("|");
    findings.push(`<li><b>${e(person)}, ${e(firma)}: schwankt zwischen den Läufen.</b> ${f.verdicts.map((v, i) => `Lauf ${i + 1}: ${e(v)}`).join(" · ")}</li>`);
  }

  // --- system decided where the test set says "unbekannt" -----------------
  const decidedRows = rows
    .flatMap((r) =>
      KEYS.filter((k) => r[`${k}_soll`] === "unbekannt" && (r[`${k}_ist`] === "ja" || r[`${k}_ist`] === "nein")).map(
        (k) =>
          `<tr><td><b>${e(r.person)}</b><span class="firm">${e(r.firma_gefunden || r.firma)}</span></td><td>${LABEL[k]}</td>` +
          `<td class="sysval">${e(r[`${k}_ist`])}</td><td>${e(r[`${k}_begruendung`])}</td>` +
          `<td>${r[`${k}_sicher`] === "nein" ? `<span class="badge flagged">unsicher</span>` : `<span class="badge">sicher</span>`}</td>` +
          `<td>${srclink(r[`${k}_quelle`]) || "–"}</td></tr>`,
      ),
    )
    .join("");

  // --- person matrix (run 1) ----------------------------------------------
  const BADGE: Record<number, [string, string]> = {
    3: ["wrong", "abweichend, System sicher"],
    2: ["flagged", "abweichend, als unsicher markiert"],
    1: ["cautious", "vorsichtig"],
  };
  const ordered = [...rows].sort((a, b) => {
    const x = severity(a);
    const y = severity(b);
    return y.worst - x.worst || Number(y.verdictMiss) - Number(x.verdictMiss) || y.count - x.count;
  });
  const deviating = rows.filter((r) => severity(r).worst || severity(r).verdictMiss).length;
  const personRows = ordered
    .map((r) => {
      const s = severity(r);
      const dev = s.worst > 0 || s.verdictMiss;
      let badge = "";
      if (s.worst) badge = `<span class="badge ${BADGE[s.worst][0]}">${BADGE[s.worst][1]} · ${s.count} Kriterium${s.count === 1 ? "" : "en"}</span>`;
      else if (s.verdictMiss) badge = `<span class="badge cautious">Empfehlung abweichend</span>`;
      const reasons = KEYS.map(
        (k) =>
          `<li><b>${LABEL[k]}:</b> ${e(r[`${k}_begruendung`] || "–")}${r[`${k}_sicher`] === "nein" && r[`${k}_ist`] !== "unbekannt" ? " <em>(unsicher)</em>" : ""}${r[`${k}_quelle`] ? " · " + srclink(r[`${k}_quelle`]) : ""}</li>`,
      ).join("");
      const firm = firmDiffers(r.firma, r.firma_gefunden)
        ? `${e(r.firma)}<span class="found">gefunden: ${e(r.firma_gefunden)}</span>`
        : e(r.firma_gefunden || r.firma);
      return (
        `<tr class="${dev ? `dev sev${s.worst}` : "same"}"><td class="p">${badge}<details><summary><span class="name">${e(r.person)}</span>` +
        `<span class="firm">${firm}</span></summary><ul class="why">${reasons}</ul></details></td>` +
        KEYS.map((k) => cell(r, k)).join("") +
        verdictCell(r, flipMap.get(keyOf(r)) ?? null) +
        `<td class="num">$${Number(r.kosten_usd || 0).toFixed(3)}</td></tr>`
      );
    })
    .join("");

  const stabilityFig = st
    ? `<div class="fig"><b>${fmtPct(pctNum(st.sameVerdict, st.persons))}</b><span>Stabilität: gleiche Empfehlung in allen ${runs.length} Läufen (Ziel ≥ 95 %)</span></div>`
    : "";

  return `<title>SwissVR-Eignungsprüfung Eval</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Source+Serif+4:ital,wght@1,500&display=swap">
<style>
/* Layout: one reading column for findings, full width for tables. m+p brand: mustard + grays. */
:root {
  --bg:#ffffff; --surface:#f7f8fa; --fg:#1a1a1a; --fg2:#2d3748; --muted:#718096; --line:#e2e8f0;
  --accent:hsl(41,75%,61%); --accent-soft:hsl(41,75%,93%); --accent-line:hsl(41,75%,80%); --accent-ink:hsl(41,75%,32%);
  --wrong-bg:#1a1a1a; --wrong-fg:#ffffff;
  --sans:'Manrope','Segoe UI','Helvetica Neue',Arial,sans-serif; --serif:'Source Serif 4',Georgia,serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#17181a; --surface:#202226; --fg:#ececec; --fg2:#d0d4da; --muted:#9aa3ae; --line:#33363c;
  --accent-soft:hsl(41,40%,20%); --accent-line:hsl(41,45%,35%); --accent-ink:hsl(41,80%,72%);
  --wrong-bg:#ececec; --wrong-fg:#17181a; color-scheme:dark; } }
:root[data-theme="dark"] {
  --bg:#17181a; --surface:#202226; --fg:#ececec; --fg2:#d0d4da; --muted:#9aa3ae; --line:#33363c;
  --accent-soft:hsl(41,40%,20%); --accent-line:hsl(41,45%,35%); --accent-ink:hsl(41,80%,72%);
  --wrong-bg:#ececec; --wrong-fg:#17181a; color-scheme:dark; }
body { background:var(--bg); color:var(--fg); font-family:var(--sans); font-size:15px; line-height:1.55; }
.wrap { max-width:1100px; margin:0 auto; padding-inline:20px; padding-block:40px 64px; display:grid; gap:44px; }
.col { max-width:70ch; display:grid; gap:14px; }
section { display:grid; gap:14px; min-width:0; }
header { display:grid; gap:10px; border-bottom:2px solid var(--accent); padding-bottom:22px; }
.eyebrow { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); font-weight:600; }
h1 { font-family:var(--serif); font-style:italic; font-weight:500; font-size:clamp(28px,4.4vw,40px); line-height:1.15; margin:0; text-wrap:balance; }
h2 { font-size:19px; font-weight:700; color:var(--fg2); margin:0; padding-bottom:6px; border-bottom:1px solid var(--accent-line); text-wrap:balance; }
p { margin:0; } .lead { font-size:17px; color:var(--fg2); max-width:70ch; }
.figures { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }
.fig { background:var(--bg); padding:16px 18px; display:grid; gap:2px; align-content:start; }
.fig b { font-size:28px; font-weight:700; font-variant-numeric:tabular-nums; }
.fig span { font-size:13px; color:var(--muted); }
.tbl { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:14px; }
th { text-align:left; font-weight:600; color:var(--fg2); background:var(--accent-soft); border:1px solid var(--accent-line); padding:8px 10px; vertical-align:bottom; }
td { border:1px solid var(--line); padding:7px 10px; vertical-align:top; }
tbody th { background:transparent; border-color:var(--line); }
.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.num small { display:block; font-size:11px; color:var(--muted); }
.target { color:var(--muted); }
.bad { font-weight:700; }
table.matrix3 { width:auto; } table.matrix3 td.m { min-width:90px; text-align:center; font-size:18px; font-weight:700; }
td.m.agree { background:var(--accent-soft); color:var(--accent-ink); } td.m.contra { background:var(--wrong-bg); color:var(--wrong-fg); } td.m.gap { color:var(--fg2); }
.findings { display:grid; gap:10px; margin:0; padding:0; list-style:none; }
.findings li { border-left:3px solid var(--accent-line); background:var(--surface); padding:10px 14px; font-size:14px; }
.findings li.sev2 { border-left-color:var(--accent); } .findings li.sev3 { border-left-color:var(--wrong-bg); }
.legend { display:flex; flex-wrap:wrap; gap:8px 18px; font-size:13px; color:var(--muted); align-items:center; }
.legend i { display:inline-block; font-style:normal; min-width:34px; text-align:center; padding:1px 6px; margin-right:6px; border:1px solid var(--line); }
.legend i.cautious { background:var(--surface); border:2px dashed var(--accent); } .legend i.flagged { background:var(--accent-soft); color:var(--accent-ink); } .legend i.wrong { background:var(--wrong-bg); color:var(--wrong-fg); }
.toolbar { display:flex; flex-wrap:wrap; gap:8px 20px; align-items:center; font-size:14px; }
.toolbar label { display:flex; gap:8px; align-items:center; cursor:pointer; font-weight:600; }
.toolbar input { accent-color:var(--accent); width:16px; height:16px; }
.hint { font-size:13px; color:var(--muted); }
.persons td.c, .persons td.v { text-align:center; white-space:nowrap; font-size:13px; vertical-align:middle; }
.persons th.k { text-align:center; }
.ok, td.hit .val, td.na .val { color:var(--muted); }
.pair-l { display:block; font-size:10px; letter-spacing:.06em; text-transform:uppercase; opacity:.75; line-height:1.2; }
.pair-v { display:block; line-height:1.3; margin-bottom:3px; } .pair-v.sys { font-weight:700; margin-bottom:0; }
td.cautious { background:var(--surface); color:var(--fg2); outline:2px dashed var(--accent); outline-offset:-3px; }
td.flagged { background:var(--accent-soft); color:var(--accent-ink); font-weight:600; }
td.wrong { background:var(--wrong-bg); color:var(--wrong-fg); font-weight:700; }
td.v.miss { background:var(--surface); outline:2px solid var(--accent); outline-offset:-2px; }
.runs { display:block; font-size:11px; color:var(--accent-ink); margin-top:3px; white-space:normal; }
tr.same td { opacity:.6; } tr.same:hover td { opacity:1; }
tr.dev td.p { box-shadow:inset 4px 0 0 var(--accent-line); } tr.dev.sev2 td.p { box-shadow:inset 4px 0 0 var(--accent); } tr.dev.sev3 td.p { box-shadow:inset 4px 0 0 var(--wrong-bg); }
.badge { display:inline-block; font-size:11px; font-weight:600; padding:1px 7px; margin-bottom:5px; border:1px solid var(--line); }
.badge.cautious { background:var(--surface); border:1px dashed var(--accent); color:var(--fg2); }
.badge.flagged { background:var(--accent-soft); border-color:var(--accent); color:var(--accent-ink); }
.badge.wrong { background:var(--wrong-bg); border-color:var(--wrong-bg); color:var(--wrong-fg); }
td.p { min-width:220px; }
summary { cursor:pointer; list-style:none; display:grid; gap:1px; } summary::-webkit-details-marker { display:none; }
summary:focus-visible, a.src:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.name { font-weight:600; } .name::after { content:" ▸"; color:var(--accent-ink); font-size:11px; } details[open] .name::after { content:" ▾"; }
.firm { font-size:13px; color:var(--muted); display:block; } .found { display:block; color:var(--accent-ink); }
.why { margin:8px 0 2px; padding-left:16px; font-size:13px; color:var(--fg2); display:grid; gap:3px; }
.why em { color:var(--accent-ink); font-style:normal; font-weight:600; }
a.src { color:var(--accent-ink); font-weight:600; text-decoration:none; white-space:nowrap; font-size:12px; }
a.src:hover { text-decoration:underline; } td.c a.src { display:block; margin-top:3px; }
table.decided td { font-size:13px; } table.decided td.sysval { font-weight:700; text-align:center; }
.persons.only-dev tr.same { display:none; }
dl.defs { display:grid; grid-template-columns:minmax(0,max-content) minmax(0,1fr); gap:6px 16px; margin:0; font-size:14px; }
dl.defs dt { font-weight:600; } dl.defs dd { margin:0; color:var(--fg2); }
@media (max-width:640px) { dl.defs { grid-template-columns:1fr; } dl.defs dd { margin-bottom:8px; } }
footer { font-size:12px; color:var(--muted); border-top:1px solid var(--accent-line); padding-top:14px; }
@media (max-width:600px) { body { font-size:14px; } .wrap { padding-inline:16px; } }
</style>
<div class="wrap">
<header>
  <span class="eyebrow">mühlemann+popp · SwissVR-Eignungsprüfung · Evaluation vom ${e(date)}</span>
  <h1>Wie gut erkennt das System, ob eine Person für SwissVR qualifiziert?</h1>
  <p class="lead">${n} Personen aus dem Testset «${e(testset)}», automatisch geprüft und mit der manuellen Einschätzung verglichen${runs.length > 1 ? `, in ${runs.length} unabhängigen Läufen` : ""}. Geprüft werden vier Kriterien: VR-Mandat, Rechtsform, mindestens 10 Mitarbeitende und Sitz oder Wohnsitz in der Schweiz.</p>
</header>

<section class="figures" aria-label="Kennzahlen">
  <div class="fig"><b>${range(wrongRates, fmtPct)}</b><span>Falsch-sicher-Rate: sicher entschieden und falsch (Ziel ≤ 1 %)</span></div>
  <div class="fig"><b>${range(autoRates, fmtPct)}</b><span>Automatisierungsquote: ohne manuelle Prüfung entschieden (Ziel ≥ 70 %)</span></div>
  <div class="fig"><b>${range(agreeRates, fmtPct)}</b><span>Übereinstimmung mit dem Testset, «beide unsicher» zählt als Übereinstimmung</span></div>
  ${stabilityFig}
</section>

<section>
  <h2>Kennzahlen pro Lauf</h2>
  <div class="tbl"><table>
    <thead><tr><th>Kennzahl</th>${runHead}<th class="num">Ziel</th></tr></thead>
    <tbody>${metricRows}</tbody>
  </table></div>
</section>

<section>
  <h2>Testset und System im Vergleich</h2>
  <p class="col">Pro Person, Lauf 1. «Offen» heisst beim Testset: mindestens ein Kriterium ist «unbekannt». Beim System heisst es: unsicher entschieden oder «nicht beurteilbar». Die Diagonale zählt als Übereinstimmung. Schwarz wären Widersprüche (Testset sagt das Gegenteil des Systems).</p>
  <div class="tbl"><table class="matrix3">
    <thead><tr><th>Testset ↓ · System →</th><th class="num">qualifiziert</th><th class="num">qualifiziert nicht</th><th class="num">offen</th></tr></thead>
    <tbody>${matrixRows}</tbody>
  </table></div>
</section>

<section>
  <h2>Pro Kriterium</h2>
  <p class="col">Lauf 1, ${tot.hit} von ${tot.n} Einzelangaben stimmen mit dem Testset überein.</p>
  <div class="tbl"><table>
    <thead><tr><th>Kriterium</th><th class="num">Übereinstimmung</th><th class="num">vorsichtig<br><small>(«nicht ermittelbar»)</small></th><th class="num">abweichend,<br>als unsicher markiert</th><th class="num">abweichend<br>und sicher</th></tr></thead>
    <tbody>${critRows}</tbody>
  </table></div>
</section>

<section class="col">
  <h2>Zum Nachprüfen</h2>
  ${findings.length ? `<ul class="findings">${findings.join("")}</ul>` : "<p>Keine auffälligen Fälle.</p>"}
</section>

<section>
  <h2>System entschieden, Testset «unbekannt»</h2>
  <p class="col">Hier hat das System eine Antwort gefunden, wo die manuelle Prüfung keine fand (Lauf 1). Über die Quelle lässt sich prüfen, ob die Lücke im Testset liegt.</p>
  ${decidedRows ? `<div class="tbl"><table class="decided"><thead><tr><th>Person · Firma</th><th>Kriterium</th><th>System</th><th>Begründung</th><th>Quelle sicher?</th><th>Quelle</th></tr></thead><tbody>${decidedRows}</tbody></table></div>` : "<p>Keine solchen Fälle.</p>"}
</section>

<section>
  <h2>Alle Personen</h2>
  <p class="col">${deviating} von ${n} Personen weichen in mindestens einem Punkt vom Testset ab (Lauf 1). Sie stehen oben, die schwersten Abweichungen zuerst. In abweichenden Zellen steht oben der Testset-Wert und darunter fett, was das System ermittelt hat. ⚠ markiert unsichere Quellen, ↻ eine Empfehlung, die zwischen den Läufen wechselt.</p>
  <div class="legend">
    <span><i>✓</i>stimmt überein</span>
    <span><i class="cautious">?</i>vorsichtig: System sagt «nicht ermittelbar»</span>
    <span><i class="flagged">⚠</i>abweichend, als unsicher markiert</span>
    <span><i class="wrong">!</i>abweichend, System sicher</span>
  </div>
  <div class="toolbar">
    <label for="only-dev"><input type="checkbox" id="only-dev"> Nur Abweichungen zeigen</label>
    <span class="hint">Name anklicken für Begründung und Quellen pro Kriterium</span>
  </div>
  <div class="tbl"><table class="persons">
    <thead><tr><th>Person · Firma</th>${KEYS.map((k) => `<th class="k">${LABEL[k]}</th>`).join("")}<th class="k">Empfehlung</th><th class="num">Kosten</th></tr></thead>
    <tbody>${personRows}</tbody>
  </table></div>
</section>

<section class="col">
  <h2>So wurde gemessen</h2>
  <p>Pro Person sucht das System die Firma in Zefix und liest den kantonalen Handelsregisterauszug: Ist die Person eingetragen, in welcher Funktion, noch aktiv, mit welchem Wohnort? Die Mitarbeitendenzahl recherchiert ein KI-Agent im Web. Firmen ausserhalb des Schweizer Registers werden komplett per Web-Recherche geprüft. Die Empfehlung leitet fester Code aus den vier Kriterien ab, nicht das Sprachmodell.</p>
  <dl class="defs">
    <dt>Falsch-sicher-Rate</dt><dd>Personen, die das System ohne Unsicherheit entscheidet und dabei der eindeutigen Testset-Empfehlung widerspricht, geteilt durch alle Personen mit eindeutiger Testset-Empfehlung.</dd>
    <dt>Automatisierungsquote</dt><dd>Personen mit einer Empfehlung, bei der kein entscheidendes Kriterium auf einer unsicheren Quelle beruht. Sie müssten nicht manuell geprüft werden.</dd>
    <dt>Übereinstimmung</dt><dd>Testset und System entscheiden gleich, oder beide bleiben offen.</dd>
    <dt>Stabilität</dt><dd>Personen mit derselben Empfehlung in allen Läufen.</dd>
    <dt>Sichere Quellen</dt><dd>Handelsregister, Geschäftsbericht, Behörden, die eigene Website der Firma sowie deren LinkedIn- und jobs.ch-Profil. Konzernzahlen, andere Portale, Verzeichnisse und Presse gelten als unsicher.</dd>
  </dl>
</section>

<footer>Interne Auswertung · Testset: ${e(testset)} · Läufe: ${files.map(e).join(", ")} · erzeugt mit <code>pnpm cli report</code></footer>
</div>
<script>
(function () {
  var box = document.getElementById("only-dev"), table = document.querySelector(".persons");
  var KEY = "swissvr-eval-only-dev";
  try { box.checked = localStorage.getItem(KEY) === "1"; } catch (err) {}
  function apply() { table.classList.toggle("only-dev", box.checked); try { localStorage.setItem(KEY, box.checked ? "1" : "0"); } catch (err) {} }
  box.addEventListener("change", apply); apply();
})();
</script>
`;
}
