import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type CheckoutState,
  checkCheckout,
  checkManifest,
  checkNpmCli,
  checkPackedFiles,
  checkRegistry,
  checkTag,
  compareVersions,
  githubRepository,
  packedFilesFromTarListing,
  versionFromTag,
} from "../scripts/release-checks.ts";

const manifest = {
  name: "jev-code",
  version: "0.1.0",
  repository: { type: "git", url: "git+https://github.com/devagrawal09/jev-code.git" },
};

describe("release tag and manifest", () => {
  test("accepts only v followed by a stable X.Y.Z version", () => {
    assert.equal(versionFromTag("v0.1.0"), "0.1.0");
    assert.equal(versionFromTag("v10.20.30"), "10.20.30");
    for (const tag of [
      "0.1.0",
      "V0.1.0",
      "v0.1",
      "v0.1.0-rc.1",
      "v0.1.0+build",
      "v01.0.0",
      "v0.1.0 ",
      "refs/tags/v0.1.0",
    ]) {
      assert.equal(versionFromTag(tag), null, tag);
    }
  });

  test("tag must equal v + package.json version", () => {
    assert.deepEqual(checkTag("v0.1.0", manifest), []);
    assert.match(checkTag("v0.1.1", manifest).join("\n"), /does not match package.json version 0\.1\.0/);
    assert.match(checkTag("0.1.0", manifest).join("\n"), /must be v followed by/);
  });

  test("package name must be exactly jev-code", () => {
    for (const name of ["jev-code-cli", "@devagrawal09/jev-code", "Jev-Code", undefined]) {
      assert.match(checkManifest({ ...manifest, name }).join("\n"), /name must be exactly "jev-code"/);
    }
  });

  test("package version must be stable", () => {
    assert.match(checkTag("v0.1.0", { ...manifest, version: "0.1.0-beta.1" }).join("\n"), /stable X\.Y\.Z/);
  });

  test("repository must be the https GitHub URL npm provenance compares against", () => {
    assert.equal(githubRepository(manifest.repository), "devagrawal09/jev-code");
    assert.equal(githubRepository("https://github.com/devagrawal09/jev-code"), "devagrawal09/jev-code");
    assert.equal(githubRepository("git@github.com:devagrawal09/jev-code.git"), null);
    assert.equal(githubRepository("devagrawal09/jev-code"), null);
    assert.match(checkManifest({ ...manifest, repository: undefined }).join("\n"), /repository must point/);
    assert.match(
      checkManifest({ ...manifest, repository: "https://github.com/someone/jev-code" }).join("\n"),
      /repository must point/,
    );
  });
});

describe("release checkout", () => {
  const head = "a".repeat(40);
  const clean: CheckoutState = {
    tag: "v0.1.0",
    head,
    tagCommit: head,
    eventSha: head,
    eventRef: "refs/tags/v0.1.0",
    status: "",
    onReleaseBranch: true,
    prerelease: false,
  };

  test("passes for a clean checkout of the tag commit on the release branch", () => {
    assert.deepEqual(checkCheckout(clean), []);
  });

  test("rejects a checkout that did not come from the tag", () => {
    const messages = (state: Partial<CheckoutState>) => checkCheckout({ ...clean, ...state }).join("\n");
    assert.match(messages({ tagCommit: null }), /does not exist/);
    assert.match(messages({ tagCommit: "b".repeat(40) }), /is not the commit of tag/);
    assert.match(messages({ eventSha: "c".repeat(40) }), /workflow event commit/);
    assert.match(messages({ eventRef: "refs/heads/main" }), /is not refs\/tags\/v0\.1\.0/);
    assert.match(messages({ status: " M src/cli.ts\n" }), /not clean/);
    assert.match(messages({ onReleaseBranch: false }), /not reachable from main/);
    assert.match(messages({ prerelease: true }), /pre-release/);
    assert.match(messages({ head: "" }), /could not resolve HEAD/);
  });
});

describe("package contents", () => {
  const modules = ["cli.ts", "index.ts", "core/types.ts"];
  const good = [
    { path: "package.json", mode: 0o644 },
    { path: "README.md", mode: 0o644 },
    { path: "LICENSE", mode: 0o644 },
    { path: "dist/cli.js", mode: 0o755 },
    { path: "dist/cli.d.ts", mode: 0o644 },
    { path: "dist/index.js", mode: 0o644 },
    { path: "dist/index.d.ts", mode: 0o644 },
    { path: "dist/core/types.js", mode: 0o644 },
    { path: "dist/core/types.d.ts", mode: 0o644 },
  ];

  test("accepts exactly the compiled src modules plus package metadata", () => {
    assert.deepEqual(checkPackedFiles(good, modules), []);
  });

  test("rejects unexpected, missing and non-executable files", () => {
    const extra = checkPackedFiles(
      [
        ...good,
        { path: "src/cli.ts" },
        { path: "dist/cli.js.map" },
        { path: ".env" },
        { path: "dist/old.js" },
      ],
      modules,
    );
    assert.deepEqual(extra, [
      "unexpected file in package: .env",
      "unexpected file in package: dist/cli.js.map",
      "unexpected file in package: dist/old.js",
      "unexpected file in package: src/cli.ts",
    ]);
    const missing = checkPackedFiles(
      good.filter((file) => file.path !== "LICENSE" && file.path !== "dist/core/types.d.ts"),
      modules,
    );
    assert.deepEqual(missing, [
      "missing file in package: LICENSE",
      "missing file in package: dist/core/types.d.ts",
    ]);
    const notExecutable = good.map((file) => (file.path === "dist/cli.js" ? { ...file, mode: 0o644 } : file));
    assert.deepEqual(checkPackedFiles(notExecutable, modules), [
      "dist/cli.js is not executable in the package",
    ]);
  });

  test("reads paths and modes from GNU tar and bsdtar listings", () => {
    const gnu = [
      "-rwxr-xr-x 0/0           16056 1985-10-26 08:15 package/dist/cli.js",
      "-rw-r--r-- 0/0            1280 1985-10-26 08:15 package/package.json",
      "",
    ].join("\n");
    const bsd = [
      "-rwxr-xr-x  0 0      0       16056 Oct 26  1985 package/dist/cli.js",
      "drwxr-xr-x  0 0      0           0 Oct 26  1985 package/dist/",
      "-rw-r--r--  0 0      0        1280 Oct 26  1985 package/package.json",
    ].join("\n");
    const expected = [
      { path: "dist/cli.js", mode: 0o755 },
      { path: "package.json", mode: 0o644 },
    ];
    assert.deepEqual(packedFilesFromTarListing(gnu), expected);
    assert.deepEqual(packedFilesFromTarListing(bsd), expected);
  });
});

describe("npm registry and CLI", () => {
  test("rejects versions already published or not newer than latest", () => {
    assert.deepEqual(checkRegistry("0.1.0", null), []);
    const packument = { versions: { "0.0.1": {} }, "dist-tags": { latest: "0.0.1" } };
    assert.deepEqual(checkRegistry("0.1.0", packument), []);
    assert.match(checkRegistry("0.0.1", packument).join("\n"), /already published/);
    assert.match(
      checkRegistry("0.0.9", { versions: { "0.1.0": {} }, "dist-tags": { latest: "0.1.0" } }).join("\n"),
      /not greater than the current npm latest 0\.1\.0/,
    );
  });

  test("compares versions numerically", () => {
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.2.3", "1.10.0"), -1);
  });

  test("requires an npm CLI that supports trusted publishing against the public registry", () => {
    assert.deepEqual(checkNpmCli("11.5.1\n", "https://registry.npmjs.org/\n"), []);
    assert.deepEqual(checkNpmCli("11.16.0", "https://registry.npmjs.org/"), []);
    assert.match(checkNpmCli("11.5.0", "https://registry.npmjs.org/").join("\n"), />= 11\.5\.1/);
    assert.match(checkNpmCli("10.9.3", "https://registry.npmjs.org/").join("\n"), />= 11\.5\.1/);
    assert.match(checkNpmCli("11.16.0", "https://npm.example.com/").join("\n"), /registry must be/);
  });
});
