import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import { WORKFLOWS } from "../src/cli/registry.ts";
import { ROUTER_OUTCOMES, type WorkflowName } from "../src/cli/router.ts";
import { runCli } from "../src/cli.ts";
import type { JevPort as JevAdapter } from "../src/core/types.ts";
import { fake, fixture, type Responder, tempRepo } from "./helpers.ts";

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

function routed(route: WorkflowName, respond: Responder = () => undefined) {
  return fake((name, question, request) =>
    name === "route" ? fakeChoice(ROUTER_OUTCOMES, route, 0.9) : respond(name, question, request),
  );
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
  test("the only internal routing targets are the four typed workflows", () => {
    assert.deepEqual(Object.keys(WORKFLOWS), ["find", "check", "triage_failures", "triage_comments"]);
    assert.equal(WORKFLOWS.find.run.name, "find");
    assert.equal(WORKFLOWS.check.run.name, "check");
    assert.equal(WORKFLOWS.triage_failures.run.name, "triageFailures");
    assert.equal(WORKFLOWS.triage_comments.run.name, "triageComments");
  });

  test("help exposes one natural-language entry point and no command or override grammar", async () => {
    const r = repo();
    try {
      const help = await cli(r.root, ["--help"]);
      assert.equal(help.code, 0);
      assert.ok(help.stdout.includes('Usage: jev-code "<request>" [options]'));
      assert.match(help.stdout, /Jev routes the request/);
      assert.doesNotMatch(help.stdout, /Commands:|<command>|--as|--kind|--offline/);
      assert.equal((await cli(r.root, [])).code, 64);
      assert.match((await cli(r.root, ["--version"])).stdout, /^\d+\.\d+\.\d+\n$/);
      assert.equal((await cli(r.root, ["help"])).code, 0);
      assert.equal((await cli(r.root, ["find relevant code", "--bogus"])).code, 64);
      assert.equal((await cli(r.root, ["find relevant code", "--as", "find"])).code, 64);
      assert.equal((await cli(r.root, ["find relevant code", "--offline"])).code, 64);

      const missingKey = await cli(r.root, ["find relevant code"]);
      assert.equal(missingKey.code, 65);
      assert.match(missingKey.stderr, /TYPESAFE_API_KEY/);
    } finally {
      r.cleanup();
    }
  });

  test("routes natural requests with diff, input shape, capabilities, and option names as bounded context", async () => {
    const r = repo();
    try {
      const adapter = routed("check", (name) =>
        name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined,
      );
      const result = await cli(
        r.root,
        ["Check whether the change sets a to two", "--task-source", "user", "--json", "--no-persist"],
        { adapter },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).workflow, "check@1");
      const routing = adapter.requests[0]!;
      assert.deepEqual(Object.keys(routing.questions), ["route"]);
      const routeQuestion = routing.questions.route!;
      assert.equal(routeQuestion.type, "choice");
      if (routeQuestion.type !== "choice") assert.fail("route must be a choice question");
      assert.deepEqual(Object.keys(routeQuestion.criteria), ROUTER_OUTCOMES);
      assert.deepEqual(routing.state.context, {
        diff: "present",
        input: "none",
        capabilities: { find: true, check: true, triage_failures: false, triage_comments: false },
        options: ["task-source"],
      });
      assert.equal(routing.state.request, "Check whether the change sets a to two");
    } finally {
      r.cleanup();
    }
  });

  test("asks for clarification when the route is ambiguous, uncertain, or unavailable", async () => {
    const changed = repo();
    const clean = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const ambiguous = await cli(changed.root, ["Take a look", "--json"], { adapter: fake() });
      assert.equal(ambiguous.code, 64);
      assert.match(ambiguous.stderr, /Should jev-code find relevant code, check the current diff/);
      assert.equal(JSON.parse(ambiguous.stdout).error.kind, "usage");

      const uncertain = await cli(changed.root, ["Find the relevant code"], {
        adapter: fake((name) => (name === "route" ? fakeChoice(ROUTER_OUTCOMES, "find", 0.4) : undefined)),
      });
      assert.equal(uncertain.code, 64);

      const unavailable = await cli(clean.root, ["Check my current changes"], { adapter: routed("check") });
      assert.equal(unavailable.code, 64);
      assert.match(unavailable.stderr, /no current diff/i);

      const wrongShape = await cli(changed.root, ["Triage these failures"], {
        adapter: routed("triage_failures"),
        stdin: "ordinary prose, not a failure log",
      });
      assert.equal(wrongShape.code, 64);
      assert.match(wrongShape.stderr, /not recognized as failures/);
    } finally {
      changed.cleanup();
      clean.cleanup();
    }
  });

  test("rejects route answers outside the fixed outcome set", async () => {
    const r = repo();
    try {
      const adapter = fake((name) =>
        name === "route"
          ? {
              type: "choice",
              choice: "deploy",
              confidence: 0.9,
              probabilities: {
                find: 0.01,
                check: 0.01,
                triage_failures: 0.01,
                triage_comments: 0.01,
                cannot_tell: 0.01,
                deploy: 0.95,
              },
            }
          : undefined,
      );
      const result = await cli(r.root, ["Deploy this branch", "--json"], { adapter });
      assert.equal(result.code, 70);
      assert.equal(JSON.parse(result.stdout).error.kind, "internal");
      assert.equal(adapter.requests.length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("JSON output remains a versioned packet and human output remains advisory", async () => {
    const r = repo();
    try {
      const adapter = routed("check", (name) =>
        name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined,
      );
      const json = await cli(
        r.root,
        [
          "Check the change against the task and requirements",
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

      const human = await cli(r.root, ["Check whether a is set to two", "--no-persist"], { adapter });
      assert.equal(human.code, 0);
      assert.match(human.stdout, /^jev-code check@1 · /);
      assert.match(human.stdout, /advisory only/);
      assert.match(human.stdout, /not an approval/);
      assert.match(human.stdout, /project rules \(no rules supplied\)/);
      assert.match(human.stdout, /not checked:/);
    } finally {
      r.cleanup();
    }
  });

  test("routes recognized failure logs and review-comment JSON from stdin", async () => {
    const r = repo();
    try {
      const failures = routed("triage_failures", (name) =>
        name === "nondeterminism_signature" ? fakeNoul(0.1) : undefined,
      );
      const stdin = await cli(r.root, ["Triage these test failures", "--json", "--no-persist"], {
        adapter: failures,
        stdin: fixture("go-failure.txt"),
      });
      assert.equal(stdin.code, 0, stdin.stderr);
      const triaged = JSON.parse(stdin.stdout);
      assert.equal(triaged.workflow, "triage@1");
      assert.equal(triaged.summary.kind, "failures");
      assert.equal(triaged.summary.source, "stdin");
      assert.ok(triaged.results.every((result: { kind: string }) => result.kind === "failures"));
      assert.equal((failures.requests[0]!.state.context as { input: string }).input, "failure_log");

      const comments = await cli(r.root, ["Sort these review comments", "--no-diff", "--no-persist"], {
        adapter: routed("triage_comments"),
        stdin: JSON.stringify([{ id: 1, body: "a should be 3", path: "src/a.ts", line: 1 }]),
      });
      assert.equal(comments.code, 0, comments.stderr);
      assert.match(comments.stdout, /^jev-code triage@1 · /);
      assert.match(comments.stdout, /\ncomments:\n/);
    } finally {
      r.cleanup();
    }
  });

  test("keeps workflow options typed after routing", async () => {
    const r = repo();
    try {
      const both = await cli(
        r.root,
        ["Check the requirements", "--criteria", "1. a", "--criteria-file", "notes/criteria.md"],
        { adapter: routed("check") },
      );
      assert.equal(both.code, 64);
      assert.match(both.stderr, /either --criteria or --criteria-file/);

      const orphan = await cli(r.root, ["Check the requirements", "--test-results", "notes/criteria.md"], {
        adapter: routed("check"),
      });
      assert.equal(orphan.code, 64);
      assert.match(orphan.stderr, /--test-results needs --criteria/);

      const mismatched = await cli(r.root, ["Find the relevant code", "--rules", "notes/rules.json"], {
        adapter: routed("find"),
      });
      assert.equal(mismatched.code, 64);
      assert.match(mismatched.stderr, /--rules is not used/);

      const commentTask = await cli(r.root, ["Triage these comments", "--task", "x"], {
        adapter: routed("triage_comments"),
        stdin: JSON.stringify([{ body: "change this" }]),
      });
      assert.equal(commentTask.code, 64);
      assert.match(commentTask.stderr, /--task is not used/);

      assert.equal((await cli(r.root, ["Find code", "--top", "-3"], { adapter: routed("find") })).code, 64);
    } finally {
      r.cleanup();
    }
  });

  test("enforces one stdin source and workspace containment", async () => {
    const r = repo();
    try {
      const twoStdin = await cli(
        r.root,
        ["Check the task and criteria", "--task-file", "-", "--criteria-file", "-"],
        { adapter: routed("check"), stdin: "x" },
      );
      assert.equal(twoStdin.code, 64);
      assert.match(twoStdin.stderr, /only one input may be read from stdin/);

      const escaped = await cli(r.root, ["Triage these failures", "--input", "../../etc/passwd", "--json"], {
        adapter: routed("triage_failures"),
      });
      assert.equal(escaped.code, 65);
      assert.equal(JSON.parse(escaped.stdout).error.kind, "input");

      const secret = await cli(r.root, ["Check the criteria", "--criteria-file", ".env"], {
        adapter: routed("check"),
      });
      assert.equal(secret.code, 65);

      const outside = await cli("/", ["Check whether a changed", "--repo", r.root, "--no-persist"], {
        adapter: routed("check"),
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
      const leaky = fake(() => {
        throw new Error(`request failed for key ${key}`);
      });
      const result = await cli(r.root, ["Check whether a changed", "--json", "--no-persist"], {
        adapter: leaky,
        env: { TYPESAFE_API_KEY: key },
      });
      assert.equal(result.code, 70);
      assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));

      const crash: JevAdapter = {
        ask: () => {
          throw new TypeError(`boom ${key}`);
        },
      };
      const crashed = await cli(r.root, ["Find code", "--no-persist"], {
        adapter: crash,
        env: { TYPESAFE_API_KEY: key },
      });
      assert.ok(!crashed.stdout.includes(key) && !crashed.stderr.includes(key));
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
      r.cleanup();
    }
  });
});
