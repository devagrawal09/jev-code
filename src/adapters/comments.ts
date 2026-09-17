import { stableId } from "../core/hash.ts";
import { InputError } from "../workflows/errors.ts";
import { MAX_COMMENT_BODY_CHARS, MAX_COMMENTS, type ReviewComment } from "../workflows/evidence.ts";

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Normalize comments from a plain array, `{ comments: [...] }`, or GitHub review-comment API shapes. */
export function parseComments(input: string): ReviewComment[] {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new InputError("comments must be JSON");
  }
  const list = Array.isArray(value) ? value : (value as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(list)) throw new InputError("comments JSON must be an array or { comments: [...] }");
  if (list.length > MAX_COMMENTS) {
    throw new InputError(`${list.length} comments supplied; the limit is ${MAX_COMMENTS}`);
  }
  return list.map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const body = text(entry.body);
    if (body === null || body.trim().length === 0)
      throw new InputError(`comments[${index}].body must be a non-empty string`);
    const user = (entry.user ?? {}) as Record<string, unknown>;
    const author = text(entry.author) ?? text(user.login);
    const botType = text(entry.author_type) ?? text(entry.authorType) ?? text(user.type);
    const authorKind =
      botType === "Bot" || /\[bot\]$|bot$/i.test(author ?? "")
        ? "bot"
        : author || botType
          ? "human"
          : "unknown";
    const sourceId = entry.id === undefined || entry.id === null ? null : String(entry.id).slice(0, 100);
    const path = text(entry.path);
    const line =
      positiveInt(entry.line) ?? positiveInt(entry.original_line) ?? positiveInt(entry.originalLine);
    const replyTo = entry.in_reply_to_id ?? entry.inReplyTo;
    const truncated = body.length > MAX_COMMENT_BODY_CHARS;
    return {
      id: stableId("cm", { sourceId, body, path, line, index }, 10),
      sourceId,
      body: truncated ? body.slice(0, MAX_COMMENT_BODY_CHARS) : body,
      bodyTruncated: truncated,
      path: path && path.length <= 500 ? path.replace(/^\.\//, "") : null,
      line,
      startLine: positiveInt(entry.start_line) ?? positiveInt(entry.startLine),
      author: author ? author.slice(0, 100) : null,
      authorKind,
      inReplyTo: replyTo === undefined || replyTo === null ? null : String(replyTo),
      outdated: typeof entry.outdated === "boolean" ? entry.outdated : entry.position === null ? true : null,
    };
  });
}
