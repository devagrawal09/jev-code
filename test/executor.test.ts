import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { configuredModel, jevFromEnvironment } from "../src/adapters/config.ts";
import { createFakeAdapter } from "../src/adapters/fake-jev.ts";
import { type FrameAttempt, FrameExecutor } from "../src/core/executor.ts";
import { createFrame } from "../src/core/frame.ts";
import { noul } from "../src/core/questions.ts";
import type { JevPort } from "../src/core/types.ts";
import { expectKeys, readNoul } from "../src/core/validation.ts";

const LIMITS = { requests: 5, inputTokens: 100_000, wallMs: 60_000 };

function frame(scope: string) {
  return createFrame<number, string>({
    template: "generic@1",
    scope,
    state: { text: scope },
    questions: { yes: noul("Is it yes?") },
    provenance: [`source:${scope}`],
    parse(answers) {
      expectKeys(answers, ["yes"]);
      return readNoul(answers, "yes");
    },
  });
}

describe("core frame executor", () => {
  test("runs frames through a port with an abstract prepare hook and sink", async () => {
    const port = createFakeAdapter(() => ({ type: "noul", noul: 0.75 }));
    const attempts: FrameAttempt<string>[] = [];
    const executor = new FrameExecutor<string>({
      port,
      model: "jev-test",
      budget: LIMITS,
      prepare: (request) => ({
        request: { ...request, state: { text: String(request.state.text).toUpperCase() } },
        changes: 1,
      }),
      sink: {
        async attempt(record) {
          attempts.push(record);
        },
      },
    });
    const [first, second] = await executor.runAll([frame("a"), frame("b")]);
    assert.equal(first?.ok && first.value, 0.75);
    assert.equal(second?.ok, true);
    assert.deepEqual(
      port.requests.map((request) => request.state.text),
      ["A", "B"],
    );
    assert.equal(executor.preparedChanges, 2);
    assert.deepEqual(
      attempts.map((attempt) => [attempt.result, attempt.provenance[0]]),
      [
        ["ok", "source:a"],
        ["ok", "source:b"],
      ],
    );
    const usage = executor.usage();
    assert.equal(usage.status, "used");
    assert.equal(usage.requests, 2);
    assert.deepEqual(usage.resolvedModels, ["jev-test"]);
  });

  test("offline and unconfigured ports never call anything", async () => {
    const offline = new FrameExecutor({
      port: createFakeAdapter(),
      model: "m",
      budget: LIMITS,
      offline: true,
    });
    const outcome = await offline.run(frame("x"));
    assert.equal(!outcome.ok && outcome.reason, "offline");
    assert.equal(offline.usage().status, "offline");
    const missing = new FrameExecutor({ port: null, model: "m", budget: LIMITS });
    assert.equal(missing.unavailableReason, "Jev adapter is not configured");
  });

  test("invalid envelopes are rejected and budget denials reach the sink", async () => {
    const broken: JevPort = { ask: async () => ({ model: "m", answers: {} }) };
    const invalid = new FrameExecutor({ port: broken, model: "m", budget: LIMITS });
    const outcome = await invalid.run(frame("x"));
    assert.equal(!outcome.ok && outcome.reason, "invalid");
    assert.equal(invalid.usage().invalidResponses, 1);

    const denied: string[] = [];
    const tight = new FrameExecutor({
      port: createFakeAdapter(),
      model: "m",
      budget: { ...LIMITS, requests: 1 },
      sink: {
        async budgetExhausted(frameId, limit) {
          denied.push(`${frameId}:${limit}`);
        },
      },
    });
    const outcomes = await tight.runAll([frame("a"), frame("b")]);
    assert.deepEqual(
      outcomes.map((result) => result.ok),
      [true, false],
    );
    assert.deepEqual(denied, [`${frame("b").id}:requests`]);
  });

  test("an authentication failure disables the port for concurrent frames", async () => {
    let calls = 0;
    const port: JevPort = {
      async ask() {
        calls++;
        throw Object.assign(new Error("bad key"), { status: 401 });
      },
    };
    const executor = new FrameExecutor({
      port,
      model: "m",
      budget: LIMITS,
      concurrency: 1,
      classifyError: () => "auth",
    });
    const outcomes = await executor.runAll([frame("a"), frame("b")]);
    assert.equal(calls, 1);
    assert.deepEqual(
      outcomes.map((result) => !result.ok && result.reason),
      ["unavailable", "unavailable"],
    );
    assert.equal(executor.budget.requests, 1);
  });
});

describe("configuration adapter", () => {
  test("model flag wins over TYPESAFE_MODEL; missing credentials yield no port", () => {
    assert.equal(configuredModel("jev-flag", { TYPESAFE_MODEL: "jev-env" }), "jev-flag");
    assert.equal(configuredModel(undefined, { TYPESAFE_MODEL: " jev-env " }), "jev-env");
    assert.equal(configuredModel(undefined, {}), undefined);
    assert.equal(jevFromEnvironment({}), undefined);
  });
});
