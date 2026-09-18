import { CHECK, type CheckInput, type CheckResult, check } from "../workflows/check.ts";
import { FIND, type FindInput, type FindResult, find } from "../workflows/find.ts";
import type { RunOptions, WorkflowInfo } from "../workflows/run.ts";
import {
  TRIAGE,
  type TriageCommentsInput,
  type TriageCommentsResult,
  type TriageFailuresInput,
  type TriageFailuresResult,
  triageComments,
  triageFailures,
} from "../workflows/triage.ts";
import type { Packet } from "../workflows/types.ts";
import type { HumanSection } from "./output.ts";
import type { WorkflowName } from "./router.ts";

export interface WorkflowDefinition<I, R> {
  info: WorkflowInfo;
  summary: string;
  run(input: I, options: RunOptions): Promise<Packet<R>>;
  render(packet: Packet<R>): HumanSection[];
}

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : value.toFixed(2);

/** Results of one `check` section, in report order. */
function sectionOf<S extends CheckResult["section"]>(packet: Packet<CheckResult>, section: S) {
  return packet.results.filter(
    (result): result is Extract<CheckResult, { section: S }> => result.section === section,
  );
}

export const checkWorkflow: WorkflowDefinition<CheckInput, CheckResult> = {
  info: CHECK,
  summary: "Check a diff against its task, and optionally project rules and acceptance criteria",
  run: check,
  render: (packet) => [
    {
      title: "task: hunks needing attention",
      lines: sectionOf(packet, "task")
        .filter((result) => result.flags.length > 0 || result.error)
        .slice(0, 30)
        .map(
          (result) =>
            `${result.path}:${result.lines} [${result.disposition}] ${result.flags.join(",") || "-"} low=${pct(result.taskRelation?.lowMass)}${result.error ? ` (${result.error})` : ""}`,
        ),
    },
    {
      title: "rules: pairs needing attention",
      lines: sectionOf(packet, "rules")
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
    {
      title: "criteria",
      lines: sectionOf(packet, "criteria").map(
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

export const triageFailuresWorkflow: WorkflowDefinition<TriageFailuresInput, TriageFailuresResult> = {
  info: TRIAGE,
  summary: "Sort test failures and show which need attention",
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

export const triageCommentsWorkflow: WorkflowDefinition<TriageCommentsInput, TriageCommentsResult> = {
  info: TRIAGE,
  summary: "Sort review comments and show which need attention",
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

export const findWorkflow: WorkflowDefinition<FindInput, FindResult> = {
  info: FIND,
  summary: "Find files that may be relevant to a task",
  run: find,
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

/**
 * Transport-neutral internal routing targets. Public callers describe their intent instead of naming these.
 */
export const WORKFLOWS = {
  find: findWorkflow,
  check: checkWorkflow,
  triage_failures: triageFailuresWorkflow,
  triage_comments: triageCommentsWorkflow,
} as const satisfies Record<WorkflowName, unknown>;

export type { WorkflowName } from "./router.ts";
