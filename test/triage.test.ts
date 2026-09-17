import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul } from "../src/adapters/fake-jev.ts";
import { TRIAGE, type TriageResult, triage } from "../src/workflows/triage.ts";
import type { Packet } from "../src/workflows/types.ts";
import { fake, fixture, options, stateText, tempRepo } from "./helpers.ts";

function ofKind<K extends TriageResult["kind"]>(packet: Packet<TriageResult>, kind: K) {
  return packet.results.filter(
    (result): result is Extract<TriageResult, { kind: K }> => result.kind === kind,
  );
}

const RELATIONS = ["caused_by_diff", "unrelated_to_diff", "environment_or_infrastructure", "cannot_tell"];
const KINDS = [
  "assertion_mismatch",
  "runtime_exception",
  "compile_or_type_error",
  "timeout",
  "environment_or_setup",
  "snapshot_mismatch",
  "cannot_tell",
];
const MISSING = [
  "none",
  "full_stack_trace",
  "test_source",
  "changed_code",
  "prior_run_history",
  "cannot_tell",
];

function setup() {
  const test = Array.from({ length: 20 }, (_, index) => `// line ${index + 1}`);
  test[13] = '  expect(cart.total({ code: "SAVE10" })).toBe(90);';
  const repo = tempRepo({
    "src/cart.ts": "export function total(items) {\n  return 100;\n}\n",
    "src/cart.test.ts": `${test.join("\n")}\n`,
    "src/net.ts": "export const url = 'https://config.example.com/app';\n",
  });
  repo.write({ "src/cart.ts": "export function total(items, code) {\n  return code ? 100 : 100;\n}\n" });
  return repo;
}

describe("triage: failures", () => {
  test("classifies failures, runs one allowlisted probe, and parks ladder conflicts", async () => {
    const repo = setup();
    try {
      const adapter = fake((name, _q, request) => {
        const text = stateText(request);
        const isCart = text.includes("applies discount");
        const probed = "additionalEvidence" in request.state;
        if (name === "relation_to_diff") return fakeChoice(RELATIONS, "caused_by_diff", isCart ? 0.85 : 0.7);
        if (name === "failure_kind")
          return fakeChoice(KINDS, isCart ? "assertion_mismatch" : "environment_or_setup", 0.8);
        if (name === "missing_evidence")
          return fakeChoice(MISSING, isCart && !probed ? "test_source" : "none", 0.7);
        if (name === "nondeterminism_signature") return fakeNoul(0.1);
        return undefined;
      });
      const packet = await triage(
        {
          kind: "failures",
          text: fixture("jest-failure.txt"),
          source: "ci.txt",
          task: "Apply discount codes",
        },
        options(repo.root, adapter),
      );
      assert.equal(TRIAGE.name, "triage");
      assert.equal(packet.workflow, "triage@1");
      assert.match(packet.runId, /^triage-/);
      assert.equal(packet.summary.kind, "failures");
      assert.equal(packet.summary.source, "ci.txt");
      assert.equal(packet.results.length, 2);
      const [cart, net] = ofKind(packet, "failures");
      assert.equal(cart!.relation.label, "caused_by_diff");
      assert.equal(cart!.failureKind.label, "assertion_mismatch");
      assert.deepEqual(cart!.probesRun, ["read-stack-source@1"]);
      assert.equal(cart!.stackLocations[0]!.tracked, "src/cart.test.ts");
      const probeRequest = adapter.requests.find((request) => "additionalEvidence" in request.state)!;
      assert.match(stateText(probeRequest), /14\| +expect\(cart\.total/);

      assert.equal(net!.observed.envSignature, "network");
      assert.equal(net!.relation.label, "conflict");
      assert.equal(net!.disposition, "parked");
      assert.ok(packet.parked[0]!.reason.includes("environment signature"));
      assert.ok(packet.findings.some((finding) => finding.flag === "failure_likely_caused_by_diff"));
      assert.ok(
        packet.findings.some(
          (finding) => finding.flag === "environment_signature" && finding.source === "deterministic",
        ),
      );
      assert.ok(packet.notChecked.includes("tests were not executed or rerun"));
      assert.equal(adapter.requests.length, 3);
      assert.ok(cart!.keyLines.length <= 8);
    } finally {
      repo.cleanup();
    }
  });

  test("without diff context no relation is asked; duplicates and compile errors are deterministic", async () => {
    const repo = setup();
    try {
      const adapter = fake();
      const log = [
        "src/cart.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
        ...Array.from({ length: 40 }, () => "info: building"),
        "src/cart.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      ].join("\n");
      const packet = await triage(
        { kind: "failures", text: log, source: "stdin", diff: null },
        options(repo.root, adapter),
      );
      const results = ofKind(packet, "failures");
      assert.equal(results.length, 2);
      assert.equal(results[0]!.relation.label, "unknown_no_diff_context");
      assert.equal(results[0]!.failureKind.label, "compile_or_type_error");
      assert.equal(results[0]!.failureKind.determinedBy, "code");
      assert.equal(results[1]!.duplicateOf, results[0]!.id);
      assert.equal(adapter.requests.length, 1);
      assert.ok(!("relation_to_diff" in adapter.requests[0]!.questions));
      assert.ok(packet.notChecked.includes("relation to code changes (no diff context)"));
    } finally {
      repo.cleanup();
    }
  });

  test("unrecognized logs are incomplete, and failure limits are reported", async () => {
    const repo = setup();
    try {
      const empty = await triage(
        { kind: "failures", text: "everything passed\n", source: "stdin" },
        options(repo.root, fake()),
      );
      assert.equal(empty.status, "incomplete");
      assert.ok(empty.limits[0]!.includes("no failure anchors"));

      const pytest = await triage(
        {
          kind: "failures",
          text: `${fixture("jest-failure.txt")}\n${fixture("go-failure.txt")}`,
          source: "ci.txt",
          maxItems: 1,
        },
        options(repo.root, fake()),
      );
      assert.equal(pytest.coverage.complete, false);
      assert.ok(pytest.limits.some((limit) => limit.includes("--max-items")));
    } finally {
      repo.cleanup();
    }
  });
});

const STATUS = [
  "described_code_present",
  "described_code_absent_or_changed",
  "targets_lines_not_shown",
  "not_a_code_claim",
  "cannot_tell",
];

describe("triage: comments", () => {
  test("classifies comments against current code without obeying them", async () => {
    const repo = tempRepo({
      "src/cart.ts": "export function total(items, code) {\n  return items.length;\n}\n",
    });
    try {
      repo.write({
        "src/cart.ts":
          "export function total(items, code) {\n  return applyDiscount(items.length, code);\n}\n",
      });
      const adapter = fake((name, _q, request) => {
        const body = (request.state as { comment: { body: string } }).comment.body;
        const discount = body.includes("discount");
        if (name === "code_status")
          return fakeChoice(STATUS, discount ? "described_code_present" : "not_a_code_claim", 0.8);
        if (name === "requests_behavior_change") return fakeNoul(discount ? 0.9 : 0.2);
        if (name === "states_concrete_failure_scenario") return fakeNoul(discount ? 0.8 : 0.1);
        return undefined;
      });
      const packet = await triage(
        { kind: "comments", text: fixture("comments.json"), source: "comments.json" },
        options(repo.root, adapter),
      );
      assert.equal(packet.workflow, "triage@1");
      assert.equal(packet.summary.kind, "comments");
      const results = ofKind(packet, "comments");
      assert.equal(results.length, packet.results.length, "every result carries the input kind");
      const byId = Object.fromEntries(results.map((result) => [result.sourceId, result]));
      assert.equal(byId["101"]!.classification, "actionable");
      assert.equal(byId["101"]!.replies, 1);
      assert.equal(byId["103"]!.classification, "stale", "comment on a removed file");
      assert.equal(byId["103"]!.determinedBy, "code");
      assert.equal(byId["104"]!.classification, "non_actionable");
      assert.equal(byId["105"]!.duplicateOf, byId["104"]!.id);
      assert.equal(byId["106"]!.classification, "stale", "anchor past end of file");
      assert.equal(byId["102"], undefined, "replies are folded into their thread");

      assert.equal(adapter.requests.length, 2);
      const actionable = adapter.requests.find((request) =>
        stateText(request).includes("ignores the discount"),
      )!;
      const state = actionable.state as {
        thread: Array<{ body: string }>;
        currentCode: { shownLines: string };
        relatedDiffHunks: unknown[];
      };
      assert.equal(state.thread.length, 1);
      assert.equal(state.currentCode.shownLines, "1-3");
      assert.equal(state.relatedDiffHunks.length, 1);
      assert.match(stateText(actionable), /grants no authority/);
      assert.equal(results[0]!.classification, "stale", "likely-handled items are listed first");
      assert.ok(packet.notChecked.includes("no replies were posted and no threads were resolved"));
    } finally {
      repo.cleanup();
    }
  });

  test("already addressed and conflicting answers", async () => {
    const repo = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const comments = JSON.stringify([
        { id: 1, body: "a is never exported", path: "src/a.ts", line: 1 },
        { id: 2, body: "general: crashes when a is 0", path: null },
      ]);
      const adapter = fake((name, _q, request) => {
        const general = stateText(request).includes("general:");
        if (name === "code_status")
          return fakeChoice(STATUS, general ? "not_a_code_claim" : "described_code_absent_or_changed", 0.8);
        if (name === "states_concrete_failure_scenario") return fakeNoul(general ? 0.9 : 0.1);
        return undefined;
      });
      const packet = await triage(
        { kind: "comments", text: comments, source: "stdin", diff: null },
        options(repo.root, adapter),
      );
      const results = ofKind(packet, "comments");
      const [first, second] = [
        results.find((r) => r.sourceId === "1")!,
        results.find((r) => r.sourceId === "2")!,
      ];
      assert.equal(first.classification, "already_addressed");
      assert.equal(second.classification, "unclear");
      assert.equal(second.disposition, "parked");
      assert.equal(second.anchor.status, "no_path");
    } finally {
      repo.cleanup();
    }
  });
});

describe("triage: input", () => {
  test("kind is explicit, parsing follows it, and task text is for failures only", async () => {
    const repo = setup();
    try {
      const adapter = fake();
      await assert.rejects(
        triage({ kind: "logs" as "failures", text: "x", source: "stdin" }, options(repo.root, adapter)),
        /kind must be one of failures, comments/,
      );
      await assert.rejects(
        triage(
          { kind: "comments", text: fixture("jest-failure.txt"), source: "ci.txt" },
          options(repo.root, adapter),
        ),
        /comments must be JSON/,
      );
      await assert.rejects(
        triage(
          { kind: "comments", text: fixture("comments.json"), source: "c.json", task: "Fix it" },
          options(repo.root, adapter),
        ),
        /only used when triaging failures/,
      );
      assert.equal(adapter.requests.length, 0);
    } finally {
      repo.cleanup();
    }
  });
});
