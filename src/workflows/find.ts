import { shard, withSplitting } from "../core/batch.ts";
import { hashValue, seededShuffle, stableId } from "../core/hash.ts";
import { choice, noul, score } from "../core/questions.ts";
import type { JsonObject } from "../core/types.ts";
import {
  type ChoiceAnswer,
  expectKeys,
  readChoice,
  readNoul,
  readScore,
  type ScoreAnswer,
} from "../core/validation.ts";
import { classifyPath, contentExclusionReason, languageForPath, matchesAnyGlob } from "./classify.ts";
import { requireTask, sortFindings, taskTokens, unjudgedOrFailed } from "./common.ts";
import {
  decisiveLabel,
  EVIDENCE_POLICY,
  massAtLeast,
  round,
  roundedDistribution,
  UNTRUSTED_INSTRUCTION_THRESHOLD,
  untrustedInstructionQuestion,
} from "./policy.ts";
import type { RedactionPort, WorkspaceSource } from "./ports.ts";
import { buildFrame, Run, type RunOptions } from "./run.ts";
import type { EvidenceRef, Exclusion, Finding, Packet, Parked } from "./types.ts";

export interface FindInput {
  task: string;
  paths?: string[];
  top?: number;
  includeExcerpts?: boolean;
  maxFiles?: number;
}

export const FIND = {
  name: "find",
  version: 1,
  budget: { requests: 600, inputTokens: 1_200_000, wallMs: 120_000 },
} as const;

export const FIND_POLICY = {
  version: "find-policy@1",
  shardSize: 20,
  acceptMetaHighMass: 0.35,
  maxExcerptCandidates: 24,
  strongHighMass: 0.6,
  conflictHighMass: 0.6,
  conflictUnrelated: 0.6,
  cutOff: 0.6,
  missingEvidence: 0.5,
  excerptLines: 160,
  wholeFileLines: 200,
  symbolScanBytes: 64 * 1024,
  maxSymbols: 12,
  maxFileBytes: 2 * 1024 * 1024,
} as const;

const ROLES = ["implementation", "caller", "test", "config", "docs", "unrelated", "cannot_tell"] as const;
const MISSING = ["none", "caller", "callee", "configuration", "tests", "cannot_tell"] as const;
const RELEVANCE_LEVELS = [
  "Unrelated to the task.",
  "Same general area, but unlikely to need reading or changing for this task.",
  "Likely useful context for the task, e.g. a caller, test, or configuration.",
  "Likely contains the code the task is about.",
] as const;

interface Candidate {
  id: string;
  path: string;
  language: string;
  kind: string;
  bytes: number;
  symbols: string[];
  lexical: number;
}

interface MetaAnswer {
  relevance: ScoreAnswer;
  role: ChoiceAnswer<(typeof ROLES)[number]>;
}

interface ExcerptAnswer {
  relevance: ScoreAnswer;
  targetVisible: number;
  cutOff: number;
  missing: ChoiceAnswer<(typeof MISSING)[number]>;
  untrusted: number;
}

export interface FindResult {
  rank: number | null;
  id: string;
  path: string;
  kind: string;
  language: string;
  disposition: string;
  metadata: {
    highMass: number;
    expected: number;
    role: string;
    roleDistribution: Record<string, number>;
  } | null;
  excerpt: {
    ranges: string[];
    highMass: number;
    expected: number;
    targetDefinitionVisible: number;
    relevantContentCutOff: number;
    missingEvidence: string;
    text?: string;
  } | null;
  relevance: number | null;
  probesRun: string[];
  error: string | null;
}

function lexicalScore(tokens: readonly string[], path: string, symbols: readonly string[]): number {
  const haystack = `${path} ${symbols.join(" ")}`.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return tokens.filter((token) => haystack.includes(token)).length;
}

const SYMBOL =
  /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def|fn|func|struct|trait|const)\s+\*?\s*([A-Za-z_$][\w$]{2,})/g;

async function inventory(source: WorkspaceSource, input: FindInput, tokens: string[]) {
  const all = await source.trackedFiles();
  const excluded: Exclusion[] = [];
  const candidates: Candidate[] = [];
  for (const path of all) {
    const kind = classifyPath(path);
    const reason =
      contentExclusionReason(kind) ??
      (kind === "lockfile" ? "lockfile" : kind === "generated" ? "generated file" : null) ??
      (input.paths && input.paths.length > 0 && !matchesAnyGlob(path, input.paths)
        ? "outside --paths"
        : null);
    if (reason) {
      if (reason !== "outside --paths") excluded.push({ id: `file:${path}`, path, reason });
      continue;
    }
    const bytes = await source.fileSize(path);
    if (bytes === null) {
      excluded.push({ id: `file:${path}`, path, reason: "deleted or not a regular file in the worktree" });
      continue;
    }
    const symbols: string[] = [];
    if (bytes <= FIND_POLICY.maxFileBytes && kind !== "documentation") {
      const file = await source.readLines(path, FIND_POLICY.maxFileBytes);
      if (file) {
        const head = file.lines.join("\n").slice(0, FIND_POLICY.symbolScanBytes);
        for (const match of head.matchAll(SYMBOL)) {
          if (!symbols.includes(match[1]!)) symbols.push(match[1]!);
          if (symbols.length >= FIND_POLICY.maxSymbols) break;
        }
      }
    }
    candidates.push({
      id: stableId("c", path, 8),
      path,
      language: languageForPath(path),
      kind,
      bytes,
      symbols,
      lexical: lexicalScore(tokens, path, symbols),
    });
  }
  return { tracked: all.length, candidates, excluded };
}

function metaFrame(task: string, shardItems: readonly Candidate[]) {
  const questions: Record<string, ReturnType<typeof score> | ReturnType<typeof choice>> = {};
  for (const candidate of shardItems) {
    questions[`relevance_${candidate.id}`] = score(
      `Based only on its metadata, how relevant is candidate ${candidate.id} (${candidate.path}) to the task?`,
      [...RELEVANCE_LEVELS],
    );
    questions[`role_${candidate.id}`] = choice(
      `Based only on its metadata, what role would candidate ${candidate.id} (${candidate.path}) play for the task?`,
      {
        implementation: "Implements behavior the task is about.",
        caller: "Uses or invokes the relevant behavior.",
        test: "Tests the relevant behavior.",
        config: "Configures the relevant behavior.",
        docs: "Documents the relevant behavior.",
        unrelated: "Has nothing to do with the task.",
        cannot_tell: "Metadata is not enough to tell.",
      },
    );
  }
  const keys = Object.keys(questions);
  return buildFrame<Map<string, MetaAnswer>>({
    template: "candidate_meta@1",
    scope: stableId(
      "shard",
      shardItems.map((item) => item.id),
    ),
    state: {
      evidencePolicy: EVIDENCE_POLICY,
      task,
      candidates: shardItems.map((item) => ({
        id: item.id,
        path: item.path,
        language: item.language,
        kind: item.kind,
        bytes: item.bytes,
        symbols: item.symbols,
      })),
    },
    questions,
    provenance: shardItems.map((item) => ({
      kind: "file_metadata" as const,
      id: item.id,
      path: item.path,
      probe: "git-ls-files+symbol-scan@1",
      truncated: false,
    })),
    parse(answers) {
      expectKeys(answers, keys);
      return new Map(
        shardItems.map((item) => [
          item.id,
          {
            relevance: readScore(answers, `relevance_${item.id}`, 4),
            role: readChoice(answers, `role_${item.id}`, ROLES),
          },
        ]),
      );
    },
  });
}

interface Excerpt {
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
}

async function readExcerpt(
  source: WorkspaceSource,
  redaction: RedactionPort,
  candidate: Candidate,
  tokens: string[],
  after?: number,
): Promise<Excerpt | null> {
  const file = await source.readLines(candidate.path, FIND_POLICY.maxFileBytes);
  if (!file) return null;
  const total = file.lines.length;
  let start = 1;
  if (after !== undefined) {
    start = after + 1;
    if (start > total) return null;
  } else if (total > FIND_POLICY.wholeFileLines) {
    const hit = file.lines.findIndex((line) => tokens.some((token) => line.toLowerCase().includes(token)));
    start = hit < 0 ? 1 : Math.max(1, hit + 1 - 20);
  }
  const span = total <= FIND_POLICY.wholeFileLines && after === undefined ? total : FIND_POLICY.excerptLines;
  const end = Math.min(total, start + span - 1);
  const text = file.lines
    .slice(start - 1, end)
    .map((line, offset) => `${start + offset}| ${line}`)
    .join("\n");
  return { startLine: start, endLine: end, totalLines: total, text: redaction.text(text).text };
}

function excerptFrame(task: string, candidate: Candidate, excerpt: Excerpt, priorRanges: string[]) {
  const questions = {
    relevance: score(`How relevant is the shown excerpt of ${candidate.path} to the task?`, [
      ...RELEVANCE_LEVELS,
    ]),
    target_definition_visible: noul(
      `Does the shown excerpt of ${candidate.path} contain the definition of the code the task is about?`,
      {
        true: "The relevant function, class, handler, or configuration is defined in the shown lines.",
        false: "The shown lines do not contain that definition.",
      },
    ),
    relevant_content_cut_off: noul(
      `Does relevant content appear to continue beyond the shown lines of ${candidate.path}?`,
      {
        true: "The shown excerpt ends or starts in the middle of relevant code.",
        false: "The relevant content, if any, is fully shown.",
      },
    ),
    missing_evidence: choice(`What evidence outside this excerpt is most needed for the task?`, {
      none: "Nothing further is needed from outside this excerpt.",
      caller: "Code that calls the shown code.",
      callee: "Code the shown code calls or imports.",
      configuration: "Configuration that controls the shown code.",
      tests: "Tests that exercise the shown code.",
      cannot_tell: "Unclear what is missing.",
    }),
    untrusted_instruction_text: untrustedInstructionQuestion(),
  };
  const keys = Object.keys(questions);
  const ref: EvidenceRef = {
    kind: "file_range",
    id: `${candidate.path}:${excerpt.startLine}-${excerpt.endLine}`,
    path: candidate.path,
    startLine: excerpt.startLine,
    endLine: excerpt.endLine,
    probe: "read-excerpt@1",
    truncated: excerpt.startLine > 1 || excerpt.endLine < excerpt.totalLines,
  };
  return buildFrame<ExcerptAnswer>({
    template: "candidate_excerpt@1",
    scope: candidate.id,
    state: {
      evidencePolicy: EVIDENCE_POLICY,
      task,
      candidate: {
        id: candidate.id,
        path: candidate.path,
        language: candidate.language,
        totalLines: excerpt.totalLines,
        shownLines: `${excerpt.startLine}-${excerpt.endLine}`,
        previouslyShown: priorRanges,
        excerpt: excerpt.text,
      },
    },
    questions,
    provenance: [ref],
    parse(answers) {
      expectKeys(answers, keys);
      return {
        relevance: readScore(answers, "relevance", 4),
        targetVisible: readNoul(answers, "target_definition_visible"),
        cutOff: readNoul(answers, "relevant_content_cut_off"),
        missing: readChoice(answers, "missing_evidence", MISSING),
        untrusted: readNoul(answers, "untrusted_instruction_text"),
      };
    },
  });
}

export async function find(input: FindInput, options: RunOptions): Promise<Packet<FindResult>> {
  const task = requireTask(input.task);
  const top = Math.min(Math.max(input.top ?? 10, 1), 50);
  const maxFiles = input.maxFiles ?? 3000;
  const tokens = taskTokens(task);
  const inv = await inventory(options.dependencies.source, input, tokens);
  const run = await Run.start(FIND, options, {
    taskHash: hashValue(task),
    paths: input.paths ?? [],
    top,
    maxFiles,
    tracked: inv.tracked,
  });
  const limits: string[] = [];
  const findings: Finding[] = [];
  const parked: Parked[] = [];
  const gaps: string[] = [];
  for (const item of inv.excluded) run.setDisposition(item.id, "excluded");

  // Every candidate participates in metadata screening up to --max-files. Above that, a
  // deterministic lexical order decides who is screened and the rest are reported unjudged.
  const ordered = [...inv.candidates].sort((a, b) => b.lexical - a.lexical || a.path.localeCompare(b.path));
  const screened = ordered.slice(0, maxFiles);
  const unscreened = ordered.slice(maxFiles);
  if (unscreened.length > 0) {
    limits.push(
      `${unscreened.length} of ${ordered.length} candidates exceeded --max-files ${maxFiles} and were not screened (lowest lexical overlap first)`,
    );
  }
  const results = new Map<string, FindResult>();
  for (const candidate of ordered) {
    results.set(candidate.id, {
      rank: null,
      id: candidate.id,
      path: candidate.path,
      kind: candidate.kind,
      language: candidate.language,
      disposition: "unjudged",
      metadata: null,
      excerpt: null,
      relevance: null,
      probesRun: [],
      error: unscreened.includes(candidate) ? "not screened: --max-files limit" : null,
    });
    run.setDisposition(candidate.id, "unjudged");
  }
  await run.candidates({ tracked: inv.tracked, candidates: ordered, excluded: inv.excluded });

  // Round 1: metadata shards in a seeded order so position bias is not tied to path order.
  const shuffled = seededShuffle(screened, `find:${hashValue(task)}`);
  const shards = shard(shuffled, FIND_POLICY.shardSize);
  const metaAnswers = new Map<string, MetaAnswer>();
  const shardRuns = await Promise.all(
    shards.map((items) =>
      withSplitting(items, async (subset) => {
        const outcome = await run.judge(metaFrame(task, subset));
        if (!outcome.ok && outcome.reason === "too_large") return { tooLarge: true };
        return { tooLarge: false, value: outcome };
      }),
    ),
  );
  for (const pieces of shardRuns) {
    for (const piece of pieces) {
      for (const candidate of piece.items) {
        const result = results.get(candidate.id)!;
        const outcome = piece.value;
        if (!outcome) {
          result.error = "metadata frame too large even for one candidate";
          result.disposition = "failed";
          run.setDisposition(candidate.id, "failed");
          continue;
        }
        if (!outcome.ok) {
          result.error = `${outcome.reason}: ${outcome.detail}`;
          const disposition = unjudgedOrFailed(outcome.reason);
          result.disposition = disposition;
          run.setDisposition(candidate.id, disposition);
          continue;
        }
        const answer = outcome.value.get(candidate.id)!;
        metaAnswers.set(candidate.id, answer);
        result.metadata = {
          highMass: massAtLeast(answer.relevance, 2),
          expected: round(answer.relevance.score),
          role: answer.role.choice,
          roleDistribution: roundedDistribution(answer.role.probabilities),
        };
        result.relevance = result.metadata.highMass;
        result.disposition = "judged";
        run.setDisposition(candidate.id, "judged");
      }
    }
  }

  // Round 2: bounded excerpts for accepted candidates only (fail open on recall).
  const accepted = screened
    .filter(
      (candidate) => (results.get(candidate.id)?.metadata?.highMass ?? 0) >= FIND_POLICY.acceptMetaHighMass,
    )
    .sort(
      (a, b) =>
        results.get(b.id)!.metadata!.highMass - results.get(a.id)!.metadata!.highMass ||
        a.path.localeCompare(b.path),
    );
  const excerptLimit = Math.min(FIND_POLICY.maxExcerptCandidates, Math.max(top * 2, top));
  const toRead = accepted.slice(0, excerptLimit);
  if (accepted.length > toRead.length) {
    limits.push(
      `${accepted.length - toRead.length} accepted candidates were ranked by metadata only (excerpt limit ${excerptLimit})`,
    );
  }
  const excerptTexts = new Map<string, string>();
  await Promise.all(
    toRead.map(async (candidate) => {
      const result = results.get(candidate.id)!;
      let excerpt = await readExcerpt(
        options.dependencies.source,
        options.dependencies.redaction,
        candidate,
        tokens,
      );
      if (!excerpt) {
        result.error = "excerpt unreadable (binary, too large, or missing)";
        return;
      }
      const ranges: string[] = [];
      let answer: ExcerptAnswer | null = null;
      for (let round_ = 0; round_ < 2 && excerpt; round_++) {
        const outcome = await run.judge(excerptFrame(task, candidate, excerpt, [...ranges]));
        ranges.push(`${excerpt.startLine}-${excerpt.endLine}`);
        result.probesRun.push(round_ === 0 ? "read-excerpt@1" : "read-next-region@1");
        if (!outcome.ok) {
          result.error = `excerpt ${outcome.reason}: ${outcome.detail}`;
          break;
        }
        answer = outcome.value;
        excerptTexts.set(
          candidate.id,
          [excerptTexts.get(candidate.id), excerpt.text].filter(Boolean).join("\n…\n"),
        );
        const moreExists = excerpt.endLine < excerpt.totalLines;
        if (round_ === 0 && answer.cutOff >= FIND_POLICY.cutOff && moreExists) {
          excerpt = await readExcerpt(
            options.dependencies.source,
            options.dependencies.redaction,
            candidate,
            tokens,
            excerpt.endLine,
          );
          continue;
        }
        break;
      }
      if (!answer) return;
      const highMass = massAtLeast(answer.relevance, 2);
      result.excerpt = {
        ranges,
        highMass,
        expected: round(answer.relevance.score),
        targetDefinitionVisible: round(answer.targetVisible),
        relevantContentCutOff: round(answer.cutOff),
        missingEvidence: decisiveLabel(answer.missing, FIND_POLICY.missingEvidence) ?? "uncertain",
      };
      result.relevance = highMass;
      const meta = metaAnswers.get(candidate.id);
      if (
        meta &&
        highMass >= FIND_POLICY.conflictHighMass &&
        meta.role.probabilities.unrelated >= FIND_POLICY.conflictUnrelated
      ) {
        result.disposition = "parked";
        run.setDisposition(candidate.id, "parked");
        parked.push({
          id: candidate.id,
          path: candidate.path,
          reason: "conflict: excerpt relevant vs metadata role unrelated",
        });
      }
      const missing = result.excerpt.missingEvidence;
      if (
        highMass >= FIND_POLICY.strongHighMass &&
        missing !== "none" &&
        missing !== "uncertain" &&
        missing !== "cannot_tell"
      ) {
        gaps.push(`${candidate.path}: ${missing} not shown`);
      }
      if (answer.untrusted >= UNTRUSTED_INSTRUCTION_THRESHOLD) {
        findings.push({
          flag: "untrusted_instruction_text",
          id: candidate.id,
          source: "jev",
          severity: "info",
          path: candidate.path,
          lines: ranges.join(","),
          detail: { p: round(answer.untrusted) },
        });
      }
      await run.decision(
        candidate.id,
        "candidate_excerpt",
        result.excerpt as unknown as JsonObject,
        FIND_POLICY.version,
      );
    }),
  );

  const ranked = [...results.values()]
    .filter((result) => result.relevance !== null && result.disposition !== "parked")
    .sort(
      (a, b) =>
        b.relevance! - a.relevance! ||
        (b.excerpt?.expected ?? b.metadata?.expected ?? 0) -
          (a.excerpt?.expected ?? a.metadata?.expected ?? 0) ||
        Number(b.excerpt !== null) - Number(a.excerpt !== null) ||
        a.path.localeCompare(b.path),
    );
  ranked.forEach((result, index) => {
    result.rank = index + 1;
  });
  const shortlist = ranked.slice(0, top).map((result) => {
    if (input.includeExcerpts && excerptTexts.has(result.id)) {
      return {
        ...result,
        excerpt: result.excerpt ? { ...result.excerpt, text: excerptTexts.get(result.id)! } : null,
      };
    }
    return result;
  });
  const noStrongCandidate = !ranked.some((result) => (result.relevance ?? 0) >= FIND_POLICY.strongHighMass);
  if (noStrongCandidate && run.coverage().judged > 0) {
    findings.push({
      flag: "no_strong_candidate",
      id: "task",
      source: "policy",
      severity: "warn",
      detail: { note: "next step likely needs a new search string or different paths chosen by the host" },
    });
  }
  const parkedResults = [...results.values()].filter((result) => result.disposition === "parked");
  const failedResults = [...results.values()].filter((result) => result.disposition === "failed");
  return run.finish({
    findings: sortFindings(findings),
    parked,
    excluded: inv.excluded,
    limits,
    notChecked: [
      "this is a ranked shortlist, not an answer to the task",
      "untracked files are not candidates",
      "files were ranked by metadata unless an excerpt was read",
      "content beyond shown excerpt ranges",
    ],
    results: [...shortlist, ...parkedResults, ...failedResults],
    summary: {
      task: { tokens: tokens.slice(0, 20) },
      tracked: inv.tracked,
      candidates: ordered.length,
      screened: screened.length,
      excerpted: toRead.length,
      ranked: ranked.length,
      returned: shortlist.length,
      noStrongCandidate,
      gaps,
    },
  });
}
