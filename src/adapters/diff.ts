import { stableId } from "../core/hash.ts";
import { classifyPath, type PathKind } from "../workflows/classify.ts";
import { type DiffFile, type DiffLine, type Hunk, MAX_HUNK_LINES } from "../workflows/evidence.ts";

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stripPrefix(raw: string): string | null {
  const value = unquote(raw.replace(/\t.*$/, ""));
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/** Parse `git diff` unified output into files and hunks with stable IDs. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  let file: DiffFile | null = null;
  let current: Omit<Hunk, "id" | "kind" | "part"> | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;

  const flushHunk = () => {
    if (file && current) file.hunks.push(...finalizeHunk(current, file.kind));
    current = null;
  };
  const flushFile = () => {
    flushHunk();
    if (file) files.push(file);
    file = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ")) {
      flushFile();
      const match = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      const path = match ? unquote(match[2]!) : line.slice(11);
      file = {
        path,
        oldPath: match ? unquote(match[1]!) : null,
        status: "mode_only",
        kind: classifyPath(path),
        hunks: [],
      };
      continue;
    }
    if (!file) continue;
    const active = file as DiffFile;
    if (current && (oldRemaining > 0 || newRemaining > 0)) {
      const marker = line[0];
      if (marker === "+" || marker === "-" || marker === " " || line === "") {
        const type = (line === "" ? " " : marker) as DiffLine["type"];
        current.lines.push({ type, text: line.slice(1) });
        if (type === "+") {
          current.added++;
          newRemaining--;
        } else if (type === "-") {
          current.removed++;
          oldRemaining--;
        } else {
          oldRemaining--;
          newRemaining--;
        }
        continue;
      }
      if (line.startsWith("\\")) continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("--- ")) {
      const oldPath = stripPrefix(line.slice(4));
      if (oldPath === null) active.status = "added";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = stripPrefix(line.slice(4));
      if (newPath === null) active.status = "deleted";
      else {
        active.path = newPath;
        active.kind = classifyPath(newPath);
        if (active.status === "mode_only") active.status = "modified";
      }
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      active.status = "binary";
      continue;
    }
    if (line.startsWith("new file mode")) active.status = "added";
    if (line.startsWith("deleted file mode")) active.status = "deleted";
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (header) {
      flushHunk();
      const oldLines = header[2] === undefined ? 1 : Number(header[2]);
      const newLines = header[4] === undefined ? 1 : Number(header[4]);
      current = {
        path: active.path,
        oldPath: active.oldPath !== active.path ? active.oldPath : null,
        fileStatus:
          active.status === "added" ? "added" : active.status === "deleted" ? "deleted" : "modified",
        oldStart: Number(header[1]),
        oldLines,
        newStart: Number(header[3]),
        newLines,
        section: header[5] ?? "",
        lines: [],
        added: 0,
        removed: 0,
      };
      oldRemaining = oldLines;
      newRemaining = newLines;
    }
  }
  flushFile();
  return files;
}

function finalizeHunk(raw: Omit<Hunk, "id" | "kind" | "part">, kind: PathKind): Hunk[] {
  const identity = (value: Omit<Hunk, "id">) =>
    stableId("h", {
      path: value.path,
      oldStart: value.oldStart,
      newStart: value.newStart,
      lines: value.lines,
      part: value.part,
    });
  if (raw.lines.length <= MAX_HUNK_LINES) {
    const hunk = { ...raw, kind, part: null };
    return [{ ...hunk, id: identity(hunk) }];
  }
  const count = Math.ceil(raw.lines.length / MAX_HUNK_LINES);
  const parts: Hunk[] = [];
  let oldLine = raw.oldStart;
  let newLine = raw.newStart;
  for (let index = 0; index < count; index++) {
    const lines = raw.lines.slice(index * MAX_HUNK_LINES, (index + 1) * MAX_HUNK_LINES);
    const added = lines.filter((line) => line.type === "+").length;
    const removed = lines.filter((line) => line.type === "-").length;
    const context = lines.length - added - removed;
    const part: Omit<Hunk, "id"> = {
      ...raw,
      kind,
      lines,
      added,
      removed,
      oldStart: oldLine,
      oldLines: removed + context,
      newStart: newLine,
      newLines: added + context,
      part: { index: index + 1, count },
    };
    oldLine += removed + context;
    newLine += added + context;
    parts.push({ ...part, id: identity(part) });
  }
  return parts;
}
