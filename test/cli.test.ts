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
      for (const name of ["review", "failures", "rules", "criteria", "comments", "find", "ask"]) {
        assert.ok(help.stdout.includes(name), name);
      }
      assert.match(help.stdout, /Experimental: every command and report may change/);
      assert.match(
        help.stdout,
        /review[\s\S]*failures[\s\S]*rules[\s\S]*criteria[\s\S]*comments[\s\S]*find[\s\S]*ask/,
      );
      assert.equal((await cli(r.root, [])).code, 64);
      assert.match((await cli(r.root, ["--version"])).stdout, /^\d+\.\d+\.\d+\n$/);
      assert.equal((await cli(r.root, ["deploy"])).code, 64);
      assert.equal((await cli(r.root, ["constructor"])).code, 64);
      // Unreleased names have no aliases.
      for (const removed of [
        "flag-diff",
        "triage-failures",
        "flag-rules",
        "map-criteria",
        "triage-comments",
        "locate",
        "run-frame",
        "audit-diff",
        "check-rules",
        "check-criteria",
      ]) {
        assert.equal((await cli(r.root, [removed, "--help"])).code, 64, removed);
      }
      const adapter = fake();
      const missing = await cli(r.root, ["review"], { adapter });
      assert.equal(missing.code, 64);
      assert.match(missing.stderr, /task is required/);
      assert.equal((await cli(r.root, ["review", "--task", "x", "--bogus"])).code, 64);
      assert.equal(
        (await cli(r.root, ["review", "--task", "x", "--scope", "everything"], { adapter })).code,
        64,
      );
      assert.equal((await cli(r.root, ["find", "x", "--top", "-3"], { adapter })).code, 64);
      const noKey = await cli(r.root, ["review", "--task", "x"]);
      assert.equal(noKey.code, 64);
      assert.match(noKey.stderr, /TYPESAFE_API_KEY is required/);
      assert.equal((await cli(r.root, ["review", "--task", "x", "--offline"])).code, 64);
      const commandHelp = await cli(r.root, ["rules", "--help"]);
      assert.equal(commandHelp.code, 0);
      assert.match(commandHelp.stdout, /--rules <path>/);
      assert.match(commandHelp.stdout, /Experimental: this command and its report may change/);
      assert.doesNotMatch(commandHelp.stdout, /Preview|Advanced/);
      assert.match((await cli(r.root, ["review", "--help"])).stdout, /Experimental:/);
      assert.match((await cli(r.root, ["ask", "--help"])).stdout, /Experimental:/);
    } finally {
      r.cleanup();
    }
  });

  test("JSON output is a versioned packet; human output is concise and advisory", async () => {
    const r = repo();
    try {
      const adapter = fake((name) => (name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined));
      const json = await cli(r.root, ["review", "--task", "set a to two", "--json", "--no-persist"], {
        adapter,
      });
      assert.equal(json.code, 0, json.stderr);
      const packet = JSON.parse(json.stdout);
      assert.equal(packet.schema, "jev-code.packet/v1");
      assert.equal(packet.workflow, "review@1");
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

      const human = await cli(r.root, ["review", "--task", "set a to two", "--no-persist"], { adapter });
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
      const stdin = await cli(r.root, ["failures", "--log", "-", "--json", "--no-persist"], {
        adapter,
        stdin: fixture("go-failure.txt"),
      });
      assert.equal(stdin.code, 0, stdin.stderr);
      assert.equal(JSON.parse(stdin.stdout).summary.logSource, "stdin");

      const escaped = await cli(r.root, ["failures", "--log", "../../etc/passwd", "--json"], {
        adapter,
      });
      assert.equal(escaped.code, 65);
      assert.equal(JSON.parse(escaped.stdout).error.kind, "input");
      const secret = await cli(r.root, ["criteria", "--criteria-file", ".env"], { adapter });
      assert.equal(secret.code, 65);

      const criteria = await cli(
        r.root,
        ["criteria", "--criteria-file", "notes/criteria.md", "--no-persist", "--json"],
        { adapter },
      );
      assert.equal(criteria.code, 0);
      const outside = await cli("/", ["review", "--task", "x", "--repo", r.root, "--no-persist"], {
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
      const result = await cli(r.root, ["review", "--task", "set a to two", "--json", "--no-persist"], {
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
      const crashed = await cli(r.root, ["review", "--task", "x", "--no-persist"], { adapter: crash });
      assert.ok(!crashed.stdout.includes(key) && !crashed.stderr.includes(key));
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
      r.cleanup();
    }
  });
});
