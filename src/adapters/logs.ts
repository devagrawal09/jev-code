import { stableId } from "../core/hash.ts";
import { InputError } from "../workflows/errors.ts";
import {
  type FailureBlock,
  LOG_CONTEXT_LINES,
  type LogLine,
  MAX_BLOCK_LINES,
  MAX_LOG_LINES,
  normalizeForSignature,
  type ParsedLog,
} from "../workflows/evidence.ts";

const ANCHORS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "bun_fail", pattern: /^\(fail\)\s+\S/ },
  { kind: "jest_fail", pattern: /^\s*FAIL\s+\S/ },
  { kind: "jest_test", pattern: /^\s*●\s+\S.*/ },
  { kind: "vitest_fail", pattern: /^\s*(?:[×✗✕]|FAIL)\s+\S.*(?:>|›)/ },
  { kind: "pytest_failed", pattern: /^(?:FAILED|ERROR)\s+\S+::\S+/ },
  { kind: "pytest_section", pattern: /^_{3,}\s+\S.*\s+_{3,}$/ },
  { kind: "go_fail", pattern: /^\s*--- FAIL: \S+/ },
  { kind: "panic", pattern: /^panic: / },
  { kind: "tap_not_ok", pattern: /^\s*not ok \d+/ },
  { kind: "traceback", pattern: /Traceback \(most recent call last\)/ },
  { kind: "error_line", pattern: /^\s*(?:Uncaught\s+)?[A-Z]\w*(?:Error|Exception)(?::|\s*\[)/ },
  { kind: "compiler_error", pattern: /(?:^|\s)error(?:\[E\d+\]| TS\d+)?:\s/ },
  { kind: "npm_err", pattern: /^npm ERR!/ },
  {
    kind: "exit_code",
    pattern: /\b(?:exit(?:ed)?|Process completed) with (?:exit )?(?:code|status) [1-9]\d*/i,
  },
];

const STACK_LINE =
  /^\s+at\s|^\s+File "|^\s*[\w./-]+\.(?:go|rs|py|ts|js|java|rb):\d+|^\s+\.\.\.|^\s*\^+\s*$|^E\s{2,}/;
const TEST_NAME: RegExp[] = [
  /^\(fail\)\s+(.+?)(?:\s+\[[^\]]+\])?$/,
  /--- FAIL: (\S+)/,
  /^(?:FAILED|ERROR)\s+(\S+::\S+)/,
  /^\s*●\s+(.+)$/,
  /not ok \d+\s*-?\s*(.+)$/,
  /^\s*[×✗✕]\s+(.+?)(?:\s+\d+ms)?$/,
  /^_{3,}\s+(\S.*?)\s+_{3,}$/,
];
const MESSAGE =
  /(?:^\s*(?:Uncaught\s+)?[A-Z]\w*(?:Error|Exception)\b.*|^E\s{2,}\S.*|^\s*(?:Expected|Received|expected|actual)\b.*|^panic: .*|error(?:\[E\d+\]| TS\d+)?:\s.*|assert(?:ion)?\s.*failed.*)$/i;
const STACK_LOCATION: RegExp[] = [
  /\(?((?:[A-Za-z]:)?[\w@./-]+\.[A-Za-z]{1,4}):(\d+)(?::\d+)?\)?/,
  /File "([^"]+)", line (\d+)/,
];

const ENV: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "network",
    pattern:
      /ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|socket hang up|getaddrinfo|Temporary failure in name resolution|Could not resolve host/i,
  },
  {
    label: "resources",
    pattern: /heap out of memory|out of memory|OOMKilled|ENOSPC|No space left on device/i,
  },
  { label: "permissions", pattern: /EACCES|EPERM|Permission denied/i },
  {
    label: "service_unavailable",
    pattern: /\b(?:502 Bad Gateway|503 Service Unavailable|rate limit exceeded)\b/i,
  },
];
const COMPILE =
  /error TS\d+|SyntaxError|cannot find symbol|^\S+\.go:\d+:\d+: undefined: |error\[E\d+\]|compilation failed/im;
const MISSING_MODULE =
  /Cannot find module|ModuleNotFoundError|No module named|ERR_MODULE_NOT_FOUND|cannot find package/i;
const TIMEOUT =
  /Timeout of \d+ ?ms exceeded|timed out after|Exceeded timeout|context deadline exceeded|test timed out/i;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const BUN_OUTCOME = /^\((?:pass|fail|skip|todo)\)\s+/;
const BUN_FAIL = /^\(fail\)\s+/;
const BUN_FAILURE_SUMMARY = /^\d+ tests? failed:/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Split a test or CI log into anchored failure windows with deterministic signals. */
export function parseFailureLog(text: string, context = LOG_CONTEXT_LINES): ParsedLog {
  const lines = stripAnsi(text).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > MAX_LOG_LINES)
    throw new InputError(`log has ${lines.length} lines; the limit is ${MAX_LOG_LINES}`);

  // Bun emits each detailed failure before a terminal `(fail) suite > test` line, then repeats all
  // of those names in a summary. Outcome boundaries are more precise than overlapping error windows.
  const bunSummary = lines.findIndex((line) => BUN_FAILURE_SUMMARY.test(line));
  const bunEnd = bunSummary < 0 ? lines.length : bunSummary;
  const bunBlocks: FailureBlock[] = [];
  const bunRanges: Array<{ start: number; end: number }> = [];
  let previousOutcome = -1;
  for (let index = 0; index < bunEnd; index++) {
    const line = lines[index]!;
    if (!BUN_OUTCOME.test(line)) continue;
    if (BUN_FAIL.test(line)) {
      const start = previousOutcome + 1;
      const all = lines
        .slice(start, index + 1)
        .map((value, offset) => ({ n: start + offset + 1, text: value }));
      const head = Math.floor(MAX_BLOCK_LINES / 2);
      const shown =
        all.length <= MAX_BLOCK_LINES
          ? all
          : [...all.slice(0, head), ...all.slice(all.length - (MAX_BLOCK_LINES - head))];
      bunBlocks.push(toBlock(shown, all.length - shown.length, ["bun_fail"]));
      bunRanges.push({ start, end: index });
    }
    previousOutcome = index;
  }
  const anchorsAt = new Map<number, string[]>();
  let bunRangeIndex = 0;
  for (const [index, line] of lines.entries()) {
    while (bunRanges[bunRangeIndex] && bunRanges[bunRangeIndex]!.end < index) bunRangeIndex++;
    const bunRange = bunRanges[bunRangeIndex];
    if (bunRange && index >= bunRange.start) continue;
    const kinds = ANCHORS.filter(
      ({ kind, pattern }) =>
        pattern.test(line) && !(kind === "bun_fail" && bunSummary >= 0 && index >= bunSummary),
    ).map(({ kind }) => kind);
    if (kinds.length > 0) anchorsAt.set(index, kinds);
  }

  // Build windows, extend through stack traces, then merge overlaps while respecting the block cap.
  const windows: Array<{ start: number; end: number; anchors: Set<string> }> = [];
  for (const [index, kinds] of anchorsAt) {
    const start = Math.max(0, index - context);
    let end = Math.min(lines.length - 1, index + context);
    while (end + 1 < lines.length && STACK_LINE.test(lines[end + 1]!) && end - start < MAX_BLOCK_LINES * 2)
      end++;
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1 && Math.max(end, last.end) - last.start + 1 <= MAX_BLOCK_LINES) {
      last.end = Math.max(last.end, end);
      for (const kind of kinds) last.anchors.add(kind);
    } else {
      windows.push({ start: last && start <= last.end ? last.end + 1 : start, end, anchors: new Set(kinds) });
    }
  }

  const genericBlocks = windows
    .filter((window) => window.end >= window.start)
    .map((window) => {
      const all = lines
        .slice(window.start, window.end + 1)
        .map((text, offset) => ({ n: window.start + offset + 1, text }));
      const shown = all.length > MAX_BLOCK_LINES ? all.slice(0, MAX_BLOCK_LINES) : all;
      return toBlock(shown, all.length - shown.length, [...window.anchors]);
    });
  const blocks = [...bunBlocks, ...genericBlocks].sort((a, b) => a.startLine - b.startLine);
  return { totalLines: lines.length, blocks };
}

function toBlock(lines: LogLine[], omittedLines: number, anchors: string[]): FailureBlock {
  const text = lines.map((line) => line.text).join("\n");
  let testName: string | null = null;
  for (const line of lines) {
    for (const pattern of TEST_NAME) {
      const match = pattern.exec(line.text);
      if (match?.[1]) {
        testName = match[1].trim().slice(0, 200);
        break;
      }
    }
    if (testName) break;
  }
  const messageLine = lines.find((line) => MESSAGE.test(line.text));
  const message = messageLine ? messageLine.text.trim().slice(0, 300) : null;
  const stackLocations: FailureBlock["stackLocations"] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!STACK_LINE.test(line.text) && !/\.\w{1,4}:\d+/.test(line.text)) continue;
    for (const pattern of STACK_LOCATION) {
      const match = pattern.exec(line.text);
      if (!match?.[1] || /^https?:/.test(match[1]) || match[1].includes("node:internal")) continue;
      const key = `${match[1]}:${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stackLocations.push({ path: match[1], line: match[2] ? Number(match[2]) : null });
      break;
    }
    if (stackLocations.length >= 20) break;
  }
  // Fingerprint the failure-bearing lines only, so the same failure in a different log position matches.
  const keyText = lines
    .map((line) => line.text)
    .filter(
      (line) =>
        ANCHORS.some(({ pattern }) => pattern.test(line)) || MESSAGE.test(line) || STACK_LINE.test(line),
    )
    .join("\n");
  const normalizedBody = normalizeForSignature(keyText || text);
  const signature = stableId(
    "fam",
    normalizeForSignature(message ?? lines.find((l) => l.text.trim())?.text ?? ""),
    8,
  );
  return {
    id: stableId("fail", { lines, anchors }, 10),
    startLine: lines[0]?.n ?? 0,
    endLine: lines[lines.length - 1]?.n ?? 0,
    lines,
    omittedLines,
    anchors,
    testName,
    message,
    stackLocations,
    signature,
    fingerprint: stableId("fp", normalizedBody, 12),
    envSignature: ENV.find(({ pattern }) => pattern.test(text))?.label ?? null,
    compileError: COMPILE.test(text),
    missingModule: MISSING_MODULE.test(text),
    timeout: TIMEOUT.test(text),
  };
}
