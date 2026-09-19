import type { AgentRunOptions, AgentRunResult, AgentTask, CodingAgentPort } from "../workflows/agent.ts";

export interface FakeAgentCall {
  readonly task: AgentTask;
  readonly options: AgentRunOptions;
}

/**
 * Deterministic coding-agent port for tests and smoke runs. `respond` may perform side effects (for example
 * write a candidate workflow) and return a partial result; every call is recorded.
 */
export function createFakeAgent(
  respond: (
    task: AgentTask,
    options: AgentRunOptions,
  ) => Partial<AgentRunResult> | Promise<Partial<AgentRunResult>> = () => ({}),
  name = "fake",
): CodingAgentPort & { readonly calls: FakeAgentCall[] } {
  const calls: FakeAgentCall[] = [];
  return {
    name,
    calls,
    async run(task, options) {
      calls.push({ task, options });
      options.signal?.throwIfAborted();
      const partial = await respond(task, options);
      return {
        outcome: "finished",
        text: "",
        exitCode: 0,
        durationMs: 1,
        toolCalls: 0,
        ...partial,
      };
    },
  };
}
