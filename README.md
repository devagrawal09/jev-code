# jev-code

[![CI](https://github.com/devagrawal09/jev-code/actions/workflows/ci.yml/badge.svg)](https://github.com/devagrawal09/jev-code/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jev-code)](https://www.npmjs.com/package/jev-code)
[![license: MIT](https://img.shields.io/npm/l/jev-code)](LICENSE)

**Find what to double-check before you trust a coding agent's "done".**

Coding agents often finish with passing tests and a confident summary, but the change can still:

- touch code that has nothing to do with the task;
- weaken tests so they pass: skip them, delete assertions, or loosen expected values;
- misread a failing test and "fix" the wrong thing.

jev-code is a command-line tool that points you at those spots. It never edits code, never runs your tests,
and never says a change is correct. It gives you a short list of places to look.

## How it works

1. **Code gathers small pieces of evidence.** jev-code reads your Git diff (or a test log you saved) and splits
   it into small, size-limited pieces, such as one changed block of a file or one failure from a log.
2. **Exact checks run first.** Plain rules catch things like an added `test.skip`, deleted assertions,
   deleted test files, and lockfile, CI or config changes. These need no API key and no network.
3. **Jev answers fixed-choice questions about each piece.** If you have a TypeSafe API key, jev-code asks
   [TypeSafe Jev](https://typesafe.ai), a model that answers multiple-choice questions, about one small piece
   at a time. For example: "How closely is this changed block related to the task?" jev-code's own code, not
   the model, turns the answers into flags using fixed thresholds.
4. **You get an advisory report.** Each flag points to a file and line range. The report also lists what
   could not be decided and what was **not checked**. There is no "pass" result.

## Get started

> **Release status:** the `jev-code` package on npm is `0.0.1`, an early preview with no working commands.
> This README describes `0.1.0`, which is not released yet. Until it is, build from source.

**Requirements:** Node.js 22.18 or newer, `git`, and a Git repository to check. A TypeSafe API key is
optional. CI tests on Linux; Windows is untested.

**Install** (from source, until 0.1.0 is on npm):

```sh
git clone https://github.com/devagrawal09/jev-code.git
cd jev-code
npm ci
npm run build
node dist/cli.js --help   # use "node /path/to/jev-code/dist/cli.js" wherever this README says "jev-code"
```

After 0.1.0 is released: `npm install --global jev-code`.

**API key** (optional). jev-code reads it only from this environment variable, never from files or flags:

```sh
export TYPESAFE_API_KEY="<your TypeSafe API key>"
```

**Example.** An agent was asked to fix a crash. It did, but it also skipped the test and removed an assertion.
Inside that repository:

```sh
jev-code flag-diff --task "Fix the crash in parseConfig when raw is null" --offline
```

The report points to the skipped test and removed assertion. Because this example uses `--offline`, it also says that semantic checks were not run and coverage is incomplete.

Read both `findings` and `notChecked`. An empty findings list is **not** an approval. Without `--offline`, and with an API key, jev-code can also ask Jev whether each changed block belongs to the task and whether a test expectation became weaker.

## The two stable commands

**`flag-diff`** compares a diff with the task text and flags changed blocks that look unrelated to the task,
tests that were weakened, and unexpected lockfile, CI or config edits.

```sh
jev-code flag-diff --task "Fix the crash in parseConfig when raw is null"   # uncommitted changes vs HEAD
jev-code flag-diff --task-file task.md --task-source user --scope staged    # only staged changes
jev-code flag-diff --task-file task.md --scope branch --base main           # a whole branch vs main
```

Give it the task as the person wrote it, not the agent's summary of what it did.

**`triage-failures`** splits a saved test or CI log into separate failures, groups duplicates, and sorts each
one against the diff, for example as related to the change, or as an environment or network problem. It
also says what rerun would settle the question. It does not run or rerun anything.

```sh
jev-code triage-failures --log test-output.log
npm test 2>&1 | jev-code triage-failures --log -
```

Files passed with `--task-file` or `--log` must be inside the repository. Run `jev-code <command> --help` for
all options.

## Other commands

These work, but are not part of the stable 0.1 promise. Preview output may change in a minor release;
experimental commands may change or be removed.

| Command           | Status       | What it does                                                                     |
| ----------------- | ------------ | -------------------------------------------------------------------------------- |
| `flag-rules`      | preview      | Flags changes that may break rules you write in a JSON rules file                |
| `map-criteria`    | preview      | Maps each acceptance criterion to changed code and test results you supply       |
| `triage-comments` | experimental | Sorts exported review comments: actionable, already addressed, stale, unclear... |
| `locate`          | experimental | Ranks tracked files that may matter for a task (a shortlist, not an answer)      |
| `run-frame`       | advanced     | Sends one custom question file you write to Jev; answers are not calibrated      |

## Using it from a coding agent

jev-code is a CLI with a JSON output. It ships no agent plugin or hook. Copy this into your agent instructions
(for example `AGENTS.md` or `CLAUDE.md`):

```text
Before you say a coding task is done:
1. Run the project's normal tests, type checks and linters yourself. jev-code does not run them.
2. Run: jev-code flag-diff --task "<the user's original task, word for word>" --task-source user --json
3. Optional: if a test run failed, save its output to a file in the repository and run:
   jev-code triage-failures --log <that file> --json
4. Read every item in "findings", "parked" and "notChecked". Fix the code, or tell the user why each one is fine.
5. Exit codes 10, 11 and 12 are normal. No findings does not mean the change is approved. Never say jev-code passed it.
```

## Reports and privacy

Use `--offline` to run only exact local checks and make no network requests. If no API key is set, jev-code also stays local and clearly reports that semantic checks were skipped.

Use `--json` when an agent or script will read the report. The most important fields are:

- `findings`: places to inspect
- `parked`: items jev-code could not decide
- `notChecked`: work jev-code did not perform
- `coverage`: how much evidence was actually examined

There is no `pass` or `approved` result. Run `jev-code --help` for exit-code meanings.

By default, run records are saved under `.jev-code/runs/<run-id>/`. They can contain code and log lines, so they are private to your user and ignored by Git. Use `--no-persist` to disable them.

When model-backed checks run, jev-code sends TypeSafe only the task and bounded evidence needed by that command, such as changed blocks or short failure-log sections. Obvious secret files and common token formats are filtered on a best-effort basis, but jev-code is not a secret scanner. Review TypeSafe's data terms before sending private or regulated code.

jev-code does not replace tests, type checks, linters, security tools, or human review.

## Development

```sh
npm ci
npm run check           # lint, typecheck, tests, build, offline smoke test
npm run lint            # Biome
npm run typecheck
npm test                # uses a fake Jev and makes no network calls
npm run build
npm run smoke           # runs the built CLI offline in a temporary Git repository
npm run check:package   # package manifest and file-list checks used by the release workflow
```

`node scripts/smoke-real.ts` makes a few real Jev requests after `npm run build`; it skips itself without
`TYPESAFE_API_KEY`. See [docs/architecture.md](docs/architecture.md) for how the code is organized and
[docs/RELEASING.md](docs/RELEASING.md) for how releases are published.

## TypeSafe

Jev and TypeSafe are products of TypeSafe. jev-code is an independent open-source project and is **not**
affiliated with, endorsed by or supported by TypeSafe. It calls Jev with an API key you provide, under your
own TypeSafe account and terms.

## License

[MIT](LICENSE) © 2026 Dev Agrawal
