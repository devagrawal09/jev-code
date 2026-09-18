/**
 * Smoke test the built CLI with a deterministic test Jev. No network calls are made.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createFakeAdapter, fakeChoice } from "../src/adapters/fake-jev.ts";
import { ROUTER_OUTCOMES } from "../src/cli/router.ts";

type RunCli = typeof import("../src/cli.ts").runCli;

const built = (await import(pathToFileURL(resolve(import.meta.dirname, "../dist/cli.js")).href)) as {
  runCli: RunCli;
};
const root = mkdtempSync(join(tmpdir(), "jev-code-smoke-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};
const adapter = createFakeAdapter((name, _question, request) => {
  if (name !== "route") return undefined;
  const prompt = String(request.state.request).toLowerCase();
  const route = prompt.includes("failure")
    ? "triage_failures"
    : prompt.includes("comment")
      ? "triage_comments"
      : prompt.includes("find") || prompt.includes("where")
        ? "find"
        : prompt.includes("check")
          ? "check"
          : "cannot_tell";
  return fakeChoice(ROUTER_OUTCOMES, route, 0.9);
});

async function invoke(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await built.runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      stdin: Readable.from([]),
      cwd: root,
      env: {},
    },
    { adapter },
  );
  return { code, stdout, stderr };
}

try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "smoke");
  write("src/math.js", "export function add(a, b) {\n  return a + b;\n}\n");
  write(
    "test/math.test.js",
    'import { add } from "../src/math.js";\ntest("adds", () => {\n  expect(add(1, 2)).toEqual(3);\n});\n',
  );
  git("add", "-A");
  git("commit", "-qm", "init");
  write("src/math.js", "export function add(a, b) {\n  if (a === 41) return 42;\n  return a + b;\n}\n");
  write(
    "test/math.test.js",
    'import { add } from "../src/math.js";\ntest.skip("adds", () => {\n  expect(add(1, 2)).toBeDefined();\n});\n',
  );
  write(
    "ci.txt",
    "FAIL test/math.test.js\n  adds\n    Expected: 3\n    Received: 4\n      at test/math.test.js:3:20\n",
  );
  write("criteria.md", "- add returns the sum\n- add handles overflow\n");
  write("junit.xml", '<testsuite><testcase classname="math" name="add returns the sum"/></testsuite>');
  write(
    "rules.json",
    JSON.stringify({
      version: 1,
      rules: [
        { id: "no-magic", class: "semantic", text: "No magic-number special cases.", scope: ["src/**"] },
      ],
    }),
  );
  write(
    "comments.json",
    JSON.stringify([{ id: 1, body: "This returns 42 for 41, why?", path: "src/math.js", line: 2 }]),
  );
  const cases: Array<{
    args: string[];
    expect: number;
    json?: boolean;
    workflow?: string;
    error?: RegExp;
    sections?: string[];
  }> = [
    { args: ["--help"], expect: 0 },
    { args: [], expect: 64 },
    { args: ["Do something vague"], expect: 64 },
    {
      args: ["Check whether the change fixes add overflow", "--json"],
      expect: 0,
      json: true,
      workflow: "check@1",
    },
    {
      args: [
        "Check the add overflow change against the task and requirements",
        "--task",
        "fix add overflow",
        "--rules",
        "rules.json",
        "--criteria-file",
        "criteria.md",
        "--test-results",
        "junit.xml",
        "--json",
      ],
      expect: 0,
      json: true,
      workflow: "check@1",
      sections: ["task", "rules", "criteria"],
    },
    { args: ["Check the results", "--test-results", "junit.xml"], expect: 64 },
    {
      args: ["Triage these failures", "--input", "ci.txt", "--json"],
      expect: 0,
      json: true,
      workflow: "triage@1",
    },
    {
      args: ["Triage these comments", "--input", "comments.json", "--json"],
      expect: 0,
      json: true,
      workflow: "triage@1",
    },
    { args: ["Triage these failures", "--input", "../outside.log"], expect: 65 },
    {
      args: ["Find where add is implemented", "--json"],
      expect: 0,
      json: true,
      workflow: "find@1",
    },
    { args: ["Find add", "--rules", "rules.json"], expect: 64 },
    { args: ["Find add", "--as", "find"], expect: 64 },
    { args: ["Triage failures", "--kind", "failures", "--input", "ci.txt"], expect: 64 },
    { args: ["Check the change", "--offline"], expect: 64 },
  ];

  let failures = 0;
  for (const test of cases) {
    const result = await invoke(test.args);
    let ok = result.code === test.expect && (!test.error || test.error.test(result.stderr));
    let note = "";
    if (ok && test.json) {
      try {
        const packet = JSON.parse(result.stdout) as {
          schema?: string;
          workflow?: string;
          advisory?: boolean;
          notChecked?: unknown[];
          summary?: { sections?: string[] };
        };
        ok =
          packet.schema === "jev-code.packet/v1" &&
          packet.workflow === test.workflow &&
          packet.advisory === true &&
          Array.isArray(packet.notChecked) &&
          packet.notChecked.length > 0 &&
          (!test.sections || JSON.stringify(packet.summary?.sections) === JSON.stringify(test.sections));
        if (!ok) note = " (packet shape)";
      } catch {
        ok = false;
        note = " (invalid JSON)";
      }
    }
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} exit=${result.code} jev-code ${test.args.join(" ")}${note}`);
    if (!ok) console.log(result.stdout.slice(0, 2000), result.stderr.slice(0, 2000));
  }
  const status = execFileSync("git", ["status", "--porcelain", "--ignored"], {
    cwd: root,
    encoding: "utf8",
  });
  if (!status.includes(".jev-code/")) {
    failures++;
    console.log("FAIL expected persisted .jev-code/ artifacts to exist and be ignored");
  }
  console.log(failures === 0 ? `smoke: all ${cases.length} cases passed` : `smoke: ${failures} failure(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
