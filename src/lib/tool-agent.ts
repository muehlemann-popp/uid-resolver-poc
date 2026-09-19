/**
 * A thin, domain-free wrapper around the SDK's beta Tool Runner
 * (`client.beta.messages.toolRunner`).
 *
 * The Tool Runner already owns the request -> execute tools -> feed results back
 * loop, so what is left to abstract is the small amount of plumbing every agent
 * we write needs anyway:
 *
 *   - accumulating token usage across the loop's iterations,
 *   - surfacing thinking / text / tool calls as a stream of events,
 *   - stopping on a "terminal tool" whose arguments ARE the result, without
 *     paying for one more round trip just to let the model say goodbye,
 *   - resuming a `pause_turn` (the runner does not do this by itself).
 *
 * Everything domain-specific - prompts, tools, pricing - stays with the caller.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import * as z from "zod";

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export type ToolAgentEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "usage"; usage: TokenUsage };

/**
 * A tool the model calls to hand back its final answer. Its arguments are the
 * result, so the loop can stop the moment the call appears - no extra API call.
 */
export type TerminalTool<Output> = {
  tool: BetaRunnableTool<unknown>;
  name: string;
  /** Validates the tool_use arguments; returns null when they don't fit. */
  parse: (input: unknown) => Output | null;
};

export function terminalTool<Schema extends z.ZodType>(options: {
  name: string;
  description: string;
  schema: Schema;
}): TerminalTool<z.infer<Schema>> {
  return {
    name: options.name,
    parse: (input) => {
      const parsed = options.schema.safeParse(input);
      return parsed.success ? (parsed.data as z.infer<Schema>) : null;
    },
    // `run` is a formality: runToolAgent breaks out of the loop as soon as the
    // call is seen, so this only fires if the tool is used outside that path.
    tool: betaZodTool({
      name: options.name,
      description: options.description,
      inputSchema: options.schema,
      run: async () => "Result recorded.",
    }) as BetaRunnableTool<unknown>,
  };
}

export type ToolAgentResult<Output> = {
  /** Parsed terminal-tool arguments, or null if the model never delivered one. */
  output: Output | null;
  /** Why the run ended - useful for the "no result" message. */
  stopReason: "terminal_tool" | "max_iterations" | "no_terminal_call";
  usage: TokenUsage;
};

export async function runToolAgent<Output>(options: {
  model: string;
  system: string;
  prompt: string;
  tools: BetaRunnableTool<never>[];
  terminal: TerminalTool<Output>;
  maxIterations: number;
  maxTokens?: number;
  onEvent: (event: ToolAgentEvent) => void;
  client?: Anthropic;
}): Promise<ToolAgentResult<Output>> {
  const client = options.client ?? new Anthropic();
  const usage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  const runner = client.beta.messages.toolRunner({
    model: options.model,
    max_tokens: options.maxTokens ?? 16000,
    system: options.system,
    thinking: { type: "adaptive", display: "summarized" },
    max_iterations: options.maxIterations,
    tools: [...options.tools, options.terminal.tool],
    messages: [{ role: "user", content: options.prompt }],
  });

  let iterations = 0;

  for await (const message of runner) {
    iterations += 1;

    usage.input_tokens += message.usage.input_tokens ?? 0;
    usage.output_tokens += message.usage.output_tokens ?? 0;
    usage.cache_read_tokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cache_write_tokens += message.usage.cache_creation_input_tokens ?? 0;
    options.onEvent({ type: "usage", usage: { ...usage } });

    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking.trim()) {
        options.onEvent({ type: "thinking", text: block.thinking });
      }
      if (block.type === "text" && block.text.trim()) {
        options.onEvent({ type: "thinking", text: block.text });
      }
      if (block.type === "tool_use" && block.name !== options.terminal.name) {
        options.onEvent({ type: "tool_call", tool: block.name, input: block.input });
      }
    }

    const finished = message.content.find(
      (b) => b.type === "tool_use" && b.name === options.terminal.name,
    );
    if (finished && finished.type === "tool_use") {
      // Break before the runner executes the tool and spends another request.
      const output = options.terminal.parse(finished.input);
      if (output !== null) {
        return { output, stopReason: "terminal_tool", usage };
      }
      return { output: null, stopReason: "no_terminal_call", usage };
    }

    // Server tools can park a turn; the runner only resumes after a client
    // tool produces a result, so push the turn back ourselves.
    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content });
      continue;
    }

    // Model stopped without delivering - nudge it rather than give up.
    if (message.stop_reason !== "tool_use") {
      runner.pushMessages({
        role: "user",
        content: `Please deliver the result now via ${options.terminal.name}.`,
      });
    }
  }

  return {
    output: null,
    stopReason: iterations >= options.maxIterations ? "max_iterations" : "no_terminal_call",
    usage,
  };
}
