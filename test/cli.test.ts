import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
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
  const r = tempRepo({ "src/a.ts": "export const a = 1;\n", "notes/criteria.md": "- a is two\n" });
  r.write({ "src/a.ts": "export const a = 2;\n" });
  return r;
}

describe("cli", () => {
  test("help, version, unknown commands, and usage errors", async () => {
    const r = repo();
    try {
      const help = await cli(r.root, ["--help"]);
      assert.equal(help.code, 0);
      for (const name of [
        "flag-diff",
        "triage-failures",
        "flag-rules",
        "map-criteria",
        "triage-comments",
        "locate",
        "run-frame",
      ]) {
        assert.ok(help.stdout.includes(name), name);
      }
      const [stable, preview, experimental, advanced] = help.stdout
        .split(/\n(?=Preview commands|Experimental commands|Advanced:|Global options:)/)
        .slice(0, 4);
      assert.match(stable!, /flag-diff[\s\S]*triage-failures/);
      assert.match(preview!, /flag-rules[\s\S]*map-criteria/);
      assert.match(experimental!, /triage-comments[\s\S]*locate/);
      assert.match(advanced!, /run-frame/);
      assert.equal((await cli(r.root, [])).code, 64);
      assert.match((await cli(r.root, ["--version"])).stdout, /^\d+\.\d+\.\d+\n$/);
      assert.equal((await cli(r.root, ["deploy"])).code, 64);
      assert.equal((await cli(r.root, ["constructor"])).code, 64);
      // Pre-release names have no aliases.
      for (const removed of ["audit-diff", "check-rules", "check-criteria"]) {
        assert.equal((await cli(r.root, [removed, "--help"])).code, 64, removed);
      }
      const missing = await cli(r.root, ["flag-diff"]);
      assert.equal(missing.code, 64);
      assert.match(missing.stderr, /task is required/);
      assert.equal((await cli(r.root, ["flag-diff", "--task", "x", "--bogus"])).code, 64);
      assert.equal((await cli(r.root, ["flag-diff", "--task", "x", "--scope", "everything"])).code, 64);
      assert.equal((await cli(r.root, ["locate", "x", "--top", "-3"])).code, 64);
      const commandHelp = await cli(r.root, ["flag-rules", "--help"]);
      assert.equal(commandHelp.code, 0);
      assert.match(commandHelp.stdout, /--rules <path>/);
      assert.match(commandHelp.stdout, /^Preview:/m);
      assert.match((await cli(r.root, ["locate", "--help"])).stdout, /^Experimental:/m);
      assert.match((await cli(r.root, ["run-frame", "--help"])).stdout, /^Advanced:/m);
      assert.doesNotMatch((await cli(r.root, ["flag-diff", "--help"])).stdout, /Preview|Experimental/);
    } finally {
      r.cleanup();
    }
  });

  test("JSON output is a stable packet; human output is concise and advisory", async () => {
    const r = repo();
    try {
      const adapter = fake((name) => (name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined));
      const json = await cli(r.root, ["flag-diff", "--task", "set a to two", "--json", "--no-persist"], {
        adapter,
      });
      assert.equal(json.code, 0, json.stderr);
      const packet = JSON.parse(json.stdout);
      assert.equal(packet.schema, "jev-code.packet/v1");
      assert.equal(packet.workflow, "flag-diff@1");
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

      const human = await cli(r.root, ["flag-diff", "--task", "set a to two", "--no-persist"], { adapter });
      assert.equal(human.code, 0);
      assert.match(human.stdout, /advisory only/);
      assert.match(human.stdout, /not an approval/);
      assert.match(human.stdout, /not checked:/);
    } finally {
      r.cleanup();
    }
  });

  test("reads one input from stdin and enforces workspace containment for files", async () => {
    const r = repo();
    try {
      const adapter = fake((name) => (name === "nondeterminism_signature" ? fakeNoul(0.1) : undefined));
      const stdin = await cli(r.root, ["triage-failures", "--log", "-", "--json", "--no-persist"], {
        adapter,
        stdin: fixture("go-failure.txt"),
      });
      assert.equal(stdin.code, 0, stdin.stderr);
      assert.equal(JSON.parse(stdin.stdout).summary.logSource, "stdin");

      const escaped = await cli(r.root, ["triage-failures", "--log", "../../etc/passwd", "--json"]);
      assert.equal(escaped.code, 65);
      assert.equal(JSON.parse(escaped.stdout).error.kind, "input");
      const secret = await cli(r.root, ["map-criteria", "--criteria-file", ".env"]);
      assert.equal(secret.code, 65);

      const criteria = await cli(r.root, [
        "map-criteria",
        "--criteria-file",
        "notes/criteria.md",
        "--offline",
        "--no-persist",
        "--json",
      ]);
      assert.equal(criteria.code, 11);
      const outside = await cli("/", [
        "flag-diff",
        "--task",
        "x",
        "--repo",
        r.root,
        "--offline",
        "--no-persist",
      ]);
      assert.equal(outside.code, 11);
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
      const result = await cli(r.root, ["flag-diff", "--task", "set a to two", "--json", "--no-persist"], {
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
      const crashed = await cli(r.root, ["flag-diff", "--task", "x", "--no-persist"], { adapter: crash });
      assert.ok(!crashed.stdout.includes(key) && !crashed.stderr.includes(key));
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
      r.cleanup();
    }
  });
});
