/** Smoke test the built CLI with a deterministic test Jev. No network calls are made. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createFakeAdapter } from "../src/adapters/fake-jev.ts";

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
const adapter = createFakeAdapter();

async function invoke(args: string[], withAdapter = true) {
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
    withAdapter ? { adapter } : {},
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
  write(
    "frame.json",
    JSON.stringify({
      version: 1,
      scope: "smoke",
      state: { note: "hello" },
      questions: { greeting: { type: "noul", instructions: "Is this a greeting?" } },
    }),
  );

  const cases: Array<{ args: string[]; expect: number; json?: boolean; adapter?: boolean; error?: RegExp }> =
    [
      { args: ["--help"], expect: 0 },
      { args: ["review", "--help"], expect: 0 },
      { args: ["review"], expect: 64 },
      { args: ["review", "--task", "fix add overflow", "--json"], expect: 0, json: true },
      { args: ["failures", "--log", "ci.txt", "--json"], expect: 0, json: true },
      { args: ["find", "where is add implemented", "--json"], expect: 0, json: true },
      { args: ["criteria", "--criteria-file", "criteria.md", "--json"], expect: 0, json: true },
      { args: ["rules", "--rules", "rules.json", "--json"], expect: 0, json: true },
      { args: ["comments", "--comments", "comments.json", "--json"], expect: 0, json: true },
      { args: ["ask", "--file", "frame.json", "--json"], expect: 0, json: true },
      { args: ["ask", "--file", "../outside.json"], expect: 65 },
      { args: ["review", "--task", "x", "--offline"], expect: 64 },
      {
        args: ["review", "--task", "x"],
        expect: 64,
        adapter: false,
        error: /TYPESAFE_API_KEY is required/,
      },
    ];

  let failures = 0;
  for (const test of cases) {
    const result = await invoke(test.args, test.adapter !== false);
    let ok = result.code === test.expect && (!test.error || test.error.test(result.stderr));
    let note = "";
    if (ok && test.json) {
      try {
        const packet = JSON.parse(result.stdout) as {
          schema?: string;
          advisory?: boolean;
          notChecked?: unknown[];
        };
        ok =
          packet.schema === "jev-code.packet/v1" &&
          packet.advisory === true &&
          Array.isArray(packet.notChecked) &&
          packet.notChecked.length > 0;
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
