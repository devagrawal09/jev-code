/**
 * Pure release checks used by scripts/release.ts and the release workflow. Every function returns a list of
 * human-readable problems; an empty list means the check passed. No I/O happens here so the rules are testable.
 */

export const PACKAGE_NAME = "jev-code";
export const REPOSITORY = "devagrawal09/jev-code";
export const RELEASE_BRANCH = "main";
export const NPM_REGISTRY = "https://registry.npmjs.org/";
/** Minimum npm CLI that can publish through npm trusted publishing (OIDC). */
export const MIN_TRUSTED_PUBLISHING_NPM = "11.5.1";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const SHA = /^[0-9a-f]{40}$/;

export interface PackageManifest {
  name?: unknown;
  version?: unknown;
  repository?: unknown;
}

export interface PackedFile {
  path: string;
  mode?: number;
}

export interface RegistryPackument {
  versions?: Record<string, unknown>;
  "dist-tags"?: Record<string, string>;
}

export interface CheckoutState {
  tag: string;
  head: string;
  tagCommit: string | null;
  /** GITHUB_SHA when running in Actions. */
  eventSha?: string;
  /** GITHUB_REF when running in Actions. */
  eventRef?: string;
  /** Output of `git status --porcelain --untracked-files=all`. */
  status: string;
  /** Whether HEAD is reachable from the release branch; undefined when not checked. */
  onReleaseBranch?: boolean;
  prerelease?: boolean;
}

/** Parses a stable X.Y.Z version. Pre-release and build metadata are rejected on purpose. */
export function parseVersion(version: string): [number, number, number] | null {
  const match = STABLE_VERSION.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Returns the version for a tag that is exactly `v` followed by a stable X.Y.Z version. */
export function versionFromTag(tag: string): string | null {
  return RELEASE_TAG.exec(tag)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`cannot compare non-X.Y.Z versions ${a} and ${b}`);
  for (let index = 0; index < 3; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * Returns `owner/repo` for a package.json repository whose url is an https github.com URL. Shorthands and
 * ssh URLs are rejected so the value npm compares against the provenance statement is unambiguous.
 */
export function githubRepository(repository: unknown): string | null {
  const url =
    typeof repository === "object" && repository !== null && "url" in repository
      ? (repository as { url: unknown }).url
      : repository;
  if (typeof url !== "string") return null;
  const match = /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** Package identity checks that do not depend on a tag. */
export function checkManifest(manifest: PackageManifest): string[] {
  const problems: string[] = [];
  if (manifest.name !== PACKAGE_NAME) {
    problems.push(
      `package.json name must be exactly "${PACKAGE_NAME}", found ${JSON.stringify(manifest.name)}`,
    );
  }
  if (typeof manifest.version !== "string" || !parseVersion(manifest.version)) {
    problems.push(
      `package.json version must be a stable X.Y.Z version, found ${JSON.stringify(manifest.version)}`,
    );
  }
  const repository = githubRepository(manifest.repository);
  if (repository !== REPOSITORY) {
    problems.push(
      `package.json repository must point at github.com/${REPOSITORY} (required for npm provenance), found ${JSON.stringify(manifest.repository)}`,
    );
  }
  return problems;
}

/** The release tag must be exactly `v` + package.json version. */
export function checkTag(tag: string, manifest: PackageManifest): string[] {
  const problems = checkManifest(manifest);
  const tagVersion = versionFromTag(tag);
  if (!tagVersion) {
    problems.push(`release tag must be v followed by a stable X.Y.Z version, found ${JSON.stringify(tag)}`);
  } else if (tag !== `v${String(manifest.version)}`) {
    problems.push(`release tag ${tag} does not match package.json version ${String(manifest.version)}`);
  }
  return problems;
}

/** The files being built and packed must come from the release tag, unmodified. */
export function checkCheckout(state: CheckoutState): string[] {
  const problems: string[] = [];
  if (!SHA.test(state.head)) {
    problems.push(`could not resolve HEAD to a commit, found ${JSON.stringify(state.head)}`);
  }
  if (state.tagCommit === null) {
    problems.push(`tag ${state.tag} does not exist in the checkout`);
  } else if (state.tagCommit !== state.head) {
    problems.push(`HEAD ${state.head} is not the commit of tag ${state.tag} (${state.tagCommit})`);
  }
  if (state.eventSha !== undefined && state.eventSha !== state.head) {
    problems.push(`HEAD ${state.head} does not match the workflow event commit ${state.eventSha}`);
  }
  if (state.eventRef !== undefined && state.eventRef !== `refs/tags/${state.tag}`) {
    problems.push(`workflow ref ${state.eventRef} is not refs/tags/${state.tag}`);
  }
  if (state.status.trim() !== "") {
    const lines = state.status.trimEnd().split("\n");
    const shown = lines.slice(0, 20).join("\n");
    const more = lines.length > 20 ? `\n... and ${lines.length - 20} more` : "";
    problems.push(`working tree is not clean:\n${shown}${more}`);
  }
  if (state.onReleaseBranch === false) {
    problems.push(`tag ${state.tag} is not reachable from ${RELEASE_BRANCH}; release only merged commits`);
  }
  if (state.prerelease === true) {
    problems.push("the GitHub Release is marked as a pre-release; stable X.Y.Z tags publish to latest");
  }
  return problems;
}

/**
 * The tarball may contain only package.json, README.md, LICENSE and the compiled output of src/. Every src
 * module must be present as .js and .d.ts, and the CLI entry must be executable.
 */
export function checkPackedFiles(files: readonly PackedFile[], sourceModules: readonly string[]): string[] {
  const problems: string[] = [];
  const expected = new Set(["package.json", "README.md", "LICENSE"]);
  for (const module of sourceModules) {
    if (!module.endsWith(".ts") || module.endsWith(".d.ts")) {
      problems.push(`unexpected source module name ${module}`);
      continue;
    }
    const stem = module.slice(0, -".ts".length);
    expected.add(`dist/${stem}.js`);
    expected.add(`dist/${stem}.d.ts`);
  }
  const packed = new Map(files.map((file) => [file.path, file]));
  for (const path of [...packed.keys()].sort()) {
    if (!expected.has(path)) problems.push(`unexpected file in package: ${path}`);
  }
  for (const path of [...expected].sort()) {
    if (!packed.has(path)) problems.push(`missing file in package: ${path}`);
  }
  const cli = packed.get("dist/cli.js");
  if (cli && (cli.mode === undefined || (cli.mode & 0o111) === 0)) {
    problems.push("dist/cli.js is not executable in the package");
  }
  return problems;
}

/**
 * Parses `tar -tvzf` output for an npm tarball. GNU tar and bsdtar both print ls-style permissions first and
 * the path last; npm package paths contain no whitespace. Directories and links are skipped.
 */
export function packedFilesFromTarListing(listing: string): PackedFile[] {
  return listing
    .split("\n")
    .filter((line) => line.startsWith("-"))
    .map((line) => ({
      path: line
        .trim()
        .split(/\s+/)
        .at(-1)!
        .replace(/^package\//, ""),
      mode: [...line.slice(1, 10)].reduce((mode, flag) => (mode << 1) | (flag === "-" ? 0 : 1), 0),
    }));
}

/** `packument` is null when the registry reports the package does not exist. */
export function checkRegistry(version: string, packument: RegistryPackument | null): string[] {
  if (!packument) return [];
  const problems: string[] = [];
  if (Object.hasOwn(packument.versions ?? {}, version)) {
    problems.push(`${PACKAGE_NAME}@${version} is already published on npm; bump the version`);
  }
  const latest = packument["dist-tags"]?.latest;
  if (latest !== undefined && parseVersion(latest) && compareVersions(version, latest) <= 0) {
    problems.push(`${version} is not greater than the current npm latest ${latest}`);
  }
  return problems;
}

export function checkNpmCli(npmVersion: string, registry: string): string[] {
  const problems: string[] = [];
  const version = npmVersion.trim();
  if (!parseVersion(version) || compareVersions(version, MIN_TRUSTED_PUBLISHING_NPM) < 0) {
    problems.push(
      `npm ${version} cannot use trusted publishing; npm >= ${MIN_TRUSTED_PUBLISHING_NPM} is required`,
    );
  }
  if (registry.trim() !== NPM_REGISTRY) {
    problems.push(`npm registry must be ${NPM_REGISTRY}, found ${registry.trim()}`);
  }
  return problems;
}
