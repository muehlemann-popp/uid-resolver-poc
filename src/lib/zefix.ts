/**
 * Minimal client for the JSON API behind the zefix.ch web app.
 *
 * This is the API the public Zefix SPA itself calls - no credentials needed,
 * but it is not an official, versioned interface (the official ZefixPublicREST
 * API requires basic auth on request). If it changes, this file is the only
 * place to adapt.
 *
 * What it gives us per company: legal form, seat, status, address, the link to
 * the cantonal register extract (where the current board is listed) and all
 * SOGC (SHAB) publications, whose text names every person entered or removed.
 */

const BASE = "https://www.zefix.ch/ZefixREST/api/v1";

/** Zefix legal form ids (GET /legalForm.json). */
export const LEGAL_FORMS: Record<number, string> = {
  0: "unbekannt",
  1: "Einzelunternehmen",
  2: "Kollektivgesellschaft",
  3: "Aktiengesellschaft",
  4: "GmbH",
  5: "Genossenschaft",
  6: "Verein",
  7: "Stiftung",
  8: "Institut des öffentlichen Rechts",
  9: "Zweigniederlassung",
  10: "Kommanditgesellschaft",
  11: "Zweigniederlassung einer ausl. Gesellschaft",
  12: "Kommanditaktiengesellschaft",
  13: "Besondere Rechtsform",
  14: "Gemeinderschaft",
  15: "Investmentgesellschaft mit festem Kapital",
  16: "Investmentgesellschaft mit variablem Kapital",
  17: "Kommanditgesellschaft für kollektive Kapitalanlagen",
  18: "Nichtkaufmännische Prokura",
};

export const BRANCH_LEGAL_FORMS = new Set([9, 11]);

export type ZefixFirm = {
  name: string;
  ehraid: number;
  uid: string;
  uidFormatted: string;
  legalSeat: string;
  legalFormId: number;
  /** "EXISTIEREND" | "GELOESCHT" | "AUFGELOEST" */
  status: string;
  cantonalExcerptWeb: string | null;
};

export type ShabPublication = {
  shabDate: string;
  shabId: number;
  registryOfficeCanton: string;
  /** Publication text with <FT> markup, e.g. "Eingetragene Personen neu oder mutierend: ..." */
  message: string;
};

export type ZefixFirmDetail = ZefixFirm & {
  purpose: string | null;
  shabPub: ShabPublication[];
  address: { street?: string; houseNumber?: string; swissZipCode?: string; town?: string; country?: string } | null;
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: { code?: string } }) | null;
  if (json?.error?.code === "API.ZFR.SEARCH.NORESULT") return { list: [] } as T;
  if (!res.ok || !json || json.error) {
    throw new Error(`Zefix ${path} ${res.status}: ${json?.error?.code ?? "no body"}`);
  }
  return json;
}

/**
 * Name or UID search. Zefix matches substrings of the name, but has no fuzzy
 * search: "Muehlemann" does not find "mühlemann" - callers try variants.
 */
export async function searchFirms(
  name: string,
  options: { activeOnly?: boolean; maxEntries?: number } = {},
): Promise<ZefixFirm[]> {
  const json = await call<{ list: ZefixFirm[] }>("/firm/search.json", {
    name,
    languageKey: "de",
    maxEntries: options.maxEntries ?? 20,
    activeOnly: options.activeOnly ?? true,
  });
  return json.list ?? [];
}

/** Company detail including all SOGC publications. */
export async function getFirm(ehraid: number): Promise<ZefixFirmDetail> {
  return call<ZefixFirmDetail>(`/firm/${ehraid}.json`);
}

/** "<FT TYPE="F">Foo AG</FT>, in ..." -> "Foo AG, in ..." */
export function stripShabMarkup(message: string): string {
  return message.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
