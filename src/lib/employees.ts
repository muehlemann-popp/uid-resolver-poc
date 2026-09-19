/** Structured headcount, shared by both pipelines and the UI (pure module, no server code). */

export type Employees = {
  /** Exact or approximate headcount. Null when the source only gives a bracket. */
  count: number | null;
  /** Lower / upper bound. Both equal `count` when the figure is exact. */
  min: number | null;
  max: number | null;
  /** Reference year, if the source states one. */
  year: number | null;
  /** True when the figure is full-time equivalents rather than persons. */
  fte: boolean;
  /** URL the figure was taken from. */
  source: string;
};

/** Build a consistent record from whatever bounds are known. */
export function makeEmployees(
  lo: number | null,
  hi: number | null,
  extra: { year?: number | null; fte?: boolean; source?: string } = {},
): Employees | null {
  const a = lo ?? hi;
  const b = hi ?? lo;
  if (a === null || b === null) return null;
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return {
    count: min === max ? min : null,
    min,
    max,
    year: extra.year ?? null,
    fte: extra.fte ?? false,
    source: extra.source ?? "",
  };
}

/** "6,655 (2025)", "11-50", "5,809 FTE (2025)" */
export function formatEmployees(e: Employees | null | undefined): string {
  if (!e) return "";
  const n = (v: number) => v.toLocaleString("en-US");
  const figure = e.count !== null ? n(e.count) : `${n(e.min ?? 0)}-${n(e.max ?? 0)}`;
  return `${figure}${e.fte ? " FTE" : ""}${e.year ? ` (${e.year})` : ""}`;
}
