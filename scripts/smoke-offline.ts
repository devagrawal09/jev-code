/**
 * Offline smoke test for the built CLI. Creates a temporary git repository, runs every
 * command with --offline (no network, no credentials), and checks exit codes and JSON shape.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dirname, "../dist/cli.js");
const root = mkdtempSync(join(tmpdir(), "jev-code-smoke-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

const env = { ...process.env };
delete env.TYPESAFE_API_KEY;

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
    "FAIL test/math.test.js\n  ● adds\n    expect(received).toEqual(expected)\n    Expected: 3\n    Received: 4\n      at Object.<anonymous> (test/math.test.js:3:20)\n",
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

  const cases: Array<{ args: string[]; expect: number[]; json?: boolean }> = [
    { args: ["--help"], expect: [0] },
    { args: ["flag-diff", "--help"], expect: [0] },
    { args: ["flag-diff"], expect: [64] },
    { args: ["flag-diff", "--task", "fix add overflow", "--offline", "--json"], expect: [11], json: true },
    { args: ["flag-diff", "--task", "fix add overflow", "--offline"], expect: [11] },
    { args: ["triage-failures", "--log", "ci.txt", "--offline", "--json"], expect: [11], json: true },
    { args: ["locate", "where is add implemented", "--offline", "--json"], expect: [11], json: true },
    {
      args: ["map-criteria", "--criteria-file", "criteria.md", "--offline", "--json"],
      expect: [11],
      json: true,
    },
    { args: ["flag-rules", "--rules", "rules.json", "--offline", "--json"], expect: [11], json: true },
    {
      args: ["triage-comments", "--comments", "comments.json", "--offline", "--json"],
      expect: [11],
      json: true,
    },
    { args: ["run-frame", "--file", "frame.json", "--offline", "--json"], expect: [11], json: true },
    { args: ["run-frame", "--file", "../outside.json", "--offline"], expect: [65] },
    // No --offline and no key: Jev is unavailable, so the packet is ladder-only.
    {
      args: ["flag-diff", "--task", "fix add overflow", "--no-persist", "--json"],
      expect: [11],
      json: true,
    },
  ];

  let failures = 0;
  for (const test of cases) {
    const result = spawnSync(process.execPath, [cli, ...test.args], { cwd: root, env, encoding: "utf8" });
    let ok = test.expect.includes(result.status ?? -1);
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
    console.log(`${ok ? "ok  " : "FAIL"} exit=${result.status} jev-code ${test.args.join(" ")}${note}`);
    if (!ok) console.log(result.stdout.slice(0, 2000), result.stderr.slice(0, 2000));
  }
  const status = execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: root, encoding: "utf8" });
  if (!status.includes(".jev-code/")) {
    failures++;
    console.log("FAIL expected persisted .jev-code/ artifacts to exist and be ignored");
  }
  console.log(failures === 0 ? `smoke: all ${cases.length} cases passed` : `smoke: ${failures} failure(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
