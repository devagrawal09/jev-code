import { AUDIT_DIFF, type AuditDiffInput, type AuditHunkResult, auditDiff } from "../workflows/audit-diff.ts";
import {
  CHECK_CRITERIA,
  type CheckCriteriaInput,
  type CriterionResult,
  checkCriteria,
} from "../workflows/check-criteria.ts";
import {
  CHECK_RULES,
  type CheckRulesInput,
  checkRules,
  type RulePairResult,
} from "../workflows/check-rules.ts";
import { LOCATE, type LocateInput, type LocateResult, locate } from "../workflows/locate.ts";
import type { RunOptions, WorkflowInfo } from "../workflows/run.ts";
import { type FrameAnswerResult, RUN_FRAME, runFrame } from "../workflows/run-frame.ts";
import {
  type CommentResult,
  TRIAGE_COMMENTS,
  type TriageCommentsInput,
  triageComments,
} from "../workflows/triage-comments.ts";
import {
  type FailureResult,
  TRIAGE_FAILURES,
  type TriageFailuresInput,
  triageFailures,
} from "../workflows/triage-failures.ts";
import type { Packet } from "../workflows/types.ts";
import type { HumanSection } from "./output.ts";

/**
 * Public maturity of a command. `stable` workflows are the launch surface; `preview` workflows work but their
 * output may change; `experimental` workflows are not part of the launch claim; `advanced` is an escape hatch.
 */
export type Stability = "stable" | "preview" | "experimental" | "advanced";

export interface WorkflowDefinition<I, R> {
  info: WorkflowInfo;
  stability: Stability;
  summary: string;
  run(input: I, options: RunOptions): Promise<Packet<R>>;
  render(packet: Packet<R>): HumanSection[];
}

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : value.toFixed(2);

export const auditDiffWorkflow: WorkflowDefinition<AuditDiffInput, AuditHunkResult> = {
  info: AUDIT_DIFF,
  stability: "stable",
  summary: "Flag diff hunks weakly related to the task and test hunks that weaken expectations",
  run: auditDiff,
  render: (packet) => [
    {
      title: "hunks",
      lines: packet.results
        .filter((result) => result.flags.length > 0 || result.error)
        .slice(0, 30)
        .map(
          (result) =>
            `${result.path}:${result.lines} [${result.disposition}] ${result.flags.join(",") || "-"} low=${pct(result.taskRelation?.lowMass)}${result.error ? ` (${result.error})` : ""}`,
        ),
    },
  ],
};

export const triageFailuresWorkflow: WorkflowDefinition<TriageFailuresInput, FailureResult> = {
  info: TRIAGE_FAILURES,
  stability: "stable",
  summary: "Parse a supplied test/CI log into failure blocks and classify each against the diff",
  run: triageFailures,
  render: (packet) => [
    {
      title: "failures",
      lines: packet.results
        .slice(0, 30)
        .flatMap((result) => [
          `${result.testName ?? result.id} (log ${result.lines}) relation=${result.relation.label} kind=${result.failureKind.label}${result.duplicateOf ? ` duplicate-of=${result.duplicateOf}` : ""}`,
          ...(result.message ? [`    ${result.message.slice(0, 140)}`] : []),
          ...(result.wouldSettle.length > 0 ? [`    would settle: ${result.wouldSettle.join("; ")}`] : []),
        ]),
    },
  ],
};

export const locateWorkflow: WorkflowDefinition<LocateInput, LocateResult> = {
  info: LOCATE,
  stability: "experimental",
  summary: "Rank tracked files for a task from metadata and bounded excerpts (a shortlist, not an answer)",
  run: locate,
  render: (packet) => [
    {
      title: "ranked candidates",
      lines: packet.results
        .filter((result) => result.rank !== null)
        .map(
          (result) =>
            `${result.rank}. ${result.path}${result.excerpt ? `:${result.excerpt.ranges.join(",")}` : ""} relevance=${pct(result.relevance)} role=${result.metadata?.role ?? "-"}${result.excerpt ? ` missing=${result.excerpt.missingEvidence}` : ""}`,
        ),
    },
    {
      title: "gaps",
      lines: Array.isArray(packet.summary.gaps) ? packet.summary.gaps.map(String) : [],
    },
  ],
};

export const checkCriteriaWorkflow: WorkflowDefinition<CheckCriteriaInput, CriterionResult> = {
  info: CHECK_CRITERIA,
  stability: "preview",
  summary: "Map each acceptance criterion to diff and supplied test-record evidence",
  run: checkCriteria,
  render: (packet) => [
    {
      title: "criteria",
      lines: packet.results.map(
        (result) =>
          `${result.status.padEnd(11)} ${result.text.slice(0, 100)}${result.cappedBy ? ` (capped: ${result.cappedBy})` : ""}${
            result.evidence.length > 0
              ? ` ← ${result.evidence
                  .map((e) => `${e.path}:${e.lines}`)
                  .slice(0, 3)
                  .join(", ")}`
              : ""
          }`,
      ),
    },
  ],
};

export const checkRulesWorkflow: WorkflowDefinition<CheckRulesInput, RulePairResult> = {
  info: CHECK_RULES,
  stability: "preview",
  summary: "Flag diff hunks that may break human-approved semantic rules from a rules file",
  run: checkRules,
  render: (packet) => [
    {
      title: "rule pairs needing attention",
      lines: packet.results
        .filter(
          (result) =>
            result.verdict === "violation_flagged" || result.verdict === "uncertain" || result.error,
        )
        .slice(0, 30)
        .map(
          (result) =>
            `${result.verdict} ${result.rule} @ ${result.path}:${result.lines}${result.error ? ` (${result.error})` : ""}`,
        ),
    },
  ],
};

export const triageCommentsWorkflow: WorkflowDefinition<TriageCommentsInput, CommentResult> = {
  info: TRIAGE_COMMENTS,
  stability: "experimental",
  summary:
    "Relate review comments to current code: actionable, already addressed, stale, unclear, non-actionable",
  run: triageComments,
  render: (packet) => [
    {
      title: "comments",
      lines: packet.results
        .slice(0, 40)
        .map(
          (result) =>
            `${result.classification.padEnd(17)} ${result.path ? `${result.path}${result.line ? `:${result.line}` : ""} ` : ""}"${result.excerpt.slice(0, 90)}"${result.duplicateOf ? ` duplicate-of=${result.duplicateOf}` : ""}`,
        ),
    },
  ],
};

export const runFrameWorkflow: WorkflowDefinition<{ file: string }, FrameAnswerResult> = {
  info: RUN_FRAME,
  stability: "advanced",
  summary: "Escape hatch: submit one validated custom frame file; answers are uncalibrated",
  run: runFrame,
  render: (packet) => [
    {
      title: "answers (uncalibrated)",
      lines: packet.results.map((result) =>
        result.type === "noul"
          ? `${result.question}: p=${pct(result.probability)}`
          : result.type === "choice"
            ? `${result.question}: ${result.choice} (confidence ${pct(result.confidence)})`
            : `${result.question}: expected ${pct(result.expected)} (confidence ${pct(result.confidence)})`,
      ),
    },
  ],
};

/** Transport-neutral registry. A CLI, MCP adapter, or hook runner can dispatch through it. */
export const WORKFLOWS = {
  "flag-diff": auditDiffWorkflow,
  "triage-failures": triageFailuresWorkflow,
  "flag-rules": checkRulesWorkflow,
  "map-criteria": checkCriteriaWorkflow,
  "triage-comments": triageCommentsWorkflow,
  locate: locateWorkflow,
  "run-frame": runFrameWorkflow,
} as const;

export type WorkflowName = keyof typeof WORKFLOWS;
