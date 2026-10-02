/**
 * SwissVR eligibility check of one person - the pipeline.
 *
 *   1. find the company in Zefix         code (name variants, scoring)
 *   2. read its register entry           code: legal form, seat, status
 *   3. list the registered persons       cantonal extract (parser, LLM fallback)
 *   4. find the person in that list      code: name matching, role classification
 *   5. headcount + sector                Claude + Firecrawl (skipped if already failed)
 *   6. further mandates                  only if the input mandate does not qualify
 *   7. apply the rules                   rules.ts, pure code
 *
 * Companies outside the Swiss register go through one web research step that
 * delivers the same facts. Steps 1-4 and 7 are deterministic and free.
 */

import { emptyCost, priceCost, type ModelId } from "../cost";
import { normalizeUid } from "../uid";
import { BRANCH_LEGAL_FORMS, LEGAL_FORMS, getFirm, searchFirms, type ZefixFirm } from "../zefix";
import { llmContext, type LlmContext } from "./llm";
import { classifyRole, matchName, nameTokens, residenceCountry } from "./match";
import { fetchBoard } from "./register";
import { companyProfile, furtherMandates, webMandate } from "./research";
import { alreadyFailed, assessMandate, decisiveMandate, personVerdict, uncertainties } from "./rules";
import type {
  AssessEvent,
  Assessment,
  MandateAssessment,
  MandateFacts,
  Mode,
  PersonQuery,
  RegisterPerson,
  Sector,
} from "./types";

export type AssessOptions = {
  model: ModelId;
  mode: Mode;
  /** Look for other mandates when the given one does not qualify. */
  further: boolean;
  /** Research headcount even when the mandate already fails (for evaluations). */
  thorough: boolean;
};

export const DEFAULT_ASSESS_MODEL: ModelId = "claude-sonnet-5";
const MAX_FURTHER = 3;
const MAX_CANDIDATES_CHECKED = 3;

/** "Hans Muster, Beispiel AG, Bern" -> person / company / town. */
export function parseQuery(input: string): PersonQuery {
  const [person = "", company = "", ...rest] = input.split(",").map((s) => s.trim());
  return { person, company, town: rest.join(", ").replace(/\s*\([A-Z]{2}\)\s*$/, "") };
}

const LEGAL_SUFFIX = /\b(AG|SA|S\.A\.|GmbH|Sàrl|Sagl|Ltd|AG in Liquidation|Holding|Genossenschaft)\b\.?/gi;

/** Zefix has no fuzzy search, so umlaut spellings and the bare name are tried as separate queries. */
export function nameVariants(company: string): string[] {
  const base = company.trim();
  const umlauts = base.replace(/ae/g, "ä").replace(/oe/g, "ö").replace(/ue/g, "ü").replace(/Ae/g, "Ä").replace(/Oe/g, "Ö").replace(/Ue/g, "Ü");
  const ascii = base.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue");
  const bare = base.replace(LEGAL_SUFFIX, "").replace(/\s+/g, " ").trim();
  return [...new Set([base, umlauts, ascii, bare].filter((v) => v.length >= 3))];
}

const LEGAL_TOKENS = new Set(["ag", "sa", "gmbh", "sarl", "sagl", "ltd", "holding", "genossenschaft"]);
const significant = (s: string) => nameTokens(s).filter((t) => !LEGAL_TOKENS.has(t));

/** Legal forms with a board of directors - where a VR mandate can exist at all. */
const BOARD_FORMS = new Set([3, 5, 8, 12, 13]);
/** Sole proprietorships and partnerships have no board. */
const NO_BOARD_FORMS = new Set([1, 2, 10]);

/**
 * 3 = same name, 2 = contains every significant word of the input, else 0 (not a candidate).
 * On top: fewer extra words, matching town, active, and a legal form that can have a board -
 * "Allianz Suisse" must find the insurer, not one of its many agencies (sole proprietorships).
 */
export function scoreFirm(
  company: string,
  town: string,
  firm: Pick<ZefixFirm, "name" | "legalSeat" | "status" | "legalFormId">,
): number {
  const want = significant(company);
  const have = significant(firm.name);
  if (want.length === 0) return 0;
  let score = 0;
  if (want.length === have.length && want.every((t) => have.includes(t))) score = 3;
  // Fewer extra words = closer match ("Allianz Suisse Versicherungs-Gesellschaft AG" before "Allianz Suisse agence ...").
  else if (want.every((t) => have.includes(t))) score = 2 - Math.min(have.length - want.length, 9) * 0.05;
  if (score === 0) return 0;
  const seat = nameTokens(firm.legalSeat);
  if (town && nameTokens(town).every((t) => seat.includes(t))) score += 0.5;
  if (firm.status === "EXISTIEREND") score += 0.4;
  if (BOARD_FORMS.has(firm.legalFormId)) score += 0.3;
  if (NO_BOARD_FORMS.has(firm.legalFormId)) score -= 0.5;
  return score;
}

async function findCandidates(company: string, town: string): Promise<ZefixFirm[]> {
  const seen = new Map<number, ZefixFirm>();
  for (const variant of nameVariants(company)) {
    // Zefix returns hits alphabetically and only as many as asked for: a broad name like
    // "Allianz Suisse" has 177, and the insurer itself sorts after dozens of agencies.
    for (const firm of await searchFirms(variant, { activeOnly: false, maxEntries: 500 })) {
      if (!BRANCH_LEGAL_FORMS.has(firm.legalFormId)) seen.set(firm.ehraid, firm);
    }
    if ([...seen.values()].some((f) => scoreFirm(company, town, f) >= 3)) break;
  }
  return [...seen.values()]
    .map((f) => ({ f, s: scoreFirm(company, town, f) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.f);
}

const PENSION_RE = /pensionskasse|vorsorge|caisse de pension|cassa pensione|fondo di previdenza|prévoyance|previdenza/i;

/** The person's row in the board listing: active rows first, then organ functions. */
function pickRow(person: string, rows: RegisterPerson[], legalFormId: number) {
  const exact = rows.filter((r) => matchName(person, r.name) === "exact");
  const partial = rows.filter((r) => matchName(person, r.name) === "partial");
  const pool = exact.length > 0 ? exact : partial;
  if (pool.length === 0) return null;
  const rank = (r: RegisterPerson) =>
    (r.active ? 0 : 10) + (["verwaltungsrat", "aufsichtsgremium"].includes(classifyRole(r.role, legalFormId)) ? 0 : 1);
  const row = [...pool].sort((a, b) => rank(a) - rank(b))[0];
  const distinctPeople = new Set(pool.filter((r) => r.active).map((r) => `${r.name}|${r.residence}`));
  return { row, unclear: exact.length === 0 || distinctPeople.size > 1 };
}

/** Steps 2-4 for one register company. */
async function registerMandate(
  person: string,
  firm: ZefixFirm,
  origin: MandateFacts["origin"],
  ctx: LlmContext,
  step: (m: string) => void,
): Promise<MandateFacts> {
  const detail = await getFirm(firm.ehraid);
  step(`Registereintrag: ${detail.name}, ${LEGAL_FORMS[detail.legalFormId] ?? "?"}, ${detail.legalSeat} (${detail.status})`);
  const board = await fetchBoard(detail, ctx);
  step(`Personen im Register: ${board.persons.length} (${board.method})`);

  const hit = pickRow(person, board.persons, detail.legalFormId);
  const readable = board.method === "extract_table" || board.method === "extract_llm";
  const role = hit ? classifyRole(hit.row.role, detail.legalFormId) : null;
  const sector: Sector | null = PENSION_RE.test(detail.name) ? "pensionskasse" : null;

  return {
    company: {
      name: detail.name,
      uid: detail.uidFormatted,
      legal_form_id: detail.legalFormId,
      legal_form: LEGAL_FORMS[detail.legalFormId] ?? "unbekannt",
      purpose: detail.purpose ?? "",
      seat: detail.legalSeat,
      seat_country: "CH",
      active: detail.status === "EXISTIEREND",
      sector,
      employees: null,
      employees_checked: false,
      employees_certain: false,
      from_register: true,
      register_source: board.source || detail.cantonalExcerptWeb || "",
      sources: [board.source].filter(Boolean),
    },
    person_in_register: hit?.row ?? null,
    role,
    role_text: hit?.row.role || (hit ? "keine Funktion (nur Zeichnungsberechtigung)" : ""),
    active: hit ? hit.row.active : null,
    verification: hit ? "register" : "none",
    checked_absent: !hit && readable && board.persons.length > 0,
    residence: hit?.row.residence ?? "",
    residence_country: hit ? residenceCountry(hit.row.residence) : null,
    identity_unclear: hit?.unclear ?? false,
    origin,
    notes: [],
  };
}

/** Step 5, unless the rules already reject the mandate. */
async function addProfile(m: MandateFacts, opts: AssessOptions, ctx: LlmContext, step: (s: string) => void) {
  if (!opts.thorough && alreadyFailed(m)) return;
  step(`Mitarbeitende und Branche: ${m.company.name}`);
  const profile = await companyProfile(
    { name: m.company.name, uid: m.company.uid, seat: m.company.seat, purpose: m.company.purpose },
    ctx,
  );
  m.company.employees = profile.employees;
  m.company.employees_certain = profile.employees_certain;
  m.company.employees_checked = true;
  m.company.sector = m.company.sector ?? profile.sector;
  if (profile.employees?.source) m.company.sources.push(profile.employees.source);
  if (profile.notes) m.notes.push(profile.notes);
}

/** Fallback when the company is not in the Swiss register. */
async function webMandateFacts(q: PersonQuery, ctx: LlmContext): Promise<MandateFacts | null> {
  const w = await webMandate(q.person, q.company, q.town, ctx);
  if (!w) return null;
  const found = w.company_found;
  return {
    company: {
      name: w.company_name || q.company,
      uid: w.uid,
      legal_form_id: found ? w.legal_form_id : null,
      legal_form: found ? w.legal_form : "unbekannt",
      purpose: "",
      seat: w.seat,
      seat_country: found ? w.seat_country : null,
      active: found ? true : null,
      sector: found ? w.sector : null,
      employees: w.employees,
      employees_checked: true,
      employees_certain: w.employees_certain,
      from_register: false,
      register_source: w.sources[0] ?? "",
      sources: w.sources,
    },
    person_in_register: w.person_found
      ? { name: q.person, residence: w.residence, role: w.role_text, signing: "", active: w.active ?? true }
      : null,
    role: w.person_found ? w.role : null,
    role_text: w.role_text,
    active: w.person_found ? w.active : null,
    verification: w.person_found ? w.verification : "none",
    checked_absent: false,
    residence: w.residence,
    residence_country: w.residence_country,
    identity_unclear: false,
    origin: "input",
    notes: [w.notes].filter(Boolean),
  };
}

/** Steps 1-5 for the company the user named. */
async function inputMandate(q: PersonQuery, opts: AssessOptions, ctx: LlmContext, step: (s: string) => void) {
  step(`Zefix-Suche: ${q.company}`);
  const candidates = await findCandidates(q.company, q.town);
  const top = candidates.length ? scoreFirm(q.company, q.town, candidates[0]) : 0;

  if (candidates.length === 0) {
    step("Nicht im Schweizer Handelsregister - Web-Recherche");
    const web = await webMandateFacts(q, ctx);
    // The web research may still identify a Swiss company under a different name.
    const uid = web?.company.uid ? normalizeUid(web.company.uid) : null;
    if (uid && web?.company.seat_country === "CH") {
      const [firm] = await searchFirms(uid, { activeOnly: false, maxEntries: 1 });
      if (firm) return registerAndProfile(q.person, firm, "input", opts, ctx, step);
    }
    return web;
  }

  // Several near-equal matches (e.g. "Allianz Suisse"): the one listing the person is the right one.
  const close = candidates.filter((c) => scoreFirm(q.company, q.town, c) >= Math.floor(top));
  const toCheck = close.length > 1 ? close.slice(0, MAX_CANDIDATES_CHECKED) : [candidates[0]];
  if (toCheck.length > 1) step(`${close.length} ähnliche Treffer, prüfe ${toCheck.length}: ${toCheck.map((c) => c.name).join(" | ")}`);
  let first: MandateFacts | null = null;
  for (const firm of toCheck) {
    const m = await registerMandate(q.person, firm, "input", ctx, step);
    if (m.person_in_register) {
      await addProfile(m, opts, ctx, step);
      return m;
    }
    first ??= m;
  }

  // Not in the register of the company found: the person may sit on the board of a related entity
  // (holding vs. operating company, a foreign parent) - one web research step before concluding.
  step(`${q.person} nicht im Register von ${toCheck.map((c) => c.name).join(" / ")} - Web-Recherche`);
  const web = await webMandateFacts(q, ctx);
  const uid = web?.company.uid ? normalizeUid(web.company.uid) : null;
  if (web?.person_in_register && uid && !toCheck.some((c) => c.uidFormatted === uid)) {
    const [firm] = await searchFirms(uid, { activeOnly: false, maxEntries: 1 });
    if (firm) {
      const m = await registerMandate(q.person, firm, "input", ctx, step);
      if (m.person_in_register) {
        await addProfile(m, opts, ctx, step);
        return m;
      }
    } else if (web.company.seat_country !== "CH") {
      return web; // foreign company - the web facts are all we have
    }
  }
  if (web?.person_in_register && web.company.seat_country && web.company.seat_country !== "CH") return web;

  if (first && toCheck.length > 1) {
    // Not found in any of several candidates: we do not know which company was meant.
    first.checked_absent = false;
    first.company = { ...first.company, legal_form_id: null, legal_form: "unbekannt", seat_country: null };
    first.notes.push(`Firma nicht eindeutig (${toCheck.map((c) => c.name).join(", ")}), Person in keiner eingetragen.`);
    return first;
  }
  if (first) await addProfile(first, opts, ctx, step);
  return first;
}

async function registerAndProfile(
  person: string,
  firm: ZefixFirm,
  origin: MandateFacts["origin"],
  opts: AssessOptions,
  ctx: LlmContext,
  step: (s: string) => void,
) {
  const m = await registerMandate(person, firm, origin, ctx, step);
  await addProfile(m, opts, ctx, step);
  return m;
}

export async function assessPerson(
  query: PersonQuery,
  emit: (e: AssessEvent) => void,
  opts: AssessOptions,
): Promise<Assessment> {
  const started = Date.now();
  const cost = emptyCost(opts.model);
  const ctx = llmContext(opts.model, cost, emit);
  const step = (message: string) => emit({ type: "step", message });
  emit({ type: "start", query });

  const mandates: MandateAssessment[] = [];
  const input = await inputMandate(query, opts, ctx, step);
  if (input) mandates.push(assessMandate(input));

  if (opts.further && decisiveMandate(mandates)?.verdict !== "qualifiziert") {
    step("Suche weitere Mandate");
    const leads = await furtherMandates(query.person, input?.company.name ?? query.company, ctx);
    const checked = new Set(mandates.map((m) => m.company.uid));
    for (const lead of leads.slice(0, MAX_FURTHER * 2)) {
      if (mandates.length > MAX_FURTHER) break;
      const firm = lead.uid
        ? (await searchFirms(lead.uid, { activeOnly: false, maxEntries: 1 }))[0]
        : (await findCandidates(lead.company, "")).find((f) => scoreFirm(lead.company, "", f) >= 3);
      if (!firm || checked.has(firm.uidFormatted)) continue;
      checked.add(firm.uidFormatted);
      step(`Weiteres Mandat prüfen: ${firm.name}`);
      const m = await registerMandate(query.person, firm, "further", ctx, step);
      if (!m.person_in_register) continue; // only a lead - not confirmed by the register
      await addProfile(m, opts, ctx, step);
      mandates.push(assessMandate(m));
      if (mandates.at(-1)?.verdict === "qualifiziert") break;
    }
  }

  const decisive = decisiveMandate(mandates);
  const verdict = personVerdict(decisive, opts.mode);
  cost.duration_ms = Date.now() - started;
  const assessment: Assessment = {
    query,
    mode: opts.mode,
    verdict,
    summary: summarize(verdict, decisive),
    uncertain: uncertainties(decisive),
    decisive,
    mandates,
    cost: priceCost(cost),
  };
  emit({ type: "assessment", assessment });
  return assessment;
}

function summarize(verdict: string, m: MandateAssessment | null): string {
  if (!m) return `${verdict}: kein Mandat ermittelbar`;
  const open = Object.entries(m.criteria)
    .filter(([, c]) => c.status !== "erfüllt")
    .map(([k, c]) => `${k.slice(0, 2).toUpperCase()} ${c.status}: ${c.reason}`);
  return `${verdict} (${m.company.name})${open.length ? " - " + open.join("; ") : ""}`;
}
