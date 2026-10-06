# Optimierungslog SwissVR-Eignungsprüfung

Jeder Eval-Durchlauf mit Kennzahlen, und was davor am System geändert wurde.
Neuester Eintrag zuoberst. Personennamen stehen bewusst nicht hier (das Repo ist
öffentlich), nur Firmen; die Details pro Person liegen in den Ergebnis-CSVs in
`eval/` (git-ignoriert).

**Testset:** `eval/261002 SwissVR | Testset.xlsx`, 35 Personen (davon 5 mit
erfundenen Firmen). Das Testset wurde zweimal korrigiert; Kennzahlen sind nur
innerhalb derselben Testset-Version direkt vergleichbar.

| Version | Stand | Änderung |
|---|---|---|
| T1 | Original (Export 15:34) | – |
| T2 | 16:13 | 4 Labels korrigiert: Ariatherm K3 → Ja, X-TEC SWISS K1 → Nein, Esperanto MidCo K3 → Ja, FC Luzern K1 → Ja |
| T3 | 17:27 | Esperanto MidCo K3 zurück auf «unbekannt» (Zelle F22) |

**Kennzahlen** (`pnpm cli metrics`), Ziele in Klammern:

- **Falsch-sicher-Rate** (≤ 1 %): sicher entschieden und widerspricht dem eindeutigen Testset
- **Automatisierungsquote** (≥ 70 %): ohne unsichere Quelle entschieden, keine manuelle Prüfung nötig
- **Übereinstimmung Testset**: gleich entschieden, oder beide offen
- **Stabilität** (≥ 95 %): gleiche Empfehlung in allen Läufen

Frühe Läufe (bis Lauf 5) wurden noch mit der Treffer-Metrik pro Kriterium gemessen;
die vier Kennzahlen gibt es erst ab Lauf 6.

**Kosten** sind Modell + Firecrawl für alle 35 Personen eines Laufs. **Dauer** ist die
mittlere Laufzeit einer einzelnen Prüfung (Start bis Ergebnis); die Läufe liefen mit
4–6 Prüfungen parallel.

## Übersicht

| Lauf | Änderung | Testset | Falsch-sicher | Automatisierung | Übereinstimmung | Stabilität | Kosten / Lauf | Ø Dauer / Person |
|---|---|---|---|---|---|---|---|---|
| V1 | **Fremdmessung**: swissVR-frontend (Mandats-Monitor), unverändert | T3 | 0 % | 29–34 % | 51–57 % | 91 % | nicht erfasst | 32.4–38.4 s |
| 10 | strengerer Domain-Abgleich (offline) | T3 | 0 % | 46–49 % | 57–60 % | 91 % | wie Lauf 9 | wie Lauf 9 |
| 9 | feste Mitarbeitendensuche | T3 | 0 % | 49–51 % | 54–57 % | 91 % | $1.90–2.22 | 14.6–15.7 s |
| 8 | Sicherheit aus URL, LinkedIn/jobs.ch sicher | T2 | 0 % | 26–34 % | 46–54 % | 71 % | $1.77–1.99 | 15.7–16.5 s |
| 7 | LinkedIn-Regel über KI-Einordnung | T2 | 0 % | 9 % | – | – | $1.79 | 15.6 s |
| 6 | erste Kennzahlen-Messung | T2 | 0 % | 6–20 % | – | 71 % | $1.77–2.12 | 18.5–20.1 s |
| 5 | Firmensuche breite Namen (nur Abweichungen) | T2 | – | – | – | – | $0.98 (14 Prüfungen) | 19–21 s |
| 4 | Quellen im Export | T1 | – | – | – | – | $2.04 | 16.9 s |
| 3 | Unsicherheit statt Fehler | T1 | – | – | – | – | $2.06 | 17.3 s |
| 2 | Rollen, Firmenwahl, Web-Fallback | T1 | – | – | – | – | $1.92 | 17.7 s |
| 1 | erste Pipeline | T1 | – | – | – | – | $1.56 | 18.3 s |

---

## Messung V1 · 2026-10-02 · Fremdmessung swissVR-frontend (Mandats-Monitor) · Testset T3

**Anlass:** Der Mandats-Monitor (`muehlemann-popp/swissVR-frontend`, Commit 5b74b99)
war noch nie gegen ein Goldset gemessen worden. Diese Messung stellt ihn unverändert
neben das bestehende System, auf demselben Testset und mit denselben Kennzahlen.

**Änderung:** keine. Der Algorithmus wurde nicht angefasst; gemessen wurde der Stand
wie er ist.

**Aufbau:** Ein Harness ruft `lookupEligibility` direkt auf, ein gemeinsames
`CompanyMemo` und `WebHealth` je Lauf (wie ein Batch in Produktion), zwischen den
Läufen kein Cache. Lauf 1 mit drei parallelen Prüfungen, Lauf 2 seriell. Quellen:
Zefix, SHAB, UID-Register, swisstopo, Firecrawl, Anthropic.

| Kennzahl | Messung V1a | Messung V1b |
|---|---|---|
| Falsch-sicher-Rate | 0 % (0/25) | 0 % (0/25) |
| Automatisierungsquote | 34.3 % | 28.6 % |
| Präzision sichere Entscheide | 100 % (11/11) | 100 % (9/9) |
| Übereinstimmung Testset | 57.1 % | 51.4 % |
| Stabilität | 91.4 % (32/35) über 2 Läufe | |
| Kosten / Ø Dauer | nicht erfasst (kein Kosten-Tracking im System) · Ø 38.4 s | Ø 32.4 s |

Dateien: `eval/swissvr-frontend-run1.csv`, `-run2.csv`,
`eval/261002 SwissVR | Eval-Auswertung swissVR-frontend.html`.

**Befund:** Null falsch-sichere Entscheide, aber nur rund ein Drittel
Automatisierungsquote — das System verweigert deutlich häufiger als das bestehende
(46–49 % in Lauf 10). Der Hebel liegt bei K1: das Mandat wird in 22 von 35 Fällen
entschieden, dabei ohne einen einzigen Fehler. K2 und K4 ebenfalls 27/35 bei null
Fehlern. Das Amtsblatt-Replay ist belastbar, deckt aber weniger ab als eine
Registerrecherche durch einen Agenten.

Beide inhaltlich falschen Antworten (Steinbock Apotheke: Spanne 10–50 der eigenen
Website gegen manuell gezählte 9; Gruyère Hydrogen Power: 300 bzw. 100 Mitarbeitende
von der Seite des Mutterkonzerns) stützten sich auf ein **web-bestätigtes** VR-Mandat
und zählen deshalb als unsicher — die Sicherheitsdefinition hat sie korrekt
abgefangen. Dem System fehlt allerdings der Begriff `group_figure`: die Konzernzahl
wurde ohne Vorbehalt übernommen.

Die fünf erfundenen Firmen wurden in beiden Läufen sauber nicht gefunden
(`zefix=none`, keine UID, alle «nicht beurteilbar»). Keine Halluzination.

Firmensuche: 27 von 35 in Zefix gefunden, davon fünf korrekt nicht (erfundene).
Drei echte Nicht-Treffer (BGB Immobiliendienste, Swiss Dental Solutions Group,
MultiConcept Fund Management) und zwei Falschtreffer auf Schwestergesellschaften
(«Allianz Suisse» → Allianz Suisse Immobilien AG statt Lebensversicherungs-
Gesellschaft; «LLB» → LLB Holding AG statt Liechtensteinische Landesbank). Beide
Falschtreffer endeten bei «nicht beurteilbar», nicht bei einer Falschablehnung.

**Testset-Version:** Die Läufe wurden um 16:55 mit den damaligen Labels extrahiert;
das Testset wurde um 17:30 auf T3 korrigiert (Esperanto MidCo und MultiConcept je
K3 von «Ja» auf «unbekannt»). Die Soll-Spalten wurden nachträglich gegen T3 neu
erzeugt — die `ist`-Werte sind davon unberührt. Alle Zahlen hier sind T3.

**Abweichungen vom Messprotokoll** (bewusst, zu beachten beim Vergleich):

- **Zwei statt drei Läufe** — der dritte wurde auf Wunsch abgebrochen. Die Stabilität
  ist damit über zwei Läufe gerechnet und nicht direkt mit 91 % über drei vergleichbar.
- **Keine Kosten erfasst** — das System führt kein Kosten-Tracking. Die Dauer ist
  erfasst, liegt aber mit Ø 32–38 s pro Person deutlich über den 14.6–15.7 s des
  bestehenden Systems (andere Parallelität, nicht direkt vergleichbar).
- **`_sicher`, `_begruendung` und `_quelle` sind abgeleitet**, nicht vom System
  geliefert: K1 sicher bei `confirmedBy ∈ {zefix, shab}`, K2 sicher sobald ein
  Rechtsform-Code vorliegt (alle drei Quellen sind Register), K4 sicher bei
  `confirmedBy ∈ {uid-register, swisstopo, zefix}`, K3 sicher bei eigener Quelle nach
  derselben Regel wie `isOwnSource`. Für K1/K2/K4 wurde keine URL erfasst, die Spalte
  bleibt leer statt eine zu erfinden.

**Offen zum Kontrollieren** («System sicher, Testset offen»): F.G. Pfister Holding
(150 von der eigenen Website; Testset ohne K3-Wert).

**Zur Testset-Prüfung vorgelegt, nicht selbst entschieden:** Steinbock Apotheke —
die eigene Website führt eine Spanne «10–50», die manuelle Prüfung zählte 9. Nach
Abschnitt 3 gilt eine Spanne auf der eigenen Website als sichere Quelle; das Label
«nein» und diese Quelle widersprechen sich. Silvan entscheidet.

---

## Lauf 10 · 2026-10-02 · strengerer Abgleich «eigene Website» · Testset T3

**Anlass:** In Lauf 9 galt bei Esperanto MidCo AG eine Teamseite von
midcoglobal.com (eine andere Firma) als eigene Website, weil ein einziges Wort
des Namens («midco») genügte. Das Testset sagt dort «unbekannt», sonst wäre es ein
falsch-sicherer Entscheid gewesen.

**Änderung** (`isOwnSource` in `src/lib/swissvr/match.ts`): Die Domain bzw. der
LinkedIn-/jobs.ch-Slug muss das erste prägende Wort des Namens enthalten (mind.
5 Zeichen), oder bei zwei prägenden Wörtern beide, bei drei und mehr alle bis auf
eines. FC Luzern-Innerschweiz (`linkedin.com/company/fc-luzern`) bleibt eigene
Quelle, midcoglobal.com für Esperanto MidCo nicht mehr.

**Ergebnis:** offline nachgerechnet auf den Läufen 9a–c, ohne neue Recherche
(nur betroffene K3-Quellen herabgestuft: Esperanto MidCo, BGB Baselland).
Dateien: `eval/v4b-run1..3.csv`.

| Kennzahl | Lauf 10a | Lauf 10b | Lauf 10c |
|---|---|---|---|
| Falsch-sicher-Rate | 0 % (0/25) | 0 % (0/25) | 0 % (0/25) |
| Automatisierungsquote | 48.6 % | 45.7 % | 48.6 % |
| Übereinstimmung Testset | 60.0 % | 57.1 % | 60.0 % |
| Stabilität | 91.4 % (32/35) | | |
| Kosten / Ø Dauer | keine neuen Kosten (offline), Recherche wie Lauf 9 | | |

Offen zum Kontrollieren («System sicher, Testset offen»): BSV Bern (jobs.ch 51–100;
Testset ohne K3-Wert), F.G. Pfister Holding (Teamseite 12–16; Testset ohne
K3-Wert), LEX Trust (Teamseite 10).

---

## Lauf 9 · 2026-10-02 · feste Suche nach den Mitarbeitenden · Testset T3

**Änderung:** Die Mitarbeitendenzahl wird nicht mehr von einem frei suchenden Agenten
ermittelt, sondern nach festem Plan (`src/lib/swissvr/headcount.ts`): drei Suchen
(LinkedIn, jobs.ch, Website), Spannen per Regel aus den Snippets, eigene Website mit
Team-/Über-uns-Seiten, Namen im Code gezählt, feste Priorität (genannte Zahl auf der
eigenen Website > LinkedIn-/jobs.ch-Spanne > Teamseite). Der freie Agent läuft nur
noch, wenn dieser Plan nichts findet.

**Stichprobe vorab:** Durena AG 21–50 (jobs.ch), TiT Imhof 101–250 (jobs.ch),
Riviera Finance 11 (Teamseite, vorher 10 gezählt), eine kleine PR-Agentur 2 (Teamseite).

| Kennzahl | Lauf 9a | Lauf 9b | Lauf 9c |
|---|---|---|---|
| Falsch-sicher-Rate | 0 % (0/25) | 0 % (0/25) | 0 % (0/25) |
| Automatisierungsquote | 51.4 % | 48.6 % | 51.4 % |
| Übereinstimmung Testset | 57.1 % | 54.3 % | 57.1 % |
| Stabilität | 91.4 % (32/35) | | |
| Kosten | $2.04 | $2.22 | $1.90 |
| Ø Kosten / Person | $0.058 | $0.063 | $0.054 |
| Ø Dauer / Person | 15.7 s | 15.4 s | 14.6 s |

**Befund:** Gegenüber Lauf 8 Automatisierung von 26–34 % auf 49–51 % und
Stabilität von 71 % auf 91 %. Unsicherheits-Markierungen bei K3 von 42 auf 20
(über 3 Läufe). Noch schwankend: Allianz Suisse (Firmenwahl), TiT Imhof (K3),
ZüriGlow (erfundene Firma, K2). Ein Fehler im Domain-Abgleich (Esperanto MidCo,
siehe Lauf 10). Dateien: `eval/v4-run1..3.csv`.

---

## Lauf 8 · 2026-10-02 · Sicherheit aus der Quellen-URL, LinkedIn und jobs.ch sicher · Testset T2

**Änderungen:**
- Entscheid SwissVR: LinkedIn-Spannen («11–50») und Spannen im eigenen jobs.ch-/jobup.ch-Profil gelten als sicher.
- Ob eine Mitarbeitendenzahl sicher ist, entscheidet der Code anhand der URL
  (eigene Website / eigenes LinkedIn- oder jobs.ch-Profil), nicht mehr die
  Selbsteinordnung der KI. Diese hatte selbst Zahlen von der eigenen Website als
  unsicher markiert.
- Teamseite der eigenen Website gilt als sicher, sobald sie ≥ 10 Personen zeigt.

| Kennzahl | Lauf 8a | Lauf 8b | Lauf 8c |
|---|---|---|---|
| Falsch-sicher-Rate | 0 % (0/25) | 0 % (0/25) | 0 % (0/26) |
| Automatisierungsquote | 34.3 % | 28.6 % | 25.7 % |
| Übereinstimmung Testset | 57.1 % | 51.4 % | 45.7 % |
| Stabilität | 71.4 % (25/35) | | |
| Kosten | $1.99 | $1.77 | $1.79 |
| Ø Kosten / Person | $0.057 | $0.051 | $0.051 |
| Ø Dauer / Person | 16.5 s | 16.1 s | 15.7 s |

**Befund:** Automatisierung etwa verdoppelt, ohne neue Fehler. Stabilität
unverändert: 9 von 10 schwankenden Fällen schwanken nur bei K3 (Zahl einmal
gefunden, einmal nicht). Dateien: `eval/v3-run1..3.csv`.

## Lauf 7 · 2026-10-02 · LinkedIn-Regel über die KI-Einordnung · Testset T2

**Änderung:** Quellenart «linkedin» als sicher (Einordnung durch die KI).

**Ergebnis:** Automatisierungsquote 8.6 % (1 Lauf), $1.79, Ø 15.6 s pro Person. Kaum Wirkung, weil die KI ihre
Quellen uneinheitlich einordnete. Führte zu Lauf 8. Ergebnisdatei verworfen.

## Lauf 6 · 2026-10-02 · erste Messung der Kennzahlen · Testset T2

Keine Codeänderung gegenüber Lauf 5, drei unabhängige Läufe für die Stabilität.

| Kennzahl | Lauf 6a | Lauf 6b | Lauf 6c |
|---|---|---|---|
| Falsch-sicher-Rate | 0 % (0/25) | 0 % (0/25) | 0 % (0/26) |
| Automatisierungsquote | 5.7 % | 20.0 % | 17.1 % |
| Stabilität | 71.4 % (25/35) | | |
| Kosten | $1.91 | $2.12 | $1.77 |
| Ø Kosten / Person | $0.055 | $0.061 | $0.051 |
| Ø Dauer / Person | 18.9 s | 20.1 s | 18.5 s |

**Befund:** Das System irrt nie sicher, entscheidet aber kaum sicher. Ursache fast
ausschliesslich K3: 42 von 61 Unsicherheits-Markierungen, 9 von 10 Schwankungen.
Dateien: `eval/stab-run1..3.csv`.

## Lauf 5 · 2026-10-02 · Firmensuche für breite Namen · Testset T2

**Änderung:** Zefix liefert Treffer alphabetisch und nur so viele wie angefordert;
für «Allianz Suisse» (177 Treffer) fehlte die Versicherung in den ersten 30. Jetzt
bis 500 Treffer, und Rechtsformen mit Verwaltungsrat (AG, Genossenschaft, Anstalt)
werden höher bewertet als Einzelunternehmen (Generalagenturen).

Nachprüfung nur der abweichenden Fälle (`eval --rerun`): K1 34/35, K2 35/35,
K3 29/33, K4 34/35, Empfehlung 30/33. Kosten: 9 Prüfungen $0.67 (Ø 19.0 s), danach
5 Prüfungen $0.31 (Ø 20.5 s). Datei: `eval/result-03-rerun.csv`.
(`result-02-rerun.csv` ist wegen eines Fehlers in `--rerun` mit gemischten
Testset-Versionen entstanden und nicht verwertbar.)

## Lauf 4 · 2026-10-02 · Quellen im Export · Testset T1

**Änderung:** `eval -o` schreibt pro Kriterium die Quellen-URL.

K1 32/35, K2 34/35, K3 26/33, K4 33/35, Empfehlung 27/33, falsch und sicher: 2
(FC Luzern laut Register aktiv; Ariatherm 24 MA auf der Website, Testset ohne
Angabe; beide später im Testset korrigiert). $2.04, Ø 16.9 s pro Person. Datei: `eval/result-01-full.csv`.

## Lauf 3 · 2026-10-02 · Unsicherheit statt falscher Angaben · Testset T1

**Änderungen:**
- Jedes Kriterium trägt eine Sicherheitsangabe; schwache Quellen werden mit ⚠ markiert.
- Fehlt eine Person im Register der gefundenen Firma, ist K1 «nicht ermittelbar» statt «nicht erfüllt».

K1 32/35, K2 34/35, K3 25/33, K4 32/35, Empfehlung 26/33, falsch und sicher: 3. $2.06, Ø 17.3 s pro Person.

## Lauf 2 · 2026-10-02 · Rollen und Firmenwahl · Testset T1

**Änderungen:**
- Waadt/Genf: Rollenkürzel «adm.» wird als Verwaltungsrat erkannt.
- Bei mehreren ähnlichen Firmen: weniger Zusatzwörter im Namen bevorzugt.
- Person nicht im Register der gefundenen Firma: Web-Recherche nach einer verwandten Gesellschaft.
- Mitarbeitenden-Prompt mit fester Quellenliste (LinkedIn, Website, Geschäftsbericht).

K1 32/35, K2 34/35, K3 23/33, K4 33/35, Empfehlung 22/33. $1.92, Ø 17.7 s pro Person.

## Lauf 1 · 2026-10-02 · erste Pipeline · Testset T1

Zefix → kantonaler Registerauszug → Personenabgleich → Mitarbeitende per Agent → Regeln.

K1 27/35, K2 34/35, K3 21/33, K4 34/35, Empfehlung 18/33. $1.56, Ø 18 s pro Person.

---
Erstellt mit Unterstützung von KI.
Zuletzt aktualisiert: 2026-10-02 · Commit: 4b86cf4 (+ uncommittet: feste Mitarbeitendensuche, strengerer Domain-Abgleich)
