import type { Budget, BudgetLimits } from "../core/budget.ts";
import { FrameExecutor, type FrameFailure, type FrameOutcome } from "../core/executor.ts";
import { createFrame } from "../core/frame.ts";
import { hashValue } from "../core/hash.ts";
import type { Questions } from "../core/questions.ts";
import type { JevUsage, JsonObject, JsonValue } from "../core/types.ts";
import { InputError } from "./errors.ts";
import type { ArtifactWriter, WorkflowDependencies } from "./ports.ts";
import {
  type Coverage,
  DEFAULT_MODEL,
  type EvidenceRef,
  type Exclusion,
  type Finding,
  PACKET_SCHEMA,
  type Packet,
  type Parked,
  RUN_SCHEMA,
  type WorkflowFrame,
} from "./types.ts";

export interface RunOptions {
  /** Workspace root, used only to relate reported paths to tracked paths. */
  root: string;
  model?: string;
  dependencies: WorkflowDependencies;
  /** Record artifacts through the artifact store. Default true. */
  persist?: boolean;
  budget?: Partial<BudgetLimits>;
  /** Shared across every Jev executor in one composed invocation tree. */
  sharedBudget?: Budget;
  concurrency?: number;
  /** Retries for transient failures only. */
  retries?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export type FailureReason = FrameFailure;
export type Outcome<A> = FrameOutcome<A>;

export type Disposition = "judged" | "deterministic" | "excluded" | "parked" | "failed" | "unjudged";

export interface WorkflowInfo {
  name: string;
  version: number;
  budget: BudgetLimits;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Per-run workflow context: redaction, recording, dispositions, and the packet envelope around the core executor. */
export class Run {
  readonly id: string;
  readonly workflow: WorkflowInfo;
  readonly root: string;
  readonly model: string;
  recorder: ArtifactWriter | null = null;
  private readonly executor: FrameExecutor<EvidenceRef>;
  private readonly dispositions = new Map<string, Disposition>();
  private readonly persist: boolean;

  private constructor(workflow: WorkflowInfo, options: RunOptions) {
    const { dependencies } = options;
    this.workflow = workflow;
    this.root = options.root;
    this.model = options.model ?? DEFAULT_MODEL;
    if (!MODEL_ID.test(this.model)) throw new InputError("invalid model identifier");
    this.persist = options.persist ?? true;
    this.id = dependencies.createRunId(workflow.name);
    const redaction = dependencies.redaction;
    this.executor = new FrameExecutor<EvidenceRef>({
      port: dependencies.jev,
      model: this.model,
      budget: { ...workflow.budget, ...definedOnly(options.budget ?? {}) },
      ...(options.sharedBudget ? { sharedBudget: options.sharedBudget } : {}),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.retries === undefined ? {} : { retries: options.retries }),
      ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
      ...(options.signal ? { signal: options.signal } : {}),
      prepare(request) {
        const state = redaction.json(request.state);
        const questions = redaction.json(request.questions as unknown as JsonObject);
        return {
          request: { ...request, state: state.value, questions: questions.value as unknown as Questions },
          changes: state.count + questions.count,
        };
      },
      classifyError: (error) => dependencies.classifyError(error),
      describeError: (error) => redaction.message(error),
      sink: {
        attempt: async (record) => {
          await this.recorder?.line("frames.ndjson", { runId: this.id, ...record });
        },
        budgetExhausted: (frameId, limit) => this.event("budget_exhausted", { frameId, limit }),
      },
    });
  }

  static async start(workflow: WorkflowInfo, options: RunOptions, inputs: JsonObject): Promise<Run> {
    const run = new Run(workflow, options);
    if (run.persist) {
      run.recorder = (await options.dependencies.artifacts?.open(run.id)) ?? null;
    }
    if (run.recorder) {
      await run.recorder.json("manifest.json", run.manifest("running"));
      await run.recorder.json("inputs.json", { schema: RUN_SCHEMA, inputs, inputsHash: hashValue(inputs) });
    }
    return run;
  }

  get budget() {
    return this.executor.budget;
  }

  get redactions(): number {
    return this.executor.preparedChanges;
  }

  /** Why Jev is not being called, or null when it is available. */
  get unavailable(): string | null {
    return this.executor.unavailableReason;
  }

  setDisposition(candidateId: string, disposition: Disposition): void {
    this.dispositions.set(candidateId, disposition);
  }

  async event(type: string, detail: JsonObject = {}): Promise<void> {
    await this.recorder?.line("events.ndjson", { at: new Date().toISOString(), type, ...detail });
  }

  async decision(candidateId: string, rule: string, result: JsonValue, policyVersion: string): Promise<void> {
    await this.recorder?.line("decisions.ndjson", { candidateId, rule, result, policyVersion });
  }

  async candidates(value: unknown): Promise<void> {
    await this.recorder?.json("candidates.json", value);
  }

  /** Judge many frames with bounded concurrency; results keep frame order. */
  judgeAll<A>(frames: readonly WorkflowFrame<A>[]): Promise<Outcome<A>[]> {
    return this.executor.runAll(frames);
  }

  /** Submit one frame. Identical frames within a run are asked once. */
  judge<A>(frame: WorkflowFrame<A>): Promise<Outcome<A>> {
    return this.executor.run(frame);
  }

  coverage(): Coverage {
    const counts: Record<Disposition, number> = {
      judged: 0,
      deterministic: 0,
      excluded: 0,
      parked: 0,
      failed: 0,
      unjudged: 0,
    };
    for (const disposition of this.dispositions.values()) counts[disposition]++;
    return {
      candidates: this.dispositions.size,
      ...counts,
      complete: counts.failed === 0 && counts.unjudged === 0,
    };
  }

  jevUsage(): JevUsage {
    return this.executor.usage();
  }

  /** Assemble, persist, and return the packet. */
  async finish<R>(parts: {
    findings: Finding[];
    parked: Parked[];
    excluded: Exclusion[];
    limits: string[];
    notChecked: string[];
    results: R[];
    summary: JsonObject;
    incomplete?: boolean;
  }): Promise<Packet<R>> {
    const coverage = this.coverage();
    if (parts.incomplete) coverage.complete = false;
    const jev = this.jevUsage();
    const status: Packet["status"] = this.budget.exhausted
      ? "budget_exhausted"
      : coverage.complete
        ? "complete"
        : "incomplete";
    const limits = [...parts.limits];
    if (this.budget.exhausted) limits.push(`budget exhausted (${this.budget.exhausted})`);
    if (this.unavailable) limits.push(`Jev not called: ${this.unavailable}`);
    const packet: Packet<R> = {
      schema: PACKET_SCHEMA,
      workflow: `${this.workflow.name}@${this.workflow.version}`,
      runId: this.id,
      advisory: true,
      status,
      coverage,
      findings: parts.findings,
      parked: parts.parked,
      excluded: parts.excluded,
      limits,
      notChecked: parts.notChecked,
      results: parts.results,
      summary: parts.summary,
      redactions: this.redactions,
      jev,
      artifact: this.recorder?.relative ?? null,
    };
    if (this.recorder) {
      await this.recorder.json("packet.json", packet);
      await this.recorder.json("manifest.json", this.manifest(status));
      await this.recorder.flush();
    }
    return packet;
  }

  private manifest(status: string): JsonObject {
    return {
      schema: RUN_SCHEMA,
      runId: this.id,
      workflow: `${this.workflow.name}@${this.workflow.version}`,
      status,
      requestedModel: this.model,
      budget: { ...this.budget.limits },
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Build a workflow frame with a stable content-derived ID. */
export function buildFrame<A>(spec: Omit<WorkflowFrame<A>, "id">): WorkflowFrame<A> {
  return createFrame<A, EvidenceRef>(spec);
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
