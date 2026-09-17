import { hashValue } from "../core/hash.ts";
import {
  CHECK_CRITERIA_POLICY,
  type CriterionResult,
  criteriaSection,
  parseCriteria,
} from "./check-criteria.ts";
import { CHECK_RULES_POLICY, parseRules, type RulePairResult, rulesSection } from "./check-rules.ts";
import { CHECK_TASK_POLICY, type TaskHunkResult, taskSection } from "./check-task.ts";
import {
  describeScope,
  diffNotChecked,
  loadDiff,
  requireTask,
  type Section,
  type SectionReport,
  sortFindings,
} from "./common.ts";
import { InputError } from "./errors.ts";
import type { DiffScope } from "./ports.ts";
import { Run, type RunOptions } from "./run.ts";
import type { Packet } from "./types.ts";

/** Text supplied by the caller plus a label for where it came from (a path, "stdin", or "argument"). */
export interface CheckSource {
  text: string;
  source: string;
}

export interface CheckInput {
  task: string;
  taskSource?: "user" | "issue" | "agent";
  /** A rules file (JSON). Omit to skip the rules section. */
  rules?: CheckSource | null;
  /** Acceptance criteria as a numbered or bulleted list. Omit to skip the criteria section. */
  criteria?: CheckSource | null;
  /** JSON or JUnit test records. Only meaningful with criteria. */
  testResults?: CheckSource | null;
  scope?: DiffScope;
  base?: string;
  maxHunks?: number;
  maxPairs?: number;
  maxEvidenceUnits?: number;
}

export const CHECK = {
  name: "check",
  version: 1,
  budget: { requests: 400, inputTokens: 600_000, wallMs: 180_000 },
} as const;

export type CheckSection = "task" | "rules" | "criteria";

/** One row of the combined report. `section` says which part of `check` produced it. */
export type CheckResult =
  | ({ section: "task" } & TaskHunkResult)
  | ({ section: "rules" } & RulePairResult)
  | ({ section: "criteria" } & CriterionResult);

/**
 * Check one diff against the task, and optionally against project rules and acceptance criteria.
 * The diff is gathered once and every section reports into the same run and packet.
 */
export async function check(input: CheckInput, options: RunOptions): Promise<Packet<CheckResult>> {
  const taskText = requireTask(input.task);
  const taskSource = input.taskSource ?? "user";
  if (input.testResults && !input.criteria) {
    throw new InputError("test results are only used as criterion evidence; supply criteria with them");
  }
  const rules = input.rules ? parseRules(input.rules.text) : null;
  const criteria = input.criteria ? parseCriteria(input.criteria.text) : null;
  const tests = input.testResults ? options.dependencies.evidence.testRecords(input.testResults.text) : [];
  const maxHunks = input.maxHunks ?? CHECK_TASK_POLICY.defaultMaxHunks;
  const maxPairs = input.maxPairs ?? CHECK_RULES_POLICY.defaultMaxPairs;
  const maxEvidenceUnits = input.maxEvidenceUnits ?? CHECK_CRITERIA_POLICY.defaultMaxEvidenceUnits;

  const diff = await loadDiff(options.dependencies, {
    scope: input.scope ?? "worktree",
    ...(input.base ? { base: input.base } : {}),
  });
  const run = await Run.start(CHECK, options, {
    taskHash: hashValue(taskText),
    taskSource,
    rules: input.rules && rules ? { source: input.rules.source, hash: hashValue(rules), maxPairs } : null,
    criteria:
      input.criteria && criteria
        ? { source: input.criteria.source, hash: hashValue(criteria), maxEvidenceUnits }
        : null,
    testResults: input.testResults ? { source: input.testResults.source, records: tests.length } : null,
    diff: describeScope(diff.source),
    diffHash: hashValue(diff.source.text),
    maxHunks,
  });
  for (const item of diff.excluded) run.setDisposition(item.id, "excluded");

  const sections: Array<[CheckSection, Section<TaskHunkResult | RulePairResult | CriterionResult>]> = [
    ["task", taskSection(run, diff, { task: { text: taskText, source: taskSource }, maxHunks })],
  ];
  if (rules) sections.push(["rules", rulesSection(run, diff, { rules, maxPairs })]);
  if (criteria)
    sections.push(["criteria", criteriaSection(run, diff, { criteria, tests, maxEvidenceUnits })]);
  await run.candidates({
    diff: describeScope(diff.source),
    excluded: diff.excluded,
    ...Object.fromEntries(sections.map(([name, section]) => [name, section.candidates])),
  });

  // Sections judge in a fixed order so request order, budget use, and artifacts are reproducible.
  const reports = new Map<CheckSection, SectionReport<TaskHunkResult | RulePairResult | CriterionResult>>();
  for (const [name, section] of sections) reports.set(name, await section.judge());

  const all = [...reports.values()];
  const skipped = [
    ...(rules ? [] : ["project rules (no rules supplied)"]),
    ...(criteria ? [] : ["acceptance criteria (no criteria supplied)"]),
  ];
  return run.finish({
    findings: sortFindings(all.flatMap((report) => report.findings)),
    parked: all.flatMap((report) => report.parked),
    excluded: diff.excluded,
    limits: all.flatMap((report) => report.limits),
    notChecked: [
      ...new Set([...all.flatMap((report) => report.notChecked), ...skipped, ...diffNotChecked(diff.source)]),
    ],
    results: [...reports].flatMap(([section, report]) =>
      report.results.map((result) => ({ section, ...result }) as CheckResult),
    ),
    summary: {
      diff: describeScope(diff.source),
      sections: [...reports.keys()],
      task: reports.get("task")!.summary,
      rules: reports.get("rules")?.summary ?? null,
      criteria: reports.get("criteria")?.summary ?? null,
    },
    incomplete: all.some((report) => report.incomplete),
  });
}
