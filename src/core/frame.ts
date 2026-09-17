import { stableId } from "./hash.ts";
import type { Frame } from "./types.ts";

/** Build a frame with a stable ID derived from its template, scope, state, and questions. */
export function createFrame<A, P = unknown>(spec: Omit<Frame<A, P>, "id">): Frame<A, P> {
  return {
    ...spec,
    id: stableId(
      "f",
      { template: spec.template, scope: spec.scope, state: spec.state, questions: spec.questions },
      16,
    ),
  };
}
