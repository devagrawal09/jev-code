import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul } from "../src/adapters/fake-jev.ts";
import { triageFailures } from "../src/workflows/triage-failures.ts";
import { fake, fixture, options, stateText, tempRepo } from "./helpers.ts";

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

describe("triage-failures", () => {
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
      const packet = await triageFailures(
        { log: fixture("jest-failure.txt"), logSource: "ci.txt", task: "Apply discount codes" },
        options(repo.root, adapter),
      );
      assert.equal(packet.results.length, 2);
      const [cart, net] = packet.results;
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
      const packet = await triageFailures(
        { log, logSource: "stdin", diff: null },
        options(repo.root, adapter),
      );
      assert.equal(packet.results.length, 2);
      assert.equal(packet.results[0]!.relation.label, "unknown_no_diff_context");
      assert.equal(packet.results[0]!.failureKind.label, "compile_or_type_error");
      assert.equal(packet.results[0]!.failureKind.determinedBy, "code");
      assert.equal(packet.results[1]!.duplicateOf, packet.results[0]!.id);
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
      const empty = await triageFailures(
        { log: "everything passed\n", logSource: "stdin" },
        options(repo.root, fake()),
      );
      assert.equal(empty.status, "incomplete");
      assert.ok(empty.limits[0]!.includes("no failure anchors"));

      const pytest = await triageFailures(
        {
          log: `${fixture("jest-failure.txt")}\n${fixture("go-failure.txt")}`,
          logSource: "ci.txt",
          maxFailures: 1,
        },
        options(repo.root, fake()),
      );
      assert.equal(pytest.coverage.complete, false);
      assert.ok(pytest.limits.some((limit) => limit.includes("--max-failures")));
    } finally {
      repo.cleanup();
    }
  });
});
