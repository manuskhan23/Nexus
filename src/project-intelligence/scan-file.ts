import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { IndexedFile } from "./scanner.js";
import { isIgnoredPath, parseIgnoreRules, type IgnoreRule } from "./ignore-rules.js";

const SECRET_NAME = /(^|\/)(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$|credentials?\.|secrets?\.)/i;
const LANGUAGES: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go", ".rs": "Rust",
  ".java": "Java", ".kt": "Kotlin", ".cs": "C#", ".cpp": "C++", ".c": "C", ".h": "C/C++",
  ".hpp": "C++", ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".json": "JSON",
  ".md": "Markdown", ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML", ".sql": "SQL",
  ".sh": "Shell", ".ps1": "PowerShell", ".vue": "Vue", ".svelte": "Svelte", ".php": "PHP",
  ".rb": "Ruby", ".swift": "Swift"
};
const DEFAULT_IGNORES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt",
  ".turbo", ".cache", "vendor", "out", "target"
]);
const MAX_FILE_BYTES = 1_000_000;

async function getRules(root: string, relativePath: string): Promise<IgnoreRule[]> {
  const segments = relativePath.split("/").slice(0, -1);
  const rules: IgnoreRule[] = [];
  let directory = root;
  try {
    rules.push(...parseIgnoreRules(await readFile(path.join(root, ".gitignore"), "utf8"), ""));
  } catch { /* optional root ignore file */ }
  let relativeDirectory = "";
  for (const segment of segments) {
    directory = path.join(directory, segment);
    relativeDirectory = relativeDirectory ? `${relativeDirectory}/${segment}` : segment;
    try {
      rules.push(...parseIgnoreRules(await readFile(path.join(directory, ".gitignore"), "utf8"), relativeDirectory));
    } catch { /* optional nested ignore file */ }
  }
  return rules;
}

/** Reject symlinks in every component, matching the full scanner's no-symlink policy. */
async function hasSafeRegularFilePath(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
      if (index < segments.length - 1 && !info.isDirectory()) return false;
      if (index === segments.length - 1 && !info.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Returns null for deleted, ignored, secret, binary, unsupported, or unsafe paths. */
export async function scanProjectFile(projectRoot: string, relativePath: string): Promise<IndexedFile | null> {
  const root = await realpath(projectRoot);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const normalized = relative.replaceAll(path.sep, "/");
  if (normalized.split("/").some((part) => DEFAULT_IGNORES.has(part)) || SECRET_NAME.test(normalized)) return null;

  // Check path components before reading nested ignore files; a symlinked parent must not
  // cause an incremental scan to read metadata from outside the registered project.
  if (!await hasSafeRegularFilePath(root, normalized)) return null;
  const resolved = await realpath(absolute);
  const resolvedRelative = path.relative(root, resolved);
  if (!resolvedRelative || resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) return null;

  const rules = await getRules(root, normalized);
  if (isIgnoredPath(normalized, false, rules)) return null;

  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const language = LANGUAGES[path.extname(absolute).toLowerCase()];
    if (!language) return null;
    const bytes = await readFile(resolved);
    if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return null;
    return {
      path: normalized,
      size: bytes.length,
      modifiedAt: info.mtime.toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      language
    };
  } catch {
    return null;
  }
}
