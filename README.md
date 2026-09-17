# jev-code

[![CI](https://github.com/devagrawal09/jev-code/actions/workflows/ci.yml/badge.svg)](https://github.com/devagrawal09/jev-code/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jev-code)](https://www.npmjs.com/package/jev-code)
[![license: MIT](https://img.shields.io/npm/l/jev-code)](LICENSE)

**The intelligent assistant for coding agents.**

jev-code is a command-line toolkit that coding agents can delegate judgment-heavy work to. Instead of asking the agent to inspect everything itself, it can hand jev-code a focused task: checking a diff, triaging failures or review comments, or finding relevant code.

Each command gathers the right evidence, asks a fixed set of bounded questions, and returns a structured report the agent can act on. jev-code does not write code or take control of the workflow. It gives the coding agent a second, consistent source of judgment for common tasks.

## What agents can delegate

| Command | What it does |
| --- | --- |
| `check` | Check a diff against its task, and optionally against project rules and acceptance criteria. |
| `triage` | Sort test failures or review comments and show which need attention. |
| `find` | Find files that may be relevant to a task. |

These three are the whole command surface.

> **Experimental:** jev-code is a new product. Every command, report, and interface may change.

A common agent flow uses `find` before editing, `check` before calling the work done, and `triage` when tests fail or review comments arrive.

## How delegation works

1. **Code gathers small pieces of evidence.** jev-code reads your Git diff (or a test log you saved) and splits
   it into small, size-limited pieces, such as one changed block of a file or one failure from a log.
2. **Exact checks run first.** Plain rules catch things like an added `test.skip`, deleted assertions,
   deleted test files, and lockfile, CI or config changes.
3. **Jev answers fixed-choice questions about each piece.** Using your required TypeSafe API key, jev-code asks
   [TypeSafe Jev](https://typesafe.ai), a model that answers multiple-choice questions, about one small piece
   at a time. For example: "How closely is this changed block related to the task?" jev-code's own code, not
   the model, turns the answers into flags using fixed thresholds.
4. **You get an advisory report.** Each flag points to a file and line range. The report also lists what
   could not be decided and what was **not checked**. There is no "pass" result.

## Get started

> **Release status:** the `jev-code` package on npm is `0.0.1`, a placeholder with no working commands.
> This README describes `0.1.0`, which is not released yet. Until it is, build from source.

**Requirements:** Node.js 22.18 or newer, `git`, a Git repository to check, and a TypeSafe API key. CI tests on Linux; Windows is untested.

**Install** (from source, until 0.1.0 is on npm):

```sh
git clone https://github.com/devagrawal09/jev-code.git
cd jev-code
npm ci
npm run build
node dist/cli.js --help   # use "node /path/to/jev-code/dist/cli.js" wherever this README says "jev-code"
```

After 0.1.0 is released: `npm install --global jev-code`.

**API key.** jev-code reads the required key only from this environment variable, never from files or flags:

```sh
export TYPESAFE_API_KEY="<your TypeSafe API key>"
```

**Example.** An agent was asked to fix a crash. It did, but it also skipped the test and removed an assertion.
Inside that repository:

```sh
jev-code check --task "Fix the crash in parseConfig when raw is null"
```

The report points to the skipped test and removed assertion. Jev also checks whether each changed block belongs to the task and whether a test expectation became weaker.

Read both `findings` and `notChecked`. An empty findings list is **not** an approval.

## The commands

**`check`** compares a diff with the task text. It always flags changed blocks that look unrelated to the
task, tests that were weakened, skipped or deleted, and unexpected lockfile, CI or config edits. The task is
required. Three optional inputs add sections to the same report:

- `--rules <path>`: a JSON file of project rules. Flags changed blocks that may break a rule.
- `--criteria <text>` or `--criteria-file <path>`: a numbered or bulleted list of requirements. Shows which
  ones have code or test evidence in the diff.
- `--test-results <path>`: JSON or JUnit test records, used as evidence for the criteria.

```sh
jev-code check --task "Fix the crash in parseConfig when raw is null"   # uncommitted changes vs HEAD
jev-code check --task-file task.md --task-source user --scope staged    # only staged changes
jev-code check --task-file task.md --scope branch --base main \
  --rules rules.json --criteria-file acceptance.md --test-results junit.xml
```

The diff is read once and everything lands in one report. Each row in `results` has a `section` field
(`task`, `rules` or `criteria`), and `summary.sections` lists the sections that ran. Give it the task as the
person wrote it, not the agent's summary of what it did.

A rules file looks like this. Only `semantic` rules are judged; `deterministic` and `process` rules are
listed as not checked, because linters and people handle those better.

```json
{
  "version": 1,
  "rules": [
    { "id": "no-client-keys", "class": "semantic", "text": "API keys are never read in client code.", "scope": ["src/client/**"] }
  ]
}
```

**`triage`** sorts incoming items. You say which kind with `--kind` and give one input with `--input`
(a file in the repository, or `-` for stdin):

- `--kind failures` splits a saved test or CI log into separate failures, groups duplicates, and relates
  each one to the diff, for example as caused by the change or as an environment or network problem. It also
  says what rerun would settle the question. It does not run or rerun anything.
- `--kind comments` reads exported review comments (a JSON array, including the GitHub API shape) and sorts
  them into actionable, already addressed, stale, unclear and non-actionable by comparing each with the
  current code. It never replies to or resolves anything.

```sh
jev-code triage --kind failures --input test-output.log
npm test 2>&1 | jev-code triage --kind failures --input -
gh api repos/OWNER/REPO/pulls/123/comments | jev-code triage --kind comments --input -
```

Every row in `results` carries the same `kind`. Use `--no-diff` when the items are unrelated to local changes.

**`find`** ranks tracked files by how relevant they look for a task, reading excerpts only of likely ones.

```sh
jev-code find "Webhook retries double-charge customers" --paths "src/**" --top 5
```

Files passed to any command must be inside the repository. Run `jev-code <command> --help` for all options.

## Using it from a coding agent

jev-code is a CLI with a JSON output. It ships no agent plugin or hook. Copy this into your agent instructions
(for example `AGENTS.md` or `CLAUDE.md`):

```text
Before you say a coding task is done:
1. Run the project's normal tests, type checks and linters yourself. jev-code does not run them.
2. Run: jev-code check --task "<the user's original task, word for word>" --task-source user --json
   Add --rules <file> and --criteria-file <file> if the project has them.
3. Optional: if a test run failed, save its output to a file in the repository and run:
   jev-code triage --kind failures --input <that file> --json
4. Read every item in "findings", "parked" and "notChecked". Fix the code, or tell the user why each one is fine.
5. Exit codes 10, 11 and 12 mean the report is incomplete (11: Jev was not called). No findings does not mean the change is approved. Never say jev-code passed it.
```

## Reports and privacy

Use `--json` when an agent or script will read the report. The most important fields are:

- `findings`: places to inspect
- `parked`: items jev-code could not decide
- `notChecked`: work jev-code did not perform
- `coverage`: how much evidence was actually examined
- `workflow`: the command and its report version, such as `check@1`

Every report uses the `jev-code.packet/v1` schema.

There is no `pass` or `approved` result. Run `jev-code --help` for exit-code meanings.

By default, run records are saved under `.jev-code/runs/<run-id>/`. They can contain code and log lines, so they are private to your user and ignored by Git. Use `--no-persist` to disable them.

When model-backed checks run, jev-code sends TypeSafe only the task and bounded evidence needed by that command, such as changed blocks or short failure-log sections. Obvious secret files and common token formats are filtered on a best-effort basis, but jev-code is not a secret scanner. Review TypeSafe's data terms before sending private or regulated code.

jev-code does not replace tests, type checks, linters, security tools, or human review.

## Development

```sh
npm ci
npm run check           # lint, typecheck, tests, build, CLI smoke test
npm run lint            # Biome
npm run typecheck
npm test                # uses a fake Jev and makes no network calls
npm run build
npm run smoke           # runs the built CLI in a temporary Git repository with fake Jev
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
