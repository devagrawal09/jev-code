import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import { checkCriteria } from "../src/workflows/check-criteria.ts";
import { checkRules } from "../src/workflows/check-rules.ts";
import { fake, fixture, options, stateText, tempRepo } from "./helpers.ts";

const RULE_LABELS = ["not_applicable", "applicable_and_followed", "applicable_and_violated", "cannot_tell"];

function criteriaRepo() {
  const repo = tempRepo({
    "src/api.ts": "export function get(id) {\n  return db[id];\n}\n",
    "test/api.test.ts": "test('get', () => {});\n",
  });
  repo.write({
    "src/api.ts":
      "export function get(id, res) {\n  const item = db[id];\n  if (!item) return res.status(404).end();\n  return item;\n}\n",
    "test/api.test.ts":
      "test('returns 404 for unknown ids', async () => {\n  expect((await get('x')).status).toBe(404);\n});\n",
  });
  return repo;
}

const CRITERIA =
  "1. Returns 404 for unknown ids\n2. Logs each retry attempt\n3. Supports cursor pagination\n";

function criteriaAdapter() {
  return fake((name, question, request) => {
    if (name.startsWith("addresses_")) {
      const criterion = (question.instructions as { criterion: string }).criterion;
      const content = stateText(request);
      if (criterion.includes("404")) return fakeNoul(content.includes("404") ? 0.9 : 0.05);
      if (criterion.includes("retry")) return fakeNoul(0.45);
      return fakeNoul(0.05);
    }
    if (name === "evidence_strength") return fakeScore(4, 3, 0.8);
    return undefined;
  });
}

describe("map-criteria", () => {
  test("maps criteria to evidence and caps support without linked passing tests", async () => {
    const repo = criteriaRepo();
    try {
      const adapter = criteriaAdapter();
      const packet = await checkCriteria(
        { criteria: CRITERIA, criteriaSource: "argument" },
        options(repo.root, adapter),
      );
      const byText = Object.fromEntries(packet.results.map((result) => [result.text, result]));
      const notFound = byText["Returns 404 for unknown ids"]!;
      assert.equal(notFound.status, "partial");
      assert.equal(notFound.cappedBy, "no test results supplied");
      assert.equal(notFound.evidence.length, 2);
      assert.equal(byText["Logs each retry attempt"]!.status, "unclear");
      assert.equal(byText["Supports cursor pagination"]!.status, "unsupported");
      assert.equal(packet.results[0]!.status, "unsupported", "unevidenced criteria are listed first");
      assert.ok(packet.parked.some((item) => item.reason.includes("uncertain band")));

      const unitRequests = adapter.requests.filter((request) =>
        Object.keys(request.questions).some((key) => key.startsWith("addresses_")),
      );
      assert.equal(unitRequests.length, 2, "one request per evidence unit");
      assert.equal(Object.keys(unitRequests[0]!.questions).length, 3, "one Noul per criterion");
      const strength = adapter.requests.find((request) => "evidence_strength" in request.questions)!;
      assert.equal(
        (strength.questions.evidence_strength!.instructions as { workedExamples: unknown[] }).workedExamples
          .length,
        4,
      );
    } finally {
      repo.cleanup();
    }
  });

  test("linked passing test records allow supported", async () => {
    const repo = criteriaRepo();
    try {
      const packet = await checkCriteria(
        {
          criteria: CRITERIA,
          criteriaSource: "argument",
          testResults: {
            text: '<testsuite><testcase classname="api" name="returns 404 for unknown ids"/></testsuite>',
            source: "junit.xml",
          },
        },
        options(repo.root, criteriaAdapter()),
      );
      const notFound = packet.results.find((result) => result.text.includes("404"))!;
      assert.equal(notFound.status, "supported");
      assert.equal(notFound.cappedBy, null);
      assert.deepEqual(notFound.linkedTests, [{ name: "api returns 404 for unknown ids", status: "passed" }]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("flag-rules", () => {
  test("judges only semantic rules on in-scope hunks and flags or parks by policy", async () => {
    const repo = tempRepo({ "src/client.ts": "export const x = 1;\n", "docs/guide.md": "# Guide\n" });
    try {
      repo.write({
        "src/client.ts": 'export const x = 1;\nconsole.log("key=" + process.env.TYPESAFE_API_KEY);\n',
        "docs/guide.md": "# Guide\nMore docs.\n",
      });
      const adapter = fake((_name, question, request) => {
        const rule = (question.instructions as { rule?: string }).rule ?? "";
        if (rule.includes("TYPESAFE_API_KEY")) {
          return stateText(request).includes("console.log")
            ? fakeChoice(RULE_LABELS, "applicable_and_violated", 0.9)
            : fakeChoice(RULE_LABELS, "not_applicable", 0.9);
        }
        if (rule.includes("user-specific")) return fakeChoice(RULE_LABELS, "cannot_tell", 0.6);
        return undefined;
      });
      const packet = await checkRules(
        { rules: fixture("rules.json"), rulesSource: "rules.json" },
        options(repo.root, adapter),
      );
      assert.equal(adapter.requests.length, 1, "docs/guide.md is out of every rule's scope");
      assert.equal(Object.keys(adapter.requests[0]!.questions).length, 2, "deterministic rules are not sent");
      const instructions = Object.values(adapter.requests[0]!.questions)[0]!.instructions as {
        workedExamples?: unknown[];
      };
      assert.equal(instructions.workedExamples?.length, 3);
      assert.deepEqual(
        packet.findings.map((finding) => [finding.flag, finding.detail?.rule]),
        [["rule_violation", "api-key-server-side"]],
      );
      assert.equal(packet.parked.length, 1);
      assert.ok(packet.parked[0]!.reason.includes("cannot_tell"));
      assert.ok(packet.notChecked.some((note) => note.includes("prettier-format")));
      assert.ok(!JSON.stringify(packet).includes('"compliant"'));
    } finally {
      repo.cleanup();
    }
  });

  test("more than twelve applicable rules are split across requests", async () => {
    const repo = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      repo.write({ "src/a.ts": "export const a = 2;\n" });
      const rules = {
        version: 1,
        rules: Array.from({ length: 13 }, (_, index) => ({
          id: `r${index}`,
          class: "semantic",
          text: `Rule ${index}`,
        })),
      };
      const adapter = fake();
      const packet = await checkRules(
        { rules: JSON.stringify(rules), rulesSource: "rules.json" },
        options(repo.root, adapter),
      );
      assert.deepEqual(
        adapter.requests.map((request) => Object.keys(request.questions).length),
        [12, 1],
      );
      assert.equal(packet.coverage.candidates, 13);
    } finally {
      repo.cleanup();
    }
  });
});
