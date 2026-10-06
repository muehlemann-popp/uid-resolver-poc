/**
 * What every pipeline stage needs to run an LLM step or a billable fetch:
 * the model, the event sink and the run's cost accumulator.
 */

import { priceCost, type Cost, type ModelId } from "../cost";
import type { TokenUsage, ToolAgentEvent } from "../tool-agent";
import type { AssessEvent } from "./types";

export type LlmContext = {
  model: ModelId;
  /** Thinking / tool calls of an LLM step; usage events are ignored (see addUsage). */
  onEvent: (event: ToolAgentEvent) => void;
  /** Adds the final usage of one finished runToolAgent call. */
  addUsage: (usage: TokenUsage) => void;
  onScrape: () => void;
  onSearch: () => void;
  /** One line per finished tool call, for the progress log. */
  onToolResult: (tool: string, summary: string) => void;
};

export function llmContext(model: ModelId, cost: Cost, emit: (e: AssessEvent) => void): LlmContext {
  const publish = () => emit({ type: "cost", cost: priceCost({ ...cost }) });
  return {
    model,
    onEvent: (event) => {
      if (event.type !== "usage") emit(event);
    },
    addUsage: (usage) => {
      cost.input_tokens += usage.input_tokens;
      cost.output_tokens += usage.output_tokens;
      cost.cache_read_tokens += usage.cache_read_tokens;
      cost.cache_write_tokens += usage.cache_write_tokens;
      publish();
    },
    onScrape: () => {
      cost.firecrawl_scrapes += 1;
      publish();
    },
    onSearch: () => {
      cost.firecrawl_searches += 1;
      publish();
    },
    onToolResult: (tool, summary) => emit({ type: "tool_result", tool, summary }),
  };
}
