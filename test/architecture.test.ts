/**
 * Enforces the production dependency direction cli -> adapters -> workflows -> core
 * (see docs/architecture.md). Uses only Node built-ins.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";

type Layer = "core" | "workflows" | "adapters" | "cli";

/** Layers each layer may import. Production modules outside these folders are rejected. */
const ALLOWED: Record<Layer, readonly Layer[]> = {
  core: ["core"],
  workflows: ["workflows", "core"],
  adapters: ["adapters", "workflows", "core"],
  cli: ["cli", "adapters", "workflows", "core"],
};

/** Top-level entry modules. They belong to the cli layer and no production module may import them. */
const ENTRY_POINTS = new Set(["cli.ts", "index.ts"]);

const FILESYSTEM_OR_PROCESS = /^(?:node:)?(?:fs|fs\/promises|child_process)$/;
const SDK = /^@typesafe-ai\/sdk(?:\/|$)/;

function layerOf(path: string): Layer | null {
  if (ENTRY_POINTS.has(path)) return "cli";
  const [folder, ...rest] = path.split("/");
  if (rest.length === 0) return null;
  return folder === "core" || folder === "workflows" || folder === "adapters" || folder === "cli"
    ? folder
    : null;
}

const SPECIFIER_PATTERNS = [
  // import x from "y"; import type { x } from "y"; export { x } from "y"; export * from "y"
  /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  // import "y"
  /\bimport\s*["']([^"']+)["']/g,
  // import("y")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  // require("y")
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

/** Every architecture violation for a set of production modules given as src-relative posix paths. */
export function architectureViolations(modules: ReadonlyArray<{ path: string; source: string }>): string[] {
  const violations: string[] = [];
  for (const { path, source } of modules) {
    const layer = layerOf(path);
    if (!layer) {
      violations.push(`${path}: not in a layer folder (core/, workflows/, adapters/, cli/)`);
      continue;
    }
    if ((layer === "core" || layer === "workflows") && /\bTypeSafeClient\b/.test(source)) {
      violations.push(`${path}: ${layer} must not reference the concrete TypeSafeClient`);
    }
    if (layer === "workflows" && /\bprocess\.env\b/.test(source)) {
      violations.push(`${path}: workflows must not read process.env; configuration belongs in adapters`);
    }
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        if (SDK.test(specifier) && (layer === "core" || layer === "workflows")) {
          violations.push(`${path}: ${layer} must not import the TypeSafe SDK (${specifier})`);
        } else if (FILESYSTEM_OR_PROCESS.test(specifier) && (layer === "core" || layer === "workflows")) {
          violations.push(`${path}: ${layer} must not import ${specifier}`);
        } else if (layer === "workflows") {
          violations.push(`${path}: workflows may import only core and workflow modules (${specifier})`);
        } else if (layer === "core" && !specifier.startsWith("node:")) {
          violations.push(`${path}: core may import only Node built-ins (${specifier})`);
        }
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (target.startsWith("../")) {
        violations.push(`${path}: imports outside src (${specifier})`);
        continue;
      }
      if (ENTRY_POINTS.has(target)) {
        violations.push(`${path} -> ${target}: entry points must not be imported`);
        continue;
      }
      const targetLayer = layerOf(target);
      if (!targetLayer) {
        violations.push(`${path} -> ${target}: target is not in a layer folder`);
      } else if (!ALLOWED[layer].includes(targetLayer)) {
        violations.push(`${path} -> ${target}: ${layer} must not import ${targetLayer}`);
      }
    }
  }
  return violations;
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : extname(path) === ".ts" ? [path] : [];
  });
}

describe("architecture", () => {
  test("production imports follow cli -> adapters -> workflows -> core", () => {
    const root = resolve(import.meta.dirname, "../src");
    const modules = walk(root).map((file) => ({
      path: relative(root, file).split(sep).join("/"),
      source: readFileSync(file, "utf8"),
    }));
    assert.ok(modules.some((module) => module.path.startsWith("core/")));
    assert.ok(modules.some((module) => module.path.startsWith("workflows/")));
    assert.ok(modules.some((module) => module.path.startsWith("adapters/")));
    assert.deepEqual(architectureViolations(modules), []);
  });

  test("the checker rejects every forbidden edge and import kind", () => {
    const cases: Array<{ path: string; source: string; expect: RegExp }> = [
      {
        path: "core/a.ts",
        source: 'import { x } from "../workflows/b.ts";',
        expect: /core must not import workflows/,
      },
      {
        path: "core/a.ts",
        source: 'import type { X } from "../adapters/b.ts";',
        expect: /core must not import adapters/,
      },
      { path: "core/a.ts", source: 'export * from "../cli/b.ts";', expect: /core must not import cli/ },
      { path: "core/a.ts", source: 'import { TypeSafeClient } from "@typesafe-ai/sdk";', expect: /TypeSafe/ },
      { path: "core/a.ts", source: "const client: TypeSafeClient = make();", expect: /TypeSafeClient/ },
      {
        path: "core/a.ts",
        source: 'import { readFile } from "node:fs/promises";',
        expect: /must not import node:fs/,
      },
      { path: "core/a.ts", source: 'import left from "left-pad";', expect: /only Node built-ins/ },
      {
        path: "workflows/a.ts",
        source: 'import { x } from "../adapters/b.ts";',
        expect: /workflows must not import adapters/,
      },
      {
        path: "workflows/a.ts",
        source: 'const m = await import("../cli/b.ts");',
        expect: /workflows must not import cli/,
      },
      {
        path: "workflows/a.ts",
        source: 'import { spawn } from "node:child_process";',
        expect: /must not import node:child_process/,
      },
      { path: "workflows/a.ts", source: 'import fs from "fs";', expect: /must not import fs/ },
      {
        path: "workflows/a.ts",
        source: 'import { createHash } from "node:crypto";',
        expect: /only core and workflow/,
      },
      { path: "workflows/a.ts", source: "const key = process.env.KEY;", expect: /process\.env/ },
      {
        path: "adapters/a.ts",
        source: 'import { x } from "../cli/b.ts";',
        expect: /adapters must not import cli/,
      },
      { path: "adapters/a.ts", source: 'import "../index.ts";', expect: /entry points must not be imported/ },
      { path: "cli/a.ts", source: 'const x = require("../../outside.ts");', expect: /outside src/ },
      { path: "misc.ts", source: "", expect: /not in a layer folder/ },
    ];
    for (const { path, source, expect } of cases) {
      const found = architectureViolations([{ path, source }]);
      assert.ok(
        found.some((violation) => expect.test(violation)),
        `${path}: ${source} -> ${JSON.stringify(found)}`,
      );
    }
    const allowed = [
      {
        path: "workflows/a.ts",
        source: 'import type { Frame } from "../core/types.ts";\nimport { b } from "./b.ts";',
      },
      {
        path: "adapters/a.ts",
        source: 'import { run } from "../workflows/run.ts";\nimport { readFile } from "node:fs";',
      },
      { path: "adapters/jev.ts", source: 'import { TypeSafeClient } from "@typesafe-ai/sdk";' },
      { path: "cli/a.ts", source: 'import { x } from "../adapters/x.ts";\nimport { y } from "./y.ts";' },
      {
        path: "index.ts",
        source: 'export * from "./workflows/types.ts";\nexport { EXIT } from "./cli/output.ts";',
      },
      { path: "core/hash.ts", source: 'import { createHash } from "node:crypto";' },
    ];
    assert.deepEqual(architectureViolations(allowed), []);
  });
});
