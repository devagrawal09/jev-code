import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorkflowDependencies } from "../src/adapters/dependencies.ts";
import { createFakeAdapter } from "../src/adapters/fake-jev.ts";
import type { Question } from "../src/core/questions.ts";
import type { JevRequest } from "../src/core/types.ts";
import type { RunOptions } from "../src/workflows/run.ts";

export interface TempRepo {
  root: string;
  write(files: Record<string, string>): void;
  git(...args: string[]): string;
  commit(message?: string): void;
  cleanup(): void;
}

export function tempRepo(files: Record<string, string> = {}): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "jev-code-test-"));
  const repo: TempRepo = {
    root,
    write(entries) {
      for (const [path, text] of Object.entries(entries)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
    },
    git: (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }),
    commit(message = "commit") {
      repo.git("add", "-A");
      repo.git("commit", "-qm", message);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  repo.git("init", "-q", "-b", "main");
  repo.git("config", "user.email", "test@example.com");
  repo.git("config", "user.name", "test");
  repo.git("config", "commit.gpgsign", "false");
  repo.write(files);
  if (Object.keys(files).length > 0) repo.commit("init");
  return repo;
}

export type Responder = (name: string, question: Question, request: JevRequest) => unknown;

export function fake(respond: Responder = () => undefined) {
  return createFakeAdapter(respond);
}

export function options(
  root: string,
  adapter: ReturnType<typeof fake>,
  extra: Partial<RunOptions> = {},
): RunOptions {
  return {
    root,
    dependencies: createWorkflowDependencies(root, adapter),
    persist: false,
    concurrency: 2,
    retries: 0,
    ...extra,
  };
}

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** The JSON-serialized state of a request, for substring assertions. */
export const stateText = (request: JevRequest) => JSON.stringify(request.state);
