import type { JevPort, JsonObject, JsonValue, TransportFailure } from "../core/types.ts";
import type { DiffFile, ParsedLog, ReviewComment, TestRecord } from "./evidence.ts";

export type DiffScope = "worktree" | "staged" | "branch";

export interface DiffSelection {
  scope: DiffScope;
  base?: string;
}

/** Raw diff text plus the metadata of how it was collected. */
export interface DiffSource {
  text: string;
  scope: DiffScope;
  baseRef: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  probe: string;
  untrackedFiles: string[];
}

/**
 * Source port: read-only workspace inputs. Implementations keep every read inside the
 * workspace, refuse credential-shaped paths, and never write.
 */
export interface WorkspaceSource {
  collectDiff(selection: DiffSelection): Promise<DiffSource>;
  trackedFiles(): Promise<string[]>;
  /** Lines of a readable text file, or null when missing, binary, oversize, or refused. */
  readLines(path: string, maxBytes?: number): Promise<{ lines: string[]; bytes: number } | null>;
  /** A whole file; throws InputError when missing, oversize, or outside the workspace. */
  readFile(path: string, maxBytes?: number): Promise<{ path: string; text: string; bytes: number }>;
  fileSize(path: string): Promise<number | null>;
}

/** Evidence port: parses externally produced formats. Throws InputError on malformed input. */
export interface EvidenceParser {
  unifiedDiff(text: string): DiffFile[];
  failureLog(text: string): ParsedLog;
  reviewComments(text: string): ReviewComment[];
  testRecords(text: string): TestRecord[];
}

export interface RedactionPort {
  json<T extends JsonValue>(value: T): { value: T; count: number };
  text(value: string): { text: string; count: number };
  /** A redacted, bounded message for a thrown error. */
  message(error: unknown): string;
}

export interface ArtifactWriter {
  /** Display location of the run's artifacts. */
  readonly relative: string;
  json(name: string, value: unknown): Promise<void>;
  line(name: string, value: unknown): Promise<void>;
  flush(): Promise<void>;
}

/** Storage port for run artifacts. */
export interface ArtifactStore {
  open(runId: string): Promise<ArtifactWriter>;
  /** The recorded `inputs` of the most recent runs of a workflow, newest first. */
  recentInputs(workflow: string, limit: number): Promise<JsonObject[]>;
}

export interface WorkflowDependencies {
  jev: JevPort;
  source: WorkspaceSource;
  evidence: EvidenceParser;
  redaction: RedactionPort;
  artifacts?: ArtifactStore;
  classifyError(error: unknown): TransportFailure;
  createRunId(workflow: string): string;
}
