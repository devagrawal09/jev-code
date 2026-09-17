import type { Question } from "../core/questions.ts";
import type { JevPort, JevRequest } from "../core/types.ts";

/**
 * Deterministic offline Jev port for tests. Answers come from `respond` when it returns a
 * value for a key; otherwise a neutral valid answer is generated from the question shape.
 */
export function createFakeAdapter(
  respond: (name: string, question: Question, request: JevRequest) => unknown = () => undefined,
  options: { model?: string; onRequest?: (request: JevRequest) => void } = {},
): JevPort & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    requests,
    async ask(request) {
      requests.push(request);
      options.onRequest?.(request);
      const answers: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(request.questions)) {
        answers[name] = respond(name, question, request) ?? neutralAnswer(question);
      }
      const bytes = JSON.stringify({ state: request.state, questions: request.questions }).length;
      return {
        model: options.model ?? request.model,
        answers,
        usage: { input_tokens: Math.ceil(bytes / 4), output_tokens: Object.keys(answers).length * 4 },
      };
    },
  };
}

export function neutralAnswer(question: Question): unknown {
  if (question.type === "noul") return fakeNoul(0.1);
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    const preferred = labels.includes("cannot_tell") ? "cannot_tell" : labels[labels.length - 1]!;
    return fakeChoice(labels, preferred, 0.8);
  }
  return fakeScore(question.criteria.length, 0, 0.8);
}

export function fakeNoul(value: number) {
  return { type: "noul", noul: value };
}

export function fakeChoice(labels: readonly string[], selected: string, mass: number) {
  const rest = labels.length > 1 ? (1 - mass) / (labels.length - 1) : 0;
  const probabilities = Object.fromEntries(labels.map((label) => [label, label === selected ? mass : rest]));
  return { type: "choice", choice: selected, confidence: mass, probabilities };
}

export function fakeScore(levels: number, level: number, mass: number) {
  const rest = levels > 1 ? (1 - mass) / (levels - 1) : 0;
  const probabilities = Object.fromEntries(
    Array.from({ length: levels }, (_, index) => [String(index), index === level ? mass : rest]),
  );
  const score = Object.values(probabilities).reduce((total, value, index) => total + value * index, 0);
  return { type: "score", score, confidence: mass, legend: {}, probabilities };
}
