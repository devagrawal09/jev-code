import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import { WORKFLOWS } from "../src/cli/registry.ts";
import { runCli } from "../src/cli.ts";
import type { JevPort as JevAdapter } from "../src/core/types.ts";
import { fake, fixture, tempRepo } from "./helpers.ts";

async function cli(
  root: string,
  args: string[],
  extra: { adapter?: JevAdapter; stdin?: string; env?: NodeJS.ProcessEnv } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
      stdin: Readable.from([extra.stdin ?? ""]),
      cwd: root,
      env: extra.env ?? {},
    },
    extra.adapter ? { adapter: extra.adapter } : {},
  );
  return { code, stdout, stderr };
}

function repo() {
  const r = tempRepo({
    "src/a.ts": "export const a = 1;\n",
    "notes/criteria.md": "- a is two\n",
    "notes/rules.json": JSON.stringify({
      version: 1,
      rules: [{ id: "no-magic", class: "semantic", text: "No magic numbers.", scope: ["src/**"] }],
    }),
  });
  r.write({ "src/a.ts": "export const a = 2;\n" });
  return r;
}

describe("cli", () => {
  test("the public commands are exactly check, triage, and find, named the same internally", () => {
    assert.deepEqual(Object.keys(WORKFLOWS), ["check", "triage", "find"]);
    for (const [command, workflow] of Object.entries(WORKFLOWS)) {
      assert.equal(workflow.info.name, command, "workflow info name must equal the command");
      assert.equal(workflow.run.name, command, "workflow function name must equal the command");
    }
  });

  test("help, version, unknown commands, and usage errors", async () => {
    const r = repo();
    try {
      const help = await cli(r.root, ["--help"]);
      assert.equal(help.code, 0);
      const listed = help.stdout
        .split("Commands:\n")[1]!
        .split("\n\n")[0]!
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[0]);
      assert.deepEqual(listed, ["check", "triage", "find"]);
      assert.match(help.stdout, /Experimental: every command and report may change/);
      assert.doesNotMatch(help.stdout, /--offline/);
      assert.equal((await cli(r.root, [])).code, 64);
      assert.match((await cli(r.root, ["--version"])).stdout, /^\d+\.\d+\.\d+\n$/);
      assert.equal((await cli(r.root, ["deploy"])).code, 64);
      assert.equal((await cli(r.root, ["constructor"])).code, 64);
      // Removed commands and internal names have no aliases, hidden or otherwise.
      for (const removed of [
        "review",
        "rules",
        "criteria",
        "failures",
        "comments",
        "ask",
        "locate",
        "run-frame",
        "audit-diff",
        "check-rules",
        "check-criteria",
        "triage-failures",
        "triage-comments",
      ]) {
        const result = await cli(r.root, [removed, "--help"]);
        assert.equal(result.code, 64, removed);
        assert.match(result.stderr, /unknown command/, removed);
      }
      const adapter = fake();
      const missing = await cli(r.root, ["check"], { adapter });
      assert.equal(missing.code, 64);
      assert.match(missing.stderr, /task is required/);
      assert.equal((await cli(r.root, ["check", "--task", "x", "--bogus"])).code, 64);
      assert.equal(
        (await cli(r.root, ["check", "--task", "x", "--scope", "everything"], { adapter })).code,
        64,
      );
      const both = await cli(
        r.root,
        ["check", "--task", "x", "--criteria", "1. a", "--criteria-file", "notes/criteria.md"],
        { adapter },
      );
      assert.equal(both.code, 64);
      assert.match(both.stderr, /either --criteria or --criteria-file/);
      const orphan = await cli(r.root, ["check", "--task", "x", "--test-results", "notes/criteria.md"], {
        adapter,
      });
      assert.equal(orphan.code, 64);
      assert.match(orphan.stderr, /--test-results needs --criteria/);
      assert.equal((await cli(r.root, ["check", "--task", "x", "--rules", "-"], { adapter })).code, 64);
      const noKind = await cli(r.root, ["triage", "--input", "-"], { adapter });
      assert.equal(noKind.code, 64);
      assert.match(noKind.stderr, /--kind failures\|comments is required/);
      assert.equal((await cli(r.root, ["triage", "--kind", "logs", "--input", "-"], { adapter })).code, 64);
      const noInput = await cli(r.root, ["triage", "--kind", "failures"], { adapter });
      assert.equal(noInput.code, 64);
      assert.match(noInput.stderr, /--input <path\|-> is required/);
      const commentTask = await cli(r.root, ["triage", "--kind", "comments", "--input", "-", "--task", "x"], {
        adapter,
      });
      assert.equal(commentTask.code, 64);
      assert.match(commentTask.stderr, /only used with --kind failures/);
      assert.equal((await cli(r.root, ["triage", "--kind", "failures", "--log", "-"], { adapter })).code, 64);
      assert.equal((await cli(r.root, ["find", "x", "--top", "-3"], { adapter })).code, 64);
      const checkHelp = await cli(r.root, ["check", "--help"]);
      assert.equal(checkHelp.code, 0);
      for (const flag of ["--task <text>", "[--rules <path>]", "[--criteria <text>", "[--test-results"]) {
        assert.ok(checkHelp.stdout.includes(flag), flag);
      }
      assert.match(checkHelp.stdout, /Experimental: this command and its report may change/);
      assert.doesNotMatch(checkHelp.stdout, /Preview|Advanced/);
      const triageHelp = await cli(r.root, ["triage", "--help"]);
      assert.match(triageHelp.stdout, /--kind failures\|comments --input <path\|->/);
      assert.match(triageHelp.stdout, /Experimental:/);
      assert.match((await cli(r.root, ["find", "--help"])).stdout, /Experimental:/);
    } finally {
      r.cleanup();
    }
  });

  test("JSON output is a versioned packet; human output is concise and advisory", async () => {
    const r = repo();
    try {
      const adapter = fake((name) => (name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined));
      const json = await cli(
        r.root,
        [
          "check",
          "--task",
          "set a to two",
          "--criteria-file",
          "notes/criteria.md",
          "--rules",
          "notes/rules.json",
          "--json",
          "--no-persist",
        ],
        { adapter },
      );
      assert.equal(json.code, 0, json.stderr);
      const packet = JSON.parse(json.stdout);
      assert.equal(packet.schema, "jev-code.packet/v1");
      assert.equal(packet.workflow, "check@1");
      assert.deepEqual(packet.summary.sections, ["task", "rules", "criteria"]);
      assert.deepEqual(
        [...new Set(packet.results.map((result: { section: string }) => result.section))],
        ["task", "rules", "criteria"],
      );
      assert.equal(packet.advisory, true);
      assert.equal(packet.artifact, null);
      for (const key of [
        "status",
        "coverage",
        "findings",
        "parked",
        "excluded",
        "limits",
        "notChecked",
        "results",
        "summary",
        "jev",
      ]) {
        assert.ok(key in packet, key);
      }
      assert.ok(!("approved" in packet) && !("pass" in packet));

      const human = await cli(r.root, ["check", "--task", "set a to two", "--no-persist"], { adapter });
      assert.equal(human.code, 0);
      assert.match(human.stdout, /^jev-code check@1 · /);
      assert.match(human.stdout, /advisory only/);
      assert.match(human.stdout, /not an approval/);
      assert.match(human.stdout, /project rules \(no rules supplied\)/);
      const sections = await cli(
        r.root,
        ["check", "--task", "set a to two", "--criteria", "1. a is two", "--no-persist"],
        { adapter },
      );
      assert.match(sections.stdout, /! criterion_unevidenced/);
      assert.match(sections.stdout, /\ncriteria:\n {2}unsupported/);
      assert.match(human.stdout, /not checked:/);
    } finally {
      r.cleanup();
    }
  });

  test("reads one input from stdin and enforces workspace containment for files", async () => {
    const r = repo();
    try {
      const adapter = fake((name) => (name === "nondeterminism_signature" ? fakeNoul(0.1) : undefined));
      const stdin = await cli(
        r.root,
        ["triage", "--kind", "failures", "--input", "-", "--json", "--no-persist"],
        { adapter, stdin: fixture("go-failure.txt") },
      );
      assert.equal(stdin.code, 0, stdin.stderr);
      const triaged = JSON.parse(stdin.stdout);
      assert.equal(triaged.workflow, "triage@1");
      assert.equal(triaged.summary.kind, "failures");
      assert.equal(triaged.summary.source, "stdin");
      assert.ok(triaged.results.every((result: { kind: string }) => result.kind === "failures"));

      const comments = await cli(
        r.root,
        ["triage", "--kind", "comments", "--input", "-", "--no-diff", "--no-persist"],
        { adapter, stdin: JSON.stringify([{ id: 1, body: "a should be 3", path: "src/a.ts", line: 1 }]) },
      );
      assert.equal(comments.code, 0, comments.stderr);
      assert.match(comments.stdout, /^jev-code triage@1 · /);
      assert.match(comments.stdout, /\ncomments:\n/);

      const twoStdin = await cli(r.root, ["check", "--task-file", "-", "--criteria-file", "-"], {
        adapter,
        stdin: "x",
      });
      assert.equal(twoStdin.code, 64);
      assert.match(twoStdin.stderr, /only one input may be read from stdin/);

      const escaped = await cli(
        r.root,
        ["triage", "--kind", "failures", "--input", "../../etc/passwd", "--json"],
        { adapter },
      );
      assert.equal(escaped.code, 65);
      assert.equal(JSON.parse(escaped.stdout).error.kind, "input");
      const secret = await cli(r.root, ["check", "--task", "x", "--criteria-file", ".env"], { adapter });
      assert.equal(secret.code, 65);

      const outside = await cli("/", ["check", "--task", "x", "--repo", r.root, "--no-persist"], {
        adapter,
      });
      assert.equal(outside.code, 0);
    } finally {
      r.cleanup();
    }
  });

  test("errors never print the API key", async () => {
    const r = repo();
    const key = "tsk_live_SUPERSECRET_0123456789";
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = key;
    try {
      const leaky: JevAdapter = {
        async ask() {
          throw new Error(`request failed for key ${key}`);
        },
      };
      const result = await cli(r.root, ["check", "--task", "set a to two", "--json", "--no-persist"], {
        adapter: leaky,
        env: { TYPESAFE_API_KEY: key },
      });
      assert.equal(result.code, 10);
      assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
      const crash: JevAdapter = {
        ask: () => {
          throw new TypeError(`boom ${key}`);
        },
      };
      const crashed = await cli(r.root, ["check", "--task", "x", "--no-persist"], { adapter: crash });
      assert.ok(!crashed.stdout.includes(key) && !crashed.stderr.includes(key));
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
      r.cleanup();
    }
  });
});
