import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEmployees } from "../employees";
import { classifyRole, isOwnSource, matchName, residenceCountry } from "./match";
import { parseChregisterPersons } from "./register";
import { assessMandate, decisiveMandate, personVerdict, uncertainties } from "./rules";
import { nameVariants, parseQuery, scoreFirm } from "./assess";
import { firmDiffers } from "./report";
import { parseBracket, teamLinks } from "./headcount";
import type { MandateFacts } from "./types";

/** A qualifying mandate; each test changes one fact. */
function mandate(patch: Partial<MandateFacts> = {}, company: Partial<MandateFacts["company"]> = {}): MandateFacts {
  return {
    company: {
      name: "Beispiel AG",
      uid: "CHE-123.456.789",
      legal_form_id: 3,
      legal_form: "Aktiengesellschaft",
      purpose: "",
      seat: "Zürich",
      seat_country: "CH",
      active: true,
      sector: "keiner",
      employees: makeEmployees(50, 50),
      employees_checked: true,
      employees_certain: true,
      from_register: true,
      register_source: "https://zh.chregister.ch/x",
      sources: [],
      ...company,
    },
    person_in_register: { name: "Muster, Hans", residence: "Bern", role: "member of the board", signing: "", active: true },
    role: "verwaltungsrat",
    role_text: "member of the board",
    active: true,
    verification: "register",
    checked_absent: false,
    residence: "Bern",
    residence_country: "CH",
    identity_unclear: false,
    origin: "input",
    notes: [],
    ...patch,
  };
}

const statuses = (m: MandateFacts) => Object.values(assessMandate(m).criteria).map((c) => c.status);

test("all four criteria met -> qualifiziert", () => {
  assert.equal(assessMandate(mandate()).verdict, "qualifiziert");
});

test("K1: inactive mandate, absent person, self-declaration, unclear identity", () => {
  assert.equal(assessMandate(mandate({ active: false })).criteria.k1_mandat.status, "nicht erfüllt");
  // Absence from the register of the company found is no proof - the mandate may be at a related entity.
  assert.equal(
    assessMandate(mandate({ person_in_register: null, role: null, checked_absent: true, verification: "none" })).criteria.k1_mandat.status,
    "nicht ermittelbar",
  );
  assert.equal(assessMandate(mandate({ verification: "self_declared" })).criteria.k1_mandat.status, "nicht ermittelbar");
  assert.equal(assessMandate(mandate({ identity_unclear: true })).criteria.k1_mandat.status, "nicht ermittelbar");
  assert.equal(assessMandate(mandate({ role: "geschaeftsleitung", role_text: "CEO" })).criteria.k1_mandat.status, "nicht erfüllt");
  assert.equal(assessMandate(mandate({ verification: "register_mirror" })).criteria.k1_mandat.status, "erfüllt");
});

test("K2: qualifying forms, GmbH excluded, sector exception, unknown", () => {
  for (const id of [3, 5, 8, 12]) assert.equal(assessMandate(mandate({}, { legal_form_id: id })).criteria.k2_rechtsform.status, "erfüllt");
  assert.equal(assessMandate(mandate({ role: "geschaeftsfuehrer" }, { legal_form_id: 4, legal_form: "GmbH" })).verdict, "qualifiziert nicht");
  // A board seat in an exception sector qualifies regardless of the legal form ...
  assert.equal(assessMandate(mandate({}, { legal_form_id: 13, legal_form: "Besondere Rechtsform", sector: "bank" })).criteria.k2_rechtsform.status, "erfüllt");
  // ... but not if it is no board seat
  assert.equal(
    assessMandate(mandate({ role: "geschaeftsleitung" }, { legal_form_id: 13, sector: "bank" })).criteria.k2_rechtsform.status,
    "nicht erfüllt",
  );
  assert.equal(assessMandate(mandate({}, { legal_form_id: 0 })).criteria.k2_rechtsform.status, "nicht ermittelbar");
});

test("exclusions beat sector exceptions", () => {
  // Foundation board of a hospital foundation
  const m = mandate({ role: "stiftungsrat" }, { legal_form_id: 7, legal_form: "Stiftung", sector: "spital" });
  assert.equal(assessMandate(m).verdict, "qualifiziert nicht");
  // Pension fund organised as a cooperative
  assert.equal(assessMandate(mandate({}, { legal_form_id: 5, sector: "pensionskasse" })).verdict, "qualifiziert nicht");
  assert.equal(assessMandate(mandate({ role: "vereinsvorstand" }, { legal_form_id: 6 })).verdict, "qualifiziert nicht");
});

test("K3 thresholds, ranges and FTE", () => {
  const k3 = (e: ReturnType<typeof makeEmployees>) => assessMandate(mandate({}, { employees: e })).criteria.k3_mitarbeitende.status;
  assert.equal(k3(makeEmployees(10, 10)), "erfüllt");
  assert.equal(k3(makeEmployees(9, 9)), "nicht erfüllt");
  assert.equal(k3(makeEmployees(11, 50)), "erfüllt");
  assert.equal(k3(makeEmployees(2, 5)), "nicht erfüllt");
  assert.equal(k3(makeEmployees(1, 10)), "nicht ermittelbar");
  assert.equal(k3(makeEmployees(8, 8, { fte: true })), "nicht ermittelbar");
  assert.equal(k3(makeEmployees(12, 12, { fte: true })), "erfüllt");
  assert.equal(k3(null), "nicht ermittelbar");
  assert.equal(assessMandate(mandate({}, { employees: null, employees_checked: false })).criteria.k3_mitarbeitende.status, "nicht ermittelbar");
});

test("K4: residence OR seat in Switzerland", () => {
  assert.equal(assessMandate(mandate({ residence_country: "abroad" })).criteria.k4_sitz.status, "erfüllt");
  assert.equal(assessMandate(mandate({ residence_country: "CH" }, { seat_country: "abroad" })).criteria.k4_sitz.status, "erfüllt");
  assert.equal(assessMandate(mandate({ residence_country: "abroad" }, { seat_country: "abroad" })).criteria.k4_sitz.status, "nicht erfüllt");
  assert.equal(assessMandate(mandate({ residence_country: null }, { seat_country: null })).criteria.k4_sitz.status, "nicht ermittelbar");
});

test("precedence: nicht erfüllt beats nicht ermittelbar", () => {
  const m = mandate({ identity_unclear: true }, { employees: makeEmployees(3, 3) });
  assert.deepEqual(statuses(m).sort(), ["erfüllt", "erfüllt", "nicht ermittelbar", "nicht erfüllt"].sort());
  assert.equal(assessMandate(m).verdict, "qualifiziert nicht");
  assert.equal(assessMandate(mandate({}, { employees: null })).verdict, "nicht beurteilbar");
});

test("best mandate decides, label depends on mode", () => {
  const fails = assessMandate(mandate({ active: false }));
  const ok = assessMandate(mandate({ origin: "further" }));
  assert.equal(decisiveMandate([fails, ok])?.verdict, "qualifiziert");
  assert.equal(personVerdict(fails, "bestand"), "nicht mehr qualifiziert");
  assert.equal(personVerdict(fails, "neuaufnahme"), "qualifiziert nicht");
  assert.equal(personVerdict(null, "bestand"), "nicht beurteilbar");
});

test("name matching", () => {
  assert.equal(matchName("Silvan Muehlemann", "Mühlemann, Silvan"), "exact");
  assert.equal(matchName("Marc Challandes", "Challandes, Marc Oliver"), "exact");
  assert.equal(matchName("Anna M. Beispiel", "Beispiel, Anna"), "exact");
  assert.equal(matchName("Gerard Jenni", "Jenni, Gérard"), "exact");
  assert.equal(matchName("M. Popp", "Popp, Markus"), "partial");
  assert.equal(matchName("Anna Popp", "Popp, Markus"), "none");
  assert.equal(matchName("Hans Muster", "Meier, Hans"), "none");
});

test("role classification depends on legal form", () => {
  assert.equal(classifyRole("member of the board", 3), "verwaltungsrat");
  assert.equal(classifyRole("Präsident des Verwaltungsrates", 3), "verwaltungsrat");
  assert.equal(classifyRole("member of the board", 7), "stiftungsrat");
  assert.equal(classifyRole("member of the board", 6), "vereinsvorstand");
  assert.equal(classifyRole("member of the management board", 3), "geschaeftsleitung");
  assert.equal(classifyRole("managing director", 4), "geschaeftsfuehrer");
  assert.equal(classifyRole("partner", 4), "gesellschafter");
  assert.equal(classifyRole("Mitglied der Verwaltung", 5), "verwaltungsrat");
  assert.equal(classifyRole("Mitglied des Bankrates", 8), "aufsichtsgremium");
  assert.equal(classifyRole("", 3), "zeichnungsberechtigt");
  assert.equal(classifyRole("Revisionsstelle", 3), "revisionsstelle");
});

test("residence country", () => {
  assert.equal(residenceCountry("Wetzikon (ZH)"), "CH");
  assert.equal(residenceCountry("Weiningen ZH"), "CH");
  assert.equal(residenceCountry("Zürich"), "CH");
  assert.equal(residenceCountry("München (DE)"), "abroad");
  assert.equal(residenceCountry(""), null);
});

test("chregister person table", () => {
  const md = `
| Ent | Mo | Ca | Personal details | Role | Signing authority |
| --- | --- | --- | --- | --- | --- |
| 1 |  | 8m | cancelled: Mühlemann, Silvan, von Bönigen, in Weiningen ZH | member of the board | joint signing authority (any two to sign) |
| 7 |  |  | Schiesser, Werner, von Glarus Süd, in Adliswil | chairperson of the board | joint signing authority (any two to sign) |
|  | 8 |  | Mühlemann, Silvan, von Bönigen, in Zürich | member of the board | joint signing authority (any two to sign) |
| 13 |  |  | Hagmann, Christian, von Sevelen, in Wetzikon (ZH) |  | joint signing authority (any two to sign) |

This commercial register information ...`;
  const persons = parseChregisterPersons(md);
  assert.equal(persons.length, 4);
  assert.deepEqual(persons[0], {
    name: "Mühlemann, Silvan",
    residence: "Weiningen ZH",
    role: "member of the board",
    signing: "joint signing authority (any two to sign)",
    active: false,
  });
  assert.equal(persons[2].active, true);
  assert.equal(persons[2].residence, "Zürich");
  assert.equal(persons[3].role, "");
});

test("query parsing and company scoring", () => {
  assert.deepEqual(parseQuery("Hans Muster, Beispiel AG, Menzingen (ZG)"), { person: "Hans Muster", company: "Beispiel AG", town: "Menzingen" });
  assert.ok(nameVariants("Muehlemann AG").includes("Mühlemann AG"));
  const firm = { name: "mühlemann+popp AG", legalSeat: "Zürich", status: "EXISTIEREND", legalFormId: 3 };
  assert.ok(scoreFirm("Muehlemann + Popp AG", "Zürich", firm) >= 3);
  assert.equal(scoreFirm("BioMatter Schweiz", "", { name: "BioMatter AG", legalSeat: "Basel", status: "EXISTIEREND", legalFormId: 3 }), 0);
  // The insurer beats its agencies (sole proprietorships cannot have a board).
  const insurer = { name: "Allianz Suisse Versicherungs-Gesellschaft AG", legalSeat: "Wallisellen", status: "EXISTIEREND", legalFormId: 3 };
  const agency = { name: "Allianz Suisse agence générale Daniel Eltschinger", legalSeat: "Granges-Paccot", status: "EXISTIEREND", legalFormId: 1 };
  assert.ok(scoreFirm("Allianz Suisse", "", insurer) > scoreFirm("Allianz Suisse", "", agency));
});

test("weak sources are flagged, not hidden", () => {
  const weak = assessMandate(mandate({}, { employees_certain: false }));
  assert.equal(weak.verdict, "qualifiziert");
  assert.equal(weak.criteria.k3_mitarbeitende.certain, false);
  assert.deepEqual(uncertainties(weak).map((u) => u.slice(0, 2)), ["K3"]);
  const mirror = assessMandate(mandate({ verification: "register_mirror" }));
  assert.equal(mirror.criteria.k1_mandat.certain, false);
  const web = assessMandate(mandate({}, { from_register: false }));
  assert.equal(web.criteria.k2_rechtsform.certain, false);
  assert.deepEqual(uncertainties(assessMandate(mandate())), []);
});

test("own website / own LinkedIn page decided from the URL", () => {
  assert.equal(isOwnSource("https://www.ariatherm.ch/uber-uns", "ARIATHERM AG"), "website");
  assert.equal(isOwnSource("https://www.rivierafinance.ch/", "Riviera Finance SA"), "website");
  assert.equal(isOwnSource("https://lextrust.ch/team", "LEX TRUST SA"), "website");
  assert.equal(isOwnSource("https://ch.linkedin.com/company/emil-egger-ag", "Emil Egger AG"), "linkedin");
  assert.equal(isOwnSource("https://ch.linkedin.com/company/bsi-software", "Esperanto MidCo AG"), null);
  assert.equal(isOwnSource("https://www.jobs.ch/de/firmen/83703-luegeten-ag/", "Luegeten AG"), "jobportal");
  assert.equal(
    isOwnSource("https://www.jobs.ch/de/firmen/2f037658-0cc3-4faa-9ca2-d777b5cec22e-durena-ag/", "Durena AG"),
    "jobportal",
  );
  assert.equal(isOwnSource("https://www.jobs.ch/de/firmen/83703-luegeten-ag/", "Nungesser AG"), null);
  assert.equal(isOwnSource("https://waisch.ch/firma/prologistik-schweiz-ag-zuerich", "proLogistik Schweiz AG"), null);
  assert.equal(isOwnSource("https://de.wikipedia.org/wiki/X", "X-TEC SWISS Holding AG"), null);
  assert.equal(isOwnSource("https://www.swissinfo.ch/x", "X-TEC SWISS Holding AG"), null);
  // One shared word is not enough
  assert.equal(isOwnSource("https://midcoglobal.com/about-us/our-team/", "Esperanto MidCo AG"), null);
  assert.equal(isOwnSource("https://www.fgpfister.ch/ueber-uns", "F.G. Pfister Holding AG"), "website");
  assert.equal(isOwnSource("https://www.tit-imhof.ch/ueber-uns/team/", "TIT Imhof Holding AG"), "website");
  assert.equal(isOwnSource("https://www.swissdentalsolutions.com/", "Swiss Dental Solutions (SDS) Group AG"), "website");
  assert.equal(isOwnSource("https://www.oxygenatwork.ch/", "Oxygen at Work AG"), "website");
  assert.equal(isOwnSource("https://ch.linkedin.com/company/fc-luzern", "FC Luzern-Innerschweiz AG"), "linkedin");
});

test("report flags a different company, not an abbreviation", () => {
  assert.equal(firmDiffers("Swiss Dental Solutions (SDS) Group AG", "SDS Group AG"), false);
  assert.equal(firmDiffers("LLB", "Liechtensteinische Landesbank Aktiengesellschaft"), false);
  assert.equal(firmDiffers("TiT Imhof AG", "TIT Imhof Holding AG"), false);
  assert.equal(firmDiffers("Dataphone AG", "proLogistik Schweiz AG"), true);
  assert.equal(firmDiffers("BGB Immobiliendienste", "Bürgschaftsgenossenschaft Baselland (BGB)"), true);
});

test("headcount brackets from search snippets", () => {
  assert.deepEqual(parseBracket("Durena AG | LinkedIn ... Unternehmensgrösse 11-50 Beschäftigte"), { min: 11, max: 50 });
  assert.deepEqual(parseBracket("Company size: 1'001–5'000 employees"), { min: 1001, max: 5000 });
  assert.deepEqual(parseBracket("21 - 50 Mitarbeitende · Zürich"), { min: 21, max: 50 });
  assert.deepEqual(parseBracket("10,001+ employees"), { min: 10001, max: null });
  assert.equal(parseBracket("Gegründet 2011, 3 Standorte"), null);
});

test("team and about links from the home page", () => {
  const md = "[Home](/) [Über uns](/ueber-uns/) [Unser Team](https://www.durena.ch/Team.htm) [Shop](https://shop.example.com/team) [Kontakt](/kontakt)";
  assert.deepEqual(teamLinks(md, "https://www.durena.ch/"), ["https://www.durena.ch/Team.htm", "https://www.durena.ch/ueber-uns/"]);
});
