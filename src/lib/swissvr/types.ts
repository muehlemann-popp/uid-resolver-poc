/** Shared types of the SwissVR eligibility check (pure module, no server code). */

import type { Cost } from "../cost";
import type { Employees } from "../employees";

/** Input: "Vorname Name, Firma[, Ort]". */
export type PersonQuery = {
  person: string;
  company: string;
  town: string;
};

export type Mode = "neuaufnahme" | "bestand";

/** What a register entry says the person does at the company. */
export type RoleCategory =
  | "verwaltungsrat" // member / chair / vice chair of the board (AG, Kommandit-AG, Genossenschaft "Verwaltung")
  | "aufsichtsgremium" // Bankrat, Spitalrat, Aufsichtsrat, Verwaltungskommission ...
  | "stiftungsrat"
  | "vereinsvorstand"
  | "gesellschafter" // partner / shareholder of a GmbH or partnership
  | "geschaeftsfuehrer" // managing director of a GmbH
  | "inhaber" // sole proprietor
  | "geschaeftsleitung" // management board, director, CEO
  | "zeichnungsberechtigt" // signing authority only (Prokura, no organ function)
  | "revisionsstelle"
  | "andere";

/** How the mandate was established - criterion 1 demands an actively verified one. */
export type Verification =
  | "register" // cantonal register extract or SOGC publication
  | "register_mirror" // Moneyhouse & co., which republish the SOGC
  | "official_publication" // annual report / website of a public institution outside the register
  | "self_declared" // LinkedIn, company website bio
  | "none";

export type Sector =
  | "bank"
  | "spital"
  | "heim"
  | "oeffentlich_wirtschaftlich"
  | "finma"
  | "snb"
  | "pensionskasse"
  | "keiner";

export type RegisterPerson = {
  /** As in the register: "Mühlemann, Silvan" */
  name: string;
  /** Residence ("in Zürich"), possibly with canton or country code. */
  residence: string;
  role: string;
  signing: string;
  active: boolean;
};

export type CompanyFacts = {
  name: string;
  uid: string | null;
  legal_form_id: number | null;
  legal_form: string;
  /** Purpose clause from the register - helps classify the sector. */
  purpose: string;
  seat: string;
  /** Every company in the Swiss register has its seat in Switzerland. */
  seat_country: "CH" | "abroad" | null;
  active: boolean | null;
  sector: Sector | null;
  employees: Employees | null;
  /** False when the headcount research was skipped because the mandate already fails. */
  employees_checked: boolean;
  /** True when the figure comes from an annual report, the company's own site or an official source. */
  employees_certain: boolean;
  /** True when legal form and seat come from the Swiss commercial register (not from web research). */
  from_register: boolean;
  /** Where register data came from, e.g. the cantonal extract URL. */
  register_source: string;
  sources: string[];
};

export type MandateFacts = {
  company: CompanyFacts;
  /** The matching register row(s); empty if the person is not listed. */
  person_in_register: RegisterPerson | null;
  role: RoleCategory | null;
  role_text: string;
  active: boolean | null;
  verification: Verification;
  /** True when the company's register entry was read and the person is not in it. */
  checked_absent: boolean;
  /** Residence of the person according to the register. */
  residence: string;
  residence_country: "CH" | "abroad" | null;
  /** Several people of that name, or name only partly matching. */
  identity_unclear: boolean;
  /** Where the mandate came from: the company the user named, or a further one found later. */
  origin: "input" | "further";
  notes: string[];
};

export type CriterionStatus = "erfüllt" | "nicht erfüllt" | "nicht ermittelbar";

export type Criterion = {
  status: CriterionStatus;
  reason: string;
  source: string;
  /** False when the status rests on a weak source (LinkedIn bracket, register mirror, web research). */
  certain: boolean;
};

export type Criteria = {
  k1_mandat: Criterion;
  k2_rechtsform: Criterion;
  k3_mitarbeitende: Criterion;
  k4_sitz: Criterion;
};

export type MandateVerdict = "qualifiziert" | "qualifiziert nicht" | "nicht beurteilbar";
export type Verdict = MandateVerdict | "nicht mehr qualifiziert";

export type MandateAssessment = MandateFacts & {
  criteria: Criteria;
  verdict: MandateVerdict;
};

export type Assessment = {
  query: PersonQuery;
  mode: Mode;
  verdict: Verdict;
  /** One line: why. */
  summary: string;
  /** Criteria of the decisive mandate whose status rests on a weak source, e.g. "K3: LinkedIn-Spanne". */
  uncertain: string[];
  /** The mandate the verdict rests on (null if none was found at all). */
  decisive: MandateAssessment | null;
  mandates: MandateAssessment[];
  cost: Cost;
};

export type AssessEvent =
  | { type: "start"; query: PersonQuery }
  | { type: "step"; message: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; summary: string }
  | { type: "cost"; cost: Cost }
  | { type: "assessment"; assessment: Assessment }
  | { type: "error"; message: string };
