"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, ResolveResult } from "@/lib/agent";
import { MODEL_PRICING, MODELS, type Cost, type ModelId } from "@/lib/cost";
import { formatEmployees } from "@/lib/employees";
import { readNdjson } from "@/lib/ndjson";

/**
 * /demo - a 16:9 stage for recording a video: Jev and Sonnet 5 resolve the same
 * company side by side, with live stopwatches, cost counters and status lines.
 * All sizes are in cqw (percent of the stage width), so it scales to any window.
 *
 * ?company=...&autostart=1 starts a run without a visible click.
 */

const LANES = ["jev-latest", "claude-sonnet-5"] as const satisfies readonly ModelId[];
type LaneModel = (typeof LANES)[number];

const DEFAULT_COMPANY = "Muehlemann und Pop";

type StepKind = "search" | "scrape" | "jev";
type Status = { id: number; text: string; detail?: string; tone?: "error" | "done" };
type Lane = {
  status: "idle" | "running" | "done" | "error";
  line: Status | null;
  steps: { id: number; kind: StepKind }[];
  cost: Cost | null;
  result: ResolveResult | null;
  finishedAt: number | null;
};

const idleLane = (): Lane => ({
  status: "idle",
  line: null,
  steps: [],
  cost: null,
  result: null,
  finishedAt: null,
});

let seq = 0;

export default function Demo() {
  const [company, setCompany] = useState(DEFAULT_COMPANY);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [lanes, setLanes] = useState<Record<LaneModel, Lane>>({
    "jev-latest": idleLane(),
    "claude-sonnet-5": idleLane(),
  });
  const abort = useRef<AbortController | null>(null);
  const autostarted = useRef(false);

  const running = LANES.some((m) => lanes[m].status === "running");

  const start = useCallback(async (name: string) => {
    const target = name.trim();
    if (!target) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const patch = (model: LaneModel, fn: (l: Lane) => Lane) =>
      setLanes((ls) => ({ ...ls, [model]: fn(ls[model]) }));

    const t0 = performance.now();
    setStartedAt(t0);
    setNow(t0);
    setLanes({
      "jev-latest": { ...idleLane(), status: "running", line: { id: ++seq, text: "Startet …" } },
      "claude-sonnet-5": { ...idleLane(), status: "running", line: { id: ++seq, text: "Startet …" } },
    });

    await Promise.all(
      LANES.map(async (model) => {
        try {
          const res = await fetch("/api/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ companies: [target], model }),
            signal: controller.signal,
          });
          await readNdjson<AgentEvent | { type: "done" }>(res, (e) =>
            patch(model, (l) => apply(l, e)),
          );
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          patch(model, (l) => ({
            ...l,
            status: "error",
            finishedAt: performance.now(),
            line: { id: ++seq, text: "Fehler", detail: String(err), tone: "error" },
          }));
        }
      }),
    );
  }, []);

  function reset() {
    abort.current?.abort();
    setStartedAt(null);
    setLanes({ "jev-latest": idleLane(), "claude-sonnet-5": idleLane() });
  }

  // Stopwatch clock: one rAF loop while any lane is running.
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = (t: number) => {
      setNow(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  // ?company=...&autostart=1
  useEffect(() => {
    if (autostarted.current) return;
    autostarted.current = true;
    const params = new URLSearchParams(window.location.search);
    const name = params.get("company");
    if (name) setCompany(name);
    if (params.get("autostart") === "1") void start(name ?? DEFAULT_COMPANY);
  }, [start]);

  // R resets (outside the input field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "r" || e.key === "R") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const elapsed = (l: Lane) =>
    startedAt === null ? 0 : Math.max(0, (l.finishedAt ?? now) - startedAt);

  const jev = lanes["jev-latest"];
  const sonnet = lanes["claude-sonnet-5"];
  const bothDone = jev.status === "done" && sonnet.status === "done";
  const leader =
    jev.status === "done" && sonnet.status === "running"
      ? "jev-latest"
      : sonnet.status === "done" && jev.status === "running"
        ? "claude-sonnet-5"
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[hsl(0_0%_6%)]">
      <div
        className="relative flex flex-col overflow-hidden text-neutral-100"
        style={{
          width: "min(100vw, 177.78vh)",
          aspectRatio: "16 / 9",
          containerType: "size",
          background:
            "radial-gradient(ellipse at 20% 0%, hsl(41 75% 61% / 0.14), transparent 55%), radial-gradient(ellipse at 90% 100%, hsl(0 0% 100% / 0.05), transparent 50%), hsl(0 0% 9%)",
        }}
      >
        {/* Header */}
        <header className="flex items-end justify-between px-[3.5cqw] pt-[2.6cqw]">
          <div className="min-w-0 flex-1">
            <div className="text-[1.05cqw] font-bold uppercase tracking-[0.25em] text-[var(--color-mustard)]">
              Aufgabe · UID und Mitarbeitende finden
            </div>
            {startedAt === null ? (
              <form
                className="mt-[0.6cqw] flex items-center gap-[1.2cqw]"
                onSubmit={(e) => {
                  e.preventDefault();
                  void start(company);
                }}
              >
                <input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  spellCheck={false}
                  autoFocus
                  className="w-[44cqw] rounded-[0.6cqw] border border-neutral-700 bg-neutral-900/70 px-[1.2cqw] py-[0.5cqw] text-[2.6cqw] font-extrabold tracking-tight text-white outline-none focus:border-[var(--color-mustard)]"
                />
                <button
                  type="submit"
                  className="rounded-[0.6cqw] bg-[var(--color-mustard)] px-[1.8cqw] py-[0.9cqw] text-[1.4cqw] font-extrabold text-neutral-900 transition hover:brightness-105"
                >
                  Rennen starten ▸
                </button>
              </form>
            ) : (
              <h1 className="mt-[0.4cqw] truncate text-[3.4cqw] font-extrabold leading-tight tracking-tight">
                «{company.trim()}»
              </h1>
            )}
          </div>
          <div className="pb-[0.5cqw] text-right text-[1cqw] leading-snug text-neutral-500">
            gleiche Aufgabe · gleiche Websuche
            <br />
            gleichzeitig gestartet
          </div>
        </header>

        {/* Lanes */}
        <section className="relative grid min-h-0 flex-1 grid-cols-2 gap-[2.2cqw] px-[3.5cqw] py-[2cqw]">
          {LANES.map((m) => (
            <LaneView
              key={m}
              model={m}
              lane={lanes[m]}
              ms={elapsed(lanes[m])}
              leading={leader === m}
            />
          ))}
          <div className="pointer-events-none absolute left-1/2 top-[45%] flex h-[4.2cqw] w-[4.2cqw] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-neutral-700 bg-[hsl(0_0%_9%)] text-[1.3cqw] font-extrabold text-neutral-400">
            vs
          </div>
        </section>

        {/* Verdict */}
        <footer className="flex h-[7.5cqw] shrink-0 items-center justify-center px-[3.5cqw] pb-[1.4cqw]">
          {bothDone && jev.result && sonnet.result ? (
            <Verdict
              costRatio={sonnet.result.cost.total_usd / Math.max(jev.result.cost.total_usd, 1e-9)}
              speedRatio={elapsed(sonnet) / Math.max(elapsed(jev), 1)}
            />
          ) : (
            <div className="text-[1.1cqw] text-neutral-600">
              {startedAt === null ? "Enter startet das Rennen · R setzt zurück" : ""}
            </div>
          )}
        </footer>

        <div className="absolute bottom-[0.8cqw] right-[1.2cqw] text-[0.7cqw] text-neutral-600">
          Erstellt mit Unterstützung von KI. · mühlemann+popp
        </div>
      </div>
    </main>
  );
}

/** Folds one stream event into a lane. */
function apply(l: Lane, e: AgentEvent | { type: "done" }): Lane {
  switch (e.type) {
    case "tool_call": {
      const kind = stepKind(e.tool);
      return {
        ...l,
        line: { id: ++seq, ...describeCall(e.tool, e.input) },
        steps: kind ? [...l.steps, { id: ++seq, kind }] : l.steps,
      };
    }
    case "tool_result":
      return { ...l, line: { id: ++seq, ...describeResult(e.tool, e.summary, l.line) } };
    case "thinking":
      return { ...l, line: { id: ++seq, text: "Denkt nach …", detail: firstSentence(e.text) } };
    case "cost":
      return { ...l, cost: e.cost };
    case "result":
      return {
        ...l,
        status: "done",
        result: e.result,
        cost: e.result.cost,
        finishedAt: performance.now(),
        line: { id: ++seq, text: "Fertig", tone: "done" },
      };
    case "error":
      return {
        ...l,
        status: "error",
        finishedAt: performance.now(),
        line: { id: ++seq, text: "Fehler", detail: e.message, tone: "error" },
      };
    default:
      return l;
  }
}

function stepKind(tool: string): StepKind | null {
  if (tool === "firecrawl_search") return "search";
  if (tool === "firecrawl_scrape") return "scrape";
  if (tool === "jev") return "jev";
  return null;
}

function describeCall(tool: string, input: unknown): Omit<Status, "id"> {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool === "firecrawl_search") return { text: "Durchsucht das Web", detail: `„${String(i.query ?? "")}“` };
  if (tool === "firecrawl_scrape") return { text: `Liest ${hostname(String(i.url ?? ""))} …` };
  if (tool === "jev") {
    return i.purpose
      ? { text: "Jev bewertet die Suchtreffer", detail: `${String(i.hits ?? "")} Treffer in einer Anfrage` }
      : { text: "Jev wählt UID und Mitarbeitende" };
  }
  if (tool === "submit_result") return { text: "Stellt das Ergebnis zusammen …" };
  return { text: tool };
}

function describeResult(tool: string, summary: string, prev: Status | null): Omit<Status, "id"> {
  const hits = summary.match(/^(\d+) hits/);
  if (hits) return { text: `${hits[1]} Treffer gefunden`, detail: prev?.detail };
  if (/chars from/.test(summary)) return { text: `${prev?.text.replace(/^Liest (.*) …$/, "$1") ?? "Seite"} gelesen` };
  if (/^Error/.test(summary)) return { text: "Quelle nicht erreichbar, sucht weiter …" };
  if (tool === "jev") return { text: "Jev hat entschieden", detail: truncate(summary, 90) };
  return { text: prev?.text ?? "Arbeitet …", detail: truncate(summary, 90) };
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Seite";
  }
}

function firstSentence(text: string): string {
  const s = text.replace(/\s+/g, " ").trim().replace(/^\*+|\*+$/g, "");
  const m = s.match(/^.+?[.!?](\s|$)/);
  return truncate(m ? m[0].trim() : s, 90);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatClock(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** What kind of model runs the lane: Jev decides between given options, it generates no text. */
const MODEL_TYPE: Record<LaneModel, string> = {
  "jev-latest": "Entscheidungsmodell",
  "claude-sonnet-5": "Sprachmodell (LLM)",
};

function priceHint(model: LaneModel): string {
  const p = MODEL_PRICING[model];
  return p.output ? `$${p.input} / $${p.output} pro 1M Tokens` : `$${p.input} pro 1M Tokens`;
}

/** Eases the displayed number towards the target, so step-wise cost events count up smoothly. */
function useTweened(target: number, ms = 800, initial = target): number {
  const [value, setValue] = useState(initial);
  const current = useRef(initial);
  useEffect(() => {
    const from = current.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      current.current = from + (target - from) * (1 - Math.pow(1 - k, 3));
      setValue(current.current);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

function LaneView({
  model,
  lane,
  ms,
  leading,
}: {
  model: LaneModel;
  lane: Lane;
  ms: number;
  leading: boolean;
}) {
  const isJev = model === "jev-latest";
  const label = MODELS.find((m) => m.id === model)?.label ?? model;
  const total = lane.cost?.total_usd ?? 0;
  const shown = useTweened(total);
  const accent = isJev ? "text-[var(--color-mustard)]" : "text-neutral-200";

  return (
    <div
      className={`relative flex min-h-0 flex-col rounded-[1.2cqw] border px-[2.2cqw] py-[1.8cqw] transition-colors duration-500 ${
        lane.status === "done" && isJev
          ? "border-[var(--color-mustard)] bg-[hsl(41_75%_61%/0.08)]"
          : "border-neutral-800 bg-neutral-900/60"
      }`}
    >
      {/* Label */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-[1cqw]">
            <span className={`text-[2.2cqw] font-extrabold leading-none tracking-tight ${accent}`}>{label}</span>
            <span
              className={`rounded-full border px-[0.8cqw] py-[0.2cqw] text-[0.9cqw] font-bold uppercase tracking-[0.12em] ${
                isJev
                  ? "border-[var(--color-mustard)]/60 text-[var(--color-mustard)]"
                  : "border-neutral-600 text-neutral-300"
              }`}
            >
              {MODEL_TYPE[model]}
            </span>
          </div>
          <div className="mt-[0.4cqw] text-[0.95cqw] text-neutral-500">{priceHint(model)}</div>
        </div>
        <StateBadge lane={lane} leading={leading} ms={ms} jev={isJev} />
      </div>

      {/* Stopwatch + cost */}
      <div className="mt-[1cqw] grid grid-cols-[auto_1fr] items-end gap-x-[2cqw]">
        <div>
          <div className="text-[0.9cqw] font-semibold uppercase tracking-[0.2em] text-neutral-500">Zeit</div>
          <div
            className={`font-mono text-[4.6cqw] font-bold leading-none tabular-nums ${
              lane.status === "running" ? "text-white" : lane.status === "idle" ? "text-neutral-600" : accent
            }`}
          >
            {formatClock(ms)}
          </div>
        </div>
        <div>
          <div className="text-[0.9cqw] font-semibold uppercase tracking-[0.2em] text-neutral-500">Kosten</div>
          <div
            key={total}
            className={`font-mono text-[3.4cqw] font-bold leading-none tabular-nums ${
              lane.status === "idle" ? "text-neutral-600" : accent
            } ${total > 0 ? "anim-cost" : ""}`}
          >
            ${shown.toFixed(4)}
          </div>
        </div>
      </div>
      <div className="mt-[0.5cqw] h-[1.3cqw] text-[0.9cqw] text-neutral-500">
        {lane.cost && (
          <>
            Modell ${lane.cost.model_usd.toFixed(4)} · Websuche ${lane.cost.firecrawl_usd.toFixed(4)}
          </>
        )}
      </div>

      {/* Status line */}
      <div className="mt-[1.2cqw] h-[4.2cqw] overflow-hidden rounded-[0.7cqw] bg-black/30 px-[1.2cqw] py-[0.7cqw]">
        {lane.line && (
          <div key={lane.line.id} className="anim-status">
            <div
              className={`truncate text-[1.45cqw] font-bold ${
                lane.line.tone === "error"
                  ? "text-red-400"
                  : lane.line.tone === "done"
                    ? accent
                    : "text-neutral-100"
              }`}
            >
              <span className={`mr-[0.6cqw] ${accent}`}>›</span>
              {lane.line.text}
              {lane.status === "running" && (
                <span className={`anim-caret ml-[0.3cqw] ${accent}`}>▍</span>
              )}
            </div>
            {lane.line.detail && (
              <div className="truncate pl-[1.6cqw] text-[1.05cqw] text-neutral-400">{lane.line.detail}</div>
            )}
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="mt-[1cqw] flex h-[2.4cqw] items-center gap-[0.5cqw] overflow-hidden">
        {lane.steps.map((s) => (
          <StepChip key={s.id} kind={s.kind} jev={isJev} />
        ))}
        {lane.steps.length > 0 && (
          <span className="ml-[0.5cqw] shrink-0 text-[0.95cqw] text-neutral-500">
            {lane.steps.length} {lane.steps.length === 1 ? "Schritt" : "Schritte"}
          </span>
        )}
      </div>

      {/* Result */}
      <div className="mt-auto min-h-[5.2cqw]">
        {lane.result && <ResultCard result={lane.result} accent={accent} />}
      </div>
    </div>
  );
}

function StateBadge({ lane, leading, ms, jev }: { lane: Lane; leading: boolean; ms: number; jev: boolean }) {
  if (lane.status === "running") {
    return (
      <span className="flex items-center gap-[0.5cqw] text-[1cqw] font-semibold text-neutral-400">
        <span className="h-[0.7cqw] w-[0.7cqw] animate-pulse rounded-full bg-neutral-300" />
        läuft
      </span>
    );
  }
  if (lane.status === "done") {
    return (
      <span className="flex items-center gap-[0.7cqw] text-[1.1cqw] font-bold text-[var(--color-mustard)]">
        {leading && <span>im Ziel nach {(ms / 1000).toFixed(1)} s</span>}
        <span
          className={`flex h-[2.2cqw] w-[2.2cqw] items-center justify-center rounded-full text-[1.3cqw] text-neutral-900 ${
            jev ? "bg-[var(--color-mustard)]" : "bg-neutral-300"
          } ${
            leading ? "anim-ring" : ""
          }`}
        >
          ✓
        </span>
      </span>
    );
  }
  if (lane.status === "error") {
    return <span className="text-[1.1cqw] font-bold text-red-400">abgebrochen</span>;
  }
  return null;
}

function StepChip({ kind, jev }: { kind: StepKind; jev: boolean }) {
  const title = { search: "Websuche", scrape: "Seite lesen", jev: "Jev-Entscheid" }[kind];
  return (
    <span
      title={title}
      className={`anim-chip flex h-[2.2cqw] w-[2.2cqw] shrink-0 items-center justify-center rounded-[0.5cqw] ${
        kind === "jev"
          ? "bg-[var(--color-mustard)] text-neutral-900"
          : jev
            ? "bg-[hsl(41_75%_61%/0.18)] text-[var(--color-mustard)]"
            : "bg-neutral-800 text-neutral-300"
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-[1.3cqw] w-[1.3cqw]" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        {kind === "search" && (
          <>
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4.2-4.2" />
          </>
        )}
        {kind === "scrape" && (
          <>
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M9 12h6M9 16h6" />
          </>
        )}
        {kind === "jev" && <path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="none" />}
      </svg>
    </span>
  );
}

function ResultCard({ result, accent }: { result: ResolveResult; accent: string }) {
  const employees = formatEmployees(result.employees);
  return (
    <div className="anim-status rounded-[0.8cqw] border border-neutral-800 bg-black/30 px-[1.4cqw] py-[0.9cqw]">
      <div className="flex items-baseline justify-between gap-[1cqw]">
        <span className={`font-mono text-[1.7cqw] font-bold ${result.uid ? accent : "text-neutral-500"}`}>
          {result.uid ?? "keine UID gefunden"}
        </span>
        {employees && (
          <span className="shrink-0 text-[1.15cqw] text-neutral-300">
            <span className="font-bold text-white">{employees}</span> Mitarbeitende
          </span>
        )}
      </div>
      <div className="truncate text-[1.1cqw] text-neutral-400">
        {result.official_name}
        {result.domicile ? `, ${result.domicile}` : ""}
      </div>
    </div>
  );
}

function Verdict({ costRatio, speedRatio }: { costRatio: number; speedRatio: number }) {
  return (
    <div className="anim-banner flex items-center gap-[3cqw] rounded-[1cqw] bg-[var(--color-mustard)] px-[3cqw] py-[1cqw] text-neutral-900">
      <span className="text-[1.3cqw] font-bold uppercase tracking-[0.2em]">Jev ist</span>
      <Factor ratio={costRatio} better="günstiger" worse="teurer" />
      <span className="text-[2.4cqw] font-extrabold opacity-40">·</span>
      <Factor ratio={speedRatio} better="schneller" worse="langsamer" />
    </div>
  );
}

function Factor({ ratio, better, worse }: { ratio: number; better: string; worse: string }) {
  const good = ratio >= 1;
  const target = good ? ratio : 1 / ratio;
  const shown = useTweened(target, 1400, 1);
  return (
    <span className="text-[2.8cqw] font-extrabold tracking-tight">
      <span className="font-mono tabular-nums">{target >= 10 ? Math.round(shown) : shown.toFixed(1)}×</span>{" "}
      {good ? better : worse}
    </span>
  );
}
