import type { Frame, JevUsage, JsonObject, JsonValue } from "../core/types.ts";

export const PACKET_SCHEMA = "stanley.packet/v1";
export const RUN_SCHEMA = "stanley.run/v1";
export const DEFAULT_MODEL = "jev-1.13.0";

/** Where a piece of evidence came from. Every packet item and frame carries these. */
export interface EvidenceRef {
  kind:
    | "git_hunk"
    | "file_range"
    | "file_metadata"
    | "log_window"
    | "test_record"
    | "comment"
    | "criterion"
    | "rule";
  id: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  /** The deterministic probe that produced the evidence, e.g. `git-diff-U3`. */
  probe: string;
  /** True when the evidence shown is a bounded part of a larger source. */
  truncated: boolean;
}

/** A judgment frame whose provenance is workflow evidence. */
export type WorkflowFrame<A> = Frame<A, EvidenceRef>;

export interface Coverage {
  candidates: number;
  judged: number;
  deterministic: number;
  excluded: number;
  parked: number;
  failed: number;
  unjudged: number;
  complete: boolean;
}

export interface Exclusion {
  id: string;
  path?: string;
  reason: string;
}

export interface Parked {
  id: string;
  path?: string;
  reason: string;
}

export interface Finding {
  flag: string;
  id: string;
  source: "deterministic" | "jev" | "policy";
  severity: "warn" | "info";
  path?: string;
  lines?: string;
  detail?: JsonObject;
}

export interface Packet<R = JsonValue> {
  schema: typeof PACKET_SCHEMA;
  workflow: string;
  runId: string;
  advisory: true;
  status: "complete" | "incomplete" | "budget_exhausted";
  coverage: Coverage;
  findings: Finding[];
  parked: Parked[];
  excluded: Exclusion[];
  limits: string[];
  notChecked: string[];
  results: R[];
  summary: JsonObject;
  redactions: number;
  jev: JevUsage;
  artifact: string | null;
}
