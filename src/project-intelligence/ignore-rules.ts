import path from "node:path";

export interface IgnoreRule {
  /** Directory containing the .gitignore file, relative to the project root. */
  base: string;
  pattern: string;
  negate: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  hasSlash: boolean;
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

/** Parse one .gitignore file. Rules retain their directory scope and ordering. */
export function parseIgnoreRules(contents: string, base = ""): IgnoreRule[] {
  const normalizedBase = normalize(base);
  const rules: IgnoreRule[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, "");
    if (!line) continue;
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    else if (line.startsWith("#")) continue;

    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    if (!line) continue;
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;
    rules.push({
      base: normalizedBase,
      pattern: line,
      negate,
      directoryOnly,
      anchored,
      hasSlash: line.includes("/")
    });
  }
  return rules;
}

function globRegex(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index++;
        if (glob[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end < 0) source += "\\[";
      else {
        let group = glob.slice(index + 1, end);
        if (group.startsWith("!")) group = `^${group.slice(1)}`;
        source += `[${group.replaceAll("\\", "\\\\")}]`;
        index = end;
      }
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function isWithinBase(candidate: string, base: string): boolean {
  return !base || candidate === base || candidate.startsWith(`${base}/`);
}

function ruleMatches(rule: IgnoreRule, candidatePath: string, isDirectory: boolean): boolean {
  if (!isWithinBase(candidatePath, rule.base) || (rule.directoryOnly && !isDirectory)) return false;
  const localPath = rule.base ? candidatePath.slice(rule.base.length).replace(/^\//, "") : candidatePath;
  if (!localPath) return false;
  const matcher = globRegex(rule.pattern);
  if (rule.anchored || rule.hasSlash) {
    if (matcher.test(localPath)) return true;
    // A matched directory rule also applies to every descendant.
    if (!rule.directoryOnly) return false;
    const segments = localPath.split("/");
    return segments.slice(0, -1).some((_segment, index) => matcher.test(segments.slice(0, index + 1).join("/")));
  }
  return localPath.split("/").some((segment) => matcher.test(segment));
}

function ignoredAtPath(candidate: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, candidate, isDirectory)) ignored = !rule.negate;
  }
  return ignored;
}

/** Evaluate scoped .gitignore rules; a negation cannot re-include a child of an excluded parent. */
export function isIgnoredPath(relativePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  const candidate = normalize(relativePath);
  if (!candidate || candidate === ".." || candidate.startsWith("../") || path.posix.isAbsolute(candidate)) return true;
  const segments = candidate.split("/");
  for (let index = 1; index < segments.length; index++) {
    const parent = segments.slice(0, index).join("/");
    if (ignoredAtPath(parent, true, rules)) return true;
  }
  return ignoredAtPath(candidate, isDirectory, rules);
}

/** Whether a currently ignored directory may contain a path re-included by a scoped negation. */
export function mayContainReincludedPath(relativeDirectory: string, rules: IgnoreRule[]): boolean {
  const directory = normalize(relativeDirectory);
  return rules.some((rule) => {
    if (!rule.negate) return false;
    return !rule.base || directory === rule.base || directory.startsWith(`${rule.base}/`) || rule.base.startsWith(`${directory}/`);
  });
}
