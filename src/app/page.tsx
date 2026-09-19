"use client";

import { useRef, useState } from "react";
import type { AgentEvent, ResolveResult } from "@/lib/agent";
import { formatEmployees } from "@/lib/employees";
import {
  addCost,
  DEFAULT_MODEL,
  emptyCost,
  formatDuration,
  formatUsd,
  MODELS,
  type Cost,
  type ModelId,
} from "@/lib/cost";

type LogEntry = { kind: string; text: string };
type Row = {
  company: string;
  status: "pending" | "running" | "done" | "error";
  result?: ResolveResult;
  /** Live cost, updated while the run is still in progress. */
  cost?: Cost;
  log: LogEntry[];
};

const EXAMPLES = [
  "Mühlemann + Popp AG",
  "Muehlemann und Pop",
  "Swisscom",
  "Ringier Axel Springer Schweiz",
  "Zuercher Kantonalbank Zurich",
  "Gugelhupf Bakery Hinterdorf",
].join("\n");

export default function Home() {
  const [input, setInput] = useState(EXAMPLES);
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function run() {
    const companies = input
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);
    if (companies.length === 0) return;

    setRows(companies.map((c) => ({ company: c, status: "pending", log: [] })));
    setRunning(true);
    abort.current = new AbortController();

    const patch = (company: string, fn: (r: Row) => Row) =>
      setRows((rs) => rs.map((r) => (r.company === company ? fn(r) : r)));

    let current = companies[0];

    try {
      const res = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companies, model }),
        signal: abort.current.signal,
      });
      if (!res.ok || !res.body) throw new Error(await res.text());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as AgentEvent | { type: "done" };

          if (e.type === "start") {
            current = e.company;
            setOpen(e.company);
            patch(e.company, (r) => ({ ...r, status: "running" }));
          } else if (e.type === "thinking") {
            patch(current, (r) => ({
              ...r,
              log: [...r.log, { kind: "thinking", text: e.text }],
            }));
          } else if (e.type === "tool_call") {
            patch(current, (r) => ({
              ...r,
              log: [
                ...r.log,
                { kind: e.tool, text: JSON.stringify(e.input) },
              ],
            }));
          } else if (e.type === "tool_result") {
            patch(current, (r) => ({
              ...r,
              log: [...r.log, { kind: "↳", text: e.summary }],
            }));
          } else if (e.type === "cost") {
            patch(e.company, (r) => ({ ...r, cost: e.cost }));
          } else if (e.type === "result") {
            patch(e.company, (r) => ({
              ...r,
              status: "done",
              result: e.result,
              cost: e.result.cost,
            }));
          } else if (e.type === "error") {
            patch(current, (r) => ({
              ...r,
              status: "error",
              log: [...r.log, { kind: "error", text: e.message }],
            }));
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        patch(current, (r) => ({
          ...r,
          status: "error",
          log: [...r.log, { kind: "error", text: String(err) }],
        }));
      }
    } finally {
      setRunning(false);
    }
  }

  function copyCsv() {
    const csv = [
      "Input;UID;Official name;Domicile;Employees;Employees min;Employees max;Employees year;FTE;Employees source;Confidence;Model;Cost USD;Duration s;Rationale",
      ...rows.map((r) =>
        [
          r.company,
          r.result?.uid ?? "",
          r.result?.official_name ?? "",
          r.result?.domicile ?? "",
          r.result?.employees?.count ?? "",
          r.result?.employees?.min ?? "",
          r.result?.employees?.max ?? "",
          r.result?.employees?.year ?? "",
          r.result?.employees ? (r.result.employees.fte ? "1" : "0") : "",
          r.result?.employees?.source ?? "",
          r.result?.confidence?.toFixed(2) ?? "",
          r.cost?.model ?? "",
          r.cost ? r.cost.total_usd.toFixed(5) : "",
          r.cost?.duration_ms ? (r.cost.duration_ms / 1000).toFixed(1) : "",
          (r.result?.reasoning ?? "").replace(/[\r\n;]+/g, " "),
        ].join(";"),
      ),
    ].join("\n");
    navigator.clipboard.writeText(csv);
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight text-neutral-800">
          Swiss Company Resolver
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-neutral-600">
          Proof of concept: maps misspelled company names to the Swiss company
          identification number via Firecrawl (web search + scraping) - with a
          confidence score, a rationale and the employee headcount. Compare a Claude agent loop against
          a code-driven pipeline that uses Jev (TypeSafe AI) for the decisions.
        </p>
      </header>

      <section className="mb-8 rounded-lg border border-neutral-200 bg-white p-4">
        <label className="mb-2 block text-sm font-semibold text-neutral-700">
          Company names (one per line, max. 25)
        </label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={7}
          spellCheck={false}
          className="w-full resize-y rounded border border-neutral-300 p-3 font-mono text-sm outline-none focus:border-[var(--color-mustard)]"
        />
        <fieldset className="mt-4" disabled={running}>
          <legend className="mb-2 text-sm font-semibold text-neutral-700">
            Model
          </legend>
          <div className="flex flex-wrap gap-2">
            {MODELS.map((m) => (
              <label
                key={m.id}
                title={m.hint}
                className={`cursor-pointer rounded border px-3 py-2 text-sm transition ${
                  model === m.id
                    ? "border-[var(--color-mustard)] bg-[var(--color-mustard)]/20 font-bold"
                    : "border-neutral-300 hover:border-neutral-400"
                } ${running ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <input
                  type="radio"
                  name="model"
                  value={m.id}
                  checked={model === m.id}
                  onChange={() => setModel(m.id)}
                  className="sr-only"
                />
                {m.label}
                <span className="ml-2 font-normal text-neutral-500">
                  {m.hint}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={run}
            disabled={running}
            className="rounded bg-[var(--color-mustard)] px-5 py-2 text-sm font-bold text-neutral-900 transition hover:brightness-95 disabled:opacity-50"
          >
            {running ? "Running …" : "Resolve UIDs"}
          </button>
          {running && (
            <button
              onClick={() => abort.current?.abort()}
              className="rounded border border-neutral-300 px-4 py-2 text-sm"
            >
              Cancel
            </button>
          )}
          {rows.some((r) => r.result) && (
            <button
              onClick={copyCsv}
              className="rounded border border-neutral-300 px-4 py-2 text-sm"
            >
              Copy as CSV
            </button>
          )}
        </div>
      </section>

      {rows.length > 0 && <CostSummary rows={rows} />}

      {rows.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-100 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Input</th>
                <th className="px-4 py-3">UID</th>
                <th className="px-4 py-3">Official name</th>
                <th className="px-4 py-3 text-right">Empl.</th>
                <th className="px-4 py-3">Conf.</th>
                <th className="px-4 py-3 text-right">Cost</th>
                <th className="px-4 py-3 text-right">Time</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RowView
                  key={r.company}
                  row={r}
                  open={open === r.company}
                  onToggle={() =>
                    setOpen(open === r.company ? null : r.company)
                  }
                />
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="mt-10 text-xs text-neutral-400">
        Created with AI assistance.
      </footer>
    </main>
  );
}

function RowView({
  row,
  open,
  onToggle,
}: {
  row: Row;
  open: boolean;
  onToggle: () => void;
}) {
  const conf = row.result?.confidence ?? 0;
  const confColor =
    conf >= 0.9
      ? "bg-emerald-100 text-emerald-800"
      : conf >= 0.7
        ? "bg-[var(--color-mustard)]/30 text-neutral-800"
        : "bg-red-100 text-red-800";

  return (
    <>
      <tr className="border-t border-neutral-200">
        <td className="px-4 py-3 font-medium">{row.company}</td>
        <td className="px-4 py-3 font-mono">
          {row.status === "running" && (
            <span className="text-neutral-400">researching …</span>
          )}
          {row.result?.uid ?? (row.status === "done" ? "—" : "")}
        </td>
        <td className="px-4 py-3 text-neutral-600">
          {row.result?.official_name}
          {row.result?.domicile ? `, ${row.result.domicile}` : ""}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-neutral-600">
          {row.result?.employees && (
            <span title={row.result.employees.source}>
              {formatEmployees(row.result.employees)}
            </span>
          )}
        </td>
        <td className="px-4 py-3">
          {row.result && (
            <span className={`rounded px-2 py-1 text-xs font-bold ${confColor}`}>
              {conf.toFixed(2)}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-neutral-500">
          {row.cost ? formatUsd(row.cost.total_usd) : ""}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-neutral-500">
          {row.cost?.duration_ms ? formatDuration(row.cost.duration_ms) : ""}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={onToggle}
            className="text-xs text-neutral-500 underline"
          >
            {open ? "Hide details" : "Details"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-neutral-100 bg-neutral-50">
          <td colSpan={8} className="px-4 py-4">
            {row.result && (
              <div className="mb-4">
                <p className="text-sm text-neutral-700">
                  {row.result.reasoning}
                </p>
                {row.result.sources.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs">
                    {row.result.sources.map((s) => (
                      <li key={s}>
                        <a
                          href={s}
                          target="_blank"
                          rel="noreferrer"
                          className="text-neutral-500 underline"
                        >
                          {s}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {row.cost && <CostBreakdown cost={row.cost} />}

            <details open={!row.result}>
              <summary className="cursor-pointer text-xs font-semibold text-neutral-500">
                Agent steps ({row.log.length})
              </summary>
              <ol className="mt-2 space-y-1 font-mono text-xs text-neutral-600">
                {row.log.map((l, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 font-bold text-[var(--color-mustard-dark)]">
                      {l.kind}
                    </span>
                    <span className="whitespace-pre-wrap">{l.text}</span>
                  </li>
                ))}
              </ol>
            </details>
          </td>
        </tr>
      )}
    </>
  );
}

function CostSummary({ rows }: { rows: Row[] }) {
  const total = rows
    .map((r) => r.cost)
    .filter((c): c is Cost => Boolean(c))
    .reduce(addCost, emptyCost());
  const priced = rows.filter((r) => r.cost).length;
  if (priced === 0) return null;

  const modelsUsed = [
    ...new Set(
      rows
        .map((r) => r.cost?.model)
        .filter(Boolean)
        .map((id) => MODELS.find((m) => m.id === id)?.label ?? id),
    ),
  ].join(" + ");

  return (
    <section className="mb-4 flex flex-wrap items-baseline gap-x-8 gap-y-2 rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm">
      <div>
        <span className="text-neutral-500">Total </span>
        <span className="font-bold">{formatUsd(total.total_usd)}</span>
        <span className="text-neutral-400">
          {" "}
          for {priced} {priced === 1 ? "company" : "companies"}
        </span>
      </div>
      <div className="text-neutral-500">
        Ø per company{" "}
        <span className="font-semibold text-neutral-700">
          {formatUsd(total.total_usd / priced)}
        </span>
      </div>
      <div className="text-neutral-500">
        {modelsUsed}{" "}
        <span className="font-semibold text-neutral-700">
          {formatUsd(total.model_usd)}
        </span>
      </div>
      <div className="text-neutral-500">
        Firecrawl{" "}
        <span className="font-semibold text-neutral-700">
          {formatUsd(total.firecrawl_usd)}
        </span>
        <span className="text-neutral-400">
          {" "}
          ({total.firecrawl_credits} credits)
        </span>
      </div>
    </section>
  );
}

function CostBreakdown({ cost }: { cost: Cost }) {
  const cells: [string, string][] = [
    ["Input tokens", cost.input_tokens.toLocaleString("en-US")],
    ["Output tokens", cost.output_tokens.toLocaleString("en-US")],
    [
      `Model (${MODELS.find((m) => m.id === cost.model)?.label ?? cost.model})`,
      formatUsd(cost.model_usd),
    ],
    ...(cost.jev_requests > 0
      ? ([["Jev requests", String(cost.jev_requests)]] as [string, string][])
      : []),
    ...(cost.duration_ms > 0
      ? ([["Duration", formatDuration(cost.duration_ms)]] as [string, string][])
      : []),
    [
      "Firecrawl",
      `${cost.firecrawl_searches} search / ${cost.firecrawl_scrapes} scrape = ${cost.firecrawl_credits} credits`,
    ],
    ["Firecrawl cost", formatUsd(cost.firecrawl_usd)],
    ["Total", formatUsd(cost.total_usd)],
  ];

  return (
    <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1 border-y border-neutral-200 py-3 text-xs sm:grid-cols-3">
      {cells.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2">
          <dt className="text-neutral-500">{k}</dt>
          <dd className="font-mono font-semibold text-neutral-700">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
