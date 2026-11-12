import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readBoundedRegularFile } from "./bounded-file.js";
import {
  isIgnoredPath,
  mayContainReincludedPath,
  readIgnoreRulesFile,
  type IgnoreRule
} from "./ignore-rules.js";

export interface IndexedFile {
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
  language: string;
}

export interface ProjectScan {
  root: string;
  scannedAt: string;
  files: IndexedFile[];
  skipped: { ignored: number; secret: number; binaryOrUnsupported: number; oversized: number };
  languages: Record<string, number>;
  package: { name?: string; packageManager?: string; scripts: string[]; dependencies: string[]; frameworks: string[] } | null;
}

const DEFAULT_IGNORES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt",
  ".turbo", ".cache", "vendor", "out", "target"
]);
const SECRET_NAME = /(^|\/)(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$|credentials?\.|secrets?\.)/i;
const ALLOWED = new Map<string, string>([
  [".ts", "TypeScript"], [".tsx", "TypeScript"], [".js", "JavaScript"], [".jsx", "JavaScript"],
  [".mjs", "JavaScript"], [".cjs", "JavaScript"], [".py", "Python"], [".go", "Go"],
  [".rs", "Rust"], [".java", "Java"], [".kt", "Kotlin"], [".cs", "C#"],
  [".cpp", "C++"], [".c", "C"], [".h", "C/C++"], [".hpp", "C++"],
  [".html", "HTML"], [".css", "CSS"], [".scss", "SCSS"], [".json", "JSON"],
  [".md", "Markdown"], [".yml", "YAML"], [".yaml", "YAML"], [".toml", "TOML"],
  [".sql", "SQL"], [".sh", "Shell"], [".ps1", "PowerShell"], [".vue", "Vue"],
  [".svelte", "Svelte"], [".php", "PHP"], [".rb", "Ruby"], [".swift", "Swift"]
]);
const MAX_FILES = 10_000;
const MAX_DIRECTORIES = 50_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_PACKAGE_BYTES = 256_000;
const MAX_DEPTH = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

async function readPackage(root: string): Promise<ProjectScan["package"]> {
  const file = await readBoundedRegularFile(path.join(root, "package.json"), MAX_PACKAGE_BYTES);
  if (!file || file.bytes.includes(0)) return null;
  try {
    const data: unknown = JSON.parse(file.bytes.toString("utf8"));
    if (!isRecord(data)) return null;
    const dependencies = {
      ...(isRecord(data.dependencies) ? data.dependencies : {}),
      ...(isRecord(data.devDependencies) ? data.devDependencies : {}),
      ...(isRecord(data.peerDependencies) ? data.peerDependencies : {})
    };
    const frameworks = ["react", "next", "vue", "svelte", "express", "electron", "vite", "angular"]
      .filter((name) => Object.hasOwn(dependencies, name));
    return {
      ...(typeof data.name === "string" && data.name.length <= 214 ? { name: data.name } : {}),
      ...(typeof data.packageManager === "string" && data.packageManager.length <= 120 ? { packageManager: data.packageManager } : {}),
      scripts: stringKeys(data.scripts),
      dependencies: Object.keys(dependencies).sort(),
      frameworks
    };
  } catch {
    return null;
  }
}

async function rulesForDirectory(directory: string, relativeDirectory: string, inherited: IgnoreRule[]): Promise<IgnoreRule[]> {
  const localRules = await readIgnoreRulesFile(path.join(directory, ".gitignore"), relativeDirectory);
  return localRules.length ? [...inherited, ...localRules] : inherited;
}

function containsDefaultIgnore(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => DEFAULT_IGNORES.has(segment));
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readIndexedFile(root: string, absolute: string): Promise<{ bytes: Buffer; modifiedAt: string } | null> {
  try {
    const resolved = await fs.realpath(absolute);
    if (!isInsideRoot(root, resolved)) return null;
    const file = await readBoundedRegularFile(resolved, MAX_FILE_BYTES);
    if (!file || file.bytes.includes(0)) return null;
    return { bytes: file.bytes, modifiedAt: file.stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Indexes bounded metadata only; never returns secret files, binary data, or file contents. */
export async function scanProject(inputPath: string): Promise<ProjectScan> {
  const root = await fs.realpath(inputPath);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error("Project path must be a directory");
  const files: IndexedFile[] = [];
  const skipped = { ignored: 0, secret: 0, binaryOrUnsupported: 0, oversized: 0 };
  let visitedDirectories = 0;

  const visit = async (directory: string, relativeDirectory: string, depth: number, inherited: IgnoreRule[]): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES || visitedDirectories >= MAX_DIRECTORIES) return;
    visitedDirectories++;
    const rules = await rulesForDirectory(directory, relativeDirectory, inherited);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES || visitedDirectories >= MAX_DIRECTORIES) break;
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { skipped.ignored++; continue; }
      if (entry.isDirectory()) {
        if (containsDefaultIgnore(relative)) { skipped.ignored++; continue; }
        if (isIgnoredPath(relative, true, rules)) {
          skipped.ignored++;
          if (!mayContainReincludedPath(relative, rules)) continue;
        }
        await visit(absolute, relative, depth + 1, rules);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SECRET_NAME.test(relative)) { skipped.secret++; continue; }
      if (isIgnoredPath(relative, false, rules)) { skipped.ignored++; continue; }
      const language = ALLOWED.get(path.extname(entry.name).toLowerCase());
      if (!language) { skipped.binaryOrUnsupported++; continue; }
      const file = await readIndexedFile(root, absolute);
      if (!file) {
        const stat = await fs.lstat(absolute).catch(() => null);
        if (stat && stat.size > MAX_FILE_BYTES) skipped.oversized++;
        else skipped.ignored++;
        continue;
      }
      files.push({
        path: relative,
        size: file.bytes.length,
        modifiedAt: file.modifiedAt,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        language
      });
    }
  };

  await visit(root, "", 0, []);
  const languages: Record<string, number> = {};
  for (const file of files) languages[file.language] = (languages[file.language] ?? 0) + 1;
  return { root, scannedAt: new Date().toISOString(), files, skipped, languages, package: await readPackage(root) };
}
