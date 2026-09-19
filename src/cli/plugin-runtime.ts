import {
  completePluginResult,
  createPluginLog,
  isPluginValue,
  type JudgeFn,
  type PluginLogRecord,
  PluginValidationError,
  type PluginValue,
  type PromptResult,
} from "../core/plugin.ts";
import type { RegisteredWorkflow, WorkflowRegistry } from "./registry.ts";

export const PLUGIN_INVOCATION_LIMITS = { maxDepth: 8, maxChildCalls: 32 } as const;

export type FallbackReason = "unroutable" | "unavailable" | "cycle" | "depth" | "calls";

export interface PluginPromptRuntimeOptions {
  readonly root: string;
  readonly registry: WorkflowRegistry;
  readonly signal: AbortSignal;
  readonly route: (
    request: string,
    input: PluginValue | undefined,
    excluded: ReadonlySet<string>,
  ) => Promise<string | null>;
  readonly runBuiltin: (
    workflow: RegisteredWorkflow,
    request: string,
    input: PluginValue | undefined,
    depth: number,
  ) => Promise<PromptResult>;
  readonly fallback: (
    request: string,
    input: PluginValue | undefined,
    reason: FallbackReason,
  ) => Promise<PromptResult> | PromptResult;
  /** Builds the bounded `judge` primitive for one plugin run. Defaults to an always-unavailable judge. */
  readonly judge?: (workflow: RegisteredWorkflow) => JudgeFn;
  readonly log?: (record: PluginLogRecord) => void;
}

const noJudge: JudgeFn = async () => ({
  ok: false,
  reason: "unavailable",
  detail: "judge is not configured",
});

/** Runs trusted plugins and composes child prompts through the same late-bound router. */
export class PluginPromptRuntime {
  private childCalls = 0;
  private readonly options: PluginPromptRuntimeOptions;

  constructor(options: PluginPromptRuntimeOptions) {
    this.options = options;
  }

  /** Execute an already-routed top-level workflow. */
  async run(id: string, request: string, input?: PluginValue): Promise<PromptResult> {
    validatePromptCall(request, input);
    return this.execute(id, request, input, [], 0);
  }

  private async execute(
    id: string,
    request: string,
    input: PluginValue | undefined,
    stack: readonly string[],
    depth: number,
  ): Promise<PromptResult> {
    this.options.signal.throwIfAborted();
    if (stack.includes(id)) return this.options.fallback(request, input, "cycle");
    const workflow = this.options.registry.get(id);
    if (!workflow) return this.options.fallback(request, input, "unavailable");
    if (workflow.kind === "builtin") {
      return this.options.runBuiltin(workflow, request, input, depth);
    }
    if (!workflow.plugin) return this.options.fallback(request, input, "unavailable");

    const active = [...stack, id];
    const prompt = async (instructions: string, childInput?: PluginValue): Promise<PromptResult> => {
      validatePromptCall(instructions, childInput);
      this.options.signal.throwIfAborted();
      if (depth >= PLUGIN_INVOCATION_LIMITS.maxDepth) {
        return this.options.fallback(instructions, childInput, "depth");
      }
      this.childCalls++;
      if (this.childCalls > PLUGIN_INVOCATION_LIMITS.maxChildCalls) {
        return this.options.fallback(instructions, childInput, "calls");
      }
      const selected = await this.options.route(instructions, childInput, new Set(active));
      if (!selected) return this.options.fallback(instructions, childInput, "unroutable");
      return this.execute(selected, instructions, childInput, active, depth + 1);
    };

    const value = await workflow.plugin.run({
      request,
      ...(input === undefined ? {} : { input }),
      root: this.options.root,
      prompt,
      judge: this.options.judge?.(workflow) ?? noJudge,
      signal: this.options.signal,
      log: createPluginLog(workflow.origin, this.options.log ?? (() => {})),
    });
    return completePluginResult(value);
  }
}

function validatePromptCall(request: unknown, input: unknown): asserts request is string {
  if (
    typeof request !== "string" ||
    !request.trim() ||
    request.includes("\0") ||
    Buffer.byteLength(request) > 16 * 1024
  ) {
    throw new PluginValidationError(
      "prompt instructions must be non-empty text of at most 16384 bytes with no null bytes",
    );
  }
  if (input !== undefined && !isPluginValue(input)) {
    throw new PluginValidationError("prompt input must be text or JSON");
  }
}
