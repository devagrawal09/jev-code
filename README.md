# jev-code

[![CI](https://github.com/devagrawal09/jev-code/actions/workflows/ci.yml/badge.svg)](https://github.com/devagrawal09/jev-code/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jev-code)](https://www.npmjs.com/package/jev-code)
[![license: MIT](https://img.shields.io/npm/l/jev-code)](LICENSE)

**Know what to check before you trust "done".**

jev-code does pre-review triage for changes written by coding agents. Point it at the diff your agent just
produced and the task you gave it, and it tells you where to look first:

- diff hunks that seem only loosely related to the task;
- test changes that now accept more than before: added skip markers, deleted assertions, weakened
  expectations;
- lockfile, CI and config edits you may not have expected.

It can also split a failing test or CI log into separate failure blocks and sort each one against the diff.

jev-code is **not** an AI code reviewer, guardrail, judge, verifier or approval step. It never says a change
is correct and never approves anything. Every report points to files and line ranges, and lists what it did
**not** check. Reports have no "pass" field, and "no flags" is not an approval. Keep your tests, types,
linters and human review.

Built-in checks run locally and need no API key. Model-backed flags use
[TypeSafe Jev](https://typesafe.ai) with your own API key.

## Contents

- [Workflows](#workflows)
- [Install](#install)
- [TypeSafe API key](#typesafe-api-key)
- [Running without a key](#running-without-a-key)
- [Quick start](#quick-start)
- [Walkthrough: a fix plus a weakened test](#walkthrough-a-fix-plus-a-weakened-test)
- [JSON output and exit codes](#json-output-and-exit-codes)
- [What is stored and what is sent](#what-is-stored-and-what-is-sent)
- [Using jev-code from a coding agent](#using-jev-code-from-a-coding-agent)
- [Security model and non-goals](#security-model-and-non-goals)
- [Architecture](#architecture)
- [Development](#development)
- [TypeSafe attribution](#typesafe-attribution)

## Workflows

| Command           | Status       | What you get                                                                                       | Built-in checks (no key)                                                                                   |
| ----------------- | ------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `flag-diff`       | stable       | Flags on diff hunks compared with the task text                                                    | Added skip markers, removed assertions in test hunks, deleted test files, lockfile/CI/config/generated changes |
| `triage-failures` | stable       | Failure blocks from a supplied test/CI log, each sorted against the diff                           | Failure-block extraction, duplicate grouping, compile errors, network/resource/permission signatures        |
| `flag-rules`      | preview      | Flags on hunks that may break rules from a JSON rules file you write and approve                   | Rule-file validation and scoping only                                                                      |
| `map-criteria`    | preview      | Each acceptance criterion mapped to diff hunks and any test results you supply                     | Criteria and test-record parsing only                                                                      |
| `triage-comments` | experimental | Exported review comments sorted as actionable, already addressed, stale, unclear or non-actionable | Comment parsing only                                                                                       |
| `locate`          | experimental | A ranked shortlist of tracked files for a task                                                     | None                                                                                                       |
| `run-frame`       | advanced     | Uncalibrated answers to one custom, validated question file                                        | Frame validation only                                                                                      |

- **Stable** commands are the 0.1 launch surface.
- **Preview** commands work, but their output and thresholds may change in a minor release.
- **Experimental** commands are included for evaluation only. They are not part of what 0.1 claims to do,
  and they may change or be removed.
- **Advanced:** `run-frame` is a constrained escape hatch, not a workflow. See [below](#run-frame).

`jev-code --help` shows the same grouping, and `jev-code <command> --help` shows each command's options.

Thresholds are fixed and versioned per workflow (for example `flag-diff-policy@1`), but they have not been
calibrated against a public evaluation set yet. Treat model-backed flags as leads, not measurements.

## Install

Prerequisites:

- Node.js 22.18 or newer. CI runs on Linux with Node 22.18.0, 22 and 24. Windows is untested.
- `git` on your `PATH`, and a Git repository to run in (or pass `--repo <dir>`).
- Optional: a TypeSafe API key with Jev access, for model-backed flags.

```sh
npm install --global jev-code
jev-code --help
```

Or run it without installing:

```sh
npx jev-code --help
```

## TypeSafe API key

```sh
export TYPESAFE_API_KEY="<your TypeSafe API key>"
```

- The key is read **only** from the `TYPESAFE_API_KEY` environment variable. jev-code does not read `.env`
  files, config files or command-line flags for it.
- The key is redacted from printed errors, JSON output and run artifacts. SDK debug logging is turned off
  because it would include request bodies.
- The model defaults to `jev-1.13.0`. Override it with `--model <id>` or `TYPESAFE_MODEL`.
- Every report records how many requests and input tokens it used (`jev.requests`, `jev.inputTokens`), so you
  can work out cost at your own TypeSafe rate. jev-code does not quote prices.

## Running without a key

With no key, or with `--offline`, jev-code never calls Jev. Built-in checks still run, and the report says
the model was not called:

- `status` is `ladder_only` and the exit code is `11` whenever something was left for the model.
- `limits` explains why, for example `Jev not called: offline mode`.
- Hunks the model would have looked at are listed as `unjudged`, and coverage is marked `INCOMPLETE`.

`--offline` makes no network requests. Without `--offline`, a missing key has the same result.

## Quick start

Run these inside the repository your agent changed.

```sh
# Uncommitted changes (staged and unstaged) against HEAD
jev-code flag-diff --task "Fix the null dereference in parseConfig"

# Only staged changes, or a whole branch against its base (default base: main)
jev-code flag-diff --task-file task.md --scope staged
jev-code flag-diff --task-file task.md --scope branch --base main

# A test or CI log, from a file or stdin
jev-code triage-failures --log ci.log
npm test 2>&1 | jev-code triage-failures --log -
```

Use the task as the human wrote it, not the agent's summary of what it did. `--task-source user|issue|agent`
records where the text came from. File arguments such as `--task-file` and `--log` must be inside the
repository, and credential-shaped paths such as `.env` are refused.

## Walkthrough: a fix plus a weakened test

This builds a two-file repository, makes the kind of change an agent might make, and runs `flag-diff` with
no API key.

```sh
git init -q jev-demo && cd jev-demo
mkdir src test

cat > src/config.js <<'EOF'
export function parseConfig(raw) {
  return JSON.parse(raw).port;
}
EOF

cat > test/config.test.js <<'EOF'
import { parseConfig } from "../src/config.js";

test("reads the port", () => {
  expect(parseConfig('{"port":8080}')).toEqual(8080);
  expect(parseConfig("{}")).toBeUndefined();
});
EOF

git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init
```

Now the "agent" fixes the null dereference, but also special-cases a fixture value, skips the test and
loosens an assertion:

```sh
cat > src/config.js <<'EOF'
export function parseConfig(raw) {
  if (raw === "fixture-7") return 8080;
  return JSON.parse(raw ?? "{}").port;
}
EOF

cat > test/config.test.js <<'EOF'
import { parseConfig } from "../src/config.js";

test.skip("reads the port", () => {
  expect(parseConfig('{"port":8080}')).toBeDefined();
});
EOF

jev-code flag-diff --task "Fix the null dereference in parseConfig" --offline --no-persist
```

Output (exit code 11, because the model was not called):

```text
jev-code flag-diff@1 · ladder_only · advisory only
coverage: 2 candidates · 0 judged · 0 deterministic · 0 excluded · 0 parked · 0 failed · 2 unjudged · INCOMPLETE

findings (2):
  ! assertions_removed test/config.test.js:1-5 [deterministic]
  ! skip_marker_added test/config.test.js:1-5 [deterministic]

hunks:
  src/config.js:1-4 [unjudged] - low=- (offline: offline mode)
  test/config.test.js:1-5 [unjudged] - low=- (offline: offline mode; test_expectation offline: offline mode)

limits:
  - Jev not called: offline mode

not checked: correctness of the change; tests were not executed; hunks are judged individually; intent spread across unlinked hunks is not modeled; hunks with unchanged test files are not checked for weakening
jev: offline · model jev-1.13.0 · 0 requests · 0 input tokens · 0 ms
artifact: not persisted
```

The built-in checks catch the skip marker and the deleted assertion. They do **not** catch the
`fixture-7` special case, or that `toEqual(8080)` became `toBeDefined()`. Those need the model: with a key
and without `--offline`, `flag-diff` also asks Jev about each hunk, and can add flags such as
`special_cased_literal_input`, `test_expectation_weakened` or `weak_task_relation`. Whether it raises them
for a given diff depends on the model's answers; no result is guaranteed.

## JSON output and exit codes

`--json` prints one packet with schema `jev-code.packet/v1`:

```sh
jev-code flag-diff --task "Fix the null dereference in parseConfig" --json \
  | jq -r '.findings[] | "\(.flag) \(.path):\(.lines)"'
```

```text
assertions_removed test/config.test.js:1-5
skip_marker_added test/config.test.js:1-5
```

Top-level fields: `schema`, `workflow`, `runId`, `advisory` (always `true`), `status`, `coverage`,
`findings`, `parked` (undecided items worth a look), `excluded`, `limits`, `notChecked`, `results`,
`summary`, `redactions`, `jev` (model, requests, tokens, latency) and `artifact`. There is no `pass` or
`approved` field. `notChecked` is never empty.

Usage and input errors print `{"schema": "jev-code.error/v1", ...}` on stdout when `--json` is set.

| Exit code | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| 0         | Complete: every candidate was handled                               |
| 10        | Incomplete coverage: some candidates were not judged                |
| 11        | Jev not called (no key, or `--offline`); built-in checks only       |
| 12        | Budget exhausted; see `--max-requests`, `--max-input-tokens`, `--timeout-seconds` |
| 64        | Usage error                                                         |
| 65        | Invalid input                                                       |
| 70        | Internal error                                                      |

jev-code never exits with 1 or 2, because some agent hook systems treat exit code 2 as "block". None of these
codes means the change passed or failed. Read `status` and `findings` instead.

## What is stored and what is sent

**Stored locally.** Unless you pass `--no-persist`, each run writes `.jev/runs/<run-id>/` in the repository:

- `manifest.json`, `inputs.json`, `candidates.json`, `packet.json`, and when relevant `decisions.ndjson` and
  `events.ndjson`;
- `frames.ndjson`: every Jev request and response, after redaction. **It can contain code from your diff and
  lines from your logs.**

Files are created with mode `0600` and directories with `0700`. jev-code writes `.jev/.gitignore` containing
`*`, so artifacts stay out of commits even if your own `.gitignore` does not list them. jev-code sends no
telemetry and makes no network calls of its own besides Jev requests.

**Sent to TypeSafe.** Only when a key is set and `--offline` is not. Requests go through the
`@typesafe-ai/sdk` package and contain the evidence the workflow needs, such as:

- the task text, file paths, and diff hunks (`flag-diff`);
- failure windows from the log, related diff hunks, and up to 31 lines of a tracked file around a
  stack-trace location (`triage-failures`);
- file metadata and file excerpts (`locate`), rule text (`flag-rules`), criteria and test records
  (`map-criteria`), and comment text (`triage-comments`).

Before anything is sent:

- Files at credential-shaped paths (`.env`, private keys, `.npmrc`, `.aws/`, …), binaries and vendored
  dependencies are excluded. The report lists them under `excluded`.
- `flag-diff`, `flag-rules` and `map-criteria` do not send lockfile or generated-file hunks.
- Common token shapes are redacted: private keys, AWS, GitHub, Slack and `sk-` style keys, JWTs, bearer
  tokens, URL credentials, and `password=`/`token=` style assignments. The number of redactions is reported
  in `redactions`.

Redaction is best effort. It is not a secret scanner. Read TypeSafe's own terms for how request data is
handled and retained; jev-code cannot make promises about that.

## Using jev-code from a coding agent

jev-code 0.1.0 is a CLI with a JSON contract. It does not ship agent plugins, hooks or an MCP server, and it
has not been verified end to end inside any particular agent.

The intended pattern is **advisory context, never a gate**:

1. When the agent reports it is done, run `flag-diff` with the task text the human wrote.
2. Give the agent or the human the `findings`, `parked` and `notChecked` fields. Let them decide what to
   revert, restore or look at.
3. Always let the hook succeed. Exit codes 10–12 are normal, and "no findings" must not be read as approval.

For example, as a command in a stop hook:

```sh
jev-code flag-diff --task-file task.md --task-source user --json \
  | jq '{status, findings, parked, notChecked}' || true
```

`triage-failures` fits the loop earlier: when a test run fails, pipe the log through it instead of pasting
the whole log into the agent's context.

## Security model and non-goals

- **Read-only on your code.** jev-code runs read-only `git` commands, reads files only inside the repository,
  and writes only under `.jev/`. It never edits code, runs tests, posts comments or resolves threads.
- **Repository text is untrusted.** Diffs, logs and comments are sent as evidence with an instruction not to
  follow directives inside them, and `flag-diff` asks whether a hunk contains text aimed at an automated
  reviewer. This is a hint, **not** a prompt-injection defense or a security boundary.
- **Budgets.** Each workflow has request, input-token and wall-clock limits. When a limit is hit, no further
  requests are sent and the report status is `budget_exhausted`.

jev-code is not:

- a code reviewer, merge gate, approval step or compliance check;
- a test runner or flaky-test detector (`triage-failures` says what rerun would settle a question; it does
  not rerun anything);
- a security scanner or secret scanner;
- a code search engine (`locate` is experimental);
- a coding agent;
- a replacement for linters, type checkers, tests or human review.

It makes no claim about catching bugs, correctness, or detecting cheating. Model output is structured, but
structured does not mean correct.

### run-frame

`run-frame` sends one JSON file you write, with `state` plus up to 12 yes/no, choice or score questions, and
prints the answers. The file cannot name commands, files to read, models or actions. No thresholds or
decisions are applied, and answers are uncalibrated. If earlier recorded runs asked different questions
about identical state, the report says so under `limits`. Use it to prototype a question, not as a workflow.

```sh
jev-code run-frame --file frame.json
```

## Architecture

```text
cli  ->  adapters  ->  workflows  ->  core
```

- **core** is generic machinery for question frames, answer validation, budgets, batching and retries. It has
  no product knowledge and no filesystem or SDK access.
- **workflows** hold the domain logic and built-in checks. They reach Git, files, storage and Jev only through
  ports, and cannot import Node built-ins, npm packages or `process.env`.
- **adapters** implement the ports: read-only Git, workspace-contained file reads, log/diff/comment parsers,
  redaction, the artifact recorder and the TypeSafe SDK client.
- **cli** is the composition root: argument parsing, exit codes and output.

`test/architecture.test.ts` enforces these boundaries. See [docs/architecture.md](docs/architecture.md).

The command-line interface and the `jev-code.packet/v1` JSON schema are the 0.1 contract. The package also
exports its internal modules for experimentation, but that JavaScript API is not stable yet.

## Development

```sh
npm ci
npm run check           # lint, typecheck, tests, build, offline smoke test
npm run lint            # Biome
npm run typecheck
npm test                # node:test, uses a fake Jev adapter and makes no network calls
npm run build
npm run smoke           # runs the built CLI with --offline in a temporary Git repository
npm run check:package   # manifest and tarball allowlist checks used by the release workflow
```

`node scripts/smoke-real.ts` makes a few live Jev requests after `npm run build`. It needs `TYPESAFE_API_KEY`
and skips itself when the key is not set.

Releases are published from GitHub Actions with npm trusted publishing and provenance. See
[docs/RELEASING.md](docs/RELEASING.md).

## TypeSafe attribution

Jev and TypeSafe are products of TypeSafe. jev-code is an independent open-source project. It is **not**
affiliated with, endorsed by or supported by TypeSafe. It calls Jev through the `@typesafe-ai/sdk` package
with an API key you provide, under your own TypeSafe account and terms.

## License

[MIT](LICENSE) © 2026 Dev Agrawal
