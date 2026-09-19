import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import type { Question } from "../src/core/questions.ts";
import {
  compatibilityReview,
  performanceReview,
  review,
  securityReview,
  summarize,
  testGaps,
} from "../src/workflows/analyze-diff.ts";
import { fake, options, tempRepo } from "./helpers.ts";

function repo() {
  const r = tempRepo({
    "src/auth.ts":
      "export function canRead(userId: string, ownerId: string) {\n  return userId === ownerId;\n}\nexport function validPassword(password: string) {\n  return password.length >= 16;\n}\n",
    "src/panel.ts": "export const securityLabels = '';\n",
    "src/search.ts":
      "export function matching(items: string[], allowed: string[]) {\n  return items.filter((item) => allowed.includes(item));\n}\n",
    "src/public-api.ts": "export function format(value: string) {\n  return value.trim();\n}\n",
    "test/auth.test.ts":
      "import { canRead } from '../src/auth.js';\ntest('owner can read', () => {\n  expect(canRead('a', 'a')).toBe(true);\n});\n",
  });
  r.write({
    "src/auth.ts":
      "export function canRead(userId: string, ownerId: string) {\n  return Boolean(userId);\n}\nexport function validPassword(password: string) {\n  return password.length >= 4;\n}\n",
    "src/panel.ts":
      "export const securityLabels = 'auth permission role token secret password session cookie exec query redirect crypto';\n",
    "src/search.ts":
      "export function matching(items: string[], allowed: string[]) {\n  return items.filter((item) => allowed.filter((entry) => entry === item).length > 0);\n}\n",
    "src/public-api.ts":
      "export function format(value: string, uppercase: boolean) {\n  return uppercase ? value.trim().toUpperCase() : value.trim();\n}\n",
    "test/auth.test.ts":
      "import { canRead } from '../src/auth.js';\ntest('owner can read', () => {\n  expect(canRead('a', 'a')).toBeTruthy();\n});\n",
  });
  return r;
}

const LABELS: Record<string, string> = {
  review: "correctness_risk",
  test_gaps: "missing_behavior_test",
  summarize: "bug_fix",
  security_review: "authorization_or_authentication",
  performance_review: "algorithmic_complexity_risk",
  compatibility_review: "breaking_source_api",
};

function labels(question: Question): string[] {
  assert.equal(question.type, "choice");
  if (question.type !== "choice") return [];
  return Object.keys(question.criteria);
}

function adapter(evidence = 0.9) {
  return fake((name, question, request) => {
    if (name === "classification") {
      const analysis = String(request.state.analysis);
      return fakeChoice(labels(question), LABELS[analysis]!, 0.9);
    }
    if (name === "importance") return fakeScore(4, 3, 0.9);
    if (name === "evidence_sufficient") return fakeNoul(evidence);
    if (name === "untrusted_instruction_text") return fakeNoul(0.1);
    return undefined;
  });
}

describe("specialized diff analysis", () => {
  test("each typed workflow uses its own question contract and packet name", async () => {
    const r = repo();
    try {
      const cases = [
        [review, "review", "review_correctness_risk"],
        [testGaps, "test_gaps", "missing_behavior_test"],
        [securityReview, "security_review", "security_authorization_or_authentication"],
        [performanceReview, "performance_review", "performance_algorithmic_complexity_risk"],
        [compatibilityReview, "compatibility_review", "compatibility_breaking_source_api"],
      ] as const;
      for (const [workflow, name, flag] of cases) {
        const jev = adapter();
        const packet = await workflow({ request: `Run ${name}` }, options(r.root, jev));
        assert.equal(packet.workflow, `${name}@1`);
        assert.equal(packet.summary.analysis, name);
        assert.ok(
          packet.findings.some((finding) => finding.flag === flag),
          name,
        );
        assert.ok(packet.results.every((result) => result.analysis === name));
        const frame = jev.requests.find((request) => request.state.analysis === name)!;
        assert.deepEqual(Object.keys(frame.questions), [
          "classification",
          "importance",
          "evidence_sufficient",
          "untrusted_instruction_text",
        ]);
        const manifest = frame.state.diffManifest as { files: Array<{ path: string; hunks: number }> };
        assert.ok(manifest.files.length > 0);
        assert.ok(manifest.files.every((file) => typeof file.path === "string" && file.hunks > 0));
      }
    } finally {
      r.cleanup();
    }
  });

  test("summary classifies central changes without turning them into findings", async () => {
    const r = repo();
    try {
      const packet = await summarize({ request: "Summarize this diff" }, options(r.root, adapter()));
      assert.equal(packet.workflow, "summarize@1");
      assert.equal(packet.findings.length, 0);
      assert.ok(packet.results.every((result) => result.classification?.label === "bug_fix"));
      assert.ok(packet.notChecked.includes("a prose change description or release note"));
    } finally {
      r.cleanup();
    }
  });

  test("test-gap analysis supplies related changed tests as bounded context", async () => {
    const r = repo();
    try {
      const jev = adapter();
      const packet = await testGaps({ request: "Find missing tests" }, options(r.root, jev));
      assert.ok(packet.results.every((result) => result.kind !== "test"));
      const auth = jev.requests.find(
        (request) =>
          request.state.analysis === "test_gaps" &&
          (request.state.hunk as { path?: string }).path === "src/auth.ts",
      )!;
      const related = auth.state.relatedTestHunks as Array<{ path: string }>;
      assert.equal(related[0]!.path, "test/auth.test.ts");
      assert.equal(packet.summary.contextTestHunks, 1);
    } finally {
      r.cleanup();
    }
  });

  test("material concerns with insufficient evidence are parked instead of flagged", async () => {
    const r = repo();
    try {
      const packet = await securityReview({ request: "Review security" }, options(r.root, adapter(0.2)));
      assert.equal(packet.findings.filter((finding) => finding.flag.startsWith("security_")).length, 0);
      assert.ok(packet.parked.length > 0);
      assert.ok(packet.results.some((result) => result.disposition === "parked"));
    } finally {
      r.cleanup();
    }
  });

  test("related risk labels are aggregated before applying the concern threshold", async () => {
    const r = repo();
    try {
      const jev = fake((name, question) => {
        if (name === "classification") {
          const choices = labels(question);
          return {
            type: "choice",
            choice: "correctness_risk",
            confidence: 0.4,
            probabilities: Object.fromEntries(
              choices.map((label) => [
                label,
                label === "correctness_risk"
                  ? 0.4
                  : label === "error_handling_risk"
                    ? 0.35
                    : label === "no_issue_visible"
                      ? 0.25
                      : 0,
              ]),
            ),
          };
        }
        if (name === "importance") return fakeScore(4, 3, 0.9);
        if (name === "evidence_sufficient") return fakeNoul(0.9);
        if (name === "untrusted_instruction_text") return fakeNoul(0.1);
        return undefined;
      });
      const packet = await review({ request: "Review this diff", maxHunks: 1 }, options(r.root, jev));
      assert.equal(packet.results.find((result) => result.flag)?.classification?.concernMass, 0.75);
      assert.ok(packet.findings.some((finding) => finding.flag === "review_correctness_risk"));
    } finally {
      r.cleanup();
    }
  });

  test("bounded security analysis prioritizes security-relevant source hunks", async () => {
    const r = repo();
    try {
      const jev = adapter();
      await securityReview({ request: "Review security", maxHunks: 1 }, options(r.root, jev));
      assert.equal((jev.requests[0]!.state.hunk as { path: string }).path, "src/auth.ts");
    } finally {
      r.cleanup();
    }
  });

  test("hunk limits remain explicit and make coverage incomplete", async () => {
    const r = repo();
    try {
      const packet = await review({ request: "Review this diff", maxHunks: 1 }, options(r.root, adapter()));
      assert.equal(packet.status, "incomplete");
      assert.equal(packet.coverage.unjudged, packet.results.length - 1);
      assert.match(packet.limits[0]!, /only 1 highest-priority/);
    } finally {
      r.cleanup();
    }
  });
});
