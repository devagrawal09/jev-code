import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul } from "../src/adapters/fake-jev.ts";
import { runFrame } from "../src/workflows/run-frame.ts";
import { triageComments } from "../src/workflows/triage-comments.ts";
import { fake, fixture, options, stateText, tempRepo } from "./helpers.ts";

const STATUS = [
  "described_code_present",
  "described_code_absent_or_changed",
  "targets_lines_not_shown",
  "not_a_code_claim",
  "cannot_tell",
];

describe("triage-comments", () => {
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
      const packet = await triageComments(
        { comments: fixture("comments.json"), commentsSource: "comments.json" },
        options(repo.root, adapter),
      );
      const byId = Object.fromEntries(packet.results.map((result) => [result.sourceId, result]));
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
      assert.equal(packet.results[0]!.classification, "stale", "likely-handled items are listed first");
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
      const packet = await triageComments(
        { comments, commentsSource: "stdin", diff: null },
        options(repo.root, adapter),
      );
      const [first, second] = [
        packet.results.find((r) => r.sourceId === "1")!,
        packet.results.find((r) => r.sourceId === "2")!,
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

describe("run-frame", () => {
  test("submits only validated state and questions and returns uncalibrated answers", async () => {
    const repo = tempRepo({ "frames/check.json": fixture("frame.json") });
    try {
      const adapter = fake((name) => {
        if (name === "mentions_retry") return fakeNoul(0.93);
        if (name === "retry_kind")
          return fakeChoice(["fixed", "exponential", "cannot_tell"], "exponential", 0.9);
        return undefined;
      });
      const packet = await runFrame({ file: "frames/check.json" }, options(repo.root, adapter));
      assert.equal(packet.status, "complete");
      assert.equal(packet.summary.uncalibrated, true);
      assert.deepEqual(packet.findings, []);
      assert.deepEqual(
        packet.results.map((result) => [
          result.question,
          result.probability ?? result.choice ?? result.expected,
        ]),
        [
          ["mentions_retry", 0.93],
          ["retry_kind", "exponential"],
          ["clarity", 0.3],
        ],
      );
      const request = adapter.requests[0]!;
      assert.deepEqual(Object.keys(request.state).sort(), ["evidence", "evidencePolicy"]);
      await assert.rejects(
        runFrame({ file: "../frame.json" }, options(repo.root, fake())),
        /escapes the workspace/,
      );
    } finally {
      repo.cleanup();
    }
  });

  test("detects re-asking different questions over identical state", async () => {
    const repo = tempRepo({ "a.json": fixture("frame.json") });
    try {
      const variant = JSON.parse(fixture("frame.json"));
      variant.questions = { other: { type: "noul", instructions: "Is it short?" } };
      repo.write({ "b.json": JSON.stringify(variant) });
      const persisted = { ...options(repo.root, fake()), persist: true };
      const first = await runFrame({ file: "a.json" }, persisted);
      assert.equal(first.summary.priorRunsSameStateDifferentQuestions, 0);
      const second = await runFrame({ file: "b.json" }, persisted);
      assert.equal(second.summary.priorRunsSameStateDifferentQuestions, 1);
      assert.ok(second.limits.some((limit) => limit.includes("judge shopping")));
    } finally {
      repo.cleanup();
    }
  });
});
