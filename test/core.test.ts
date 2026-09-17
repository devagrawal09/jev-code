import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import { assertSafeRef } from "../src/adapters/git.ts";
import { classifyError } from "../src/adapters/jev.ts";
import { readWorkspaceFile, resolveWorkspacePath } from "../src/adapters/paths.ts";
import { redactJson, redactText, safeMessage } from "../src/adapters/redact.ts";
import { mapPool, shard, withSplitting } from "../src/core/batch.ts";
import { Budget } from "../src/core/budget.ts";
import { hashValue, seededShuffle, stableId, stableStringify } from "../src/core/hash.ts";
import {
  expectKeys,
  readChoice,
  readEnvelope,
  readNoul,
  readScore,
  ValidationError,
} from "../src/core/validation.ts";
import { classifyPath, globToRegExp, isSecretPath, matchesAnyGlob } from "../src/workflows/classify.ts";
import { InputError } from "../src/workflows/errors.ts";
import { decisiveLabel, massAtLeast, massBelow } from "../src/workflows/policy.ts";
import { tempRepo } from "./helpers.ts";

describe("hashing", () => {
  test("stable stringify ignores key order", () => {
    assert.equal(
      stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }),
      stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
    assert.equal(hashValue({ x: 1, y: 2 }), hashValue({ y: 2, x: 1 }));
    assert.match(stableId("h", "value"), /^h_[0-9a-f]{10}$/);
  });

  test("seeded shuffle is deterministic and a permutation", () => {
    const items = Array.from({ length: 30 }, (_, index) => index);
    const first = seededShuffle(items, "seed");
    assert.deepEqual(first, seededShuffle(items, "seed"));
    assert.notDeepEqual(first, seededShuffle(items, "other"));
    assert.deepEqual(
      [...first].sort((a, b) => a - b),
      items,
    );
  });
});

describe("redaction", () => {
  test("redacts common credential shapes", () => {
    const input = [
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "aws AKIAABCDEFGHIJKLMNOP",
      'const apiKey = "sk-live-0123456789abcdefghij"',
      "Authorization: Bearer abcdefghijklmnop0123456789",
      "postgres://user:hunter2secret@db.example.com/app",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
      "PASSWORD=Sup3rS3cretValue",
    ].join("\n");
    const { text, count } = redactText(input, []);
    assert.ok(count >= 7, `expected at least 7 redactions, got ${count}`);
    for (const secret of [
      "ghp_abc",
      "AKIAABCD",
      "sk-live-0123",
      "abcdefghijklmnop0123456789",
      "hunter2secret",
      "MIIabc",
      "Sup3rS3cretValue",
    ]) {
      assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
    }
    assert.match(text, /postgres:\/\/\[REDACTED:url_credentials\]@db\.example\.com/);
  });

  test("leaves ordinary code alone", () => {
    const code =
      "const token = getToken();\nconst tokenizer = createTokenizer;\nexpect(total).toBe(42);\nconst password = process.env.DB_PASSWORD;";
    assert.deepEqual(redactText(code, []), { text: code, count: 0 });
  });

  test("redacts the process API key value anywhere and sensitive JSON fields", () => {
    const key = "tsk_live_example_value_1234567890";
    const { value, count } = redactJson({ note: `key is ${key}`, nested: [{ apiKey: "anything" }] }, [key]);
    assert.equal(count, 1);
    assert.ok(!JSON.stringify(value).includes(key));
    assert.equal((value as { nested: Array<{ apiKey: string }> }).nested[0]!.apiKey, "[REDACTED:field]");
  });

  test("safe messages are redacted and bounded", () => {
    const message = safeMessage(new Error(`failed with ghp_${"a".repeat(40)} ${"x".repeat(500)}`));
    assert.ok(!message.includes("ghp_aaaa"));
    assert.ok(message.length <= 301);
  });
});

describe("path classification and globs", () => {
  test("classifies paths", () => {
    assert.equal(classifyPath("src/app.ts"), "source");
    assert.equal(classifyPath("src/app.test.ts"), "test");
    assert.equal(classifyPath("tests/test_parser.py"), "test");
    assert.equal(classifyPath("pkg/calc_test.go"), "test");
    assert.equal(classifyPath("package-lock.json"), "lockfile");
    assert.equal(classifyPath("dist/bundle.js"), "generated");
    assert.equal(classifyPath("node_modules/x/index.js"), "vendored");
    assert.equal(classifyPath(".github/workflows/ci.yml"), "ci");
    assert.equal(classifyPath("README.md"), "documentation");
    assert.equal(classifyPath("logo.png"), "binary");
    assert.equal(classifyPath(".env"), "secret");
  });

  test("secret paths", () => {
    for (const path of [
      ".env",
      "config/.env.production",
      "keys/server.pem",
      "home/.ssh/config",
      ".npmrc",
      "id_ed25519",
    ]) {
      assert.ok(isSecretPath(path), path);
    }
    for (const path of [".env.example", "src/env.ts", "id_ed25519.pub", "docs/secrets-guide.md"]) {
      assert.ok(!isSecretPath(path), path);
    }
  });

  test("glob matching", () => {
    assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/c.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/a/c.ts"));
    assert.ok(globToRegExp("**/*.{js,ts}").test("x/y.js"));
    assert.ok(matchesAnyGlob("lib/a.py", ["src/**", "lib/*.py"]));
    assert.ok(!matchesAnyGlob("lib/a.py", ["src/**"]));
  });

  test("refs that could be options are rejected", () => {
    assert.throws(() => assertSafeRef("--output=/tmp/x"));
    assert.throws(() => assertSafeRef("main..evil"));
    assert.equal(assertSafeRef("origin/main"), "origin/main");
    assert.equal(assertSafeRef("HEAD~2"), "HEAD~2");
  });
});

describe("workspace path containment", () => {
  test("rejects escapes, symlink escapes, secrets, and oversize files", async () => {
    const repo = tempRepo({ "inside/data.json": "{}", ".env": "SECRET=1" });
    const outside = tempRepo({ "secret.txt": "outside" });
    try {
      assert.equal((await resolveWorkspacePath(repo.root, "inside/data.json")).relative, "inside/data.json");
      await assert.rejects(resolveWorkspacePath(repo.root, "../x"), InputError);
      await assert.rejects(
        resolveWorkspacePath(repo.root, join(outside.root, "secret.txt")),
        /escapes the workspace/,
      );
      symlinkSync(join(outside.root, "secret.txt"), join(repo.root, "link.txt"));
      await assert.rejects(resolveWorkspacePath(repo.root, "link.txt"), /escapes the workspace/);
      await assert.rejects(resolveWorkspacePath(repo.root, ".env"), /credential-shaped/);
      await assert.rejects(resolveWorkspacePath(repo.root, "."), /escapes the workspace/);
      mkdirSync(join(repo.root, "big"));
      writeFileSync(join(repo.root, "big/file.txt"), "x".repeat(2048));
      await assert.rejects(readWorkspaceFile(repo.root, "big/file.txt", 1024), /limit is 1024 bytes/);
    } finally {
      repo.cleanup();
      outside.cleanup();
    }
  });
});

describe("response validation", () => {
  const answers = {
    yes: fakeNoul(0.8),
    pick: fakeChoice(["a", "b", "cannot_tell"], "a", 0.7),
    level: fakeScore(4, 3, 0.7),
  };

  test("accepts valid answers", () => {
    expectKeys(answers, ["yes", "pick", "level"]);
    assert.equal(readNoul(answers, "yes"), 0.8);
    assert.equal(readChoice(answers, "pick", ["a", "b", "cannot_tell"]).choice, "a");
    const score = readScore(answers, "level", 4);
    assert.equal(score.probabilities.length, 4);
    assert.equal(massAtLeast(score, 2), 0.8);
    assert.equal(massBelow(score, 2), 0.2);
  });

  test("rejects missing and extra keys", () => {
    assert.throws(() => expectKeys(answers, ["yes", "pick"]), /unexpected: level/);
    assert.throws(() => expectKeys(answers, ["yes", "pick", "level", "other"]), /missing: other/);
  });

  test("rejects out-of-range, non-finite, and wrong-type values", () => {
    assert.throws(() => readNoul({ x: { type: "noul", noul: 1.2 } }, "x"), ValidationError);
    assert.throws(() => readNoul({ x: { type: "noul", noul: Number.NaN } }, "x"), ValidationError);
    assert.throws(() => readNoul({ x: { type: "choice", noul: 0.5 } }, "x"), /type must be noul/);
  });

  test("rejects bad choice distributions and labels", () => {
    const bad = { ...fakeChoice(["a", "b"], "a", 0.7), probabilities: { a: 0.7, b: 0.1 } };
    assert.throws(() => readChoice({ x: bad }, "x", ["a", "b"]), /sums to/);
    assert.throws(
      () => readChoice({ x: fakeChoice(["a", "z"], "z", 0.9) }, "x", ["a", "b"]),
      /permitted label/,
    );
    const notMax = { ...fakeChoice(["a", "b"], "a", 0.7), choice: "b" };
    assert.throws(() => readChoice({ x: notMax }, "x", ["a", "b"]), /maximum-probability/);
    assert.throws(
      () => readChoice({ x: { ...fakeChoice(["a", "b"], "a", 0.7), confidence: 2 } }, "x", ["a", "b"]),
      /confidence/,
    );
  });

  test("rejects scores inconsistent with the rubric", () => {
    assert.throws(() => readScore({ x: fakeScore(3, 1, 0.8) }, "x", 4), /keys do not match/);
    assert.throws(() => readScore({ x: { ...fakeScore(4, 3, 0.9), score: 0.2 } }, "x", 4), /disagrees/);
  });

  test("validates the response envelope", () => {
    assert.throws(() => readEnvelope({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), /model/);
    assert.throws(
      () => readEnvelope({ model: "m", answers: {}, usage: { input_tokens: -1, output_tokens: 1 } }),
      /nonnegative/,
    );
  });

  test("decisive labels respect thresholds", () => {
    const choice = readChoice({ x: fakeChoice(["a", "b"], "a", 0.55) }, "x", ["a", "b"]);
    assert.equal(decisiveLabel(choice, 0.5), "a");
    assert.equal(decisiveLabel(choice, 0.6), null);
  });
});

describe("batching and budgets", () => {
  test("shards preserve order and size", () => {
    assert.deepEqual(shard([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.throws(() => shard([1], 0));
  });

  test("mapPool keeps input order under concurrency", async () => {
    const results = await mapPool([30, 10, 20, 0], 3, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });
    assert.deepEqual(results, [0, 1, 2, 3]);
  });

  test("withSplitting halves too-large shards without dropping items", async () => {
    const seen: number[][] = [];
    const pieces = await withSplitting([1, 2, 3, 4, 5], async (items) => {
      seen.push([...items]);
      return items.length > 2 ? { tooLarge: true } : { tooLarge: false, value: items.length };
    });
    assert.deepEqual(
      pieces.map((piece) => [...piece.items]),
      [[1, 2], [3], [4, 5]],
    );
    assert.deepEqual(
      pieces.flatMap((piece) => [...piece.items]),
      [1, 2, 3, 4, 5],
    );
    const single = await withSplitting([9], async () => ({ tooLarge: true }));
    assert.deepEqual(single, [{ items: [9], value: null }]);
    assert.ok(seen.length >= 3);
  });

  test("budget denies requests, tokens, and wall clock", () => {
    let now = 0;
    const budget = new Budget({ requests: 2, inputTokens: 100, wallMs: 1000 }, () => now);
    assert.equal(budget.reserve(40), null);
    assert.equal(budget.reserve(70), "input_tokens");
    budget.settle(40, 10);
    assert.equal(budget.inputTokens, 10);
    assert.equal(budget.reserve(50), null);
    assert.equal(budget.reserve(1), "requests");
    const clock = new Budget({ requests: 10, inputTokens: 1000, wallMs: 1000 }, () => now);
    now = 5000;
    assert.equal(clock.reserve(1), "wall_clock");
    assert.equal(budget.exhausted, "input_tokens");
  });

  test("classifies transport errors", () => {
    assert.equal(classifyError(Object.assign(new Error("nope"), { status: 401 })), "auth");
    assert.equal(
      classifyError(Object.assign(new Error("max_tokens_exceeded"), { status: 400 })),
      "too_large",
    );
    assert.equal(classifyError(Object.assign(new Error("busy"), { status: 503 })), "transient");
    assert.equal(classifyError(Object.assign(new Error("slow"), { name: "APITimeoutError" })), "transient");
    assert.equal(classifyError(Object.assign(new Error("bad"), { status: 422 })), "rejected");
    assert.equal(classifyError(Object.assign(new Error("stop"), { name: "APIUserAbortError" })), "aborted");
  });
});
