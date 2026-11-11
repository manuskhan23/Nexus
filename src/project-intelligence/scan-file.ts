import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { IndexedFile } from "./scanner.js";

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
const DEFAULT_IGNORES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".turbo", ".cache", "vendor", "out", "target"]);
const MAX_FILE_BYTES = 1_000_000;

function ignored(relativePath: string, rules: string[]): boolean {
  const normalized = relativePath.replaceAll(path.sep, "/");
  if (normalized.split("/").some((part) => DEFAULT_IGNORES.has(part))) return true;
  return rules.some((rule) => {
    const value = rule.trim().replace(/^\//, "").replace(/\/$/, "");
    if (!value || value.startsWith("#") || value.startsWith("!")) return false;
    return normalized === value || normalized.startsWith(value + "/") ||
      normalized.split("/").some((part) => part === value);
  });
}

/** Returns null for deleted, ignored, secret, binary, or unsupported paths. */
export async function scanProjectFile(projectRoot: string, relativePath: string): Promise<IndexedFile | null> {
  const root = await realpath(projectRoot);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const normalized = relative.replaceAll(path.sep, "/");
  if (SECRET_NAME.test(normalized)) return null;

  let rules: string[] = [];
  try {
    rules = (await readFile(path.join(root, ".gitignore"), "utf8"))
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch { /* optional ignore file */ }
  if (ignored(relative, rules)) return null;

  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
    const language = LANGUAGES[path.extname(absolute).toLowerCase()];
    if (!language) return null;
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) return null;
    return {
      path: normalized,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      language
    };
  } catch {
    return null;
  }
}
