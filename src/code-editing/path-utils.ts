import path from "node:path";

const SECRET_PATH = /(^|\/)(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$|credentials?\.|secrets?\.)/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function normalizeEditPath(input: string): string {
  const normalized = input.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) ||
      segments.some((segment) => !segment || segment === "." || segment === ".." ||
        /[<>:"|?*\u0000-\u001f]/.test(segment) || segment.endsWith(".") || segment.endsWith(" ") ||
        WINDOWS_RESERVED.test(segment))) {
    throw new Error("File path must be a valid project-relative path");
  }
  if (SECRET_PATH.test(normalized)) throw new Error("Secret and credential files cannot be edited");
  return normalized;
}

export function resolveProjectPath(root: string, relativePath: string): string {
  const normalized = normalizeEditPath(relativePath);
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("File path is outside the project");
  }
  return absolute;
}

export function isSecretEditPath(relativePath: string): boolean {
  return SECRET_PATH.test(relativePath.replaceAll("\\", "/"));
}
