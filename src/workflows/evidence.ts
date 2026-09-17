import type { PathKind } from "./classify.ts";

/**
 * Evidence types the workflows judge. Evidence parser ports produce them from external formats
 * (unified diffs, CI logs, review-comment exports, test reports); workflows never parse those formats.
 */

export const MAX_HUNK_LINES = 300;
export const LOG_CONTEXT_LINES = 12;
export const MAX_BLOCK_LINES = 160;
export const MAX_LOG_LINES = 200_000;
export const MAX_COMMENTS = 1000;
export const MAX_COMMENT_BODY_CHARS = 4000;
export const MAX_TEST_RECORDS = 5000;

export interface DiffLine {
  type: "+" | "-" | " ";
  text: string;
}

export interface Hunk {
  id: string;
  path: string;
  oldPath: string | null;
  fileStatus: "modified" | "added" | "deleted";
  kind: PathKind;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** Set when a hunk over MAX_HUNK_LINES was split deterministically into consecutive parts. */
  part: { index: number; count: number } | null;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: "modified" | "added" | "deleted" | "binary" | "mode_only";
  kind: PathKind;
  hunks: Hunk[];
}

export interface LogLine {
  n: number;
  text: string;
}

export interface FailureBlock {
  id: string;
  startLine: number;
  endLine: number;
  lines: LogLine[];
  /** Lines omitted from an overlong window (reported, never silent). */
  omittedLines: number;
  anchors: string[];
  testName: string | null;
  message: string | null;
  stackLocations: Array<{ path: string; line: number | null }>;
  signature: string;
  fingerprint: string;
  envSignature: string | null;
  compileError: boolean;
  missingModule: boolean;
  timeout: boolean;
}

export interface ParsedLog {
  totalLines: number;
  blocks: FailureBlock[];
}

export interface ReviewComment {
  id: string;
  sourceId: string | null;
  body: string;
  bodyTruncated: boolean;
  path: string | null;
  line: number | null;
  startLine: number | null;
  author: string | null;
  authorKind: "human" | "bot" | "unknown";
  inReplyTo: string | null;
  outdated: boolean | null;
}

export interface TestRecord {
  name: string;
  status: "passed" | "failed" | "skipped";
  file: string | null;
}

/** Normalize volatile details (numbers, hex, quoted values, durations) for grouping. */
export function normalizeForSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "H")
    .replace(/\b[0-9a-f]{7,40}\b/g, "H")
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, "S")
    .replace(/\d+(?:\.\d+)?\s*(?:ms|s)\b/g, "D")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

/** Map a log-reported stack path to a tracked repository path, if one matches unambiguously. */
export function resolveStackPath(
  reported: string,
  root: string,
  tracked: ReadonlySet<string>,
): string | null {
  let path = reported.replace(/\\/g, "/").replace(/^file:\/\//, "");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (path.startsWith(`${normalizedRoot}/`)) path = path.slice(normalizedRoot.length + 1);
  path = path.replace(/^\.\//, "");
  if (tracked.has(path)) return path;
  const matches = [...tracked].filter(
    (candidate) => path.endsWith(`/${candidate}`) || candidate.endsWith(`/${path}`),
  );
  return matches.length === 1 ? matches[0]! : null;
}
