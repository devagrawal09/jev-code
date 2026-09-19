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
| `adapters`  | Real implementations of the ports: read-only Git, file reads, parsers, redaction, Jev providers (TypeSafe SDK, Vercel AI Gateway, Cloudflare Workers AI) | the `cli` folder                                                     |
| `cli`       | Parse arguments, wire adapters into workflows, print output, choose the exit code          | nothing                                                              |

`src/cli.ts` (the `jev-code` binary) and `src/index.ts` (package exports) belong to `cli`. Every other
production file must live in one of the four folders. Tests and scripts may import anything.

## What happens in a run

Using `check` as the example:

1. **cli** parses the natural-language request and flags, reads `JEV_PROVIDER`, `TYPESAFE_API_KEY`,
   `AI_GATEWAY_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `TYPESAFE_MODEL`
   through `adapters/config.ts`, and builds the dependencies
   in `adapters/dependencies.ts`. The provider factory selects `TypeSafeJevProvider` (direct API,
   default), `VercelJevProvider` (Vercel AI Gateway), or `CloudflareJevProvider` (Cloudflare Workers
   AI REST run endpoint); unknown provider names fail at startup.
2. **routing** (`cli/router.ts`) receives the redacted request plus deterministic context: diff presence,
   input shape, available capabilities, and supplied option names. One validated choice selects `find`,
   `check`, `triage_failures`, `triage_comments`, or `cannot_tell`. Fixed confidence and capability gates turn
   uncertain or unavailable choices into `cannot_tell`; the CLI then asks for clarification. The router has no
   tool access and cannot name an operation outside that enum.
3. **workflow** (`workflows/check.ts`) validates every input, asks the source port for the diff once, and
   has the evidence port parse it into hunks (changed blocks). It skips secret-shaped paths, binaries and
   vendored files, starts one `Run`, and hands the diff to its sections.
4. **Exact checks** run in code first (`workflows/hunks.ts`, `classify.ts`): skip markers, removed assertions,
   deleted tests, lockfile, CI and config changes. Some pieces are settled here and never reach Jev.
5. **Questions.** For each remaining piece, the workflow builds a request: a small JSON state plus
   fixed-choice questions (yes/no, choice or score). `workflows/run.ts` redacts it and hands it to
   `core/executor.ts`, which reserves budget, calls the Jev port, validates the answer shape and retries
   transient failures or invalid model responses. If the budget is exhausted or Jev is unavailable during a run, the piece is marked
   unjudged instead. This lives in `core`, so it is the same for `check`, `triage` and `find`.
6. **Decisions** are made in code with fixed, versioned thresholds (`workflows/policy.ts`), not by the model.
   Unclear answers are "parked" for a human to look at.
7. **Report.** `Run` builds the `jev-code.packet/v1` packet with coverage, findings, parked items, limits and a
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
  and the CLI accepts no caller-written questions, workflow choices or actions.
- **Budgets are hard stops.** When a request, input-token or time limit is reached, no more requests are sent.

## Records

Unless `--no-persist` is set, `adapters/recorder.ts` writes `.jev-code/runs/<run-id>/`: `manifest.json`,
`inputs.json`, `candidates.json`, `packet.json`, and when relevant `decisions.ndjson`, `events.ndjson` and
`frames.ndjson` (every Jev request and response). Files are `0600`, directories `0700`, and
`.jev-code/.gitignore` contains `*`.

## Routing targets, workflows and sections

The public CLI has no workflow subcommands or explicit route override. Its four internal targets are safe,
typed entry points in `cli/registry.ts`:

| Router target      | Module                | Function           | Run info | Packet `workflow` |
| ------------------ | --------------------- | ------------------ | -------- | ----------------- |
| `find`             | `workflows/find.ts`   | `find()`           | `FIND`   | `find@1`          |
| `check`            | `workflows/check.ts`  | `check()`          | `CHECK`  | `check@1`         |
| `triage_failures`  | `workflows/triage.ts` | `triageFailures()` | `TRIAGE` | `triage@1`        |
| `triage_comments`  | `workflows/triage.ts` | `triageComments()` | `TRIAGE` | `triage@1`        |

`cannot_tell` is a router outcome, not a workflow. It returns a clarification error without starting a run.
`test/cli.test.ts` fixes the routing-target set and exercises each typed entry point.

`check` and `triage` are built from **sections**. A section is not a workflow: it has no `WorkflowInfo`, never
starts a `Run`, and never loads a diff. The workflow does those once and passes them in. A section plans its
candidates first, then judges, and returns a `SectionReport` (`workflows/common.ts`) that the workflow merges
into the single packet.

- `check` always runs `check-task.ts` (task alignment, test safety, exact checks). `check-rules.ts` runs when
  rules are supplied and `check-criteria.ts` when criteria are. Sections judge in that fixed order and share
  one budget. Each result row carries `section`; `summary` has one entry per section.
- `triageFailures()` and `triageComments()` fix the input kind before calling the shared `triage` workflow,
  which runs exactly one of `triage-failures.ts` or `triage-comments.ts`. Parsing and classification are
  specific to the kind. Each result row carries `kind`.

Thresholds stay with the section that uses them, each with its own policy version (for example
`check-task-policy@1`), so a decision record always names the policy that made it.

## Adding a workflow

1. Add `src/workflows/<name>.ts`. Export a `WorkflowInfo` and a typed run function that uses only ports from
   `workflows/ports.ts` and the `Run` helper. Put thresholds in code with a policy version. Prefer a new section
   of an existing workflow over a new routing target.
2. If it needs a new kind of outside input, add a method to a port and implement it in `adapters/`.
3. Add a fixed outcome and criteria to `src/cli/router.ts`, including a deterministic capability gate. Register
   the typed target and human renderer in `src/cli/registry.ts`, then add its input handling in `src/cli.ts`.
4. Add routing and workflow tests with the fake Jev adapter (`adapters/fake-jev.ts`), then run `npm run check`.
