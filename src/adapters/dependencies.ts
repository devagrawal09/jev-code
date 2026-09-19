import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import type { JevPort, TransportFailure } from "../core/types.ts";
import type {
  ArtifactStore,
  EvidenceParser,
  WorkflowDependencies,
  WorkspaceSource,
} from "../workflows/ports.ts";
import { parseComments } from "./comments.ts";
import { parseUnifiedDiff } from "./diff.ts";
import { collectDiff, trackedFiles } from "./git.ts";
import { classifyError } from "./jev.ts";
import { parseFailureLog } from "./logs.ts";
import { readLines, resolveWorkspacePath } from "./paths.ts";
import { Recorder } from "./recorder.ts";
import { createRedaction } from "./redact.ts";
import { parseTestRecords } from "./test-records.ts";

/** Read-only git and filesystem inputs confined to `root`. */
export function createWorkspaceSource(root: string): WorkspaceSource {
  return {
    collectDiff: (selection) => collectDiff(root, selection),
    trackedFiles: () => trackedFiles(root),
    readLines: (path, maxBytes) => readLines(root, path, maxBytes),
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

// createRedaction moved to redact.ts (env-aware); re-exported for callers.
export { createRedaction } from "./redact.ts";

/** Artifacts under `<root>/.jev-code/runs`. */
export function createArtifactStore(root: string): ArtifactStore {
  return { open: (runId) => Recorder.open(root, runId) };
}

export function createRunId(workflow: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${workflow}-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Every workflow port implemented for a local workspace. */
export function createWorkflowDependencies(
  root: string,
  jev: JevPort,
  classify?: (error: unknown) => TransportFailure,
  env: NodeJS.ProcessEnv = process.env,
): WorkflowDependencies {
  return {
    jev,
    source: createWorkspaceSource(root),
    evidence: createEvidenceParser(),
    redaction: createRedaction(env, portSecrets(jev)),
    artifacts: createArtifactStore(root),
    // Prefer the classifier the port itself declares, so a provider-aware
    // port can never be paired with a foreign classifier by default.
    classifyError: classify ?? defaultClassifierFor(jev),
    createRunId,
  };
}

import { portSecrets } from "./jev.ts";

/** The port's own classifier (bound to the port), or the TypeSafe default. */
function defaultClassifierFor(jev: JevPort): (error: unknown) => TransportFailure {
  const candidate = (jev as { classifyError?: unknown }).classifyError;
  // Bind so a method-style classifier keeps the port as `this` when invoked
  // through the dependencies object.
  return typeof candidate === "function"
    ? (candidate as (this: JevPort, error: unknown) => TransportFailure).bind(jev)
    : classifyError;
}
