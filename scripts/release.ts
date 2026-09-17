/**
 * Release verification used by .github/workflows/release.yml (see docs/RELEASING.md). Node built-ins only.
 *
 *   node scripts/release.ts manifest
 *   node scripts/release.ts source --tag v1.2.3 [--require-release-branch] [--prerelease true|false]
 *   node scripts/release.ts npm-cli
 *   node scripts/release.ts registry
 *   node scripts/release.ts pack (--dry-run | --out <dir>)
 *   node scripts/release.ts tarball --tag v1.2.3 --file <path.tgz> --sha256 <hex>
 *
 * Exits 1 with one message per problem when a check fails. In GitHub Actions, `pack --out` writes the tarball
 * path and sha256 to $GITHUB_OUTPUT.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  checkCheckout,
  checkManifest,
  checkNpmCli,
  checkPackedFiles,
  checkRegistry,
  checkTag,
  NPM_REGISTRY,
  PACKAGE_NAME,
  type PackageManifest,
  type PackedFile,
  packedFilesFromTarListing,
  RELEASE_BRANCH,
  type RegistryPackument,
} from "./release-checks.ts";

const root = resolve(import.meta.dirname, "..");
const inActions = process.env.GITHUB_ACTIONS === "true";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tag: { type: "string" },
    prerelease: { type: "string" },
    "require-release-branch": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string" },
    file: { type: "string" },
    sha256: { type: "string" },
  },
});

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function required(name: "tag" | "out" | "file" | "sha256"): string {
  const value = values[name];
  if (!value) finish([`--${name} is required`]);
  return value;
}

function finish(problems: string[], success?: string): never {
  for (const problem of problems) {
    if (inActions) console.log(`::error::${problem.replaceAll("%", "%25").replaceAll("\n", "%0A")}`);
    else console.error(`error: ${problem}`);
  }
  if (problems.length === 0 && success) console.log(success);
  process.exit(problems.length === 0 ? 0 : 1);
}

function readManifest(): PackageManifest {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest;
}

function sourceModules(): string[] {
  return readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path.endsWith(".ts"))
    .sort();
}

function gitCommit(ref: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isOnReleaseBranch(): boolean {
  const branch = `refs/remotes/origin/${RELEASE_BRANCH}`;
  if (!gitCommit(branch)) finish([`${branch} is not available; check out with full history`]);
  const result = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", branch], { cwd: root });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  finish([`git merge-base failed with status ${result.status}`]);
}

async function fetchPackument(): Promise<RegistryPackument | null> {
  const response = await fetch(new URL(PACKAGE_NAME, NPM_REGISTRY), {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry responded ${response.status} for ${PACKAGE_NAME}`);
  return (await response.json()) as RegistryPackument;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const command = positionals[0];
switch (command) {
  case "manifest": {
    const manifest = readManifest();
    finish(checkManifest(manifest), `ok: ${PACKAGE_NAME}@${String(manifest.version)} manifest`);
    break;
  }
  case "source": {
    const tag = required("tag");
    const manifest = readManifest();
    const problems = checkTag(tag, manifest);
    if (values.prerelease !== undefined && values.prerelease !== "true" && values.prerelease !== "false") {
      problems.push(`--prerelease must be true or false, found ${values.prerelease}`);
    }
    problems.push(
      ...checkCheckout({
        tag,
        head: gitCommit("HEAD") ?? "",
        tagCommit: gitCommit(`refs/tags/${tag}`),
        eventSha: inActions ? process.env.GITHUB_SHA : undefined,
        eventRef: inActions ? process.env.GITHUB_REF : undefined,
        status: run("git", ["status", "--porcelain", "--untracked-files=all"]),
        onReleaseBranch: values["require-release-branch"] ? isOnReleaseBranch() : undefined,
        prerelease: values.prerelease === "true",
      }),
    );
    finish(problems, `ok: ${tag} matches ${PACKAGE_NAME}@${String(manifest.version)} and a clean checkout`);
    break;
  }
  case "npm-cli": {
    const npmVersion = run("npm", ["--version"]);
    const registry = run("npm", ["config", "get", "registry"]);
    finish(checkNpmCli(npmVersion, registry), `ok: npm ${npmVersion.trim()} using ${registry.trim()}`);
    break;
  }
  case "registry": {
    const manifest = readManifest();
    const problems = checkManifest(manifest);
    if (problems.length > 0) finish(problems);
    const version = String(manifest.version);
    const packument = await fetchPackument();
    finish(
      checkRegistry(version, packument),
      `ok: ${PACKAGE_NAME}@${version} is not on npm (latest: ${packument?.["dist-tags"]?.latest ?? "none"})`,
    );
    break;
  }
  case "pack": {
    const dryRun = values["dry-run"];
    if (dryRun === (values.out !== undefined)) finish(["pack needs exactly one of --dry-run or --out <dir>"]);
    const args = ["pack", "--json", "--ignore-scripts"];
    if (dryRun) args.push("--dry-run");
    else args.push("--pack-destination", resolve(required("out")));
    const [result] = JSON.parse(run("npm", args)) as Array<{ filename: string; files: PackedFile[] }>;
    if (!result) finish(["npm pack produced no result"]);
    const problems = checkPackedFiles(result.files, sourceModules());
    const shebang = readFileSync(join(root, "dist/cli.js"), "utf8").startsWith("#!/usr/bin/env node\n");
    if (!shebang) problems.push("dist/cli.js must start with #!/usr/bin/env node");
    if (problems.length > 0) finish(problems);
    for (const file of result.files) console.log(`  ${file.path}`);
    if (!dryRun) {
      const tarball = resolve(required("out"), result.filename);
      const digest = sha256(tarball);
      console.log(`tarball: ${tarball}\nsha256: ${digest}`);
      if (inActions && process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${result.filename}\nsha256=${digest}\n`);
      }
    }
    finish([], `ok: ${result.files.length} packaged files match the allowlist`);
    break;
  }
  case "tarball": {
    const tag = required("tag");
    const file = resolve(required("file"));
    const expected = required("sha256");
    const actual = sha256(file);
    if (actual !== expected) finish([`tarball sha256 ${actual} does not match verified ${expected}`]);
    const packed = JSON.parse(run("tar", ["-xzOf", file, "package/package.json"])) as PackageManifest;
    const problems = checkTag(tag, packed);
    problems.push(
      ...checkPackedFiles(packedFilesFromTarListing(run("tar", ["-tvzf", file])), sourceModules()),
    );
    finish(problems, `ok: ${file} is the verified ${PACKAGE_NAME}@${String(packed.version)} tarball`);
    break;
  }
  default:
    finish([`unknown command ${JSON.stringify(command)}; see the usage at the top of scripts/release.ts`]);
}
