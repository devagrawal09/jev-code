import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import type { JevPort } from "../core/types.ts";
import type {
  ArtifactStore,
  EvidenceParser,
  RedactionPort,
  WorkflowDependencies,
  WorkspaceSource,
} from "../workflows/ports.ts";
import { parseComments } from "./comments.ts";
import { parseUnifiedDiff } from "./diff.ts";
import { collectDiff, trackedFiles } from "./git.ts";
import { classifyError } from "./jev.ts";
import { parseFailureLog } from "./logs.ts";
import { readLines, readWorkspaceFile, resolveWorkspacePath } from "./paths.ts";
import { Recorder, recentInputs } from "./recorder.ts";
import { redactJson, redactText, safeMessage } from "./redact.ts";
import { parseTestRecords } from "./test-records.ts";

/** Read-only git and filesystem inputs confined to `root`. */
export function createWorkspaceSource(root: string): WorkspaceSource {
  return {
    collectDiff: (selection) => collectDiff(root, selection),
    trackedFiles: () => trackedFiles(root),
    readLines: (path, maxBytes) => readLines(root, path, maxBytes),
    readFile: (path, maxBytes) => readWorkspaceFile(root, path, maxBytes),
    async fileSize(path) {
      try {
        const resolved = await resolveWorkspacePath(root, path);
        const info = await stat(resolved.absolute);
        return info.isFile() ? info.size : null;
      } catch {
        return null;
      }
    },
  };
}

export function createEvidenceParser(): EvidenceParser {
  return {
    unifiedDiff: parseUnifiedDiff,
    failureLog: (text) => parseFailureLog(text),
    reviewComments: parseComments,
    testRecords: parseTestRecords,
  };
}

export function createRedaction(): RedactionPort {
  return { json: (value) => redactJson(value), text: (value) => redactText(value), message: safeMessage };
}

/** Artifacts under `<root>/.jev/runs`. */
export function createArtifactStore(root: string): ArtifactStore {
  return {
    open: (runId) => Recorder.open(root, runId),
    recentInputs: (workflow, limit) => recentInputs(root, workflow, limit),
  };
}

export function createRunId(workflow: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${workflow}-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Every workflow port implemented for a local workspace. */
export function createWorkflowDependencies(root: string, jev?: JevPort): WorkflowDependencies {
  return {
    ...(jev ? { jev } : {}),
    source: createWorkspaceSource(root),
    evidence: createEvidenceParser(),
    redaction: createRedaction(),
    artifacts: createArtifactStore(root),
    classifyError,
    createRunId,
  };
}
