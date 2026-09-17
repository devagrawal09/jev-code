import { spawn } from "node:child_process";
import type { DiffSelection, DiffSource } from "../workflows/ports.ts";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Read-only git subcommands this tool may run. Anything else is a programming error. */
const ALLOWED = new Set(["rev-parse", "diff", "ls-files", "log"]);
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Run a fixed read-only git command with an argument array (no shell). Configuration that
 * could execute repository-controlled programs (fsmonitor, external diff, textconv, pager)
 * is disabled, and optional index locks are skipped so nothing is written.
 */
export async function git(root: string, args: readonly string[]): Promise<string> {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED.has(subcommand))
    throw new GitError(`git subcommand not allowed: ${subcommand}`);
  const fullArgs = ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-C", root, ...args];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
  for (const name of ["GIT_EXTERNAL_DIFF", "TYPESAFE_API_KEY", "COPILOT_MCP_TYPESAFE_API_KEY"])
    delete env[name];
  return new Promise((resolve, reject) => {
    const child = spawn("git", fullArgs, { stdio: ["ignore", "pipe", "pipe"], shell: false, env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(new GitError(`git ${subcommand} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      stdout.push(part);
    });
    child.stderr.on("data", (part: Buffer) => stderr.push(part));
    child.on("error", (error) => reject(new GitError(`git could not start: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else {
        const message = Buffer.concat(stderr).toString("utf8").trim().split("\n")[0] ?? "";
        reject(new GitError(`git ${subcommand} failed: ${message.slice(0, 200)}`));
      }
    });
  });
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

/** Accept only conventional ref spellings; never let a ref be parsed as an option. */
export function assertSafeRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(ref) || ref.includes("..")) {
    throw new GitError(`unsupported ref: ${JSON.stringify(ref.slice(0, 80))}`);
  }
  return ref;
}

export async function resolveCommit(root: string, ref: string): Promise<string> {
  const safe = assertSafeRef(ref);
  return (await git(root, ["rev-parse", "--verify", "--quiet", `${safe}^{commit}`])).trim();
}

export async function headCommit(root: string): Promise<string | null> {
  try {
    return await resolveCommit(root, "HEAD");
  } catch {
    return null;
  }
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3"];

/** Collect the diff for a scope using fixed arguments. */
export async function collectDiff(root: string, selection: DiffSelection): Promise<DiffSource> {
  const head = await headCommit(root);
  let args: string[];
  let baseRef: string | null = null;
  let baseCommit: string | null = null;
  if (selection.scope === "staged") {
    args = ["diff", ...DIFF_FLAGS, "--cached"];
    if (head) args.push(head);
  } else if (selection.scope === "branch") {
    baseRef = selection.base ?? "main";
    baseCommit = await resolveCommit(root, baseRef);
    if (!head) throw new GitError("branch scope needs a HEAD commit");
    args = ["diff", ...DIFF_FLAGS, `${baseCommit}...${head}`];
  } else {
    baseRef = selection.base ?? (head ? "HEAD" : null);
    baseCommit = baseRef ? await resolveCommit(root, baseRef) : null;
    args = ["diff", ...DIFF_FLAGS];
    if (baseCommit) args.push(baseCommit);
  }
  const text = await git(root, [...args, "--"]);
  const untracked =
    selection.scope === "worktree"
      ? (await git(root, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean)
      : [];
  return {
    text,
    scope: selection.scope,
    baseRef,
    baseCommit,
    headCommit: head,
    probe: `git-diff-U3:${selection.scope}`,
    untrackedFiles: untracked,
  };
}

export async function trackedFiles(root: string): Promise<string[]> {
  return (await git(root, ["ls-files", "-z", "--cached"])).split("\0").filter(Boolean);
}
