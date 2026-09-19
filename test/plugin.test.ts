import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import {
  cleanupPlugins,
  discoverPlugins,
  formatPluginDiagnostic,
  loadPlugins,
  PLUGIN_DIRECTORY,
} from "../src/adapters/plugins.ts";
import { PLUGIN_INVOCATION_LIMITS, PluginPromptRuntime } from "../src/cli/plugin-runtime.ts";
import {
  createDefaultRegistry,
  DuplicateWorkflowIdError,
  ReservedWorkflowIdError,
  registerRepositoryPlugins,
  WORKFLOWS,
  WorkflowRegistry,
} from "../src/cli/registry.ts";
import { BUILTIN_ROUTING_CRITERIA, ROUTER_OUTCOMES, type WorkflowName } from "../src/cli/router.ts";
import {
  completePluginResult,
  createPluginLog,
  isPluginValue,
  type Plugin,
  type PluginLogRecord,
  PluginValidationError,
  pluginRoutingMetadata,
  validatePlugin,
  validatePluginFactory,
} from "../src/core/plugin.ts";

const run = async () => "ok";

// ---------------------------------------------------------------------------
// Control-envelope validation
// ---------------------------------------------------------------------------

describe("plugin control envelope", () => {
  test("requires only id and run, and preserves arbitrary JSON routing fields", () => {
    const routing = {
      purpose: "release notes",
      examples: ["write a changelog"],
      weight: 2,
      nested: { a: null },
    };
    const value = { id: "release-notes", run, routing, anything: "else" };
    const plugin = validatePlugin(value);
    assert.equal(plugin, value);
    assert.deepEqual(plugin.routing, routing);
    assert.deepEqual(pluginRoutingMetadata(plugin), { routing, anything: "else" });
    assert.doesNotThrow(() => validatePlugin({ id: "minimal", run }));
  });

  test("rejects non-JSON routing fields and non-JSON run results", () => {
    assert.throws(
      () => validatePlugin({ id: "bad-metadata", run, helper: () => null }),
      /plugin\.helper must be JSON routing metadata/,
    );
    assert.deepEqual(completePluginResult({ ok: true }), {
      status: "complete",
      output: { ok: true },
    });
    assert.throws(() => completePluginResult(undefined), /plugin\.run must return text or JSON/);
  });

  test("accepts class instances whose run lives on the prototype", () => {
    class Workflow {
      readonly id = "classy";
      run() {
        return "ok";
      }
    }
    assert.doesNotThrow(() => validatePlugin(new Workflow()));
  });

  test("accepts an optional cleanup function and rejects a non-function cleanup", () => {
    assert.doesNotThrow(() => validatePlugin({ id: "a", run, cleanup: async () => {} }));
    assert.doesNotThrow(() => validatePlugin({ id: "a", run, cleanup: undefined }));
    for (const cleanup of [null, "close", 1, {}]) {
      assert.throws(() => validatePlugin({ id: "a", run, cleanup }), /plugin\.cleanup must be a function/);
    }
  });

  test("rejects non-object plugins", () => {
    for (const value of [null, undefined, "plugin", 42, [], true, run]) {
      assert.throws(() => validatePlugin(value), PluginValidationError);
    }
  });

  test("accepts lowercase ids up to 64 characters and rejects others", () => {
    for (const id of ["a", "my-workflow", "check_task", "a0-b1_c2", "z".repeat(64)]) {
      assert.doesNotThrow(() => validatePlugin({ id, run }), id);
    }
    for (const id of ["", "UPPER", "has space", "0digit", "-dash", "a".repeat(65), "a.b", null, 42, {}]) {
      assert.throws(() => validatePlugin({ id, run }), /plugin\.id must match/, String(id));
    }
  });

  test("rejects a missing or non-function run", () => {
    for (const value of [undefined, "run", null, {}]) {
      assert.throws(() => validatePlugin({ id: "a", run: value }), /plugin\.run must be a function/);
    }
  });

  test("factories must be functions", () => {
    const factory = async () => ({ id: "a", run });
    assert.equal(validatePluginFactory(factory), factory);
    for (const value of [undefined, null, { id: "a", run }, "factory"]) {
      assert.throws(() => validatePluginFactory(value), /default export must be an async factory function/);
    }
  });
});

describe("opaque plugin values", () => {
  test("text and arbitrary JSON are plugin values", () => {
    for (const value of [
      "",
      "text",
      0,
      -1.5,
      true,
      null,
      [],
      {},
      [1, "a", { b: [null] }],
      { deep: { x: [1] } },
    ]) {
      assert.ok(isPluginValue(value), JSON.stringify(value));
    }
    const shared = { x: 1 };
    assert.ok(isPluginValue({ a: shared, b: shared }), "shared acyclic references are fine");
    assert.ok(isPluginValue(Object.create(null)));
  });

  test("non-JSON values are rejected", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      run,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      Symbol("s"),
      new Date(),
      new Map(),
      cyclic,
      [undefined],
      { f: run },
    ]) {
      assert.ok(!isPluginValue(value), String(typeof value));
    }
  });
});

describe("plugin log", () => {
  test("emits structured records attributed to the plugin source", () => {
    const records: PluginLogRecord[] = [];
    const log = createPluginLog(".stanley/plugins/a.ts", (record) => records.push(record));
    log.info("started", { files: 2 });
    log.warn("careful");
    log.debug("d");
    log.error("e", null);
    assert.deepEqual(records, [
      { level: "info", source: ".stanley/plugins/a.ts", message: "started", data: { files: 2 } },
      { level: "warn", source: ".stanley/plugins/a.ts", message: "careful" },
      { level: "debug", source: ".stanley/plugins/a.ts", message: "d" },
      { level: "error", source: ".stanley/plugins/a.ts", message: "e", data: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Workflow registry
// ---------------------------------------------------------------------------

describe("workflow registry", () => {
  test("registers and retrieves candidates in insertion order", () => {
    const registry = new WorkflowRegistry();
    registry.register({ id: "alpha", routing: { instructions: "when Alpha" } }, "builtin");
    registry.register({ id: "beta", routing: { examples: ["Beta"] } }, "plugin");

    assert.equal(registry.size, 2);
    assert.ok(registry.has("alpha"));
    assert.ok(!registry.has("gamma"));
    assert.deepEqual(registry.ids(), ["alpha", "beta"]);
    assert.equal(registry.kindOf("alpha"), "builtin");
    assert.equal(registry.kindOf("beta"), "plugin");
    assert.equal(registry.kindOf("gamma"), undefined);
    assert.deepEqual(
      registry.candidates().map((candidate) => candidate.id),
      ["alpha", "beta"],
    );
  });

  test("rejects duplicate ids", () => {
    const registry = new WorkflowRegistry();
    registry.register({ id: "x", routing: { instructions: "when X" } }, "builtin");
    assert.throws(
      () => registry.register({ id: "x", routing: { instructions: "when X2" } }, "plugin"),
      /duplicate workflow id: x/,
    );
    assert.equal(registry.size, 1);
  });

  test("a plugin cannot replace a built-in", () => {
    const registry = createDefaultRegistry();
    const builtin = registry.get("find");
    assert.throws(
      () => registry.registerPlugin({ id: "find", run }, ".stanley/plugins/find.ts"),
      (error: unknown) =>
        error instanceof DuplicateWorkflowIdError &&
        error.id === "find" &&
        error.origins.join(",") === "builtin,.stanley/plugins/find.ts",
    );
    assert.equal(registry.get("find"), builtin);
    assert.equal(registry.size, 10);
  });

  test("plugins cannot replace each other", () => {
    const registry = new WorkflowRegistry();
    registry.registerPlugin({ id: "notes", run }, ".stanley/plugins/a.ts");
    assert.throws(
      () => registry.registerPlugin({ id: "notes", run }, ".stanley/plugins/b.ts"),
      DuplicateWorkflowIdError,
    );
    assert.equal(registry.get("notes")?.origin, ".stanley/plugins/a.ts");
  });

  test("batch registration is atomic", () => {
    const registry = new WorkflowRegistry();
    assert.throws(
      () =>
        registry.registerPlugins([
          { plugin: { id: "one", run }, origin: "a.ts" },
          { plugin: { id: "two", run }, origin: "b.ts" },
          { plugin: { id: "one", run }, origin: "c.ts" },
        ]),
      /duplicate workflow id: one \(registered by a\.ts and c\.ts\)/,
    );
    assert.equal(registry.size, 0);
  });

  test("router labels are reserved", () => {
    const registry = new WorkflowRegistry();
    assert.throws(() => registry.registerPlugin({ id: "cannot_tell", run }, "x.ts"), ReservedWorkflowIdError);
    assert.throws(
      () => registry.register({ id: "cannot_tell", routing: { instructions: "w" } }, "builtin"),
      ReservedWorkflowIdError,
    );
  });

  test("registered plugins are validated and retained, and can be registered as built-ins", () => {
    const registry = new WorkflowRegistry();
    assert.throws(() => registry.registerPlugin({ id: "Bad", run } as Plugin, "x.ts"), PluginValidationError);
    const plugin = { id: "native", run, routing: { any: "json" } };
    registry.registerPlugin(plugin, "builtin", "builtin");
    assert.deepEqual(registry.get("native"), {
      id: "native",
      kind: "builtin",
      origin: "builtin",
      metadata: { id: "native", routing: { routing: { any: "json" } } },
      plugin,
    });
  });

  test("all plugin JSON fields become routing metadata", () => {
    const registry = createDefaultRegistry();
    registry.registerPlugin(
      { id: "notes", run, instructions: "Use for release notes", examples: ["Write a changelog"] },
      ".stanley/plugins/notes.ts",
    );
    assert.equal(registry.size, 11);
    assert.deepEqual(registry.candidates().at(-1), {
      id: "notes",
      routing: { instructions: "Use for release notes", examples: ["Write a changelog"] },
    });
    assert.equal(registry.ids().at(-1), "notes");
  });
});

// ---------------------------------------------------------------------------
// Default registry (built-in workflows)
// ---------------------------------------------------------------------------

describe("default registry", () => {
  test("contains all ten built-in workflows", () => {
    const registry = createDefaultRegistry();
    assert.equal(registry.size, 10);
    for (const name of Object.keys(WORKFLOWS)) {
      assert.equal(registry.kindOf(name), "builtin", name);
    }
  });

  test("candidate ids match ROUTER_OUTCOMES (excluding cannot_tell) and WORKFLOWS keys", () => {
    const registry = createDefaultRegistry();
    assert.deepEqual(
      registry.ids(),
      ROUTER_OUTCOMES.filter((id) => id !== "cannot_tell"),
    );
    assert.deepEqual(registry.ids(), Object.keys(WORKFLOWS));
  });

  test("candidate metadata comes from workflow summaries and BUILTIN_ROUTING_CRITERIA", () => {
    for (const candidate of createDefaultRegistry().candidates()) {
      assert.equal(candidate.routing.description, WORKFLOWS[candidate.id as WorkflowName].summary);
      assert.equal(candidate.routing.instructions, BUILTIN_ROUTING_CRITERIA[candidate.id as WorkflowName]);
    }
  });
});

describe("plugin prompt runtime", () => {
  const fallback = (reasons: string[]) => async (_request: string, _input: unknown, reason: string) => {
    reasons.push(reason);
    return { status: "unsupported" as const, output: { reason } };
  };

  test("routes child prompts without exposing workflow identity", async () => {
    const registry = new WorkflowRegistry();
    registry.registerPlugin(
      {
        id: "parent",
        instructions: "orchestrate",
        async run({ prompt }) {
          return (await prompt("do child work", { value: 2 })).output;
        },
      },
      "parent.ts",
    );
    registry.registerPlugin(
      {
        id: "child",
        instructions: "child work",
        async run({ input }) {
          return { received: input ?? null };
        },
      },
      "child.ts",
    );
    const exclusions: string[][] = [];
    const runtime = new PluginPromptRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async (_request, _input, excluded) => {
        exclusions.push([...excluded]);
        return "child";
      },
      runBuiltin: async () => assert.fail("unexpected built-in"),
      fallback: fallback([]),
    });

    assert.deepEqual(await runtime.run("parent", "start"), {
      status: "complete",
      output: { received: { value: 2 } },
    });
    assert.deepEqual(exclusions, [["parent"]]);
  });

  test("validates top-level and nested prompt control envelopes", async () => {
    const registry = new WorkflowRegistry();
    registry.registerPlugin(
      {
        id: "invalid-caller",
        async run({ prompt }) {
          await prompt("child", new Date() as never);
          return null;
        },
      },
      "invalid.ts",
    );
    const runtime = new PluginPromptRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async () => assert.fail("invalid child input must not be routed"),
      runBuiltin: async () => assert.fail("unexpected built-in"),
      fallback: fallback([]),
    });

    await assert.rejects(runtime.run("invalid-caller", ""), /prompt instructions must be non-empty text/);
    await assert.rejects(runtime.run("invalid-caller", "start"), /prompt input must be text or JSON/);
  });

  test("stops active-stack cycles and depth overflow", async () => {
    const registry = new WorkflowRegistry();
    registry.registerPlugin(
      {
        id: "loop",
        async run({ prompt }) {
          return (await prompt("again")).output;
        },
      },
      "loop.ts",
    );
    const cycleReasons: string[] = [];
    const cycle = new PluginPromptRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async () => "loop",
      runBuiltin: async () => assert.fail("unexpected built-in"),
      fallback: fallback(cycleReasons),
    });
    await cycle.run("loop", "start");
    assert.deepEqual(cycleReasons, ["cycle"]);

    for (let index = 0; index <= PLUGIN_INVOCATION_LIMITS.maxDepth; index++) {
      const id = `step-${index}`;
      registry.registerPlugin(
        {
          id,
          async run({ prompt }) {
            return (await prompt("next")).output;
          },
        },
        `${id}.ts`,
      );
    }
    const depthReasons: string[] = [];
    let next = 1;
    const depth = new PluginPromptRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async () => `step-${next++}`,
      runBuiltin: async () => assert.fail("unexpected built-in"),
      fallback: fallback(depthReasons),
    });
    await depth.run("step-0", "start");
    assert.deepEqual(depthReasons, ["depth"]);
  });

  test("limits a tree to 32 child prompt calls", async () => {
    const registry = new WorkflowRegistry();
    registry.registerPlugin(
      {
        id: "fanout",
        async run({ prompt }) {
          let output: unknown = null;
          for (let index = 0; index <= PLUGIN_INVOCATION_LIMITS.maxChildCalls; index++) {
            output = (await prompt(`child ${index}`)).output;
          }
          return output as null;
        },
      },
      "fanout.ts",
    );
    registry.register({ id: "leaf", routing: { instructions: "leaf" } }, "builtin");
    const reasons: string[] = [];
    const runtime = new PluginPromptRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async () => "leaf",
      runBuiltin: async () => ({ status: "complete", output: "ok" }),
      fallback: fallback(reasons),
    });
    await runtime.run("fanout", "start");
    assert.deepEqual(reasons, ["calls"]);
  });
});

// ---------------------------------------------------------------------------
// Discovery and loading
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A temporary repository with the given files under `.stanley/plugins/`. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jev-plugins-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, PLUGIN_DIRECTORY, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

interface Events {
  __jevPluginEvents?: string[];
}
const events = () => {
  const store = globalThis as Events;
  store.__jevPluginEvents = [];
  return store.__jevPluginEvents;
};
const record = (event: string) => `(globalThis as any).__jevPluginEvents?.push(${JSON.stringify(event)});`;

const plugin = (id: string, extra = "") =>
  `export default async () => ({ id: ${JSON.stringify(id)}, async run() { return "ok"; }${extra} });\n`;

describe("plugin discovery", () => {
  test("a repository without a plugin directory has no plugins", async () => {
    const root = repository({});
    assert.deepEqual(await discoverPlugins(root), { sources: [], diagnostics: [] });
  });

  test("finds direct .ts/.js files and package directories in name order", async () => {
    const root = repository({
      "b.ts": plugin("b"),
      "a.js": plugin("a"),
      "types.d.ts": "export {};",
      "README.md": "# notes",
      "config.json": "{}",
      ".hidden.ts": plugin("hidden"),
      "pkg-main/package.json": JSON.stringify({ main: "lib/entry.ts" }),
      "pkg-main/lib/entry.ts": plugin("pkg-main"),
      "pkg-exports/package.json": JSON.stringify({
        exports: { ".": { import: "./src/p.js" } },
        main: "nope.js",
      }),
      "pkg-exports/src/p.js": plugin("pkg-exports"),
      "pkg-index/index.ts": plugin("pkg-index"),
      "pkg-index/package.json": JSON.stringify({ name: "pkg-index" }),
      "node_modules/dep/index.js": plugin("dep"),
    });
    const { sources, diagnostics } = await discoverPlugins(root);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      sources.map(({ path, kind, entry }) => [path, kind, entry.slice(root.length + 1)]),
      [
        [".stanley/plugins/a.js", "file", ".stanley/plugins/a.js"],
        [".stanley/plugins/b.ts", "file", ".stanley/plugins/b.ts"],
        [".stanley/plugins/pkg-exports", "package", ".stanley/plugins/pkg-exports/src/p.js"],
        [".stanley/plugins/pkg-index", "package", ".stanley/plugins/pkg-index/index.ts"],
        [".stanley/plugins/pkg-main", "package", ".stanley/plugins/pkg-main/lib/entry.ts"],
      ],
    );
  });

  test("unresolvable package directories become discovery diagnostics", async () => {
    const root = repository({
      "empty/notes.txt": "",
      "escape/package.json": JSON.stringify({ main: "../outside.ts" }),
      "missing/package.json": JSON.stringify({ main: "gone.ts" }),
      "broken/package.json": "{",
    });
    const { sources, diagnostics } = await discoverPlugins(root);
    assert.deepEqual(sources, []);
    assert.deepEqual(
      diagnostics.map(({ source, phase }) => [source, phase]),
      [
        [".stanley/plugins/broken", "discover"],
        [".stanley/plugins/empty", "discover"],
        [".stanley/plugins/escape", "discover"],
        [".stanley/plugins/missing", "discover"],
      ],
    );
    assert.match(diagnostics[0]!.message, /invalid package\.json/);
    assert.match(diagnostics[1]!.message, /no package entrypoint/);
    assert.match(
      diagnostics[2]!.message,
      /package entrypoint not found or escapes its directory: \.\.\/outside\.ts/,
    );
    assert.match(diagnostics[3]!.message, /package entrypoint not found or escapes its directory: gone\.ts/);
  });

  test("package entrypoint symlinks cannot escape the package directory", async () => {
    const root = repository({
      "linked/package.json": JSON.stringify({ main: "entry.ts" }),
    });
    const outside = join(root, "outside.ts");
    writeFileSync(outside, plugin("outside"));
    symlinkSync(outside, join(root, PLUGIN_DIRECTORY, "linked/entry.ts"));

    const discovery = await discoverPlugins(root);
    assert.deepEqual(discovery.sources, []);
    assert.equal(discovery.diagnostics[0]?.source, ".stanley/plugins/linked");
    assert.match(discovery.diagnostics[0]?.message ?? "", /escapes its directory/);
  });

  test("direct files and package directories cannot be symlinked outside the plugin directory", async () => {
    const root = repository({ "notes.txt": "" });
    const outsideFile = join(root, "outside.ts");
    const outsidePackage = join(root, "outside-package");
    writeFileSync(outsideFile, plugin("outside-file"));
    mkdirSync(outsidePackage);
    writeFileSync(join(outsidePackage, "index.ts"), plugin("outside-package"));
    symlinkSync(outsideFile, join(root, PLUGIN_DIRECTORY, "escaped.ts"));
    symlinkSync(outsidePackage, join(root, PLUGIN_DIRECTORY, "linked-package"));

    const discovery = await discoverPlugins(root);
    assert.deepEqual(discovery.sources, []);
    assert.deepEqual(
      discovery.diagnostics.map(({ source, message }) => [source, message]),
      [
        [".stanley/plugins/escaped.ts", "plugin source escapes its directory"],
        [".stanley/plugins/linked-package", "plugin source escapes its directory"],
      ],
    );
  });
});

describe("plugin loading", () => {
  test("imports TypeScript through tsx and awaits factories with only root, signal, and log", async () => {
    const root = repository({
      "enum.ts": [
        "enum Kind { Notes = 'notes' }",
        "export default async function (context: { root: string; signal: AbortSignal; log: any }) {",
        "  (globalThis as any).__jevInit = { keys: Object.keys(context).sort(), root: context.root, aborted: context.signal.aborted };",
        "  context.log.info('initialized', { kind: Kind.Notes });",
        "  await new Promise((resolve) => setTimeout(resolve, 5));",
        "  return { id: Kind.Notes, run: async () => 'ok', routing: { purpose: 'notes' } };",
        "}",
      ].join("\n"),
      "esm/package.json": JSON.stringify({ type: "module", main: "index.js" }),
      "esm/index.js": plugin("esm-js"),
      "plain.js": "module.exports = async () => ({ id: 'plain-cjs', run() {} });",
    });
    const logs: PluginLogRecord[] = [];
    const warnings: string[] = [];
    const result = await loadPlugins({
      root,
      log: (entry) => logs.push(entry),
      warn: (w) => warnings.push(w),
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(result.quarantined, []);
    assert.deepEqual(
      result.loaded.map(({ plugin, source }) => [plugin.id, source.path, source.kind]),
      [
        ["notes", ".stanley/plugins/enum.ts", "file"],
        ["esm-js", ".stanley/plugins/esm", "package"],
        ["plain-cjs", ".stanley/plugins/plain.js", "file"],
      ],
    );
    assert.deepEqual(result.loaded[0]!.plugin.routing, { purpose: "notes" });
    const init = (globalThis as { __jevInit?: unknown }).__jevInit;
    assert.deepEqual(init, { keys: ["log", "root", "signal"], root: realpathSync(root), aborted: false });
    assert.deepEqual(logs, [
      { level: "info", source: ".stanley/plugins/enum.ts", message: "initialized", data: { kind: "notes" } },
    ]);
  });

  test("quarantines import, factory, and validation failures with visible warnings and keeps the rest", async () => {
    const seen = events();
    const root = repository({
      "a-syntax.ts": "export default async () => ({ id: 'x', run() {",
      "b-throws.ts": "export default async () => { throw new Error('factory exploded'); };",
      "c-invalid.ts": `export default async () => ({ id: 'Invalid Id', run: async () => 'ok', cleanup: async () => { ${record("cleanup:c")} } });`,
      "d-no-default.ts": "export const plugin = { id: 'd', run() {} };",
      "e-object.ts": "export default { id: 'e', run() {} };",
      "f-sync.ts": "export default () => ({ id: 'sync', run() {} });",
      "g-good.ts": plugin("good"),
    });
    mkdirSync(join(root, PLUGIN_DIRECTORY, "h-dir"));
    const warnings: string[] = [];
    const result = await loadPlugins({ root, warn: (warning) => warnings.push(warning) });

    assert.deepEqual(
      result.loaded.map(({ plugin }) => plugin.id),
      ["good"],
    );
    assert.deepEqual(
      result.quarantined.map(({ source, phase }) => [source, phase]),
      [
        [".stanley/plugins/h-dir", "discover"],
        [".stanley/plugins/a-syntax.ts", "import"],
        [".stanley/plugins/b-throws.ts", "factory"],
        [".stanley/plugins/c-invalid.ts", "validate"],
        [".stanley/plugins/d-no-default.ts", "validate"],
        [".stanley/plugins/e-object.ts", "validate"],
        [".stanley/plugins/f-sync.ts", "factory"],
      ],
    );
    assert.equal(result.quarantined[2]!.message, "factory exploded");
    assert.match(result.quarantined[3]!.message, /plugin\.id must match/);
    assert.match(
      result.quarantined[4]!.message,
      /default export must be an async factory function \(got undefined\)/,
    );
    assert.match(result.quarantined[5]!.message, /\(got object\)/);
    assert.match(result.quarantined[6]!.message, /default factory must return a Promise/);
    assert.deepEqual(warnings, result.quarantined.map(formatPluginDiagnostic));
    assert.match(
      warnings[2]!,
      /^stanley: warning: plugin \.stanley\/plugins\/b-throws\.ts quarantined \(factory\): factory exploded$/,
    );
    assert.deepEqual(seen, ["cleanup:c"], "an invalid plugin's cleanup still runs");
  });

  test("an aborted load cleans up initialized plugins and rethrows", async () => {
    const seen = events();
    const controller = new AbortController();
    (globalThis as { __jevAbort?: AbortController }).__jevAbort = controller;
    const root = repository({
      "a.ts": plugin("a", `, cleanup: async () => { ${record("cleanup:a")} }`),
      "b.ts": `export default async () => { (globalThis as any).__jevAbort.abort(new Error("stop")); return { id: "b", run() {}, cleanup() { ${record("cleanup:b")} } }; };`,
      "c.ts": `export default async () => { ${record("init:c")} return { id: "c", run() {} }; };`,
    });
    await assert.rejects(loadPlugins({ root, signal: controller.signal, warn: () => {} }), /stop/);
    assert.deepEqual(seen, ["cleanup:b", "cleanup:a"]);
  });

  test("cleanup runs in reverse order and reports failures without stopping", async () => {
    const order: string[] = [];
    const source = (path: string) => ({ path, kind: "file" as const, entry: path });
    const warnings: string[] = [];
    await cleanupPlugins(
      [
        { plugin: { id: "a", run, cleanup: async () => void order.push("a") }, source: source("a.ts") },
        { plugin: { id: "b", run }, source: source("b.ts") },
        {
          plugin: {
            id: "c",
            run,
            cleanup: async () => {
              order.push("c");
              throw new Error("busy");
            },
          },
          source: source("c.ts"),
        },
      ],
      (warning) => warnings.push(warning),
    );
    assert.deepEqual(order, ["c", "a"]);
    assert.deepEqual(warnings, ["stanley: warning: plugin c.ts cleanup failed: busy"]);
  });
});

describe("repository plugin registration", () => {
  test("registers loaded plugins beside built-ins as routing candidates", async () => {
    const root = repository({ "notes.ts": plugin("release_notes") });
    const registry = createDefaultRegistry();
    const candidates = registry.candidates();
    const result = await registerRepositoryPlugins(registry, { root, warn: () => {} });
    assert.equal(result.loaded.length, 1);
    assert.equal(registry.size, 11);
    assert.equal(registry.get("release_notes")?.kind, "plugin");
    assert.equal(registry.get("release_notes")?.origin, ".stanley/plugins/notes.ts");
    assert.equal(registry.get("release_notes")?.plugin, result.loaded[0]!.plugin);
    assert.deepEqual(registry.candidates(), [...candidates, { id: "release_notes", routing: {} }]);
  });

  test("a plugin claiming a built-in id fails registration and is cleaned up", async () => {
    const seen = events();
    const root = repository({
      "find.ts": plugin("find", `, cleanup() { ${record("cleanup:find")} }`),
      "other.ts": plugin("other", `, cleanup() { ${record("cleanup:other")} }`),
    });
    const registry = createDefaultRegistry();
    await assert.rejects(
      registerRepositoryPlugins(registry, { root, warn: () => {} }),
      /duplicate workflow id: find \(registered by builtin and \.stanley\/plugins\/find\.ts\)/,
    );
    assert.equal(registry.size, 10);
    assert.equal(registry.kindOf("find"), "builtin");
    assert.deepEqual(seen, ["cleanup:other", "cleanup:find"]);
  });

  test("two plugins with the same id fail registration rather than choosing one", async () => {
    const root = repository({ "a.ts": plugin("same"), "b/index.ts": plugin("same") });
    const registry = new WorkflowRegistry();
    await assert.rejects(
      registerRepositoryPlugins(registry, { root, warn: () => {} }),
      (error: unknown) =>
        error instanceof DuplicateWorkflowIdError &&
        error.origins.join(",") === ".stanley/plugins/a.ts,.stanley/plugins/b",
    );
    assert.equal(registry.size, 0);
  });
});
