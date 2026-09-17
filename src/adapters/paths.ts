import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isSecretPath } from "../workflows/classify.ts";
import { InputError } from "../workflows/errors.ts";

export const DEFAULT_INPUT_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Resolve a user-supplied path and require that it stays inside the workspace after
 * symlink resolution. Credential-shaped paths are refused outright.
 */
export async function resolveWorkspacePath(
  root: string,
  userPath: string,
): Promise<{ absolute: string; relative: string }> {
  if (userPath.length === 0 || userPath.includes("\0")) throw new InputError("path is empty or invalid");
  const realRoot = await realpath(root);
  const escapes = (rel: string) =>
    rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  const candidate = resolve(realRoot, userPath);
  // Check lexically first so nothing outside the workspace is even probed, then again after
  // resolving symlinks.
  if (escapes(relative(realRoot, candidate)) && escapes(relative(resolve(root), resolve(root, userPath)))) {
    throw new InputError(`path escapes the workspace: ${userPath}`);
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new InputError(`file not found inside workspace: ${userPath}`);
  }
  const rel = relative(realRoot, real);
  if (escapes(rel)) throw new InputError(`path escapes the workspace: ${userPath}`);
  const posix = rel.split(sep).join("/");
  if (isSecretPath(posix)) throw new InputError(`refusing to read a credential-shaped path: ${posix}`);
  return { absolute: real, relative: posix };
}

/** Read a workspace file with an explicit byte limit; oversize input is an error, never truncated. */
export async function readWorkspaceFile(
  root: string,
  userPath: string,
  maxBytes = DEFAULT_INPUT_LIMIT_BYTES,
) {
  const { absolute, relative: rel } = await resolveWorkspacePath(root, userPath);
  const info = await stat(absolute);
  if (!info.isFile()) throw new InputError(`not a regular file: ${rel}`);
  if (info.size > maxBytes)
    throw new InputError(`${rel} is ${info.size} bytes; the limit is ${maxBytes} bytes`);
  const handle = await open(absolute, "r");
  try {
    const text = (await handle.readFile()).toString("utf8");
    return { path: rel, text, bytes: info.size };
  } finally {
    await handle.close();
  }
}

export async function readStdin(
  stream: NodeJS.ReadableStream,
  maxBytes = DEFAULT_INPUT_LIMIT_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > maxBytes) throw new InputError(`stdin exceeds the ${maxBytes} byte limit`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a line range from a tracked workspace file. Lines are 1-based and inclusive. */
export async function readLines(
  root: string,
  path: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<{ lines: string[]; bytes: number } | null> {
  try {
    const file = await readWorkspaceFile(root, path, maxBytes);
    if (file.text.includes("\0")) return null;
    const lines = file.text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return { lines, bytes: file.bytes };
  } catch {
    return null;
  }
}
