import { hashValue } from "../core/hash.ts";
import { choice, noul, type Question, score } from "../core/questions.ts";
import type { JsonObject, JsonValue } from "../core/types.ts";
import { expectKeys, readChoice, readNoul, readScore } from "../core/validation.ts";
import { unjudgedOrFailed } from "./common.ts";
import { InputError } from "./errors.ts";
import { EVIDENCE_POLICY, round, roundedDistribution } from "./policy.ts";
import type { ArtifactStore } from "./ports.ts";
import { buildFrame, Run, type RunOptions } from "./run.ts";
import type { Packet } from "./types.ts";

export const RUN_FRAME = {
  name: "run-frame",
  version: 1,
  budget: { requests: 3, inputTokens: 40_000, wallMs: 60_000 },
} as const;

export const FRAME_LIMITS = {
  fileBytes: 64 * 1024,
  stateBytes: 32 * 1024,
  stateDepth: 8,
  questions: 12,
  instructionChars: 2000,
  descriptionChars: 500,
  choiceLabels: 32,
  scoreLevels: 6,
  priorRunScan: 200,
} as const;

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

export interface FrameFile {
  scope: string;
  state: JsonObject;
  questions: Record<string, Question>;
}

function depth(value: JsonValue): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (value !== null && typeof value === "object") return 1 + Math.max(0, ...Object.values(value).map(depth));
  return 0;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new InputError(`${where} has unsupported key "${key}"`);
  }
}

function description(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > FRAME_LIMITS.descriptionChars) {
    throw new InputError(`${where} must be a string of 1-${FRAME_LIMITS.descriptionChars} characters`);
  }
  return value;
}

/**
 * Validate a custom frame file. It may carry only state and Noul/Choice/Score questions; there
 * is no field for commands, paths to read, models, or actions.
 */
export function parseFrameFile(text: string): FrameFile {
  if (byteLength(text) > FRAME_LIMITS.fileBytes)
    throw new InputError(`frame file exceeds ${FRAME_LIMITS.fileBytes} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InputError("frame file must be JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InputError("frame file must be an object");
  const root = value as Record<string, unknown>;
  onlyKeys(root, ["version", "scope", "state", "questions"], "frame");
  if (root.version !== 1) throw new InputError("frame.version must be 1");
  if (typeof root.scope !== "string" || !/^[A-Za-z0-9][\w.:-]{0,79}$/.test(root.scope)) {
    throw new InputError("frame.scope must be an identifier of at most 80 characters");
  }
  if (typeof root.state !== "object" || root.state === null || Array.isArray(root.state)) {
    throw new InputError("frame.state must be a JSON object");
  }
  const state = root.state as JsonObject;
  if (byteLength(JSON.stringify(state)) > FRAME_LIMITS.stateBytes) {
    throw new InputError(`frame.state exceeds ${FRAME_LIMITS.stateBytes} bytes`);
  }
  if (depth(state) > FRAME_LIMITS.stateDepth)
    throw new InputError(`frame.state is nested deeper than ${FRAME_LIMITS.stateDepth}`);
  if (typeof root.questions !== "object" || root.questions === null || Array.isArray(root.questions)) {
    throw new InputError("frame.questions must be an object");
  }
  const entries = Object.entries(root.questions as Record<string, unknown>);
  if (entries.length === 0 || entries.length > FRAME_LIMITS.questions) {
    throw new InputError(`frame.questions must have 1-${FRAME_LIMITS.questions} questions`);
  }
  const questions: Record<string, Question> = {};
  for (const [name, raw] of entries) {
    const where = `questions.${name}`;
    if (!NAME.test(name)) throw new InputError(`${where}: names must match ${NAME}`);
    if (typeof raw !== "object" || raw === null) throw new InputError(`${where} must be an object`);
    const question = raw as Record<string, unknown>;
    onlyKeys(question, ["type", "instructions", "criteria"], where);
    const instructions = question.instructions;
    if (
      (typeof instructions !== "string" && (typeof instructions !== "object" || instructions === null)) ||
      JSON.stringify(instructions).length > FRAME_LIMITS.instructionChars
    ) {
      throw new InputError(
        `${where}.instructions must be a string or object up to ${FRAME_LIMITS.instructionChars} characters`,
      );
    }
    const instructionValue = instructions as string | JsonObject;
    if (question.type === "noul") {
      let criteria: { true: string; false: string } | undefined;
      if (question.criteria !== undefined) {
        const c = question.criteria as Record<string, unknown>;
        if (typeof c !== "object" || c === null) throw new InputError(`${where}.criteria must be an object`);
        onlyKeys(c, ["true", "false"], `${where}.criteria`);
        criteria = {
          true: description(c.true, `${where}.criteria.true`),
          false: description(c.false, `${where}.criteria.false`),
        };
      }
      questions[name] = noul(instructionValue, criteria ?? null);
    } else if (question.type === "choice") {
      const c = question.criteria as Record<string, unknown>;
      if (typeof c !== "object" || c === null || Array.isArray(c))
        throw new InputError(`${where}.criteria must be an object of labels`);
      const labels = Object.keys(c);
      if (labels.length < 2 || labels.length > FRAME_LIMITS.choiceLabels) {
        throw new InputError(`${where}.criteria must have 2-${FRAME_LIMITS.choiceLabels} labels`);
      }
      if (!labels.includes("cannot_tell"))
        throw new InputError(`${where}.criteria must include a cannot_tell label`);
      const criteria: Record<string, string> = {};
      for (const label of labels) {
        if (!NAME.test(label)) throw new InputError(`${where}.criteria label "${label}" must match ${NAME}`);
        criteria[label] = description(c[label], `${where}.criteria.${label}`);
      }
      questions[name] = choice(instructionValue, criteria);
    } else if (question.type === "score") {
      const c = question.criteria;
      if (!Array.isArray(c) || c.length < 2 || c.length > FRAME_LIMITS.scoreLevels) {
        throw new InputError(
          `${where}.criteria must be an array of 2-${FRAME_LIMITS.scoreLevels} level descriptions`,
        );
      }
      const levels = c.map((level, index) => description(level, `${where}.criteria[${index}]`));
      questions[name] = score(instructionValue, levels as [string, string, ...string[]]);
    } else {
      throw new InputError(`${where}.type must be noul, choice, or score`);
    }
  }
  return { scope: root.scope, state, questions };
}

export interface FrameAnswerResult {
  question: string;
  type: "noul" | "choice" | "score";
  probability?: number;
  choice?: string;
  expected?: number;
  confidence?: number;
  distribution?: Record<string, number> | number[];
}

/** Earlier recorded runs that asked different questions over identical state. */
async function priorRunsWithSameState(
  artifacts: ArtifactStore | undefined,
  stateHash: string,
  questionsHash: string,
): Promise<number> {
  if (!artifacts) return 0;
  const recent = await artifacts.recentInputs(RUN_FRAME.name, FRAME_LIMITS.priorRunScan);
  return recent.filter((inputs) => inputs.stateHash === stateHash && inputs.questionsHash !== questionsHash)
    .length;
}

export async function runFrame(
  input: { file: string },
  options: RunOptions,
): Promise<Packet<FrameAnswerResult>> {
  const file = await options.dependencies.source.readFile(input.file, FRAME_LIMITS.fileBytes);
  const frameFile = parseFrameFile(file.text);
  const stateHash = hashValue(frameFile.state);
  const questionsHash = hashValue(frameFile.questions);
  const reasked = await priorRunsWithSameState(options.dependencies.artifacts, stateHash, questionsHash);
  const run = await Run.start(RUN_FRAME, options, {
    file: file.path,
    scope: frameFile.scope,
    stateHash,
    questionsHash,
  });
  const names = Object.keys(frameFile.questions);
  const frame = buildFrame<Record<string, unknown>>({
    template: "custom@1",
    scope: frameFile.scope,
    state: { evidencePolicy: EVIDENCE_POLICY, evidence: frameFile.state },
    questions: frameFile.questions,
    provenance: [
      { kind: "file_range", id: file.path, path: file.path, probe: "run-frame-file@1", truncated: false },
    ],
    parse(answers) {
      expectKeys(answers, names);
      const parsed: Record<string, unknown> = {};
      for (const [name, question] of Object.entries(frameFile.questions)) {
        if (question.type === "noul") parsed[name] = readNoul(answers, name);
        else if (question.type === "choice")
          parsed[name] = readChoice(answers, name, Object.keys(question.criteria));
        else parsed[name] = readScore(answers, name, question.criteria.length);
      }
      return parsed;
    },
  });
  run.setDisposition(frame.id, "unjudged");
  const outcome = await run.judge(frame);
  const results: FrameAnswerResult[] = [];
  const limits: string[] = [];
  if (reasked > 0) {
    limits.push(
      `${reasked} earlier run-frame run(s) asked different questions over identical state (possible judge shopping)`,
    );
  }
  if (outcome.ok) {
    run.setDisposition(frame.id, "judged");
    for (const [name, question] of Object.entries(frameFile.questions)) {
      const answer = outcome.value[name];
      if (question.type === "noul")
        results.push({ question: name, type: "noul", probability: round(answer as number) });
      else if (question.type === "choice") {
        const value = answer as ReturnType<typeof readChoice>;
        results.push({
          question: name,
          type: "choice",
          choice: value.choice,
          confidence: round(value.confidence),
          distribution: roundedDistribution(value.probabilities),
        });
      } else {
        const value = answer as ReturnType<typeof readScore>;
        results.push({
          question: name,
          type: "score",
          expected: round(value.score),
          confidence: round(value.confidence),
          distribution: value.probabilities.map((p) => round(p)),
        });
      }
    }
  } else {
    run.setDisposition(frame.id, unjudgedOrFailed(outcome.reason));
    limits.push(`frame not answered: ${outcome.reason}: ${outcome.detail}`);
  }
  return run.finish({
    findings: [],
    parked: [],
    excluded: [],
    limits,
    notChecked: [
      "answers are uncalibrated; no thresholds or decisions were applied",
      "state content was supplied by the caller and not verified against the repository",
      "no action is authorized by these answers",
    ],
    results,
    summary: {
      uncalibrated: true,
      file: file.path,
      scope: frameFile.scope,
      stateHash,
      questionsHash,
      priorRunsSameStateDifferentQuestions: reasked,
    },
  });
}
