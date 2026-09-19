/**
 * Pi coding-agent adapter: implements `CodingAgentPort` by running the installed `pi` binary
 * (`@earendil-works/pi-coding-agent`) in non-interactive JSON mode.
 *
 * Contract used (pi 0.85, docs/json.md): `pi --mode json --print` writes one JSON event per line to stdout,
 * reads piped stdin and merges it into the initial prompt, and exits non-zero on failure. `message_end` carries
 * the final authoritative assistant message; `tool_execution_start` marks each tool call. Stanley never links
 * Pi's SDK: the process boundary keeps Pi's dependencies, credentials, and settings out of this package.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AGENT_LIMITS, type AgentRunResult, type CodingAgentPort } from "../workflows/agent.ts";

/** `STANLEY_AGENT=off` disables the agent fallback and the improvement worker. */
export const AGENT_ENV = "STANLEY_AGENT";
/** Explicit path to the `pi` binary; otherwise `pi` is looked up on PATH. */
export const PI_BINARY_ENV = "STANLEY_PI_BIN";
/** Optional Pi model pattern, passed as `--model`. */
export const AGENT_MODEL_ENV = "STANLEY_AGENT_MODEL";
/** Set in every agent subprocess: a nested `stanley` never delegates or queues improvements again. */
export const NESTED_ENV = "STANLEY_NESTED";

export const PI_ADAPTER_NAME = "pi";
export const PI_FIXED_ARGS = ["--mode", "json", "--print", "--no-session", "--no-approve"] as const;
/** The argv message; the actual instructions travel over stdin so they never appear in process listings. */
export const PI_PREAMBLE =
  "Your complete instructions were delivered on standard input. Follow them exactly and finish with the requested summary.";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;

export type AgentUnavailableReason = "disabled" | "nested" | "not_installed";

export type AgentAvailability =
  | { readonly agent: CodingAgentPort; readonly reason?: undefined }
  | { readonly agent: null; readonly reason: AgentUnavailableReason };

export interface PiAgentOptions {
  readonly binary: string;
  readonly env: NodeJS.ProcessEnv;
  readonly spawn?: typeof nodeSpawn;
  /** Extra arguments placed before the preamble, for example `--model`. */
  readonly extraArgs?: readonly string[];
  /** Time between SIGTERM and SIGKILL when stopping the agent. */
  readonly killGraceMs?: number;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `pi` binary from `STANLEY_PI_BIN` or PATH, or null when Pi is not installed. */
export function findPiBinary(env: NodeJS.ProcessEnv): string | null {
  const explicit = env[PI_BINARY_ENV]?.trim();
  if (explicit) return isExecutableFile(explicit) ? explicit : null;
  const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve the production agent from the environment. Never throws; unavailability is a reason, not an error. */
export function agentFromEnvironment(
  env: NodeJS.ProcessEnv,
  spawn: typeof nodeSpawn = nodeSpawn,
): AgentAvailability {
  if (env[AGENT_ENV]?.trim().toLowerCase() === "off") return { agent: null, reason: "disabled" };
  if (env[NESTED_ENV]?.trim()) return { agent: null, reason: "nested" };
  const binary = findPiBinary(env);
  if (!binary) return { agent: null, reason: "not_installed" };
  const model = env[AGENT_MODEL_ENV]?.trim();
  return {
    agent: createPiAgent({ binary, env, spawn, ...(model ? { extraArgs: ["--model", model] } : {}) }),
  };
}

/** Incremental reader for Pi's LF-delimited JSON event stream. Tolerates non-JSON lines. */
export class PiEventReader {
  text = "";
  toolCalls = 0;
  events = 0;
  /** The last assistant message's error, when it stopped with `error` or `aborted`. */
  error: string | null = null;
  private buffer = "";
  private overflow = false;

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.overflow) this.overflow = false;
      else this.line(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = "";
      this.overflow = true;
    }
  }

  finish(): void {
    if (!this.overflow && this.buffer.trim()) this.line(this.buffer);
    this.buffer = "";
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null) return;
    this.events++;
    const record = event as Record<string, unknown>;
    if (record.type === "tool_execution_start") this.toolCalls++;
    if (record.type !== "message_end") return;
    const message = record.message;
    if (typeof message !== "object" || message === null) return;
    const { role, content, stopReason, errorMessage } = message as Record<string, unknown>;
    if (role !== "assistant") return;
    const text = contentText(content);
    if (text) this.text = text.slice(0, AGENT_LIMITS.maxTextBytes);
    this.error =
      stopReason === "error" || stopReason === "aborted"
        ? typeof errorMessage === "string" && errorMessage
          ? errorMessage.slice(0, 500)
          : `request ${String(stopReason)}`
        : null;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Environment for the agent subprocess: marks nesting and keeps Pi offline for startup network calls. */
export function agentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [NESTED_ENV]: "1", PI_OFFLINE: env.PI_OFFLINE ?? "1" };
}

export function createPiAgent(options: PiAgentOptions): CodingAgentPort {
  const spawn = options.spawn ?? nodeSpawn;
  const killGraceMs = options.killGraceMs ?? 5_000;
  return {
    name: PI_ADAPTER_NAME,
    run(task, runOptions) {
      if (Buffer.byteLength(task.instructions) > AGENT_LIMITS.maxInstructionBytes) {
        return Promise.resolve(failed("agent instructions exceed the size limit"));
      }
      const started = performance.now();
      return new Promise<AgentRunResult>((resolve) => {
        const reader = new PiEventReader();
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const args = [...PI_FIXED_ARGS, ...(options.extraArgs ?? []), PI_PREAMBLE];
        const child = spawn(options.binary, args, {
          cwd: task.cwd,
          env: agentEnvironment(options.env),
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
        const terminate = () => {
          try {
            child.kill("SIGTERM");
          } catch {
            // The process may already be gone.
          }
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore: the process exited between signals.
            }
          }, killGraceMs);
          killTimer.unref();
        };
        const timer = setTimeout(
          () => {
            timedOut = true;
            terminate();
          },
          Math.min(runOptions.timeoutMs, AGENT_LIMITS.maxTimeoutMs),
        );
        const onAbort = () => {
          aborted = true;
          terminate();
        };
        const done = (result: AgentRunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          runOptions.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const finish = (outcome: AgentRunResult["outcome"], exitCode: number | null, detail?: string) => {
          reader.finish();
          done({
            outcome,
            text: reader.text,
            exitCode,
            durationMs: Math.round(performance.now() - started),
            toolCalls: reader.toolCalls,
            ...(detail ? { detail } : {}),
          });
        };
        runOptions.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => reader.push(chunk));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-MAX_STDERR_BYTES);
        });
        child.on("error", (error) => finish("failed", null, `could not start the agent: ${error.message}`));
        child.on("close", (code, signal) => {
          if (timedOut) finish("timeout", code, "the agent was stopped at the time limit");
          else if (aborted) finish("aborted", code, "the agent run was cancelled");
          else if (reader.error) finish("failed", code, reader.error);
          else if (code === 0) finish("finished", 0);
          else {
            finish(
              "failed",
              code,
              stderrSummary(stderr) || `the agent exited with ${code ?? signal ?? "unknown status"}`,
            );
          }
        });
        if (runOptions.signal?.aborted) onAbort();
        child.stdin?.on("error", () => {
          // A process that exits before reading stdin surfaces through `close`.
        });
        child.stdin?.end(task.instructions);
      });
    },
  };
}

/**
 * The most informative stderr line: Pi prints the error first and follows it with indented documentation
 * paths and settings warnings, so the first line that is neither indented nor a warning is the message.
 */
export function stderrSummary(stderr: string): string {
  const lines = stderr.split("\n").filter((line) => line.trim());
  const informative = lines.find((line) => !/^\s/.test(line) && !/^Warning:/i.test(line));
  return (informative ?? lines.at(-1) ?? "").trim().slice(0, 500);
}

function failed(detail: string): AgentRunResult {
  return { outcome: "failed", text: "", exitCode: null, durationMs: 0, toolCalls: 0, detail };
}
