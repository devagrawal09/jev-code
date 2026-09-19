# Plugin Design Decisions

This file is the shared implementation brief for the plugin-system work. Update it after every user decision.
Implementation agents must read it before changing code and must not guess decisions marked unresolved.

## Settled Principles

- Plugins are trusted repository code with arbitrary execution privileges.
- Repository plugins are discovered from `.stanley/plugins/`. Direct `.ts` and `.js` files are loaded, as are
  plugin package directories with supported package or index entrypoints, following OpenCode's discovery model.
- Each plugin module default-exports an asynchronous JavaScript/TypeScript factory that returns a plugin object.
- Built-in workflows use the same registry and invocation abstraction as repository plugins.
- Workflow composition is semantic and late-bound: a workflow prompts Stanley with natural-language
  instructions, and the intent router selects the most appropriate currently available workflow.
- Calling workflows do not name or depend on child workflow IDs. Workflow identities are implementation
  details used for registration, diagnostics, traces, and recursion protection.
- The workflow author is responsible for clearly describing what the workflow does and when Jev should
  select it.
- Workflow-specific input and output may be text or arbitrary JSON. No workflow-specific schema is required.
- The host still validates the small plugin and invocation control envelope.
- Nested prompts run in-process through the same router. They do not launch another CLI process.
- Nested invocations share repository context, cancellation, budgets, tracing, and recursion limits.
- Active workflows are protected from accidental routing cycles.
- Built-in workflow implementations may retain their internal TypeScript types.
- No compatibility behavior is required for a plugin system that has not shipped yet.

## Plugin API

```ts
export default async function () {
  return {
    id: "release-notes",
    instructions: "Use when the user requests release notes or a changelog",
    async run({ request, input, root, prompt, signal, log }) {
      const summary = await prompt("Summarize the current diff")
      return { request, summary: summary.output }
    },
  }
}
```

`prompt(instructions, input?)` is the primary composition API. It always routes by intent rather than calling
a named workflow. Direct child invocation by workflow ID is intentionally not part of the public design.
It resolves to a workflow-agnostic `{ status, output }` envelope. The selected workflow identity remains in
internal diagnostics and traces rather than the composition API.

Repository plugin modules are loaded through `tsx`, so plugins can use ordinary TypeScript syntax and module
resolution instead of being restricted to Node's erasable-TypeScript subset.

A plugin that fails to import, whose factory throws, or whose returned object fails control-envelope validation
is quarantined. Stanley emits a visible warning and continues with the remaining workflows. Duplicate plugin
IDs are different: registration fails rather than choosing an implementation by precedence. Built-in IDs cannot
be silently replaced.

Every plugin `run` function receives the minimal public context: `request`, optional text/JSON `input`, canonical
repository `root`, the compositional `prompt` function, the bounded `judge` function, an `AbortSignal`, and
structured `log`. Filesystem, shell, network, environment, Git, raw Jev, adapters, the registry, workflow IDs,
and parsed CLI options are not exposed as host APIs; trusted plugin code may use normal TypeScript and Node APIs
directly.

`judge({ scope, state, questions })` is the Jev-first primitive: it asks Jev bounded fixed-choice questions
(`noul`, `choice`, `score`) about JSON evidence the plugin supplies, through the same validated, redacted,
budgeted executor built-ins use. It is capped at 64 calls per run and 8 questions per call, returns
`{ ok: true, answers }` or `{ ok: false, reason }`, and never throws. It is not raw Jev: the host validates the
request shape and the answers, and every call draws from the shared invocation budget.

Agent-authored workflows (improvement candidates) use exactly this API. They are staged under
`.stanley/candidates/<job>/`, validated with the same loader, and activated only by an explicit
`stanley --promote-candidate <id>` (see [decision-log.md](decision-log.md), D-08 and D-09).

Routing is total from the caller's perspective. When Jev cannot confidently select a workflow, or a request is
outside the installed capability surface, the router selects a built-in fallback workflow rather than returning
`cannot_tell` or throwing a routing error to the caller.

The fallback explains the unsupported or unresolved capability clearly. When a clearly relevant read-only
analysis is available, it also performs that safe analysis; it does not invent arbitrary actions or silently claim
to have completed the unsupported request. Its status is `unsupported`, even when supplemental analysis succeeds;
shared resource exhaustion remains `budget_exhausted`.

One top-level invocation tree permits at most eight nested prompt levels and 32 total child prompt calls. The
entire tree shares the top-level Jev request-count, token, and wall-clock budgets and cancellation signal.
Active-stack cycle detection remains mandatory in addition to these limits.

The default export is an asynchronous initialization function. Stanley awaits it before routing and supplies an
initialization context containing only canonical repository `root`, an `AbortSignal`, and structured `log`. The
returned plugin object contains routing metadata and `run`, and may expose an asynchronous cleanup function for
resources created during initialization.

A nested prompt inherits operational context only: repository root, diff scope/base, shared budgets, cancellation,
and tracing. It does not silently inherit the parent request or input. The parent workflow must include semantic
instructions in the child request and pass any child input explicitly.

When a built-in workflow handles a prompt, the outer `{ status, output }` envelope contains output with both a
human-readable `text` representation and useful structured JSON `data`. Workflow identity and run metadata stay
in internal diagnostics and artifacts, not in the composition value.

Plugin routing metadata has no fixed description/when/examples schema. Only `id` and `run` are required control
fields. A redacted copy of every additional JSON-serializable field is passed to Jev as routing metadata.
`instructions` is the documented convention, but plugin authors may structure metadata however they need and
remain responsible for making the plugin's purpose and selection criteria clear to Jev. Reserved executable and
lifecycle fields are not included in routing metadata.

A plugin `run` function returns raw text or any JSON value. A successful return is normalized by the host to
`{ status: "complete", output }`. Host-owned workflows such as the fallback may produce another status, and
thrown errors remain execution failures rather than successful output.

## Decision History

- 2026-09-18: Initial settled principles recorded from the design discussion.
- 2026-09-18: Nested prompts return `{ status, output }` without exposing the selected workflow identity.
- 2026-09-18: Repository TypeScript plugins are loaded with `tsx`.
- 2026-09-18: Invalid or unloadable plugins are quarantined with a visible warning.
- 2026-09-18: Duplicate plugin IDs fail registration; plugins do not override built-ins or each other.
- 2026-09-18: Plugin runs receive only `request`, `input`, `root`, `prompt`, `signal`, and structured `log`.
- 2026-09-18: Uncertain and unsupported requests route to a built-in fallback workflow.
- 2026-09-18: The fallback explains the limitation and performs clearly relevant safe analysis when possible.
- 2026-09-18: Invocation trees are limited to depth 8 and 32 child prompts with shared top-level budgets.
- 2026-09-18: Plugin factories initialize asynchronously before routing.
- 2026-09-18: Nested prompts inherit operational context, but not parent requests or input.
- 2026-09-18: The fallback always returns `unsupported`; any safe analysis is supplemental.
- 2026-09-18: Plugin initialization receives `root`, `signal`, and `log`, with optional asynchronous cleanup.
- 2026-09-18: Built-in prompt output contains both readable text and structured JSON without workflow identity.
- 2026-09-18: Discovery follows OpenCode-style direct files and plugin package directories.
- 2026-09-18: Plugins require only `id` and `run`; routing metadata may be arbitrary JSON.
- 2026-09-18: All additional JSON fields are routing metadata; `instructions` is the documented convention.
- 2026-09-18: Plugin runs return raw text/JSON and successful values are wrapped with `complete` status.
- 2026-09-18: Plugin runs also receive `judge`, a bounded, validated, budgeted fixed-choice Jev primitive
  (supersedes "raw Jev is not exposed" only in the sense that a validated, capped primitive now is).
- 2026-09-18: Confidently unsupported top-level requests delegate to the Pi coding agent when one is
  installed; the fallback result is then `complete`/`incomplete` and explicitly unverified, never `unsupported`.
  Uncertain, capability-gated, nested, and `--no-agent` requests keep the previous `unsupported` fallback.
- 2026-09-18: Every delegation queues a durable improvement job; a detached worker stages a candidate workflow
  that is validated, never auto-activated. Later decisions are recorded in `docs/decision-log.md`.
