import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  AGENT_ENV,
  agentEnvironment,
  agentFromEnvironment,
  createPiAgent,
  findPiBinary,
  NESTED_ENV,
  PI_BINARY_ENV,
  PI_FIXED_ARGS,
  PI_PREAMBLE,
  PiEventReader,
} from "../src/adapters/pi.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in `pi` binary: a Node script that speaks Pi's JSON event protocol. FAKE_PI_MODE selects its
 * behavior so process handling can be tested without any model.
 */
function fakePi(): { directory: string; binary: string } {
  const directory = mkdtempSync(join(tmpdir(), "stanley-fake-pi-"));
  roots.push(directory);
  const binary = join(directory, "pi");
  writeFileSync(
    binary,
    `#!${process.execPath}
const mode = process.env.FAKE_PI_MODE ?? "ok";
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  out({ type: "session", version: 3, id: "s", cwd: process.cwd() });
  out({ type: "agent_start" });
  if (mode === "hang") { setTimeout(() => {}, 30000); return; }
  if (mode === "crash") {
    process.stderr.write("Warning: Invalid settings file\\nfatal: nope\\n  /path/to/docs.md\\n");
    process.stdout.write("not json\\n");
    process.exit(3);
  }
  out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} });
  out({ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: {} });
  const text = JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(), stdinHead: stdin.split("\\n")[0],
    nested: process.env.${NESTED_ENV}, offline: process.env.PI_OFFLINE,
  });
  if (mode === "error") {
    out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } });
    process.exit(1);
  }
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
  out({ type: "agent_end", messages: [] });
  process.exit(0);
});
`,
    { mode: 0o755 },
  );
  chmodSync(binary, 0o755);
  return { directory, binary };
}

describe("pi event reader", () => {
  test("assembles chunked lines, counts tool calls, keeps the last assistant text, and tolerates noise", () => {
    const reader = new PiEventReader();
    const events = [
      { type: "session", version: 3 },
      "garbage",
      { type: "tool_execution_start", toolName: "read" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } },
      { type: "tool_execution_start", toolName: "bash" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "done: " },
            { type: "text", text: "all good" },
          ],
        },
      },
    ];
    const stream = events
      .map((event) => (typeof event === "string" ? event : JSON.stringify(event)))
      .join("\n");
    for (let index = 0; index < stream.length; index += 7) reader.push(stream.slice(index, index + 7));
    reader.finish();
    assert.equal(reader.toolCalls, 2);
    assert.equal(reader.text, "done: \nall good");
    assert.equal(reader.error, null);
    assert.equal(reader.events, 6);

    const failed = new PiEventReader();
    failed.push(
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "quota" } })}\n`,
    );
    assert.equal(failed.error, "quota");
  });
});

describe("pi adapter", () => {
  test("finds the binary through STANLEY_PI_BIN or PATH and reports why it is unavailable", () => {
    const { directory, binary } = fakePi();
    assert.equal(findPiBinary({ PATH: directory }), binary);
    assert.equal(findPiBinary({ PATH: "/nonexistent" }), null);
    assert.equal(findPiBinary({}), null);
    assert.equal(findPiBinary({ [PI_BINARY_ENV]: binary, PATH: "" }), binary);
    assert.equal(findPiBinary({ [PI_BINARY_ENV]: join(directory, "missing") }), null);

    assert.deepEqual(agentFromEnvironment({ PATH: directory, [AGENT_ENV]: "off" }), {
      agent: null,
      reason: "disabled",
    });
    assert.deepEqual(agentFromEnvironment({ PATH: directory, [NESTED_ENV]: "1" }), {
      agent: null,
      reason: "nested",
    });
    assert.deepEqual(agentFromEnvironment({ PATH: "/nonexistent" }), {
      agent: null,
      reason: "not_installed",
    });
    assert.equal(agentFromEnvironment({ PATH: directory }).agent?.name, "pi");
    assert.equal(agentEnvironment({ A: "1" })[NESTED_ENV], "1");
    assert.equal(agentEnvironment({ PI_OFFLINE: "0" }).PI_OFFLINE, "0");
  });

  test("runs pi in JSON print mode with instructions on stdin and marks the subprocess as nested", async () => {
    const { binary, directory } = fakePi();
    const agent = createPiAgent({ binary, env: { PATH: directory, FAKE_PI_MODE: "ok" } });
    const result = await agent.run(
      { kind: "delegate", instructions: "first line of task\nsecond line", cwd: directory },
      { timeoutMs: 10_000 },
    );
    assert.equal(result.outcome, "finished");
    assert.equal(result.exitCode, 0);
    assert.equal(result.toolCalls, 2);
    const echoed = JSON.parse(result.text) as Record<string, unknown>;
    assert.deepEqual(echoed.args, [...PI_FIXED_ARGS, PI_PREAMBLE]);
    assert.equal(echoed.stdinHead, "first line of task");
    assert.equal(echoed.nested, "1");
    assert.equal(echoed.offline, "1");
    assert.ok(typeof echoed.cwd === "string");

    const withModel = createPiAgent({ binary, env: { FAKE_PI_MODE: "ok" }, extraArgs: ["--model", "x"] });
    const modelRun = await withModel.run(
      { kind: "improve", instructions: "t", cwd: directory },
      { timeoutMs: 10_000 },
    );
    assert.deepEqual((JSON.parse(modelRun.text) as { args: string[] }).args, [
      ...PI_FIXED_ARGS,
      "--model",
      "x",
      PI_PREAMBLE,
    ]);
  });

  test("reports model errors, crashes, timeouts, and cancellation truthfully", async () => {
    const { binary, directory } = fakePi();
    const run = (mode: string, options: { timeoutMs: number; signal?: AbortSignal }) =>
      createPiAgent({ binary, env: { FAKE_PI_MODE: mode }, killGraceMs: 200 }).run(
        { kind: "delegate", instructions: "t", cwd: directory },
        options,
      );

    const errored = await run("error", { timeoutMs: 10_000 });
    assert.equal(errored.outcome, "failed");
    assert.equal(errored.detail, "boom");

    const crashed = await run("crash", { timeoutMs: 10_000 });
    assert.equal(crashed.outcome, "failed");
    assert.equal(crashed.exitCode, 3);
    assert.equal(crashed.detail, "fatal: nope");

    const timedOut = await run("hang", { timeoutMs: 300 });
    assert.equal(timedOut.outcome, "timeout");
    assert.ok(timedOut.durationMs < 5_000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await run("hang", { timeoutMs: 10_000, signal: controller.signal });
    assert.equal(aborted.outcome, "aborted");

    const missing = await createPiAgent({ binary: join(directory, "missing"), env: {} }).run(
      { kind: "delegate", instructions: "t", cwd: directory },
      { timeoutMs: 1_000 },
    );
    assert.equal(missing.outcome, "failed");
    assert.match(missing.detail ?? "", /could not start the agent/);
  });
});
