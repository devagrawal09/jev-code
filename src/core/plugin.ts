/**
 * Public plugin contract and control-envelope validation.
 *
 * Settled (docs/plugin-design-decisions.md):
 *  - A plugin module default-exports an asynchronous factory. The host awaits it with an initialization context
 *    containing only `root`, `signal`, and structured `log`.
 *  - The returned plugin object requires only `id` and `run`, and may expose an asynchronous `cleanup`.
 *  - Workflow input and output are opaque text or arbitrary JSON; the host validates only the control envelope.
 *
 *  - Every additional enumerable field is JSON routing metadata. `instructions` is the documented convention.
 *  - `run` returns text or JSON; the host wraps successful values as `{ status: "complete", output }`.
 *  - `judge` asks Jev bounded fixed-choice questions about evidence the plugin supplies. It is the same
 *    primitive built-in workflows use, validated, redacted, and charged to the shared budget by the host.
 *
 * This module is pure: no filesystem, process, or module-loading access.
 */

import type { FrameFailure } from "./executor.ts";
import type { Questions } from "./questions.ts";
import type { JsonObject, JsonValue } from "./types.ts";
import type { TypedAnswer } from "./validation.ts";

/**
 * Opaque workflow input or output: text or arbitrary JSON. Text is the `string` case of JsonValue, so both share
 * one type. The host does not interpret its contents.
 */
export type PluginValue = JsonValue;

export const PLUGIN_STATUSES = ["complete", "incomplete", "budget_exhausted", "unsupported"] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

/** Structured log handed to plugins at initialization and (later) at run time. */
export interface PluginLog {
  debug(message: string, data?: JsonValue): void;
  info(message: string, data?: JsonValue): void;
  warn(message: string, data?: JsonValue): void;
  error(message: string, data?: JsonValue): void;
}

/** One structured log record emitted by a plugin, attributed by the host to its source. */
export interface PluginLogRecord {
  readonly level: PluginLogLevel;
  readonly source: string;
  readonly message: string;
  readonly data?: JsonValue;
}

/** Initialization context: only canonical repository root, cancellation, and structured log. */
export interface PluginInitContext {
  readonly root: string;
  readonly signal: AbortSignal;
  readonly log: PluginLog;
}

/** Workflow-agnostic result of a nested prompt. The selected workflow identity is never exposed. */
export interface PromptResult {
  readonly status: PluginStatus;
  readonly output: PluginValue;
}

/** Compose by intent through the router. Never names a target workflow. */
export type PromptFn = (instructions: string, input?: PluginValue) => Promise<PromptResult>;

/** One bounded Jev judgment: a short scope label, JSON evidence, and fixed-choice questions about it. */
export interface JudgeRequest {
  readonly scope: string;
  readonly state: JsonObject;
  readonly questions: Questions;
}

export type JudgeFailure = FrameFailure | "limit";

export type JudgeResult =
  | { readonly ok: true; readonly answers: Record<string, TypedAnswer>; readonly model: string }
  | { readonly ok: false; readonly reason: JudgeFailure; readonly detail: string };

/** Ask Jev about supplied evidence. Answers are validated against the questions; failures never throw. */
export type JudgeFn = (request: JudgeRequest) => Promise<JudgeResult>;

/** The minimal public run context. */
export interface PluginRunContext {
  readonly request: string;
  readonly input?: PluginValue;
  readonly root: string;
  readonly prompt: PromptFn;
  readonly judge: JudgeFn;
  readonly signal: AbortSignal;
  readonly log: PluginLog;
}

export const JUDGE_LIMITS = {
  /** Judge calls one plugin run may make; the shared request budget still applies underneath. */
  maxCallsPerRun: 64,
  maxQuestions: 8,
  maxStateBytes: 32 * 1024,
  maxScopeLength: 120,
} as const;

/** Runtime-validate a plugin's judge request: the host never sends unchecked shapes to Jev. */
export function validateJudgeRequest(value: unknown): JudgeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginValidationError(`judge request must be an object (got ${describe(value)})`);
  }
  const { scope, state, questions } = value as Record<string, unknown>;
  if (typeof scope !== "string" || !scope.trim() || scope.length > JUDGE_LIMITS.maxScopeLength) {
    throw new PluginValidationError(
      `judge scope must be non-empty text of at most ${JUDGE_LIMITS.maxScopeLength} characters`,
    );
  }
  if (typeof state !== "object" || state === null || Array.isArray(state) || !isPluginValue(state)) {
    throw new PluginValidationError("judge state must be a JSON object");
  }
  if (JSON.stringify(state).length > JUDGE_LIMITS.maxStateBytes) {
    throw new PluginValidationError(`judge state must be at most ${JUDGE_LIMITS.maxStateBytes} bytes`);
  }
  if (typeof questions !== "object" || questions === null || Array.isArray(questions)) {
    throw new PluginValidationError("judge questions must be an object of questions");
  }
  const names = Object.keys(questions);
  if (names.length === 0 || names.length > JUDGE_LIMITS.maxQuestions) {
    throw new PluginValidationError(`judge needs between 1 and ${JUDGE_LIMITS.maxQuestions} questions`);
  }
  for (const name of names) {
    const question = (questions as Record<string, unknown>)[name];
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new PluginValidationError(`judge question names must be lowercase identifiers (got ${name})`);
    }
    if (
      typeof question !== "object" ||
      question === null ||
      Array.isArray(question) ||
      !isPluginValue(question)
    ) {
      throw new PluginValidationError(`judge question ${name} must be a JSON object`);
    }
    const { type, criteria } = question as Record<string, unknown>;
    if (type === "noul") continue;
    if (type === "choice") {
      if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
        throw new PluginValidationError(`judge question ${name}: choice criteria must be an object`);
      }
      const labels = Object.keys(criteria);
      if (labels.length < 2 || labels.some((label) => !/^[a-z][a-z0-9_]{0,63}$/.test(label))) {
        throw new PluginValidationError(
          `judge question ${name}: choice needs at least two lowercase identifier labels`,
        );
      }
      continue;
    }
    if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
        throw new PluginValidationError(`judge question ${name}: score criteria need 2 to 10 levels`);
      }
      continue;
    }
    throw new PluginValidationError(`judge question ${name}: type must be noul, choice, or score`);
  }
  return { scope: scope.trim(), state: state as JsonObject, questions: questions as Questions };
}

/**
 * A plugin object. Only `id` and `run` are required control fields; `cleanup` is optional. Every other own,
 * enumerable field must be JSON and is supplied to Jev as routing metadata.
 */
export interface Plugin {
  readonly id: string;
  run(context: PluginRunContext): PluginValue | Promise<PluginValue>;
  /** Release resources created during initialization. */
  cleanup?(): Promise<void> | void;
  readonly [field: string]: unknown;
}

/** The default export of a plugin module. */
export type PluginFactory = (context: PluginInitContext) => Promise<Plugin>;

/** Workflow ids: lowercase, start with a letter, at most 64 characters of `a-z`, `0-9`, `_`, `-`. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export class PluginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginValidationError";
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
  return typeof value;
}

/** Runtime-validate a plugin module's default export as a factory function. */
export function validatePluginFactory(value: unknown): PluginFactory {
  if (typeof value !== "function") {
    throw new PluginValidationError(
      `default export must be an async factory function (got ${describe(value)})`,
    );
  }
  return value as PluginFactory;
}

/**
 * Runtime-validate the plugin control envelope. Returns the original object so fields outside the control
 * envelope are preserved exactly. Throws PluginValidationError on violations.
 */
export function validatePlugin(value: unknown): Plugin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginValidationError(`factory must resolve to a plugin object (got ${describe(value)})`);
  }
  const plugin = value as Record<string, unknown>;
  if (typeof plugin.id !== "string" || !PLUGIN_ID_PATTERN.test(plugin.id)) {
    throw new PluginValidationError(`plugin.id must match ${PLUGIN_ID_PATTERN} (got ${describe(plugin.id)})`);
  }
  if (typeof plugin.run !== "function") {
    throw new PluginValidationError(`plugin.run must be a function (got ${describe(plugin.run)})`);
  }
  if (plugin.cleanup !== undefined && typeof plugin.cleanup !== "function") {
    throw new PluginValidationError(
      `plugin.cleanup must be a function when present (got ${describe(plugin.cleanup)})`,
    );
  }
  for (const [field, metadata] of Object.entries(plugin)) {
    if (field === "id" || field === "run" || field === "cleanup") continue;
    if (!isPluginValue(metadata)) {
      throw new PluginValidationError(
        `plugin.${field} must be JSON routing metadata (got ${describe(metadata)})`,
      );
    }
  }
  return value as Plugin;
}

/** Collect all non-control fields exactly as the router should present them to Jev. */
export function pluginRoutingMetadata(plugin: Plugin): JsonObject {
  return Object.fromEntries(
    Object.entries(plugin).filter(([field]) => !["id", "run", "cleanup"].includes(field)),
  ) as JsonObject;
}

/** Validate and normalize one successful external-plugin return value. */
export function completePluginResult(value: unknown): PromptResult {
  if (!isPluginValue(value)) {
    throw new PluginValidationError(`plugin.run must return text or JSON (got ${describe(value)})`);
  }
  return { status: "complete", output: value };
}

/**
 * Whether a value is opaque text or JSON: strings, finite numbers, booleans, null, arrays, and plain objects
 * thereof, without cycles.
 */
export function isPluginValue(value: unknown): value is PluginValue {
  const active = new Set<object>();
  const visit = (current: unknown): boolean => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current !== "object") return false;
    if (active.has(current)) return false;
    if (!Array.isArray(current)) {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    active.add(current);
    const ok = Array.isArray(current)
      ? current.every(visit)
      : Object.values(current as Record<string, unknown>).every(visit);
    active.delete(current);
    return ok;
  };
  return visit(value);
}

/** A structured plugin log that forwards attributed records to a host sink. */
export function createPluginLog(source: string, sink: (record: PluginLogRecord) => void): PluginLog {
  const emit =
    (level: PluginLogLevel) =>
    (message: string, data?: JsonValue): void => {
      sink(
        data === undefined
          ? { level, source, message: String(message) }
          : { level, source, message: String(message), data },
      );
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
