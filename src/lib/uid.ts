/** Small pure helpers shared by the Claude and the Jev pipeline. */

/**
 * Defensive cleanup: in rare cases a model leaks fragments of its tool
 * serialisation into short string fields. Discard such values.
 */
export function sanitizeText(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";
  if (/[<>]|parameter name=/i.test(text)) return "";
  return text;
}

/** CHE123456789 / CHE-123.456.789 MWST / che 123 456 789 -> CHE-123.456.789 */
export function normalizeUid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 9) return null;
  return `CHE-${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}`;
}
