// Public package API. This module is the top of the dependency graph; no production module imports it.

// adapters: port implementations for a local workspace and the TypeSafe SDK
export { parseComments } from "./adapters/comments.ts";
export { configuredModel, jevFromEnvironment } from "./adapters/config.ts";
export {
  createArtifactStore,
  createEvidenceParser,
  createWorkflowDependencies,
  createWorkspaceSource,
} from "./adapters/dependencies.ts";
export { parseUnifiedDiff } from "./adapters/diff.ts";
export { createFakeAdapter, fakeChoice, fakeNoul, fakeScore } from "./adapters/fake-jev.ts";
export { classifyError, createSdkAdapter, MissingCredentialError } from "./adapters/jev.ts";
export { parseFailureLog } from "./adapters/logs.ts";
export { redactJson, redactText } from "./adapters/redact.ts";
export { parseTestRecords } from "./adapters/test-records.ts";
// cli: dispatch registry and output formatting
export { EXIT, exitCodeFor, renderHuman } from "./cli/output.ts";
export { type Stability, WORKFLOWS, type WorkflowDefinition, type WorkflowName } from "./cli/registry.ts";
// core: generic frames, questions, validation, budgets, batching, and execution
export { mapPool, shard, withSplitting } from "./core/batch.ts";
export { Budget, type BudgetDenial, type BudgetLimits, estimateTokens } from "./core/budget.ts";
export {
  type FrameAttempt,
  FrameExecutor,
  type FrameExecutorOptions,
  type FrameFailure,
  type FrameOutcome,
  type FrameSink,
} from "./core/executor.ts";
export { createFrame } from "./core/frame.ts";
export { hashValue, stableId, stableStringify } from "./core/hash.ts";
export { choice, noul, type Question, type Questions, score } from "./core/questions.ts";
export type {
  Frame,
  JevCallOptions,
  JevPort,
  JevRequest,
  JevStatus,
  JevUsage,
  JsonObject,
  JsonValue,
  TransportFailure,
} from "./core/types.ts";
export {
  type ChoiceAnswer,
  expectKeys,
  readChoice,
  readEnvelope,
  readNoul,
  readScore,
  type ScoreAnswer,
  ValidationError,
} from "./core/validation.ts";
// workflows: domain workflows, run context, evidence types, and ports
export { type AuditDiffInput, auditDiff } from "./workflows/audit-diff.ts";
export { type CheckCriteriaInput, checkCriteria, parseCriteria } from "./workflows/check-criteria.ts";
export { type CheckRulesInput, checkRules, parseRules } from "./workflows/check-rules.ts";
export { classifyPath, globToRegExp, isSecretPath } from "./workflows/classify.ts";
export { InputError } from "./workflows/errors.ts";
export type {
  DiffFile,
  FailureBlock,
  Hunk,
  ParsedLog,
  ReviewComment,
  TestRecord,
} from "./workflows/evidence.ts";
export { ladderForHunk } from "./workflows/hunks.ts";
export { type LocateInput, locate } from "./workflows/locate.ts";
export type {
  ArtifactStore,
  ArtifactWriter,
  DiffSelection,
  DiffSource,
  EvidenceParser,
  RedactionPort,
  WorkflowDependencies,
  WorkspaceSource,
} from "./workflows/ports.ts";
export { buildFrame, type Outcome, Run, type RunOptions } from "./workflows/run.ts";
export { parseFrameFile, runFrame } from "./workflows/run-frame.ts";
export { type TriageCommentsInput, triageComments } from "./workflows/triage-comments.ts";
export { type TriageFailuresInput, triageFailures } from "./workflows/triage-failures.ts";
export * from "./workflows/types.ts";
