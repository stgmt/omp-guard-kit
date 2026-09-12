import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const HOOK_MARKER = "OMP Guard Kit root check (managed)";

export type HookInstallStatus =
  | "installed"
  | "occupied"
  | "no-git"
  | "write-failed";

export interface HookInstallResult {
  status: HookInstallStatus;
  detail: string;
  manualSnippet?: string;
}

export type GitRun = (args: string[], cwd: string) => string;

export interface HookFs {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  write: (path: string, content: string) => void;
  makeExecutable: (path: string) => void;
  makeDir: (path: string) => void;
}

const nodeFs: HookFs = {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  write: (path, content) => writeFileSync(path, content, "utf8"),
  makeExecutable: (path) => {
    try {
      chmodSync(path, 0o755);
    } catch {
      // Best effort: Git for Windows runs hooks through sh regardless.
    }
  },
  makeDir: (path) => mkdirSync(path, { recursive: true }),
};

const defaultRun: GitRun = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

export function hookScript(distPath: string): string {
  const safe = distPath.replaceAll('"', '\\"');
  return `#!/bin/sh
# ${HOOK_MARKER} — safe to delete this file to uninstall.
if command -v node >/dev/null 2>&1 && [ -f "${safe}" ]; then
  node "${safe}" --staged || exit 1
fi
`;
}

export function manualSnippet(distPath: string): string {
  const safe = distPath.replaceAll('"', '\\"');
  return [
    "Add this to your pre-commit hook (or run it in CI):",
    `node "${safe}" --staged`,
    "# same check, once installed from npm: guard-kit-check-root --staged",
  ].join("\n");
}
/**
 * Installs the pre-commit gate. Never overwrites a foreign hook:
 * an occupied slot returns `occupied` with a manual snippet instead.
 */
export function installPreCommitHook(options: {
  cwd: string;
  distPath: string;
  run?: GitRun;
  fs?: HookFs;
}): HookInstallResult {
  const run = options.run ?? defaultRun;
  const fs = options.fs ?? nodeFs;

  let topLevel: string;
  try {
    topLevel = run(["rev-parse", "--show-toplevel"], options.cwd).trim();
  } catch {
    return { status: "no-git", detail: "not a git repository" };
  }
  let configuredHooksPath = "";
  try {
    configuredHooksPath = run(["config", "core.hooksPath"], options.cwd).trim();
  } catch {
    configuredHooksPath = "";
  }
  let hooksDir: string;
  if (configuredHooksPath) {
    const resolved = isAbsolute(configuredHooksPath)
      ? configuredHooksPath
      : resolve(topLevel, configuredHooksPath);
    return {
      status: "occupied",
      detail: `core.hooksPath points at ${resolved}`,
      manualSnippet: manualSnippet(options.distPath),
    };
  }
  let gitDir = ".git";
  try {
    gitDir = run(["rev-parse", "--git-dir"], options.cwd).trim() || ".git";
  } catch {
    gitDir = ".git";
  }
  hooksDir = resolve(topLevel, gitDir, "hooks");

  const hookFile = join(hooksDir, "pre-commit");
  if (fs.exists(hookFile)) {
    let current = "";
    try {
      current = fs.read(hookFile);
    } catch {
      current = "";
    }
    if (!current.includes(HOOK_MARKER)) {
      return {
        status: "occupied",
        detail: `${hookFile} already exists and is not managed`,
        manualSnippet: manualSnippet(options.distPath),
      };
    }
  }
  try {
    fs.makeDir(hooksDir);
    fs.write(hookFile, hookScript(options.distPath));
    fs.makeExecutable(hookFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "write-failed",
      detail: message,
      manualSnippet: manualSnippet(options.distPath),
    };
  }
  return { status: "installed", detail: hookFile };
}
