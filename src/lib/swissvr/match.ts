/**
 * Pure helpers that turn register text into facts: name matching, role
 * classification and residence country. No I/O, unit-tested.
 */

import type { RoleCategory } from "./types";

const CANTONS = new Set(
  "ZH BE LU UR SZ OW NW GL ZG FR SO BS BL SH AR AI SG GR AG TG TI VD VS NE GE JU".split(" "),
);

/** "Mühlemann" and "Muehlemann" must compare equal, "Gérard" and "Gerard" too. */
export function nameTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export type NameMatch = "exact" | "partial" | "none";

/**
 * Register names are "Surname, First names"; input order is arbitrary.
 * exact   - every token of the shorter side appears in the longer one
 *           (covers additional middle names on either side), at least two tokens
 * partial - surname matches, first names only by initial or not at all
 */
export function matchName(input: string, registerName: string): NameMatch {
  const a = nameTokens(input);
  const b = nameTokens(registerName);
  if (a.length === 0 || b.length === 0) return "none";
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const covered = shorter.filter((t) => longer.includes(t)).length;
  if (covered === shorter.length && shorter.length >= 2) return "exact";

  const surname = nameTokens(registerName.split(",")[0] ?? "");
  if (surname.length > 0 && surname.every((t) => a.includes(t))) {
    const firstNames = b.filter((t) => !surname.includes(t));
    const rest = a.filter((t) => !surname.includes(t));
    const initialMatch = rest.some((r) => firstNames.some((f) => f[0] === r[0]));
    if (initialMatch || rest.length === 0) return "partial";
  }
  return "none";
}

/** "in Wetzikon (ZH)" / "in Weiningen ZH" -> CH, "in München (DE)" -> abroad. */
export function residenceCountry(residence: string): "CH" | "abroad" | null {
  const text = residence.trim();
  if (!text) return null;
  const code = text.match(/\(([A-Z]{2})\)\s*$/)?.[1] ?? text.match(/\s([A-Z]{2})\s*$/)?.[1];
  if (code) return CANTONS.has(code) || code === "CH" ? "CH" : "abroad";
  if (/staatsangehörig|citizen|ressortissant|cittadin/i.test(text)) return "abroad";
  // Swiss register entries name a foreign residence with its country code;
  // a bare town name is a Swiss municipality.
  return "CH";
}

/**
 * Classify a register role. The same words mean different organs depending
 * on the legal form ("member of the board" is the Stiftungsrat of a foundation
 * and the Vorstand of an association), so the legal form decides.
 */
export function classifyRole(roleText: string, legalFormId: number | null): RoleCategory {
  const t = roleText.toLowerCase();

  if (/revisionsstelle|auditor|organe de révision|ufficio di revisione/.test(t)) return "revisionsstelle";
  if (/inhaber|owner|titulaire|titolare/.test(t)) return "inhaber";

  const board =
    /\badm\b|\bprés|membre du conseil|verwaltungsrat|board of directors|\bboard\b|conseil d'administration|consiglio di amministrazione|administrat(eur|rice)|amministrat(ore|rice)|mitglied der verwaltung|member of the administration|stiftungsrat|foundation board|conseil de fondation|consiglio di fondazione|vorstand|comité|comitato|bankrat|spitalrat|aufsichtsrat|supervisory|verwaltungskommission|commission administrative|conseil de surveillance/.test(
      t,
    ) && !/management board|geschäftsleitung|direction générale|direzione generale/.test(t);

  if (board) {
    if (legalFormId === 7) return "stiftungsrat";
    if (legalFormId === 6) return "vereinsvorstand";
    if (/stiftungsrat|foundation board|conseil de fondation|consiglio di fondazione/.test(t)) return "stiftungsrat";
    if (/vorstand|comité|comitato/.test(t) && legalFormId !== 3 && legalFormId !== 5) return "vereinsvorstand";
    if (/bankrat|spitalrat|aufsichtsrat|supervisory|verwaltungskommission|commission administrative|conseil de surveillance/.test(t))
      return "aufsichtsgremium";
    if (legalFormId === 8 || legalFormId === 13) return "aufsichtsgremium";
    return "verwaltungsrat";
  }

  if (/geschäftsführ|managing director|gérant|gerente/.test(t)) {
    return legalFormId === 4 ? "geschaeftsfuehrer" : "geschaeftsleitung";
  }
  if (/gesellschafter|partner|associé|socio|shareholder|teilhaber|kommanditär|limited partner/.test(t)) return "gesellschafter";
  if (/management|geschäftsleitung|direktor|director|direct(eur|rice)|diret(tore|trice)|ceo|vorsitzende/.test(t))
    return "geschaeftsleitung";
  if (!t.trim() || /prokur|proxy|procuration|procura|zeichnungs|signing|signature/.test(t)) return "zeichnungsberechtigt";
  return "andere";
}

/** Organ functions that can satisfy criterion 1. */
export const BOARD_ROLES: ReadonlySet<RoleCategory> = new Set(["verwaltungsrat", "aufsichtsgremium"]);

/** Legal forms and generic words that say nothing about whose website it is ("swiss" matches swissinfo.ch). */
const LEGAL_WORDS = new Set(
  ("ag sa gmbh sarl sagl ltd holding group gruppe genossenschaft in liquidation swiss schweiz suisse svizzera " +
    "international services management partner partners consulting finance invest").split(" "),
);

/**
 * Is the URL the company's own website or its own LinkedIn company page? Decided from the URL, not by
 * the model: the domain label (or the LinkedIn slug) has to contain a distinctive word of the company name.
 *   ariatherm.ch/uber-uns            for ARIATHERM AG                     -> true
 *   linkedin.com/company/emil-egger-ag for Emil Egger AG                  -> true
 *   jobs.ch/de/firmen/83703-luegeten-ag for Luegeten AG                  -> jobportal (own profile)
 */
export function isOwnSource(url: string, companyName: string): "website" | "linkedin" | "jobportal" | null {
  let host: string;
  let path: string;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname.toLowerCase();
  } catch {
    return null;
  }
  const words = nameTokens(companyName).filter((t) => !LEGAL_WORDS.has(t) && t.length >= 3);
  if (words.length === 0) return null;
  const fits = (label: string) => {
    const flat = label.replace(/[^a-z]/g, "");
    return flat.length >= 3 && words.some((w) => flat.includes(w) || (flat.length >= 4 && w.includes(flat)));
  };
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const slug = path.match(/^\/company\/([^/]+)/)?.[1];
    return slug && fits(decodeURIComponent(slug)) ? "linkedin" : null;
  }
  // The company's own profile on jobs.ch / jobup.ch (same platform), e.g. /de/firmen/83703-luegeten-ag/
  if (/(^|\.)(jobs|jobup)\.ch$/.test(host)) {
    const slug = path.match(/\/(firmen|companies|entreprises)\/([^/]+)/)?.[2];
    return slug && fits(decodeURIComponent(slug).replace(/^[0-9a-f-]{8,}-|^\d+-/, "")) ? "jobportal" : null;
  }
  const label = host.split(".").slice(-2, -1)[0] ?? "";
  return fits(label) ? "website" : null;
}
