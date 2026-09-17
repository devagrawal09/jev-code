# Architecture

The code in `src/` is split into four folders. Imports only point one way:

```text
cli  ->  adapters  ->  workflows  ->  core
```

A folder may import itself and anything to its right, never anything to its left. When a lower folder needs
something from the outside world, such as Git or the TypeSafe SDK, it declares an interface (a "port") and a
higher folder supplies the implementation. `test/architecture.test.ts` scans every import, including
`import type`, dynamic `import()` and `require()`, and fails the build on a wrong-way import.

## One job per folder

| Folder      | Job                                                                                         | Must not use                                                         |
| ----------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `core`      | Send structured questions to Jev safely: validate answers, enforce budgets, batch, retry     | npm packages, `fs`, `child_process`, the SDK; only `node:` built-ins |
| `workflows` | Product logic: gather evidence, run exact checks, ask questions, turn answers into a report | any package or Node built-in, `process.env`, the SDK                 |
| `adapters`  | Real implementations of the ports: read-only Git, file reads, parsers, redaction, SDK client | the `cli` folder                                                     |
| `cli`       | Parse arguments, wire adapters into workflows, print output, choose the exit code          | nothing                                                              |

`src/cli.ts` (the `jev-code` binary) and `src/index.ts` (package exports) belong to `cli`. Every other
production file must live in one of the four folders. Tests and scripts may import anything.

## What happens in a run

Using `review` as the example:

1. **cli** parses flags, reads `TYPESAFE_API_KEY` and `TYPESAFE_MODEL` through `adapters/config.ts`, builds the
   dependencies in `adapters/dependencies.ts`, and calls the workflow listed in `cli/registry.ts`.
2. **workflow** (`workflows/audit-diff.ts`) asks the source port for the diff and the evidence port to parse it
   into hunks (changed blocks). It skips secret-shaped paths, binaries and vendored files, and applies size limits.
3. **Exact checks** run in code first (`workflows/hunks.ts`, `classify.ts`): skip markers, removed assertions,
   deleted tests, lockfile, CI and config changes. Some pieces are settled here and never reach Jev.
4. **Questions.** For each remaining piece, the workflow builds a request: a small JSON state plus
   fixed-choice questions (yes/no, choice or score). `workflows/run.ts` redacts it and hands it to
   `core/executor.ts`, which reserves budget, calls the Jev port, validates the answer shape and retries
   transient failures. Offline, with no key, or out of budget, the piece is marked unjudged instead.
5. **Decisions** are made in code with fixed, versioned thresholds (`workflows/policy.ts`), not by the model.
   Unclear answers are "parked" for a human to look at.
6. **Report.** `Run` builds the `jev-code.packet/v1` packet with coverage, findings, parked items, limits and a
   non-empty `notChecked` list. `cli/output.ts` prints it as text or JSON and maps the status to an exit code.

## Why core is thin

`core` knows nothing about diffs, logs, tests, findings, files, redaction rules or the SDK. It only knows how to
send a question set through a `JevPort`, check the reply against the questions asked, and stay within request,
token and time budgets. Keeping product meaning out of `core` means every workflow gets the same budget,
retry and validation behavior, and `core` can be tested with a fake port and no I/O.

## Safety boundaries

- **Read-only on the repository.** The Git adapter runs read-only commands. File reads stay inside the
  workspace and refuse credential-shaped paths. The only writes are run records under `.jev-code/`.
- **Workflows cannot reach the outside world directly.** They cannot import `fs`, `child_process`, the SDK or
  `process.env`, so every side effect goes through a port that the architecture test can see.
- **Everything sent or stored is redacted first**, through `RedactionPort` for requests and the recorder for
  files. Redaction is best effort, not a secret scanner.
- **Repository text is untrusted evidence.** Workflows ask Jev whether a piece contains text aimed at an
  automated reviewer and flag it. That is a hint, not a prompt-injection defense. Answers never trigger actions,
  and a custom question file (`ask`) has no field for commands, files to read, models or actions.
- **Budgets are hard stops.** When a request, input-token or time limit is reached, no more requests are sent.

## Records

Unless `--no-persist` is set, `adapters/recorder.ts` writes `.jev-code/runs/<run-id>/`: `manifest.json`,
`inputs.json`, `candidates.json`, `packet.json`, and when relevant `decisions.ndjson`, `events.ndjson` and
`frames.ndjson` (every Jev request and response). Files are `0600`, directories `0700`, and
`.jev-code/.gitignore` contains `*`.

## Adding a workflow

1. Add `src/workflows/<name>.ts`. Export a `WorkflowInfo` (name, version, budget) and a run function that uses
   only ports from `workflows/ports.ts` and the `Run` helper. Put thresholds in code with a policy version.
2. If it needs a new kind of outside input, add a method to a port and implement it in `adapters/`.
3. Register it in `src/cli/registry.ts` with a stability level (`stable`, `preview`, `experimental`,
   `advanced`), a summary and a human renderer. Add its usage line and argument handling in `src/cli.ts`.
4. Add tests with the fake Jev adapter (`adapters/fake-jev.ts`), then run `npm run check`.
