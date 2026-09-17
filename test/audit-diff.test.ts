import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import { exitCodeFor } from "../src/cli/output.ts";
import { auditDiff } from "../src/workflows/audit-diff.ts";
import { fake, options, tempRepo } from "./helpers.ts";

const KINDS = [
  "behavior_change",
  "refactor_no_behavior_change",
  "formatting_or_comments",
  "test_change",
  "config_or_dependency",
  "documentation",
  "cannot_tell",
];

function setup() {
  const repo = tempRepo({
    "src/cart.ts":
      "export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n",
    "src/format.ts": "export function money(value) {\n  return '$' + value;\n}\n",
    "test/cart.test.ts":
      'import { total } from "../src/cart";\ntest("total", () => {\n  expect(total([{ price: 10 }])).toBe(10);\n});\n',
    "package-lock.json": '{\n  "lockfileVersion": 3\n}\n',
    "src/style.ts": "const x = {a:1};\n",
  });
  repo.write({
    "src/cart.ts":
      'import { applyDiscount } from "./discount";\nexport function total(items, code) {\n  const subtotal = items.reduce((sum, item) => sum + item.price, 0);\n  return applyDiscount(subtotal, code);\n}\n',
    "src/discount.ts":
      "export function applyDiscount(value, code) {\n  return code === 'SAVE10' ? value * 0.9 : value;\n}\n",
    "src/format.ts": "export function money(value) {\n  return `$${value.toFixed(2)}`;\n}\n",
    "test/cart.test.ts":
      'import { total } from "../src/cart";\ntest("total", () => {\n  expect(total([{ price: 10 }])).toBeDefined();\n});\n',
    "package-lock.json": '{\n  "lockfileVersion": 3,\n  "name": "x"\n}\n',
    "src/style.ts": "const x = { a: 1 };\n",
  });
  repo.git("add", "-N", "src/discount.ts");
  return repo;
}

const pathOf = (state: unknown) =>
  (state as { hunk?: { path?: string }; candidateHunk?: { path?: string } }).hunk?.path;

describe("review", () => {
  test("flags weak hunks and weakened tests, clears enabler hunks, skips deterministic hunks", async () => {
    const repo = setup();
    try {
      const adapter = fake((name, _question, request) => {
        const path = pathOf(request.state);
        if (name === "task_relation") {
          return path === "src/format.ts" || path === "src/discount.ts"
            ? fakeScore(4, 0, 0.85)
            : fakeScore(4, 3, 0.85);
        }
        if (name === "change_kind")
          return fakeChoice(KINDS, path?.startsWith("test/") ? "test_change" : "behavior_change", 0.8);
        if (name === "weakens_expectation") return fakeNoul(0.92);
        if (name === "expectation_change_stated_in_task") return fakeNoul(0.1);
        if (name === "enables_other_hunk") return fakeNoul(0.85);
        if (name === "untrusted_instruction_text") return fakeNoul(0.99);
        return undefined;
      });
      const packet = await auditDiff(
        { task: "Apply discount codes to cart totals" },
        options(repo.root, adapter),
      );

      assert.equal(packet.status, "complete");
      assert.equal(exitCodeFor(packet), 0);
      assert.equal(packet.advisory, true);
      assert.ok(packet.notChecked.length > 0);
      const flags = packet.findings.map((finding) => `${finding.flag}:${finding.path ?? ""}`);
      assert.ok(flags.includes("weak_task_relation:src/format.ts"), flags.join(" "));
      assert.ok(flags.includes("test_expectation_weakened:test/cart.test.ts"));
      assert.ok(flags.includes("lockfile_changed:package-lock.json"));
      assert.ok(!flags.includes("weak_task_relation:src/discount.ts"), "enabler hunk should be cleared");
      assert.ok(!flags.some((flag) => flag.startsWith("untrusted_instruction_text:")));
      const discount = packet.results.find((result) => result.path === "src/discount.ts")!;
      assert.ok(discount.flags.includes("enables_linked_hunk"));

      const sentPaths = adapter.requests.map((request) => pathOf(request.state)).filter(Boolean);
      assert.ok(!sentPaths.includes("package-lock.json"), "lockfile hunks are deterministic only");
      assert.ok(!sentPaths.includes("src/style.ts"), "formatting-only hunks are deterministic only");
      assert.equal(
        packet.results.find((result) => result.path === "src/style.ts")!.disposition,
        "deterministic",
      );
      assert.equal(packet.coverage.deterministic, 2);
      assert.equal(packet.coverage.judged, 4);

      const intent = adapter.requests.find(
        (request) => pathOf(request.state) === "src/cart.ts" && "diffManifest" in request.state,
      )!;
      assert.ok("special_cases_literal_input" in intent.questions, "source hunks ask about special-casing");
      assert.match(JSON.stringify(intent.state), /untrusted evidence/);
      assert.equal(intent.model, "jev-1.13.0");
      const testFrame = adapter.requests.find((request) => "weakens_expectation" in request.questions)!;
      assert.deepEqual(Object.keys(testFrame.state).sort(), ["evidencePolicy", "hunk", "task"]);
      const instructions = testFrame.questions.weakens_expectation!.instructions as {
        workedExamples: unknown[];
      };
      assert.equal(instructions.workedExamples.length, 6);
    } finally {
      repo.cleanup();
    }
  });

  test("hard conflicts are parked and vague tasks produce a single insufficiency finding", async () => {
    const repo = setup();
    try {
      const conflicted = fake((name, _q, request) => {
        if (name === "task_relation")
          return pathOf(request.state) === "src/format.ts" ? fakeScore(4, 3, 0.9) : fakeScore(4, 0, 0.9);
        if (name === "change_kind") return fakeChoice(KINDS, "formatting_or_comments", 0.9);
        if (name === "enables_other_hunk") return fakeNoul(0.1);
        return undefined;
      });
      const packet = await auditDiff({ task: "Improve things" }, options(repo.root, conflicted));
      assert.deepEqual(
        packet.parked.map((item) => item.path),
        ["src/format.ts"],
      );
      assert.equal(packet.coverage.parked, 1);

      const vague = fake((name) => {
        if (name === "task_relation") return fakeScore(4, 0, 0.9);
        if (name === "change_kind") return fakeChoice(KINDS, "behavior_change", 0.9);
        if (name === "enables_other_hunk") return fakeNoul(0.1);
        return undefined;
      });
      const vaguePacket = await auditDiff({ task: "Improve things" }, options(repo.root, vague));
      const flags = vaguePacket.findings.map((finding) => finding.flag);
      assert.ok(flags.includes("task_text_insufficient"));
      assert.ok(!flags.includes("weak_task_relation"));
    } finally {
      repo.cleanup();
    }
  });

  test("invalid responses make coverage incomplete", async () => {
    const repo = setup();
    try {
      const broken = fake((name) => (name === "task_relation" ? { type: "score", score: 9 } : undefined));
      const packet = await auditDiff({ task: "Apply discount codes" }, options(repo.root, broken));
      assert.equal(packet.status, "incomplete");
      assert.equal(exitCodeFor(packet), 10);
      assert.ok(packet.coverage.failed > 0);
    } finally {
      repo.cleanup();
    }
  });

  test("hunk limits are reported, not silent; staged and branch scopes work", async () => {
    const repo = setup();
    try {
      const limited = await auditDiff(
        { task: "Apply discount codes", maxHunks: 1 },
        options(repo.root, fake()),
      );
      assert.equal(limited.coverage.complete, false);
      assert.ok(limited.limits.some((limit) => limit.includes("--max-hunks")));
      assert.ok(limited.results.some((result) => result.error === "not judged: hunk limit"));

      const staged = await auditDiff({ task: "x", scope: "staged" }, options(repo.root, fake()));
      assert.equal(staged.results.length, 0);
      assert.equal(staged.status, "complete");

      repo.git("checkout", "-q", "-b", "feature");
      repo.commit("feature work");
      const branch = await auditDiff(
        { task: "Apply discount codes", scope: "branch", base: "main" },
        options(repo.root, fake()),
      );
      assert.ok(branch.results.some((result) => result.path === "src/discount.ts"));
      await assert.rejects(
        auditDiff({ task: "x", scope: "branch", base: "--upload-pack=evil" }, options(repo.root, fake())),
        /unsupported ref/,
      );
      await assert.rejects(auditDiff({ task: "   " }, options(repo.root, fake())), /task text is required/);
    } finally {
      repo.cleanup();
    }
  });
});
