import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, JsonValue } from "../core/types.ts";
import type { ArtifactWriter } from "../workflows/ports.ts";
import { redactJson } from "./redact.ts";

export const ARTIFACT_ROOT = ".jev-code/runs";

/**
 * Writes one run's artifacts under `.jev-code/runs/<runId>`. Every value passes through the
 * redactor before it touches disk. Files are 0600 and directories 0700.
 */
export class Recorder implements ArtifactWriter {
  readonly directory: string;
  readonly relative: string;
  private chain: Promise<void> = Promise.resolve();

  private constructor(directory: string, relative: string) {
    this.directory = directory;
    this.relative = relative;
  }

  static async open(root: string, runId: string): Promise<Recorder> {
    const jevDir = join(root, ".jev-code");
    await mkdir(jevDir, { recursive: true, mode: 0o700 });
    // Keep artifacts out of commits even when the repository's .gitignore does not list them.
    await writeFile(join(jevDir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }).catch(() => undefined);
    const relative = `${ARTIFACT_ROOT}/${runId}`;
    const directory = join(root, relative);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new Recorder(directory, relative);
  }

  json(name: string, value: unknown): Promise<void> {
    return this.enqueue(async () => {
      const path = join(this.directory, name);
      const temporary = `${path}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(sanitize(value), null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    });
  }

  line(name: string, value: unknown): Promise<void> {
    return this.enqueue(() =>
      appendFile(join(this.directory, name), `${JSON.stringify(sanitize(value))}\n`, { mode: 0o600 }),
    );
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/**
 * The recorded `inputs` of the newest runs whose IDs start with `<workflow>-`, newest first.
 * Run IDs embed a UTC timestamp, so reverse lexical order is newest first. Partial artifacts are skipped.
 */
export async function recentInputs(root: string, workflow: string, limit: number): Promise<JsonObject[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, ARTIFACT_ROOT)))
      .filter((name) => name.startsWith(`${workflow}-`))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const found: JsonObject[] = [];
  for (const name of names.slice(0, limit)) {
    try {
      const value = JSON.parse(await readFile(join(root, ARTIFACT_ROOT, name, "inputs.json"), "utf8")) as {
        inputs?: unknown;
      };
      if (typeof value.inputs === "object" && value.inputs !== null && !Array.isArray(value.inputs)) {
        found.push(value.inputs as JsonObject);
      }
    } catch {
      // Partial artifacts are ignored.
    }
  }
  return found;
}

function sanitize(value: unknown): JsonValue {
  const plain = JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  return redactJson(plain).value;
}
