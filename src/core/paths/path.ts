import { homedir } from "node:os";
import { posix, win32 } from "node:path";

function usesWindowsPath(paths: string[]): boolean {
  const backslash = String.fromCharCode(92);
  return paths.some((path) => {
    const drivePath =
      path.length >= 3 &&
      path[1] === ":" &&
      (path[2] === "/" || path[2] === backslash);
    const uncPath =
      path.length >= 2 && path[0] === backslash && path[1] === backslash;
    return drivePath || uncPath;
  });
}

function pathApi(...paths: string[]) {
  return usesWindowsPath(paths) ? win32 : posix;
}

/**
 * A path grant with an explicit kind.
 *
 * `file` matches the exact path only. `directory` matches the directory itself
 * and any descendant (boundary/prefix match).
 *
 * This replaces the previous trailing-slash convention on a flat `string[]`,
 * where the kind was inferred from whether a path ended in `/`.
 */
export type AllowedPath =
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string };

/**
 * Expand a leading tilde to the current user's home directory.
 * Preserves all other paths unchanged.
 */
export function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\"))
    return `${homedir()}/${input.slice(2).replaceAll(String.fromCharCode(92), "/")}`;
  return input;
}

export function resolveFromCwd(input: string, cwd: string): string {
  const expanded = expandHomePath(input);
  if (input === "~" || input.startsWith("~/") || input.startsWith("~\\"))
    return expanded;
  const resolved = pathApi(cwd, expanded).resolve(cwd, expanded);
  if (
    usesWindowsPath([cwd, input]) &&
    input.includes("/") &&
    !input.includes(String.fromCharCode(92))
  ) {
    return resolved.replaceAll(String.fromCharCode(92), "/");
  }
  return resolved;
}

/**
 * Lexical boundary check. Returns true if targetAbsPath equals rootAbsPath
 * or is a descendant. Both paths must already be resolved (absolute, no ..).
 * Does NOT resolve symlinks — this is a known limitation.
 */
export function isWithinBoundary(
  targetAbsPath: string,
  rootAbsPath: string,
): boolean {
  const api = pathApi(targetAbsPath, rootAbsPath);
  const rel = api.relative(rootAbsPath, targetAbsPath);
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel));
}

/**
 * Format an absolute path for display:
 * - relative if inside cwd
 * - ~/... if under home
 * - absolute otherwise
 */
export function normalizeForDisplay(absPath: string, cwd: string): string {
  const home = homedir();
  const api = pathApi(cwd, absPath);
  const rel = api.relative(cwd, absPath);
  if (rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel)))
    return (rel || ".").replaceAll(String.fromCharCode(92), "/");

  const homeRelative = api.relative(home, absPath);
  if (
    homeRelative === "" ||
    (!homeRelative.startsWith("..") && !api.isAbsolute(homeRelative))
  ) {
    return homeRelative
      ? `~/${homeRelative.replaceAll(String.fromCharCode(92), "/")}`
      : "~";
  }
  return absPath;
}

/**
 * Convert an absolute path to storage form for config persistence.
 *
 * Uses `~/` for home paths, absolute otherwise, and normalizes separators to
 * forward slash. The kind (file vs directory) is carried explicitly on the
 * returned `AllowedPath` instead of via a trailing slash.
 */
export function toStorageGrant(
  absPath: string,
  isDirectory: boolean,
): AllowedPath {
  return {
    kind: isDirectory ? "directory" : "file",
    path: toStoragePath(absPath),
  };
}

/**
 * Normalize an absolute path for storage: expand home to `~/`, collapse
 * backslashes to forward slashes, and strip any trailing slash (the kind now
 * lives on `AllowedPath`, not on the path string).
 */
function toStoragePath(absPath: string): string {
  const home = homedir();
  let stored: string;
  if (
    absPath === home ||
    absPath.startsWith(`${home}/`) ||
    absPath.startsWith(`${home}\\`)
  ) {
    stored = `~${absPath.slice(home.length)}`;
  } else {
    stored = absPath;
  }
  stored = stored.replace(/\\/g, "/");
  stored = stored.replace(/\/+$/, "");
  return stored;
}

/**
 * Heuristic: is this token likely a filesystem path?
 *
 * Checks for structural path signals: separators (/ \), drive letters
 * (C:\), home prefix (~), and relative path prefixes (./ ../).
 *
 * False positives (MIME types, version strings, domains) are safe —
 * they just get checked against policies and miss.
 *
 * Known false negatives: bare filenames without separators or dots
 * (Makefile, LICENSE, README). These are cwd-relative and would
 * pass the boundary check anyway.
 */
export function maybePathLike(token: string): boolean {
  if (!token) return false;

  if (token.includes("/")) return true;
  if (token.includes("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (/^(?:~|\.{1,2})[\\/]/.test(token)) return true;
  return false;
}
