import type { Hunk } from "./evidence.ts";

export function hunkText(hunk: Hunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section ? ` ${hunk.section}` : ""}`;
  return [header, ...hunk.lines.map((line) => `${line.type}${line.text}`)].join("\n");
}

export function lineRange(hunk: Hunk): string {
  if (hunk.fileStatus === "deleted" || hunk.newLines === 0)
    return `old ${hunk.oldStart}-${hunk.oldStart + Math.max(hunk.oldLines - 1, 0)}`;
  return `${hunk.newStart}-${hunk.newStart + Math.max(hunk.newLines - 1, 0)}`;
}

const SKIP_MARKERS = [
  /\b(?:it|test|describe|context|suite)\.(?:skip|todo)\s*\(/,
  /\b(?:xit|xtest|xdescribe|xcontext)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail)\s*\(/,
  /@unittest\.skip/,
  /\bt\.Skip(?:f|Now)?\s*\(/,
  /#\[ignore\]/,
  /@(?:Disabled|Ignore)\b/,
  /\{\s*skip\s*:\s*true\s*\}/,
];
const ASSERTION =
  /\b(?:expect|assert\w*|should|assertThat|require\.\w+)\s*[.(!]|\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(|\bXCTAssert\w*\s*\(|\.to(?:Be|Equal|Match|Throw|Have)\w*\s*\(/;

export interface HunkLadder {
  formattingOnly: boolean;
  skipMarkersAdded: number;
  assertionsRemoved: number;
  assertionsAdded: number;
  testFileDeleted: boolean;
  flags: string[];
}

export function ladderForHunk(hunk: Hunk): HunkLadder {
  const added = hunk.lines.filter((line) => line.type === "+").map((line) => line.text);
  const removed = hunk.lines.filter((line) => line.type === "-").map((line) => line.text);
  const squash = (values: string[]) => values.join("").replace(/\s+/g, "");
  const formattingOnly = (added.length > 0 || removed.length > 0) && squash(added) === squash(removed);
  const skipMarkersAdded = added.filter((line) => SKIP_MARKERS.some((pattern) => pattern.test(line))).length;
  const skipMarkersRemoved = removed.filter((line) =>
    SKIP_MARKERS.some((pattern) => pattern.test(line)),
  ).length;
  const assertionsRemoved = removed.filter((line) => ASSERTION.test(line)).length;
  const assertionsAdded = added.filter((line) => ASSERTION.test(line)).length;
  const testFileDeleted = hunk.kind === "test" && hunk.fileStatus === "deleted";
  const flags: string[] = [];
  if (formattingOnly) flags.push("formatting_only");
  if (skipMarkersAdded > skipMarkersRemoved) flags.push("skip_marker_added");
  if (hunk.kind === "test" && assertionsRemoved > assertionsAdded) flags.push("assertions_removed");
  if (testFileDeleted) flags.push("test_file_deleted");
  if (hunk.kind === "lockfile") flags.push("lockfile_changed");
  if (hunk.kind === "generated") flags.push("generated_file_changed");
  if (hunk.kind === "ci") flags.push("ci_config_changed");
  if (hunk.kind === "config") flags.push("config_changed");
  return { formattingOnly, skipMarkersAdded, assertionsRemoved, assertionsAdded, testFileDeleted, flags };
}

const DECLARATION =
  /\b(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module)\s+\*?\s*([A-Za-z_$][\w$]{2,})/g;

/** Identifiers declared on added lines. */
export function declaredIdentifiers(hunk: Hunk): Set<string> {
  const names = new Set<string>();
  for (const line of hunk.lines) {
    if (line.type !== "+") continue;
    for (const match of line.text.matchAll(DECLARATION)) names.add(match[1]!);
  }
  return names;
}

/** Identifiers referenced on added or context lines. */
export function referencedIdentifiers(hunk: Hunk): Set<string> {
  const names = new Set<string>();
  for (const line of hunk.lines) {
    if (line.type === "-") continue;
    for (const match of line.text.matchAll(/[A-Za-z_$][\w$]{2,}/g)) names.add(match[0]);
  }
  return names;
}

/** For each hunk, the other hunks that reference identifiers it declares (hunks it may enable). */
export function enabledHunks(hunks: readonly Hunk[]): Map<string, string[]> {
  const references = new Map(hunks.map((hunk) => [hunk.id, referencedIdentifiers(hunk)]));
  const result = new Map<string, string[]>();
  for (const hunk of hunks) {
    const declared = declaredIdentifiers(hunk);
    const linked: string[] = [];
    if (declared.size > 0) {
      for (const other of hunks) {
        if (other.id === hunk.id) continue;
        const refs = references.get(other.id)!;
        if ([...declared].some((name) => refs.has(name))) linked.push(other.id);
      }
    }
    result.set(hunk.id, linked);
  }
  return result;
}
