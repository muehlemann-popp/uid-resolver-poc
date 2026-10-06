/**
 * The SwissVR qualification rules. Pure: facts in, criteria and verdict out.
 *
 * A person qualifies when one mandate meets all four criteria:
 *   1. board mandate, actively verified (not self-declared)
 *   2. qualifying legal form - AG, Kommandit-AG, Genossenschaft, independent
 *      public-law institution - or an exception sector (bank, hospital, care
 *      home, public institution with economic activity, FINMA, SNB) when the
 *      mandate is a seat on the supervisory / governing body
 *   3. at least 10 employees
 *   4. Swiss residence of the person OR Swiss seat of the company
 * Explicit exclusions (foundation boards, pension funds, association boards,
 * GmbH partners, partnerships, sole proprietors) never qualify and take
 * precedence over the sector exceptions.
 *
 * Within a mandate "nicht erfüllt" beats "nicht ermittelbar".
 */

import { formatEmployees } from "../employees";
import { BOARD_ROLES } from "./match";
import type {
  Criteria,
  Criterion,
  MandateAssessment,
  MandateFacts,
  MandateVerdict,
  Mode,
  RoleCategory,
  Verdict,
} from "./types";

/** Zefix legal form ids that qualify on their own: AG, Genossenschaft, IOR, Kommandit-AG. */
const QUALIFYING_FORMS = new Set([3, 5, 8, 12]);
/** GmbH, Kollektiv-/Kommanditgesellschaft, Einzelunternehmen, Verein, Stiftung, Gemeinderschaft. */
const EXCLUDED_FORMS: Record<number, string> = {
  1: "Einzelunternehmen",
  2: "Kollektivgesellschaft",
  4: "GmbH",
  6: "Verein",
  7: "Stiftung",
  10: "Kommanditgesellschaft",
  14: "Gemeinderschaft",
};
const EXCLUDED_ROLES: Partial<Record<RoleCategory, string>> = {
  stiftungsrat: "Stiftungsrat",
  vereinsvorstand: "Vereinsvorstand",
  gesellschafter: "Gesellschafter",
  geschaeftsfuehrer: "GmbH-Geschäftsführer",
  inhaber: "Einzelunternehmer",
};
const EXCEPTION_SECTORS = new Set(["bank", "spital", "heim", "oeffentlich_wirtschaftlich", "finma", "snb"]);

const ok = (reason: string, source = "", certain = true): Criterion => ({ status: "erfüllt", reason, source, certain });
const fail = (reason: string, source = "", certain = true): Criterion => ({ status: "nicht erfüllt", reason, source, certain });
const unknown = (reason: string, source = ""): Criterion => ({ status: "nicht ermittelbar", reason, source, certain: true });

/** Exclusion that rules the mandate out regardless of anything else, or null. */
export function exclusion(m: MandateFacts): string | null {
  if (m.company.sector === "pensionskasse") return "Pensionskasse (explizit ausgeschlossen)";
  const role = m.role ? EXCLUDED_ROLES[m.role] : undefined;
  if (role) return `${role} (explizit ausgeschlossen)`;
  const form = m.company.legal_form_id !== null ? EXCLUDED_FORMS[m.company.legal_form_id] : undefined;
  if (form && m.person_in_register) return `Mandat in einer ${form} (explizit ausgeschlossen)`;
  return null;
}

export function k1Mandate(m: MandateFacts): Criterion {
  const src = m.company.register_source;
  const excluded = exclusion(m);
  if (excluded) return fail(excluded, src, m.company.from_register);

  // Absence is no proof: the mandate may be held at a related entity. Only a cancelled entry or a
  // non-board function (below) is evidence enough for "nicht erfüllt".
  if (m.checked_absent) return unknown(`Nicht im Handelsregister von ${m.company.name} gefunden`, src);
  if (!m.person_in_register && m.verification === "none") return unknown("Kein Mandat gefunden", src);
  if (m.identity_unclear) return unknown(`Identität nicht eindeutig (Registereintrag: ${m.person_in_register?.name ?? "?"})`, src);
  if (m.verification === "self_declared") return unknown("Nur Selbstdeklaration, nicht im Register verifiziert", src);

  if (!m.role || !BOARD_ROLES.has(m.role)) {
    return fail(`Funktion «${m.role_text || "keine Organfunktion"}» ist kein VR-/Aufsichtsmandat`, src, m.verification === "register");
  }
  if (m.active === false) return fail(`Mandat beendet (${m.role_text})`, src, m.verification === "register");
  if (m.active === null) return unknown(`Status des Mandats unklar (${m.role_text})`, src);

  const via =
    m.verification === "register"
      ? "Handelsregister"
      : m.verification === "register_mirror"
        ? "Registerspiegel (SHAB-Daten)"
        : "offizielle Publikation ausserhalb Handelsregister";
  return ok(`${m.role_text} (${via})`, src, m.verification === "register" && m.company.from_register);
}

export function k2LegalForm(m: MandateFacts): Criterion {
  const src = m.company.register_source;
  const sure = m.company.from_register;
  const excluded = exclusion(m);
  if (excluded) return fail(excluded, src, sure);

  const id = m.company.legal_form_id;
  if (id !== null && QUALIFYING_FORMS.has(id)) return ok(m.company.legal_form, src, sure);

  const sector = m.company.sector;
  if (sector && EXCEPTION_SECTORS.has(sector) && m.role && BOARD_ROLES.has(m.role)) {
    return ok(`${m.company.legal_form || "Rechtsform"} - Ausnahme Sektor ${sector}`, src, false);
  }
  if (id === null || id === 0) return unknown("Rechtsform unbekannt", src);
  if (sector === null) return unknown(`${m.company.legal_form}, Sektor-Ausnahme nicht geprüft`, src);
  return fail(`${m.company.legal_form} ist keine qualifizierende Rechtsform`, src, sure);
}

export function k3Employees(m: MandateFacts): Criterion {
  const e = m.company.employees;
  if (!m.company.employees_checked) return unknown("Nicht geprüft - Mandat nicht bestätigt oder bereits ausgeschlossen");
  if (!e || (e.min === null && e.max === null)) return unknown("Keine Mitarbeitendenzahl gefunden");
  const label = formatEmployees(e);
  const lo = e.min ?? e.count;
  const hi = e.max ?? e.count;
  // >= 10 FTE means at least 10 people; < 10 FTE can still be >= 10 people.
  const sure = m.company.employees_certain;
  if (lo !== null && lo >= 10) return ok(label, e.source, sure);
  if (hi !== null && hi < 10) {
    return e.fte ? unknown(`${label} - Personenzahl unbekannt`, e.source) : fail(label, e.source, sure);
  }
  return unknown(`${label} - Spanne über die Schwelle von 10`, e.source);
}

export function k4Domicile(m: MandateFacts): Criterion {
  const src = m.company.register_source;
  if (m.residence_country === "CH") return ok(`Wohnsitz ${m.residence}`, src, m.verification === "register");
  if (m.company.seat_country === "CH") return ok(`Firmensitz ${m.company.seat}`, src, m.company.from_register);
  if (m.residence_country === "abroad" && m.company.seat_country === "abroad") {
    return fail(`Wohnsitz ${m.residence} und Firmensitz ${m.company.seat} im Ausland`, src, false);
  }
  return unknown("Weder Wohnsitz noch Firmensitz ermittelbar");
}

export function evaluateCriteria(m: MandateFacts): Criteria {
  return {
    k1_mandat: k1Mandate(m),
    k2_rechtsform: k2LegalForm(m),
    k3_mitarbeitende: k3Employees(m),
    k4_sitz: k4Domicile(m),
  };
}

/** "nicht erfüllt" beats "nicht ermittelbar". */
export function mandateVerdict(c: Criteria): MandateVerdict {
  const all = Object.values(c) as Criterion[];
  if (all.some((x) => x.status === "nicht erfüllt")) return "qualifiziert nicht";
  if (all.some((x) => x.status === "nicht ermittelbar")) return "nicht beurteilbar";
  return "qualifiziert";
}

export function assessMandate(m: MandateFacts): MandateAssessment {
  const criteria = evaluateCriteria(m);
  return { ...m, criteria, verdict: mandateVerdict(criteria) };
}

const RANK: Record<MandateVerdict, number> = { qualifiziert: 0, "nicht beurteilbar": 1, "qualifiziert nicht": 2 };

/** The person's verdict rests on their best mandate; the input company wins ties. */
export function decisiveMandate(mandates: MandateAssessment[]): MandateAssessment | null {
  if (mandates.length === 0) return null;
  return [...mandates].sort(
    (a, b) => RANK[a.verdict] - RANK[b.verdict] || (a.origin === "input" ? -1 : 1) - (b.origin === "input" ? -1 : 1),
  )[0];
}

export function personVerdict(decisive: MandateAssessment | null, mode: Mode): Verdict {
  const v: MandateVerdict = decisive?.verdict ?? "nicht beurteilbar";
  if (v === "qualifiziert nicht" && mode === "bestand") return "nicht mehr qualifiziert";
  return v;
}

/** Whether a mandate is already decided negatively, so later (paid) stages can be skipped. */
export function alreadyFailed(m: MandateFacts): boolean {
  return k1Mandate(m).status === "nicht erfüllt" || k2LegalForm(m).status === "nicht erfüllt";
}

const SHORT: Record<keyof Criteria, string> = { k1_mandat: "K1", k2_rechtsform: "K2", k3_mitarbeitende: "K3", k4_sitz: "K4" };

/** Decided criteria that rest on a weak source - shown next to the verdict. */
export function uncertainties(m: MandateAssessment | null): string[] {
  if (!m) return [];
  return (Object.entries(m.criteria) as [keyof Criteria, Criterion][])
    .filter(([, c]) => !c.certain && c.status !== "nicht ermittelbar")
    .map(([k, c]) => `${SHORT[k]}: ${c.reason}`);
}
