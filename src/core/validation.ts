import type { Questions } from "./questions.ts";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const DISTRIBUTION_TOLERANCE = 0.02;

export interface ChoiceAnswer<L extends string = string> {
  choice: L;
  confidence: number;
  probabilities: Record<L, number>;
}

export interface ScoreAnswer {
  score: number;
  confidence: number;
  /** Probability per level, index = level. */
  probabilities: number[];
}

export interface ResponseEnvelope {
  model: string;
  answers: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

export function readEnvelope(response: unknown): ResponseEnvelope {
  const value = object(response, "response");
  if (typeof value.model !== "string" || value.model.length === 0) {
    throw new ValidationError("response.model must be a non-empty string");
  }
  const answers = object(value.answers, "response.answers");
  const usage = object(value.usage, "response.usage");
  return {
    model: value.model,
    answers,
    usage: {
      inputTokens: nonnegative(usage.input_tokens, "usage.input_tokens"),
      outputTokens: nonnegative(usage.output_tokens, "usage.output_tokens"),
    },
  };
}

/** Require exactly the expected answer keys: nothing missing, nothing extra. */
export function expectKeys(answers: Record<string, unknown>, keys: readonly string[]): void {
  const supplied = Object.keys(answers).sort();
  const expected = [...keys].sort();
  const missing = expected.filter((key) => !supplied.includes(key));
  const extra = supplied.filter((key) => !expected.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new ValidationError(
      `answer keys differ (missing: ${missing.join(",") || "none"}; unexpected: ${extra.join(",") || "none"})`,
    );
  }
}

export function readNoul(answers: Record<string, unknown>, key: string): number {
  const answer = answerOf(answers, key, "noul");
  return probability(answer.noul, `${key}.noul`);
}

export function readChoice<L extends string>(
  answers: Record<string, unknown>,
  key: string,
  labels: readonly L[],
  tolerance = DISTRIBUTION_TOLERANCE,
): ChoiceAnswer<L> {
  const answer = answerOf(answers, key, "choice");
  if (typeof answer.choice !== "string" || !labels.includes(answer.choice as L)) {
    throw new ValidationError(`${key}.choice is not a permitted label`);
  }
  const confidence = probability(answer.confidence, `${key}.confidence`);
  const reported = object(answer.probabilities, `${key}.probabilities`);
  exactKeys(reported, labels, `${key}.probabilities`);
  const probabilities = {} as Record<L, number>;
  for (const label of labels)
    probabilities[label] = probability(reported[label], `${key}.probabilities.${label}`);
  checkSum(Object.values<number>(probabilities), tolerance, key);
  const max = Math.max(...Object.values<number>(probabilities));
  if (probabilities[answer.choice as L] < max - 1e-6) {
    throw new ValidationError(`${key}.choice is not a maximum-probability label`);
  }
  return { choice: answer.choice as L, confidence, probabilities };
}

export function readScore(
  answers: Record<string, unknown>,
  key: string,
  levels: number,
  tolerance = DISTRIBUTION_TOLERANCE,
): ScoreAnswer {
  const answer = answerOf(answers, key, "score");
  const score = finite(answer.score, `${key}.score`);
  if (score < -1e-6 || score > levels - 1 + 1e-6)
    throw new ValidationError(`${key}.score is outside the rubric`);
  const confidence = probability(answer.confidence, `${key}.confidence`);
  const reported = object(answer.probabilities, `${key}.probabilities`);
  const labels = Array.from({ length: levels }, (_, index) => String(index));
  exactKeys(reported, labels, `${key}.probabilities`);
  const probabilities = labels.map((label) => probability(reported[label], `${key}.probabilities.${label}`));
  checkSum(probabilities, tolerance, key);
  const implied = probabilities.reduce((total, value, index) => total + value * index, 0);
  if (Math.abs(implied - score) > Math.max(0.05, tolerance * levels)) {
    throw new ValidationError(`${key}.score disagrees with its distribution`);
  }
  return { score, confidence, probabilities };
}

/** A validated answer to one question, tagged by the question type it answered. */
export type TypedAnswer =
  | { type: "noul"; probability: number }
  | ({ type: "choice" } & ChoiceAnswer)
  | ({ type: "score" } & ScoreAnswer);

/** Validate every answer against the question it answers; exactly the asked keys must be present. */
export function readAnswers(
  answers: Record<string, unknown>,
  questions: Questions,
): Record<string, TypedAnswer> {
  const keys = Object.keys(questions);
  expectKeys(answers, keys);
  const result: Record<string, TypedAnswer> = {};
  for (const key of keys) {
    const question = questions[key]!;
    if (question.type === "noul") result[key] = { type: "noul", probability: readNoul(answers, key) };
    else if (question.type === "choice") {
      result[key] = { type: "choice", ...readChoice(answers, key, Object.keys(question.criteria)) };
    } else result[key] = { type: "score", ...readScore(answers, key, question.criteria.length) };
  }
  return result;
}

function answerOf(answers: Record<string, unknown>, key: string, type: string): Record<string, unknown> {
  const answer = object(answers[key], `answers.${key}`);
  if (answer.type !== type) throw new ValidationError(`answers.${key}.type must be ${type}`);
  return answer;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const supplied = Object.keys(value);
  if (supplied.length !== keys.length || supplied.some((key) => !keys.includes(key))) {
    throw new ValidationError(`${name} keys do not match the question's labels`);
  }
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ValidationError(`${name} must be a finite number`);
  return value;
}

function nonnegative(value: unknown, name: string): number {
  const result = finite(value, name);
  if (result < 0) throw new ValidationError(`${name} must be nonnegative`);
  return result;
}

function probability(value: unknown, name: string): number {
  const result = finite(value, name);
  if (result < 0 || result > 1) throw new ValidationError(`${name} must be within [0, 1]`);
  return result;
}

function checkSum(values: number[], tolerance: number, name: string): void {
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > tolerance)
    throw new ValidationError(`${name} distribution sums to ${sum.toFixed(4)}`);
}
