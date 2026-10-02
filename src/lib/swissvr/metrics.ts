/**
 * Metrics over eval results (the CSV rows written by `eval -o`). Pure, shared by the
 * `metrics` command and the HTML report.
 */

export type EvalRow = Record<string, string>;

export type Decision = "sicher" | "unsicher" | "offen";
export const KEYS = ["k1_mandat", "k2_rechtsform", "k3_mitarbeitende", "k4_sitz"] as const;

/**
 * How firmly the system decided one person, from an eval row:
 *   qualifiziert        sure if all four criteria rest on sure sources
 *   qualifiziert nicht  sure if at least one failed criterion rests on a sure source
 *   otherwise           open (nicht beurteilbar, error)
 */
export function decision(r: EvalRow): Decision {
  if (r.empfehlung_ist === "qualifiziert") return KEYS.every((k) => r[`${k}_sicher`] !== "nein") ? "sicher" : "unsicher";
  if (r.empfehlung_ist === "qualifiziert nicht") {
    return KEYS.some((k) => r[`${k}_ist`] === "nein" && r[`${k}_sicher`] !== "nein") ? "sicher" : "unsicher";
  }
  return "offen";
}

export function runMetrics(rows: EvalRow[]) {
  const sure = rows.filter((r) => decision(r) === "sicher");
  const definite = (r: EvalRow) => r.empfehlung_soll === "qualifiziert" || r.empfehlung_soll === "qualifiziert nicht";
  const labelled = rows.filter(definite);
  const sureLabelled = sure.filter(definite);
  const wrongYes = sureLabelled.filter((r) => r.empfehlung_ist === "qualifiziert" && r.empfehlung_soll === "qualifiziert nicht");
  const wrongNo = sureLabelled.filter((r) => r.empfehlung_ist === "qualifiziert nicht" && r.empfehlung_soll === "qualifiziert");
  return {
    persons: rows.length,
    sure: sure.length,
    unsure: rows.filter((r) => decision(r) === "unsicher").length,
    open: rows.filter((r) => decision(r) === "offen").length,
    labelled: labelled.length,
    sureLabelled: sureLabelled.length,
    sureOpenInTestset: sure.filter((r) => !definite(r)),
    wrongYes,
    wrongNo,
  };
}

export const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)} %` : "-");

export type Side = "qualifiziert" | "qualifiziert nicht" | "offen";
export const SIDES: Side[] = ["qualifiziert", "qualifiziert nicht", "offen"];

/** Testset side: a definite verdict, or open when any label is "unbekannt" or missing. */
export function testsetSide(r: EvalRow): Side {
  const labels = KEYS.map((k) => r[`${k}_soll`]);
  if (labels.includes("nein")) return "qualifiziert nicht";
  if (labels.every((l) => l === "ja")) return "qualifiziert";
  return "offen";
}

/** System side: only sure decisions count as definite; unsure and "nicht beurteilbar" are open. */
export function systemSide(r: EvalRow): Side {
  return decision(r) === "sicher" ? (r.empfehlung_ist as Side) : "offen";
}

/**
 * Agreement between test set and system, where "both unsure" also agrees: a person the test set
 * could not decide may stay open in the system as well.
 */
export function agreement(rows: EvalRow[]) {
  const matrix = new Map<string, number>();
  for (const r of rows) {
    const k = `${testsetSide(r)}|${systemSide(r)}`;
    matrix.set(k, (matrix.get(k) ?? 0) + 1);
  }
  const agree = SIDES.reduce((sum, side) => sum + (matrix.get(`${side}|${side}`) ?? 0), 0);
  return { agree, matrix };
}

/** Persons whose verdict differs between runs, with the verdict of each run. */
export function stability(runs: EvalRow[][]) {
  const key = (r: EvalRow) => `${r.person}|${r.firma}`;
  const maps = runs.map((rows) => new Map(rows.map((r) => [key(r), r])));
  const persons = [...(maps[0]?.keys() ?? [])].filter((k) => maps.every((m) => m.has(k)));
  const verdicts = (k: string) => maps.map((m) => m.get(k)!.empfehlung_ist);
  const sameVerdict = persons.filter((k) => new Set(verdicts(k)).size === 1);
  const sameDecision = persons.filter((k) => new Set(maps.map((m) => `${m.get(k)!.empfehlung_ist}/${decision(m.get(k)!)}`)).size === 1);
  const flips = persons.filter((k) => new Set(verdicts(k)).size > 1).map((k) => ({ key: k, verdicts: verdicts(k) }));
  return { persons: persons.length, sameVerdict: sameVerdict.length, sameDecision: sameDecision.length, flips, verdicts };
}
