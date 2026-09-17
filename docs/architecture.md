# Architecture

Production code in `src/` is split into four layers. Dependencies point one way:

```
cli  ->  adapters  ->  workflows  ->  core
```

Lower layers define ports (interfaces). Higher layers implement them and wire them together.
Nothing lower names a concrete implementation from a higher layer.

## Dependency matrix

Rows import columns. "yes" means allowed; everything else is rejected by `test/architecture.test.ts`.

| importer \ imported | core | workflows | adapters | cli (incl. `cli.ts`, `index.ts`) |
| ------------------- | ---- | --------- | -------- | -------------------------------- |
| **core**            | yes  | no        | no       | no                               |
| **workflows**       | yes  | yes       | no       | no                               |
| **adapters**        | yes  | yes       | yes      | no                               |
| **cli**             | yes  | yes       | yes      | yes                              |

Tests (`test/`) and scripts (`scripts/`) may import any production layer.

Package and built-in imports:

| layer     | allowed                          | rejected                                                                 |
| --------- | -------------------------------- | ------------------------------------------------------------------------ |
| core      | `node:` built-ins (e.g. `node:crypto`) | `@typesafe-ai/sdk`, any `TypeSafeClient` reference, `fs`, `child_process`, any npm package |
| workflows | nothing outside `src/`           | every package and built-in, incl. `fs`, `child_process`, the SDK; `TypeSafeClient`; `process.env` |
| adapters  | anything                         | cli modules                                                              |
| cli       | anything                         | —                                                                        |

The entry points `src/cli.ts` (bin) and `src/index.ts` (package API) belong to the cli layer and are
never imported by production modules, so there are no reverse barrels. Every other production file must
live in `core/`, `workflows/`, `adapters/`, or `cli/`.

The architecture test scans static `import`/`export ... from`, side-effect `import "x"`, dynamic
`import("x")`, and `require("x")`, including `import type`, and it self-checks the scanner against
synthetic violations.

## Layers

### core (`src/core`)

Generic machinery with no product knowledge.

- `types.ts`: JSON types, `Frame<A, P>` (provenance type is a parameter), `JevRequest`, the `JevPort`
  interface, `TransportFailure`, and `JevUsage`.
- `questions.ts`: Noul/Choice/Score question shapes and builders.
- `validation.ts`: response envelope and answer validation (`ValidationError`).
- `budget.ts`, `batch.ts`: request/token/wall-clock budgets, sharding, bounded concurrency, split-on-too-large.
- `executor.ts`: `FrameExecutor`, which reserves budget, calls the port, validates, retries transient failures,
  stops after authentication failure, and dedupes identical frames. It exposes abstract hooks: `prepare` (request
  rewriting, used for redaction), `classifyError`, `describeError`, and a `FrameSink` for attempt records.
- `frame.ts`, `hash.ts`: stable content-derived IDs and deterministic shuffling.

No workflow names, packets, findings, Git, filesystem, logs, comments, CLI formatting, redaction rules,
recorders, or SDK code.

### workflows (`src/workflows`)

Domain logic that talks to the outside world only through ports.

- Six domain workflows, plus the constrained `run-frame`. Source files keep their original names; the public
  command names are:

  | command           | source file                    | stability    |
  | ----------------- | ------------------------------ | ------------ |
  | `flag-diff`       | `audit-diff.ts`                | stable       |
  | `triage-failures` | `triage-failures.ts`           | stable       |
  | `flag-rules`      | `check-rules.ts`               | preview      |
  | `map-criteria`    | `check-criteria.ts`            | preview      |
  | `triage-comments` | `triage-comments.ts`           | experimental |
  | `locate`          | `locate.ts`                    | experimental |
  | `run-frame`       | `run-frame.ts`                 | advanced     |

  Stability lives in `src/cli/registry.ts` and is shown in `--help`.
- `run.ts`: `Run` wraps the core executor with packet/coverage/disposition semantics, redaction via the
  `RedactionPort`, and recording via the storage port.
- `types.ts`: packet schema, `EvidenceRef`, `Finding`, `Coverage`, and related types.
- `evidence.ts`: evidence types (`Hunk`, `DiffFile`, `FailureBlock`, `ReviewComment`, `TestRecord`) and limits.
- `hunks.ts`, `classify.ts`, `policy.ts`, `common.ts`: deterministic ladders, path policy, thresholds.
- `ports.ts`: the ports the workflows need:
  - source: `WorkspaceSource` (diff collection, tracked files, contained file reads)
  - evidence: `EvidenceParser` (unified diff, failure logs, review comments, test records)
  - storage: `ArtifactStore` / `ArtifactWriter` (run artifacts, recent run inputs)
  - `RedactionPort`, `classifyError`, `createRunId`, and the core `JevPort`
- `errors.ts`: `InputError`.

Tool-owned input formats (criteria lists, rules files, frame files) are validated here. Externally
produced formats are parsed in adapters.

### adapters (`src/adapters`)

Concrete implementations.

- `jev.ts`: the TypeSafe SDK `JevPort` and SDK error classification. `fake-jev.ts`: a deterministic fake port.
- `git.ts`, `paths.ts`: read-only Git commands and workspace-contained file reads.
- `diff.ts`, `logs.ts`, `comments.ts`, `test-records.ts`: parsers for external formats.
- `redact.ts`: credential redaction. `recorder.ts`: `.jev/runs` artifact persistence.
- `config.ts`: environment configuration (`TYPESAFE_API_KEY`, `TYPESAFE_MODEL`).
- `dependencies.ts`: builds `WorkflowDependencies` for a local workspace.

### cli (`src/cli`, `src/cli.ts`, `src/index.ts`)

- `cli.ts`: composition root. Parses arguments, reads configuration, wires adapters into workflow
  options, dispatches, and maps errors to exit codes.
- `cli/registry.ts`: transport-neutral workflow registry and human renderers.
- `cli/output.ts`: exit codes and human output formatting.
- `index.ts`: public package exports from every layer.
