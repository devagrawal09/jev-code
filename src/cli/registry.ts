import {
  cleanupPlugins,
  type LoadPluginsOptions,
  loadPlugins,
  type PluginLoadResult,
} from "../adapters/plugins.ts";
import { type Plugin, pluginRoutingMetadata, validatePlugin } from "../core/plugin.ts";
import type { JsonObject } from "../core/types.ts";
import {
  COMPATIBILITY_REVIEW,
  compatibilityReview,
  type DiffAnalysisInput,
  type DiffAnalysisKind,
  type DiffAnalysisResult,
  PERFORMANCE_REVIEW,
  performanceReview,
  REVIEW,
  review,
  SECURITY_REVIEW,
  SUMMARIZE,
  securityReview,
  summarize,
  TEST_GAPS,
  testGaps,
} from "../workflows/analyze-diff.ts";
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
import { BUILTIN_ROUTING_CRITERIA, type WorkflowName } from "./router.ts";

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

function diffAnalysisWorkflow<K extends DiffAnalysisKind>(
  info: WorkflowInfo,
  summary: string,
  run: (input: DiffAnalysisInput, options: RunOptions) => Promise<Packet<DiffAnalysisResult<K>>>,
): WorkflowDefinition<DiffAnalysisInput, DiffAnalysisResult<K>> {
  return {
    info,
    summary,
    run,
    render: (packet) => [
      {
        title: summary.toLowerCase(),
        lines: packet.results
          .filter(
            (result) =>
              result.flag ||
              result.disposition === "parked" ||
              (result.error !== null && result.error !== "not judged: hunk limit") ||
              (result.analysis === "summarize" && result.classification !== null),
          )
          .sort(
            (a, b) =>
              Number(b.flag !== null) - Number(a.flag !== null) ||
              Number(b.disposition === "parked") - Number(a.disposition === "parked"),
          )
          .slice(0, 50)
          .map(
            (result) =>
              `${result.path}:${result.lines} [${result.disposition}] ${result.classification?.label ?? "-"}${result.analysis === "summarize" ? "" : ` concern=${pct(result.classification?.concernMass)}`} importance=${pct(result.importance?.highMass)} evidence=${pct(result.evidenceSufficient)}${result.flag ? ` flag=${result.flag}` : ""}${result.error ? ` (${result.error})` : ""}`,
          ),
      },
    ],
  };
}

export const reviewWorkflow = diffAnalysisWorkflow(REVIEW, "Review findings", review);
export const testGapsWorkflow = diffAnalysisWorkflow(TEST_GAPS, "Test gaps", testGaps);
export const summarizeWorkflow = diffAnalysisWorkflow(SUMMARIZE, "Change summary", summarize);
export const securityReviewWorkflow = diffAnalysisWorkflow(
  SECURITY_REVIEW,
  "Security review findings",
  securityReview,
);
export const performanceReviewWorkflow = diffAnalysisWorkflow(
  PERFORMANCE_REVIEW,
  "Performance review findings",
  performanceReview,
);
export const compatibilityReviewWorkflow = diffAnalysisWorkflow(
  COMPATIBILITY_REVIEW,
  "Compatibility review findings",
  compatibilityReview,
);

/**
 * Transport-neutral internal routing targets. Public callers describe their intent instead of naming these.
 */
export const WORKFLOWS = {
  find: findWorkflow,
  check: checkWorkflow,
  triage_failures: triageFailuresWorkflow,
  triage_comments: triageCommentsWorkflow,
  review: reviewWorkflow,
  test_gaps: testGapsWorkflow,
  summarize: summarizeWorkflow,
  security_review: securityReviewWorkflow,
  performance_review: performanceReviewWorkflow,
  compatibility_review: compatibilityReviewWorkflow,
} as const satisfies Record<WorkflowName, unknown>;

export type { WorkflowName } from "./router.ts";

// ---------------------------------------------------------------------------
// Workflow registry — one id space for built-in workflows and repository plugins.
// ---------------------------------------------------------------------------

/** Routing metadata the current built-in router consumes. */
export interface CandidateMetadata {
  readonly id: string;
  /** Arbitrary JSON presented unchanged as this choice's routing criteria. */
  readonly routing: JsonObject;
}

export type WorkflowKind = "builtin" | "plugin";

/** Where a registered workflow came from: `builtin`, or a repository-relative plugin path. */
export type WorkflowOrigin = string;

export interface RegisteredWorkflow {
  readonly id: string;
  readonly kind: WorkflowKind;
  readonly origin: WorkflowOrigin;
  readonly metadata: CandidateMetadata;
  /** The validated plugin object, for workflows registered from the plugin contract. */
  readonly plugin?: Plugin;
}

/** Ids the router itself uses as labels; no workflow may claim them. */
export const RESERVED_WORKFLOW_IDS: ReadonlySet<string> = new Set(["cannot_tell"]);

export class DuplicateWorkflowIdError extends Error {
  readonly id: string;
  readonly origins: readonly WorkflowOrigin[];

  constructor(id: string, origins: readonly WorkflowOrigin[]) {
    super(`duplicate workflow id: ${id} (registered by ${origins.join(" and ")})`);
    this.name = "DuplicateWorkflowIdError";
    this.id = id;
    this.origins = origins;
  }
}

export class ReservedWorkflowIdError extends Error {
  constructor(id: string, origin: WorkflowOrigin) {
    super(`reserved workflow id: ${id} (from ${origin})`);
    this.name = "ReservedWorkflowIdError";
  }
}

/**
 * The workflows available for intent routing. Duplicate ids always fail registration: nothing overrides a
 * built-in or another plugin, and nothing is chosen by precedence.
 */
export class WorkflowRegistry {
  private readonly entries = new Map<string, RegisteredWorkflow>();

  private check(additions: readonly RegisteredWorkflow[]): void {
    const seen = new Map<string, WorkflowOrigin>();
    for (const entry of additions) {
      if (RESERVED_WORKFLOW_IDS.has(entry.id)) throw new ReservedWorkflowIdError(entry.id, entry.origin);
      const existing = this.entries.get(entry.id)?.origin ?? seen.get(entry.id);
      if (existing !== undefined) throw new DuplicateWorkflowIdError(entry.id, [existing, entry.origin]);
      seen.set(entry.id, entry.origin);
    }
  }

  private add(additions: readonly RegisteredWorkflow[]): void {
    this.check(additions);
    for (const entry of additions) this.entries.set(entry.id, entry);
  }

  /** Register a workflow by its router metadata. Rejects duplicate and reserved ids. */
  register(metadata: CandidateMetadata, kind: WorkflowKind, origin: WorkflowOrigin = kind): void {
    this.add([{ id: metadata.id, kind, origin, metadata }]);
  }

  /** Register one validated plugin object. Rejects duplicate and reserved ids. */
  registerPlugin(plugin: Plugin, origin: WorkflowOrigin, kind: WorkflowKind = "plugin"): void {
    this.registerPlugins([{ plugin, origin, kind }]);
  }

  /** Register several plugins atomically: if any id is duplicate or reserved, none are registered. */
  registerPlugins(
    plugins: ReadonlyArray<{ plugin: Plugin; origin: WorkflowOrigin; kind?: WorkflowKind }>,
  ): void {
    this.add(
      plugins.map(({ plugin, origin, kind }) => ({
        id: validatePlugin(plugin).id,
        kind: kind ?? "plugin",
        origin,
        metadata: { id: plugin.id, routing: pluginRoutingMetadata(plugin) },
        plugin,
      })),
    );
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): RegisteredWorkflow | undefined {
    return this.entries.get(id);
  }

  /** The kind of a registered workflow, or undefined if not registered. */
  kindOf(id: string): WorkflowKind | undefined {
    return this.entries.get(id)?.kind;
  }

  /** All registered workflow ids in registration order. */
  ids(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** All registrations in registration order. */
  workflows(): readonly RegisteredWorkflow[] {
    return [...this.entries.values()];
  }

  /**
   * Router metadata for every workflow, in registration order.
   */
  candidates(): readonly CandidateMetadata[] {
    return this.workflows().map((entry) => entry.metadata);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Create a registry pre-populated with the ten built-in workflows.
 * The routing descriptions match the criteria the router uses for intent classification.
 */
export function createDefaultRegistry(): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  for (const [id, workflow] of Object.entries(WORKFLOWS)) {
    registry.register(
      {
        id,
        routing: {
          description: workflow.summary,
          instructions: BUILTIN_ROUTING_CRITERIA[id as WorkflowName],
        },
      },
      "builtin",
    );
  }
  return registry;
}

/**
 * Load repository plugins and register them atomically. Quarantined plugins are reported and skipped. A duplicate
 * or reserved id fails registration; every initialized plugin is then cleaned up and the error is rethrown.
 */
export async function registerRepositoryPlugins(
  registry: WorkflowRegistry,
  options: LoadPluginsOptions,
): Promise<PluginLoadResult> {
  const result = await loadPlugins(options);
  try {
    registry.registerPlugins(result.loaded.map(({ plugin, source }) => ({ plugin, origin: source.path })));
  } catch (error) {
    await cleanupPlugins(result.loaded, options.warn);
    throw error;
  }
  return result;
}
