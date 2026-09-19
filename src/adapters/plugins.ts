/**
 * Repository plugin discovery and loading.
 *
 * Discovery follows OpenCode's model inside `.stanley/plugins/`: direct `.ts` and `.js` files are plugins, and
 * each subdirectory is a plugin package whose entrypoint comes from its package.json (`exports`, `module`, `main`)
 * or falls back to `index.ts` / `index.js`. Modules are imported through `tsx`, so ordinary TypeScript works.
 *
 * Any plugin that cannot be resolved, fails to import, whose factory throws, or whose result fails control-envelope
 * validation is quarantined: a diagnostic is returned, a visible warning is emitted, and loading continues.
 * Duplicate ids are not handled here; registration rejects them.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { sha256 } from "../core/hash.ts";
import {
  createPluginLog,
  type Plugin,
  type PluginLogRecord,
  validatePlugin,
  validatePluginFactory,
} from "../core/plugin.ts";
import { safeMessage } from "./redact.ts";

/** Repository-relative plugin directory. */
export const PLUGIN_DIRECTORY = ".stanley/plugins";

const DIRECT_EXTENSIONS = new Set([".ts", ".js"]);
const INDEX_ENTRIES = ["index.ts", "index.js"];

export interface PluginSource {
  /** Repository-relative POSIX path of the plugin file or package directory. */
  readonly path: string;
  readonly kind: "file" | "package";
  /** Absolute path of the module to import. */
  readonly entry: string;
}

export type PluginPhase = "discover" | "import" | "factory" | "validate";

export interface PluginDiagnostic {
  readonly source: string;
  readonly phase: PluginPhase;
  readonly message: string;
}

export interface LoadedPlugin {
  readonly plugin: Plugin;
  readonly source: PluginSource;
}

export interface PluginDiscovery {
  readonly sources: readonly PluginSource[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface PluginLoadResult {
  readonly loaded: readonly LoadedPlugin[];
  readonly quarantined: readonly PluginDiagnostic[];
}

export interface LoadPluginsOptions {
  /** Repository root. It is canonicalized before being handed to plugins. */
  readonly root: string;
  /** Repository-relative directory to discover in. Defaults to the active plugin directory. */
  readonly directory?: string;
  readonly signal?: AbortSignal;
  /** Receives structured plugin log records. Defaults to discarding them. */
  readonly log?: (record: PluginLogRecord) => void;
  /** Receives visible warnings for quarantined plugins. Defaults to stderr. */
  readonly warn?: (message: string) => void;
}

const toPosix = (path: string) => path.split(sep).join("/");
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isContained = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const defaultWarn = (message: string) => {
  process.stderr.write(`${safeMessage(message, 2_000)}\n`);
};

export function formatPluginDiagnostic(diagnostic: PluginDiagnostic): string {
  return `stanley: warning: plugin ${diagnostic.source} quarantined (${diagnostic.phase}): ${diagnostic.message}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The package.json-declared entry, if any: `exports` (string or "." with import/default), `module`, `main`. */
function declaredEntry(manifest: unknown): string | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const pkg = manifest as Record<string, unknown>;
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const conditions = value as Record<string, unknown>;
      if ("." in conditions) return pick(conditions["."]);
      return pick(conditions.import) ?? pick(conditions.default);
    }
    return undefined;
  };
  return pick(pkg.exports) ?? pick(pkg.module) ?? pick(pkg.main);
}

async function packageEntry(directory: string): Promise<{ entry?: string; error?: string }> {
  const packageRoot = await realpath(directory);
  const entryIfContained = async (name: string) => {
    const candidate = resolve(directory, name);
    if (!isContained(directory, candidate)) return undefined;
    if (!(await isFile(candidate))) return undefined;
    const resolved = await realpath(candidate);
    if (!isContained(packageRoot, resolved)) return undefined;
    return candidate;
  };
  const manifestPath = join(directory, "package.json");
  if (await isFile(manifestPath)) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      return { error: `invalid package.json: ${messageOf(error)}` };
    }
    const declared = declaredEntry(manifest);
    if (declared !== undefined) {
      const entry = await entryIfContained(declared);
      return entry
        ? { entry }
        : { error: `package entrypoint not found or escapes its directory: ${declared}` };
    }
  }
  for (const name of INDEX_ENTRIES) {
    const entry = await entryIfContained(name);
    if (entry) return { entry };
  }
  return {
    error: `no package entrypoint (package.json exports/module/main, or ${INDEX_ENTRIES.join(" / ")})`,
  };
}

/**
 * Discover plugin sources in `<root>/<relativeDirectory>` (default `.stanley/plugins`), sorted by name. A missing
 * directory yields none. Improvement candidates are discovered the same way from their staging directory.
 */
export async function discoverPlugins(
  root: string,
  relativeDirectory: string = PLUGIN_DIRECTORY,
): Promise<PluginDiscovery> {
  const directory = join(root, relativeDirectory);
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sources: [], diagnostics: [] };
    return {
      sources: [],
      diagnostics: [{ source: relativeDirectory, phase: "discover", message: messageOf(error) }],
    };
  }
  let canonicalRoot: string;
  let pluginRoot: string;
  try {
    canonicalRoot = await realpath(root);
    pluginRoot = await realpath(directory);
  } catch (error) {
    return {
      sources: [],
      diagnostics: [{ source: relativeDirectory, phase: "discover", message: messageOf(error) }],
    };
  }
  if (!isContained(canonicalRoot, pluginRoot)) {
    return {
      sources: [],
      diagnostics: [
        {
          source: relativeDirectory,
          phase: "discover",
          message: "plugin directory escapes the repository",
        },
      ],
    };
  }
  const sources: PluginSource[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = join(directory, name);
    const source = toPosix(relative(root, path));
    let info: Awaited<ReturnType<typeof stat>>;
    let physical: string;
    try {
      info = await stat(path);
      physical = await realpath(path);
    } catch (error) {
      diagnostics.push({ source, phase: "discover", message: messageOf(error) });
      continue;
    }
    if (!isContained(pluginRoot, physical)) {
      diagnostics.push({ source, phase: "discover", message: "plugin source escapes its directory" });
      continue;
    }
    if (info.isFile()) {
      if (DIRECT_EXTENSIONS.has(extname(name)) && !name.endsWith(".d.ts")) {
        sources.push({ path: source, kind: "file", entry: path });
      }
    } else if (info.isDirectory()) {
      try {
        const resolved = await packageEntry(path);
        if (resolved.entry) sources.push({ path: source, kind: "package", entry: resolved.entry });
        else {
          diagnostics.push({
            source,
            phase: "discover",
            message: resolved.error ?? "unresolvable package",
          });
        }
      } catch (error) {
        diagnostics.push({ source, phase: "discover", message: messageOf(error) });
      }
    }
  }
  return { sources, diagnostics };
}

/** Content hashes of every file under the plugin directory, keyed by repository-relative POSIX path. */
export async function pluginDirectoryFingerprint(
  root: string,
  relativeDirectory: string = PLUGIN_DIRECTORY,
): Promise<Map<string, string>> {
  const fingerprint = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) fingerprint.set(toPosix(relative(root, path)), sha256(await readFile(path)));
    }
  };
  await walk(join(root, relativeDirectory));
  return fingerprint;
}

export interface PluginDirectoryChanges {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
}

/** Paths that differ between two fingerprints. */
export function pluginDirectoryChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): PluginDirectoryChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [path, hash] of after) {
    const previous = before.get(path);
    if (previous === undefined) added.push(path);
    else if (previous !== hash) modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  return { added, modified, removed };
}

/**
 * The module's default export. A `.ts` file outside an ESM package is compiled as CommonJS, in which case the
 * namespace default is `module.exports`; for transpiled ES modules (`__esModule`) the author's default export sits
 * one level deeper. A plain CommonJS `module.exports = factory` is used as-is.
 */
function defaultExport(namespace: Record<string, unknown>): unknown {
  const value = namespace.default;
  if (
    "module.exports" in namespace &&
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__esModule === true
  ) {
    return (value as Record<string, unknown>).default;
  }
  return value;
}

async function discardPartial(value: unknown): Promise<void> {
  if (typeof value !== "object" || value === null) return;
  try {
    const cleanup = (value as Record<string, unknown>).cleanup;
    if (typeof cleanup !== "function") return;
    await cleanup.call(value);
  } catch {
    // The plugin is already quarantined; its original failure is the diagnostic that matters.
  }
}

/** Run every loaded plugin's cleanup, in reverse load order. Failures are reported but do not stop others. */
export async function cleanupPlugins(
  loaded: readonly LoadedPlugin[],
  warn: (message: string) => void = defaultWarn,
): Promise<void> {
  for (const { plugin, source } of [...loaded].reverse()) {
    try {
      const cleanup = plugin.cleanup;
      if (typeof cleanup !== "function") continue;
      await cleanup.call(plugin);
    } catch (error) {
      warn(`stanley: warning: plugin ${source.path} cleanup failed: ${messageOf(error)}`);
    }
  }
}

/**
 * Discover, import, initialize, and validate repository plugins in name order. Failures are quarantined with a
 * visible warning. If the signal aborts, already-initialized plugins are cleaned up and the abort is rethrown.
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<PluginLoadResult> {
  const warn = options.warn ?? defaultWarn;
  const sink = options.log ?? (() => {});
  const signal = options.signal ?? new AbortController().signal;
  const root = await realpath(options.root);
  const discovery = await discoverPlugins(root, options.directory);
  const loaded: LoadedPlugin[] = [];
  const quarantined: PluginDiagnostic[] = [...discovery.diagnostics];
  const quarantine = (diagnostic: PluginDiagnostic) => {
    quarantined.push(diagnostic);
    warn(formatPluginDiagnostic(diagnostic));
  };
  for (const diagnostic of discovery.diagnostics) warn(formatPluginDiagnostic(diagnostic));

  try {
    for (const source of discovery.sources) {
      signal.throwIfAborted();
      let namespace: Record<string, unknown>;
      try {
        namespace = await tsImport(pathToFileURL(source.entry).href, { parentURL: import.meta.url });
      } catch (error) {
        quarantine({ source: source.path, phase: "import", message: messageOf(error) });
        continue;
      }
      let factory: ReturnType<typeof validatePluginFactory>;
      try {
        factory = validatePluginFactory(defaultExport(namespace));
      } catch (error) {
        quarantine({ source: source.path, phase: "validate", message: messageOf(error) });
        continue;
      }
      let value: unknown;
      try {
        const initialized: unknown = factory({ root, signal, log: createPluginLog(source.path, sink) });
        if (
          (typeof initialized !== "object" && typeof initialized !== "function") ||
          initialized === null ||
          typeof (initialized as { then?: unknown }).then !== "function"
        ) {
          throw new Error("default factory must return a Promise");
        }
        value = await initialized;
      } catch (error) {
        signal.throwIfAborted();
        quarantine({ source: source.path, phase: "factory", message: messageOf(error) });
        continue;
      }
      try {
        loaded.push({ plugin: validatePlugin(value), source });
      } catch (error) {
        await discardPartial(value);
        quarantine({ source: source.path, phase: "validate", message: messageOf(error) });
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    await cleanupPlugins(loaded, warn);
    throw error;
  }
  return { loaded, quarantined };
}
