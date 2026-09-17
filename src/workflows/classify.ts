const basename = (path: string) => path.replaceAll("\\", "/").split("/").at(-1) ?? path;
const extname = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot);
};

export type PathKind =
  | "source"
  | "test"
  | "documentation"
  | "config"
  | "ci"
  | "lockfile"
  | "generated"
  | "vendored"
  | "secret"
  | "binary"
  | "other";

const LANGUAGES: Record<string, string> = {
  ".c": "C",
  ".cc": "C++",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".dart": "Dart",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".go": "Go",
  ".graphql": "GraphQL",
  ".h": "C header",
  ".hpp": "C++ header",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".cjs": "JavaScript",
  ".mjs": "JavaScript",
  ".json": "JSON",
  ".jsx": "JavaScript JSX",
  ".kt": "Kotlin",
  ".lua": "Lua",
  ".md": "Markdown",
  ".mdx": "MDX",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".scala": "Scala",
  ".scss": "SCSS",
  ".sh": "Shell",
  ".sql": "SQL",
  ".svelte": "Svelte",
  ".swift": "Swift",
  ".toml": "TOML",
  ".ts": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".tsx": "TypeScript JSX",
  ".txt": "Text",
  ".vue": "Vue",
  ".xml": "XML",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".zig": "Zig",
};

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".jar",
  ".class",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".mov",
  ".bin",
  ".sqlite",
  ".db",
]);
const VENDOR_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "third-party",
  ".venv",
  "venv",
  "pods",
]);
const GENERATED_SEGMENTS = new Set([
  "dist",
  "build",
  "coverage",
  "generated",
  "__generated__",
  ".next",
  "out",
  "target",
]);
const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|Pipfile\.lock)$/;
const GENERATED_NAME =
  /(?:\.min\.(?:js|css)|\.generated\.|\.g\.(?:cs|go|ts)|_generated\.|\.pb\.go|_pb2\.py|\.snap$)/i;

export function isSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (name === ".env" || (name.startsWith(".env.") && !/\.(?:example|sample|template)$/.test(name)))
    return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name) && !name.endsWith(".pub")) return true;
  if (/\.(?:pem|p12|pfx|key|jks|keystore|kdbx)$/.test(name)) return true;
  if (/^(?:\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))$/.test(name))
    return true;
  return lower
    .split("/")
    .some((segment) => segment === ".ssh" || segment === ".aws" || segment === "secrets");
}

export function classifyPath(path: string): PathKind {
  const lower = path.toLowerCase();
  const name = basename(lower);
  const segments = lower.split("/");
  if (isSecretPath(path)) return "secret";
  if (BINARY_EXTENSIONS.has(extname(name))) return "binary";
  if (segments.some((segment) => VENDOR_SEGMENTS.has(segment))) return "vendored";
  if (LOCKFILE.test(path)) return "lockfile";
  if (segments.slice(0, -1).some((segment) => GENERATED_SEGMENTS.has(segment)) || GENERATED_NAME.test(path)) {
    return "generated";
  }
  if (
    /(?:^|\/)(?:test|tests|spec|specs|__tests__|__mocks__)(?:\/|$)/.test(lower) ||
    /[._-](?:test|spec)\.[a-z0-9]+$/.test(name) ||
    /^test_.*\.py$/.test(name) ||
    /_test\.(?:go|py)$/.test(name)
  ) {
    return "test";
  }
  if (lower.startsWith(".github/") || lower.startsWith(".gitlab-ci") || lower.startsWith(".circleci/"))
    return "ci";
  if (/\.(?:md|mdx|rst|adoc|txt)$/.test(name) || segments[0] === "docs") return "documentation";
  if (
    /\.(?:ya?ml|toml|ini|cfg|conf)$/.test(name) ||
    /^(?:package\.json|tsconfig.*\.json|dockerfile|makefile|\.gitignore|\.editorconfig|biome\.json|\.eslintrc.*|\.prettierrc.*)$/.test(
      name,
    )
  ) {
    return "config";
  }
  return LANGUAGES[extname(name)] ? "source" : "other";
}

export function languageForPath(path: string): string {
  const name = basename(path);
  if (/^dockerfile$/i.test(name)) return "Dockerfile";
  if (/^makefile$/i.test(name)) return "Make";
  return LANGUAGES[extname(name).toLowerCase()] ?? "unknown";
}

/** Kinds never sent to Jev as content. */
export function contentExclusionReason(kind: PathKind): string | null {
  switch (kind) {
    case "secret":
      return "credential-shaped path";
    case "binary":
      return "binary file";
    case "vendored":
      return "vendored dependency";
    default:
      return null;
  }
}

/** Minimal glob matcher supporting `**`, `*`, `?` and `{a,b}` over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const slash = glob[index + 2] === "/";
        pattern += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if (char === "{") {
      const end = glob.indexOf("}", index);
      if (end < 0) {
        pattern += "\\{";
        continue;
      }
      const options = glob.slice(index + 1, end).split(",");
      pattern += `(?:${options.map((option) => option.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
      index = end;
    } else {
      pattern += /[.+^$()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}
