import type { JsonObject } from "../core/types.ts";
import { contentExclusionReason } from "./classify.ts";
import { InputError } from "./errors.ts";
import type { DiffFile, Hunk } from "./evidence.ts";
import { hunkText } from "./hunks.ts";
import type { DiffSelection, DiffSource, WorkflowDependencies } from "./ports.ts";
import type { FailureReason } from "./run.ts";
import type { EvidenceRef, Exclusion, Finding } from "./types.ts";

export interface DiffEvidence {
  source: DiffSource;
  files: DiffFile[];
  /** Hunks eligible to be judged, in diff order. */
  hunks: Hunk[];
  excluded: Exclusion[];
}

export async function loadDiff(
  dependencies: Pick<WorkflowDependencies, "source" | "evidence">,
  selection: DiffSelection,
): Promise<DiffEvidence> {
  const source = await dependencies.source.collectDiff(selection);
  const files = dependencies.evidence.unifiedDiff(source.text);
  const hunks: Hunk[] = [];
  const excluded: Exclusion[] = [];
  for (const file of files) {
    const reason =
      file.status === "binary"
        ? "binary change"
        : file.status === "mode_only"
          ? "mode change only"
          : contentExclusionReason(file.kind);
    if (reason) {
      excluded.push({ id: `file:${file.path}`, path: file.path, reason });
      continue;
    }
    hunks.push(...file.hunks);
  }
  return { source, files, hunks, excluded };
}

export function hunkEvidence(hunk: Hunk): JsonObject {
  return {
    id: hunk.id,
    path: hunk.path,
    kind: hunk.kind,
    fileStatus: hunk.fileStatus,
    oldRange: `${hunk.oldStart},${hunk.oldLines}`,
    newRange: `${hunk.newStart},${hunk.newLines}`,
    part: hunk.part ? `${hunk.part.index} of ${hunk.part.count}` : null,
    content: hunkText(hunk),
  };
}

export function hunkRef(hunk: Hunk, source: DiffSource): EvidenceRef {
  return {
    kind: "git_hunk",
    id: hunk.id,
    path: hunk.path,
    startLine: hunk.newStart,
    endLine: hunk.newStart + Math.max(hunk.newLines - 1, 0),
    probe: `${source.probe}${source.baseCommit ? `@${source.baseCommit.slice(0, 12)}` : ""}`,
    truncated: hunk.part !== null,
  };
}

export function diffNotChecked(source: DiffSource): string[] {
  const notes: string[] = [];
  if (source.untrackedFiles.length > 0) {
    notes.push(`${source.untrackedFiles.length} untracked file(s) are not part of the diff`);
  }
  return notes;
}

export const MAX_TASK_CHARS = 4000;

export function requireTask(task: string | undefined, label = "task"): string {
  const value = task?.trim() ?? "";
  if (value.length === 0) throw new InputError(`${label} text is required`);
  return boundedTask(value, label);
}

export function boundedTask(value: string, label = "task"): string {
  if (value.length > MAX_TASK_CHARS) {
    throw new InputError(`${label} text is ${value.length} characters; the limit is ${MAX_TASK_CHARS}`);
  }
  return value;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1) ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      a.flag.localeCompare(b.flag),
  );
}

/** Failures caused by missing capacity or availability are unjudged; bad answers are failed. */
export function unjudgedOrFailed(reason: FailureReason): "unjudged" | "failed" {
  return reason === "unavailable" || reason === "budget" || reason === "aborted" ? "unjudged" : "failed";
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "where",
  "what",
  "which",
  "should",
  "does",
  "not",
  "are",
  "fix",
  "add",
  "make",
  "use",
]);

/** Lowercase word tokens from free text, used only for deterministic ordering and linking. */
export function taskTokens(task: string): string[] {
  const words = task
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return [...new Set(words)];
}

export function describeScope(source: DiffSource): JsonObject {
  return {
    scope: source.scope,
    baseRef: source.baseRef,
    baseCommit: source.baseCommit,
    headCommit: source.headCommit,
    probe: source.probe,
  };
}
