import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseComments } from "../src/adapters/comments.ts";
import { parseUnifiedDiff } from "../src/adapters/diff.ts";
import { parseFailureLog, stripAnsi } from "../src/adapters/logs.ts";
import { parseTestRecords } from "../src/adapters/test-records.ts";
import { parseCriteria } from "../src/workflows/check-criteria.ts";
import { parseRules } from "../src/workflows/check-rules.ts";
import { InputError } from "../src/workflows/errors.ts";
import { MAX_HUNK_LINES, normalizeForSignature, resolveStackPath } from "../src/workflows/evidence.ts";
import { enabledHunks, ladderForHunk } from "../src/workflows/hunks.ts";
import { fixture } from "./helpers.ts";

const SAMPLE_DIFF = `diff --git a/src/cart.ts b/src/cart.ts
index 1111111..2222222 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -1,4 +1,5 @@ export class Cart
 export function total(items) {
-  return items.reduce((sum, item) => sum + item.price, 0);
+  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
+  return applyDiscount(subtotal);
 }
diff --git a/src/discount.ts b/src/discount.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/discount.ts
@@ -0,0 +1,3 @@
+export function applyDiscount(value) {
+  return value * 0.9;
+}
diff --git a/test/cart.test.ts b/test/cart.test.ts
index 4444444..5555555 100644
--- a/test/cart.test.ts
+++ b/test/cart.test.ts
@@ -3,3 +3,3 @@
 test("total", () => {
-  expect(total([{ price: 10 }])).toBe(10);
+  expect(total([{ price: 10 }])).toBeDefined();
 });
@@ -10,2 +10,2 @@
-test("empty", () => {
+test.skip("empty", () => {
   expect(total([])).toBe(0);
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 6666666..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/fmt.ts b/src/fmt.ts
index 9999999..aaaaaaa 100644
--- a/src/fmt.ts
+++ b/src/fmt.ts
@@ -1,1 +1,1 @@
-const x = {a:1};
+const x = { a: 1 };
`;

describe("unified diff parsing", () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);
  const hunks = files.flatMap((file) => file.hunks);

  test("parses files, statuses, and hunks", () => {
    assert.deepEqual(
      files.map((file) => [file.path, file.status, file.hunks.length]),
      [
        ["src/cart.ts", "modified", 1],
        ["src/discount.ts", "added", 1],
        ["test/cart.test.ts", "modified", 2],
        ["old.txt", "deleted", 1],
        ["logo.png", "binary", 0],
        ["src/fmt.ts", "modified", 1],
      ],
    );
    const cart = hunks[0]!;
    assert.equal(cart.section, "export class Cart");
    assert.equal(cart.added, 2);
    assert.equal(cart.removed, 1);
    assert.equal(hunks[3]!.oldStart, 10);
    assert.equal(new Set(hunks.map((hunk) => hunk.id)).size, hunks.length);
    assert.deepEqual(
      parseUnifiedDiff(SAMPLE_DIFF).flatMap((f) => f.hunks.map((h) => h.id)),
      hunks.map((h) => h.id),
    );
  });

  test("ladder flags skip markers, removed assertions, formatting", () => {
    assert.deepEqual(ladderForHunk(hunks[2]!).flags, []);
    assert.equal(ladderForHunk(hunks[2]!).assertionsRemoved, 1);
    assert.deepEqual(ladderForHunk(hunks[3]!).flags, ["skip_marker_added"]);
    assert.deepEqual(ladderForHunk(hunks[5]!).flags, ["formatting_only"]);
  });

  test("links a declaring hunk to hunks that use it", () => {
    const links = enabledHunks(hunks);
    assert.deepEqual(links.get(hunks[1]!.id), [hunks[0]!.id]);
  });

  test("splits oversized hunks into accounted parts", () => {
    const body = Array.from({ length: MAX_HUNK_LINES + 50 }, (_, index) => `+line ${index}`).join("\n");
    const diff = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,${MAX_HUNK_LINES + 50} @@\n${body}\n`;
    const parts = parseUnifiedDiff(diff)[0]!.hunks;
    assert.equal(parts.length, 2);
    assert.deepEqual(
      parts.map((part) => part.part),
      [
        { index: 1, count: 2 },
        { index: 2, count: 2 },
      ],
    );
    assert.equal(parts[0]!.added + parts[1]!.added, MAX_HUNK_LINES + 50);
    assert.equal(parts[1]!.newStart, 1 + MAX_HUNK_LINES);
  });
});

describe("failure log parsing", () => {
  test("jest log yields two separate blocks with signatures", () => {
    const parsed = parseFailureLog(fixture("jest-failure.txt"));
    assert.equal(parsed.blocks.length, 2);
    const [cart, net] = parsed.blocks;
    assert.equal(cart!.testName, "cart › applies discount");
    assert.ok(
      cart!.stackLocations.some((location) => location.path === "src/cart.test.ts" && location.line === 14),
    );
    assert.equal(cart!.envSignature, null);
    assert.equal(net!.envSignature, "network");
    assert.ok(net!.message?.includes("FetchError"));
  });

  test("pytest and go logs", () => {
    const pytest = parseFailureLog(fixture("pytest-failure.txt"));
    assert.equal(pytest.blocks.length, 1);
    assert.ok(pytest.blocks[0]!.testName?.includes("test_parse_dates"));
    assert.ok(pytest.blocks[0]!.stackLocations.some((location) => location.path === "tests/test_parser.py"));
    const go = parseFailureLog(fixture("go-failure.txt"));
    assert.equal(go.blocks.length, 1);
    assert.equal(go.blocks[0]!.testName, "TestDivide");
  });

  test("Bun failures are named and are not duplicated by the summary", () => {
    const parsed = parseFailureLog(
      [
        "bun test v1.4.0",
        "",
        "test/tools.test.ts:",
        "12 | call()",
        "TypeError: undefined is not an object",
        "      at <anonymous> (/repo/test/tools.test.ts:12:3)",
        "(fail) built-in tools > reads a file [1.05ms]",
        "error: expect(received).toEqual(expected)",
        "      at <anonymous> (/repo/test/tools.test.ts:20:3)",
        "(fail) built-in tools > edits a file [0.68ms]",
        "",
        "2 tests failed:",
        "(fail) built-in tools > reads a file [1.05ms]",
        "(fail) built-in tools > edits a file [0.68ms]",
      ].join("\n"),
    );
    assert.equal(parsed.blocks.length, 2);
    assert.equal(parsed.blocks[0]!.testName, "built-in tools > reads a file");
    assert.equal(parsed.blocks[0]!.message, "TypeError: undefined is not an object");
    assert.equal(parsed.blocks[1]!.testName, "built-in tools > edits a file");
    assert.equal(parsed.blocks[1]!.endLine, 10);
  });

  test("compile errors, TAP, ANSI, and no-anchor logs", () => {
    const tsc = parseFailureLog(
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n",
    );
    assert.equal(tsc.blocks[0]!.compileError, true);
    const tap = parseFailureLog(
      "TAP version 13\nok 1 - works\nnot ok 2 - rejects bad input\n  ---\n  message: boom\n",
    );
    assert.equal(tap.blocks[0]!.testName, "rejects bad input");
    assert.equal(stripAnsi("\u001b[31mFAIL\u001b[39m"), "FAIL");
    assert.equal(parseFailureLog("all good\n12 passed\n").blocks.length, 0);
  });

  test("duplicate failures share fingerprints despite volatile numbers", () => {
    const log = [
      "FAIL src/a.test.ts",
      "  Error: timeout after 2003ms waiting for 0xdeadbeef",
      ...Array.from({ length: 40 }, () => "PASS other"),
      "FAIL src/a.test.ts",
      "  Error: timeout after 2011ms waiting for 0xcafebabe",
    ].join("\n");
    const parsed = parseFailureLog(log);
    assert.equal(parsed.blocks.length, 2);
    assert.equal(parsed.blocks[0]!.fingerprint, parsed.blocks[1]!.fingerprint);
    assert.equal(normalizeForSignature("took 12ms at 0x1f"), "took D at H");
  });

  test("stack paths resolve only to tracked files", () => {
    const tracked = new Set(["src/cart.ts", "lib/util.ts", "other/util.ts"]);
    assert.equal(resolveStackPath("/repo/src/cart.ts", "/repo", tracked), "src/cart.ts");
    assert.equal(resolveStackPath("/ci/build/src/cart.ts", "/repo", tracked), "src/cart.ts");
    assert.equal(resolveStackPath("util.ts", "/repo", tracked), null);
    assert.equal(resolveStackPath("node_modules/x.js", "/repo", tracked), null);
  });
});

describe("input parsers", () => {
  test("criteria lists", () => {
    const criteria = parseCriteria(
      "Intro prose\n1. Returns 404 for unknown ids\n- [ ] Logs each retry\n* [x] Keeps API stable\nnot a list",
    );
    assert.deepEqual(
      criteria.map((c) => c.text),
      ["Returns 404 for unknown ids", "Logs each retry", "Keeps API stable"],
    );
    assert.match(criteria[0]!.id, /^c1_[0-9a-f]{6}$/);
    assert.throws(() => parseCriteria("just prose"), InputError);
    assert.throws(
      () => parseCriteria(Array.from({ length: 21 }, (_, i) => `- item ${i}`).join("\n")),
      /limit is 20/,
    );
    assert.throws(() => parseCriteria(`- ${"x".repeat(301)}`), /limit is 300/);
  });

  test("test records from JSON and JUnit", () => {
    assert.deepEqual(
      parseTestRecords('[{"name":"returns 404","status":"passed","file":"test/api.test.ts"}]'),
      [{ name: "returns 404", status: "passed", file: "test/api.test.ts" }],
    );
    const junit = `<testsuite><testcase classname="api" name="returns 404"/><testcase classname="api" name="retries"><failure message="x"/></testcase><testcase name="later"><skipped/></testcase></testsuite>`;
    assert.deepEqual(
      parseTestRecords(junit).map((record) => [record.name, record.status]),
      [
        ["api returns 404", "passed"],
        ["api retries", "failed"],
        ["later", "skipped"],
      ],
    );
    assert.throws(() => parseTestRecords('[{"name":"x","status":"ok"}]'), InputError);
  });

  test("rules files", () => {
    const rules = parseRules(fixture("rules.json"));
    assert.equal(rules.length, 3);
    assert.equal(rules[0]!.class, "semantic");
    assert.match(rules[0]!.key, /^rule_[0-9a-f]{10}$/);
    assert.throws(
      () => parseRules('{"version":1,"rules":[{"id":"a","class":"semantic","text":"x","run":"rm -rf /"}]}'),
      /unknown key run/,
    );
    assert.throws(
      () =>
        parseRules(
          '{"version":1,"rules":[{"id":"a","class":"semantic","text":"x","examples":[{"hunk":"x","label":"not_applicable","rationale":"r"}]}]}',
        ),
      /single example/,
    );
    assert.throws(
      () =>
        parseRules(
          '{"version":1,"rules":[{"id":"a","class":"semantic","text":"x"},{"id":"a","class":"semantic","text":"y"}]}',
        ),
      /duplicate/,
    );
  });

  test("comments in plain and GitHub shapes", () => {
    const comments = parseComments(fixture("comments.json"));
    assert.equal(comments.length, 6);
    const bot = comments.find((comment) => comment.author === "review-bot[bot]");
    assert.equal(bot?.authorKind, "bot");
    assert.equal(comments[0]!.path, "src/cart.ts");
    assert.equal(comments.find((comment) => comment.inReplyTo)?.inReplyTo, "101");
    assert.throws(() => parseComments('[{"path":"x"}]'), /body/);
    const long = parseComments(JSON.stringify([{ body: "x".repeat(5000) }]));
    assert.equal(long[0]!.bodyTruncated, true);
    assert.equal(long[0]!.body.length, 4000);
  });
});
