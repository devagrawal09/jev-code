# jev-code

[![CI](https://github.com/devagrawal09/jev-code/actions/workflows/ci.yml/badge.svg)](https://github.com/devagrawal09/jev-code/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jev-code)](https://www.npmjs.com/package/jev-code)
[![license: MIT](https://img.shields.io/npm/l/jev-code)](LICENSE)

**The intelligent assistant for coding agents.**

jev-code is a command-line toolkit that coding agents can delegate judgment-heavy work to. Instead of asking the agent to inspect everything itself, it can describe what it needs: checking a diff, triaging failures or review comments, or finding relevant code.

Jev routes that request to one typed internal workflow. The workflow gathers the right evidence, asks a fixed set of bounded questions, and returns a structured report the agent can act on. jev-code does not write code or take control of the workflow. It gives the coding agent a second, consistent source of judgment for common tasks.

## What agents can delegate

| Request | What it does |
| --- | --- |
| Find relevant code | Rank files that may be relevant to a task. |
| Check current changes | Check a diff against its task, and optionally against project rules and acceptance criteria. |
| Triage test failures | Sort failures from a supplied test or CI log. |
| Triage review comments | Sort supplied review comments and show which need attention. |

These four bounded workflows are the whole capability surface. They are not CLI subcommands: every invocation starts with a natural-language request.

> **Experimental:** jev-code is a new product. Every request, report, and interface may change.

A common agent flow asks jev-code to find relevant files before editing, check changes before calling the work done, and triage failures or review comments when they arrive.

## How delegation works

1. **The request is routed within a fixed boundary.** Jev chooses `find`, `check`, `triage_failures`,
   `triage_comments`, or `cannot_tell`. The router sees the request plus deterministic facts such as whether a
   diff exists and whether supplied input is a recognized failure log or review-comment JSON. It has no tools
   and cannot invent another operation. Ambiguous requests produce a clarification question.
2. **Code gathers small pieces of evidence.** jev-code reads your Git diff (or a test log you supplied) and splits
   it into small, size-limited pieces, such as one changed block of a file or one failure from a log.
3. **Exact checks run first.** Plain rules catch things like an added `test.skip`, deleted assertions,
   deleted test files, and lockfile, CI or config changes.
4. **Jev answers fixed-choice questions about each piece.** Using your Jev credential (TypeSafe API key, or
   an AI Gateway key with `JEV_PROVIDER=vercel`), jev-code asks
   [TypeSafe Jev](https://typesafe.ai), a model that answers multiple-choice questions, about one small piece
   at a time. For example: "How closely is this changed block related to the task?" jev-code's own code, not
   the model, turns the answers into flags using fixed thresholds.
5. **You get an advisory report.** Each flag points to a file and line range. The report also lists what
   could not be decided and what was **not checked**. There is no "pass" result.

## Get started

> **Release status:** the `jev-code` package on npm is `0.0.1`, a placeholder with no working commands.
> This README describes `0.1.0`, which is not released yet. Until it is, build from source.

**Requirements:** Node.js 22.18 or newer, `git`, a Git repository to check, and a Jev credential:
either a TypeSafe API key (default provider) or an AI Gateway key (`JEV_PROVIDER=vercel`), per the
[Jev providers](#jev-providers) section. CI tests on Linux; Windows is untested.

**Install** (from source, until 0.1.0 is on npm):

```sh
git clone https://github.com/devagrawal09/jev-code.git
cd jev-code
npm ci
npm run build
node dist/cli.js --help   # use "node /path/to/jev-code/dist/cli.js" wherever this README says "jev-code"
```

After 0.1.0 is released: `npm install --global jev-code`.

**API key.** jev-code reads the required key only from environment variables, never from files or flags. Which key it needs depends on the provider (see below):

```sh
export TYPESAFE_API_KEY="<your TypeSafe API key>"    # default provider (or see Jev providers
                                                     # for the Vercel AI Gateway alternative)
export AI_GATEWAY_API_KEY="<your gateway key>"       # JEV_PROVIDER=vercel
```

**Example.** An agent was asked to fix a crash. It did, but it also skipped the test and removed an assertion.
Inside that repository:

```sh
jev-code "Check whether these changes fix the crash in parseConfig when raw is null"
```

The report points to the skipped test and removed assertion. Jev also checks whether each changed block belongs to the task and whether a test expectation became weaker.

Read both `findings` and `notChecked`. An empty findings list is **not** an approval.

## The workflows

When the request asks to **check current changes**, jev-code compares the diff with the task text. It always flags changed blocks that look unrelated to the
task, tests that were weakened, skipped or deleted, and unexpected lockfile, CI or config edits. The task is
the request itself unless `--task` or `--task-file` supplies a more exact version. Three optional inputs add sections to the same report:

- `--rules <path>`: a JSON file of project rules. Flags changed blocks that may break a rule.
- `--criteria <text>` or `--criteria-file <path>`: a numbered or bulleted list of requirements. Shows which
  ones have code or test evidence in the diff.
- `--test-results <path>`: JSON or JUnit test records, used as evidence for the criteria.

```sh
jev-code "Check whether these changes fix null config values"          # uncommitted changes vs HEAD
jev-code "Check the staged changes" --task-file task.md --scope staged # only staged changes
jev-code "Check this branch against its requirements" --task-file task.md --scope branch --base main \
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

When the request asks to **triage incoming items**, jev-code identifies a recognized failure log or
review-comment JSON from `--input` or piped stdin:

- Failure triage splits a saved test or CI log into separate failures, groups duplicates, and relates
  each one to the diff, for example as caused by the change or as an environment or network problem. It also
  says what rerun would settle the question. It does not run or rerun anything.
- Comment triage reads exported review comments (a JSON array, including the GitHub API shape) and sorts
  them into actionable, already addressed, stale, unclear and non-actionable by comparing each with the
  current code. It never replies to or resolves anything.

```sh
jev-code "Triage the test failures" --input test-output.log
npm test 2>&1 | jev-code "Triage these failures"
gh api repos/OWNER/REPO/pulls/123/comments | jev-code "Triage these review comments"
```

Every row in `results` carries the same `kind`. Use `--no-diff` when the items are unrelated to local changes.

When the request asks to **find relevant code**, jev-code ranks tracked files by how relevant they look for the task, reading excerpts only of likely ones.

```sh
jev-code "Find the code involved when webhook retries double-charge customers" --paths "src/**" --top 5
```

Files passed to jev-code must be inside the repository. Run `jev-code --help` for all options.

## Using it from a coding agent

jev-code is a CLI with a JSON output. It ships no agent plugin or hook. Copy this into your agent instructions
(for example `AGENTS.md` or `CLAUDE.md`):

```text
Before you say a coding task is done:
1. Run the project's normal tests, type checks and linters yourself. jev-code does not run them.
2. Run: jev-code "Check the current changes against the user's task" --task "<the user's original task, word for word>" --task-source user --json
   Add --rules <file> and --criteria-file <file> if the project has them.
3. Optional: if a test run failed, save its output to a file in the repository and run:
   jev-code "Triage these test failures" --input <that file> --json
4. Read every item in "findings", "parked" and "notChecked". Fix the code, or tell the user why each one is fine.
5. Exit codes 10 and 12 mean the report is incomplete. Exit 64 means the request needs clarification. No findings does not mean the change is approved. Never say jev-code passed it.
```

## Reports and privacy

Use `--json` when an agent or script will read the report. The most important fields are:

- `findings`: places to inspect
- `parked`: items jev-code could not decide
- `notChecked`: work jev-code did not perform
- `coverage`: how much evidence was actually examined
- `workflow`: the selected workflow and its report version, such as `check@1`

Every report uses the `jev-code.packet/v1` schema.

There is no `pass` or `approved` result. Run `jev-code --help` for exit-code meanings.

By default, run records are saved under `.jev-code/runs/<run-id>/`. They can contain code and log lines, so they are private to your user and ignored by Git. Use `--no-persist` to disable them.

jev-code first sends TypeSafe the redacted request, input shape, diff presence, available capabilities and option names for routing. The selected workflow then sends only the task and bounded evidence it needs, such as changed blocks or short failure-log sections. Obvious secret files and common token formats are filtered on a best-effort basis, but jev-code is not a secret scanner. With the default provider, requests go to TypeSafe; with `JEV_PROVIDER=vercel`, requests additionally pass through the Vercel AI Gateway, which processes them even under zero-data-retention routing. Review both the gateway's and the upstream provider's data terms before sending private or regulated code.

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

`npm run smoke:real` makes a few real TypeSafe Jev requests after `npm run build`; it skips itself
without `TYPESAFE_API_KEY`. `npm run smoke:vercel` performs one minimal real Jev evaluation through
the Vercel AI Gateway; it requires `JEV_SMOKE=1` and `AI_GATEWAY_API_KEY` and skips itself otherwise,
so neither live test is part of `npm run check`. See [docs/architecture.md](docs/architecture.md) for how the code is organized and
[docs/RELEASING.md](docs/RELEASING.md) for how releases are published.

## Jev providers

Jev inference is pluggable. Both providers expose the same Jev/System One capability to the review
engine through the same request/response schema, so workflows and reports are provider-independent.
The providers are different services, though: when the gateway does not report TypeSafe's separate
confidence statistic, confidence is synthesized from the distribution and threshold-gated decisions
can differ from TypeSafe-direct (see below). Selection is entirely through configuration, at start:

```sh
export JEV_PROVIDER=typesafe        # default: direct TypeSafe API
export TYPESAFE_API_KEY="<key>"
```

or

```sh
export JEV_PROVIDER=vercel          # Vercel AI Gateway hosting of Jev
export AI_GATEWAY_API_KEY="<key>"   # canonical variable read by the ai package
```

An invalid `JEV_PROVIDER` name fails immediately at startup (exit 64), not halfway through a review.

**Model selection.** `--model` / `TYPESAFE_MODEL` select the TypeSafe-direct model for the default
provider. The Vercel provider runs in the gateway's model namespace: TypeSafe-direct ids
(`jev-1.13.0`) are a different namespace and are never forwarded — an unqualified id falls back to
the configured gateway model, and a slash-qualified gateway id (`typesafe-ai/jev-preview`) is
honored. The gateway model itself is configured with `JEV_GATEWAY_MODEL` (default `typesafe-ai/jev`,
the canonical Jev id on the Vercel AI Gateway).

**Zero data retention.** Evaluations can contain repository source code and diffs, so the Vercel
provider routes only to providers with zero data retention agreements
(`providerOptions.gateway.zeroDataRetention = true`) by default. Set
`JEV_GATEWAY_ZERO_DATA_RETENTION=0` only for troubleshooting.

Differences worth knowing:

- TypeSafe's separate per-question confidence statistic is preserved from the gateway response
  (`providerMetadata.typesafe.confidence`, Choice/Score questions). When that metadata is genuinely
  unavailable, the provider falls back to a value derived from the reported distribution (the mass
  of the selected choice, or the maximum level mass for score) — an approximation, not the model's
  own confidence, so threshold-gated decisions can differ from TypeSafe-direct in that case.
- Noul/boolean answers carry probability only; TypeSafe reports no separate confidence for them.
- Usage numbers come from the gateway; when it omits them, input usage is reported as a conservative
  estimate of the request size (the same estimate the input-token budget reserves), and output usage
  as zero.

## TypeSafe

Jev and TypeSafe are products of TypeSafe. jev-code is an independent open-source project and is **not**
affiliated with, endorsed by or supported by TypeSafe. It calls Jev with an API key you provide, under your
own TypeSafe account and terms.

## License

[MIT](LICENSE) © 2026 Dev Agrawal
