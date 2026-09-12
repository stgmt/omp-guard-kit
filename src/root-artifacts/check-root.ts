#!/usr/bin/env node
/**
 * guard-kit-check-root: standalone commit-gate for root artifacts.
 *
 * Agent-runtime hooks only see tool calls; this is the surface that gates
 * commits. Reads the project-local guardrails file, evaluates staged root
 * entries against the same policy as the extension, and fails closed.
 * Unconfigured projects pass silently so the hook never breaks strangers.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRootArtifactPolicy,
  evaluateRootArtifactTarget,
  type RootArtifactPolicy,
} from "./policy";

export interface StagedVerdict {
  path: string;
  reason: string;
}

export interface CheckRootResult {
  root: string;
  configured: boolean;
  blocked: StagedVerdict[];
  warnings: StagedVerdict[];
}

type ReadFile = (path: string) => Promise<string>;

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

type RawConfig = {
  enabled?: unknown;
  features?: Record<string, unknown>;
  rootArtifacts?: Record<string, unknown>;
};

/** Legacy string booleans ("enabled"/"disabled") predate boolean flags. */
function normalizeFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  return undefined;
}

function parseRawConfig(text: string): RawConfig | "malformed" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "malformed";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "malformed";
  }
  return parsed as RawConfig;
}

/**
 * Effective policy mirror of the extension gate: the project opts in
 * locally, global files supply defaults, absent features default off.
 */
export function buildPolicy(
  local: RawConfig | null,
  global: RawConfig | null,
): RootArtifactPolicy | null {
  if (!local || normalizeFlag(local.rootArtifacts?.enabled) !== true) {
    return null;
  }
  const feature =
    normalizeFlag(local.features?.rootArtifacts) ??
    normalizeFlag(global?.features?.rootArtifacts) ??
    false;
  if (!feature || normalizeFlag(local.enabled) === false) return null;
  const mode: "extend" | "replace" =
    local.rootArtifacts?.mode === "replace" ||
    (local.rootArtifacts?.mode === undefined &&
      global?.rootArtifacts?.mode === "replace")
      ? "replace"
      : "extend";
  const pick = <
    K extends
      | "allow"
      | "deny"
      | "ignorePatterns"
      | "trashPatterns"
      | "configPatterns",
  >(
    key: K,
  ): string[] => {
    const fromLocal = local.rootArtifacts?.[key];
    const fromGlobal = global?.rootArtifacts?.[key];
    if (mode === "replace") {
      if (Array.isArray(fromLocal)) return unique(strings(fromLocal));
      return unique(strings(fromGlobal));
    }
    // extend: union local and global so a global allow never narrows.
    return unique([
      ...(Array.isArray(fromLocal) ? strings(fromLocal) : []),
      ...(Array.isArray(fromGlobal) ? strings(fromGlobal) : []),
    ]);
  };
  const localDirs = local.rootArtifacts?.allowedDirectories;
  const globalDirs = global?.rootArtifacts?.allowedDirectories;
  return createRootArtifactPolicy({
    enabled: true,
    mode,
    allow: pick("allow"),
    deny: pick("deny"),
    allowedDirectories:
      localDirs === undefined && globalDirs === undefined
        ? undefined
        : unique([
            ...(Array.isArray(localDirs) ? strings(localDirs) : []),
            ...(Array.isArray(globalDirs) ? strings(globalDirs) : []),
          ]),
    ignorePatterns: pick("ignorePatterns"),
    trashPatterns: pick("trashPatterns"),
    configPatterns: pick("configPatterns"),
    autoPrune: { enabled: false },
  });
}

export interface LoadedPolicy {
  policy: RootArtifactPolicy;
  source: string;
}

async function readRaw(
  path: string,
  read: ReadFile,
  malformed: string[],
): Promise<RawConfig | null> {
  let text: string;
  try {
    text = await read(path);
  } catch {
    return null;
  }
  const parsed = parseRawConfig(text);
  if (parsed === "malformed") {
    malformed.push(path);
    return null;
  }
  return parsed;
}

function globalCandidates(home: string): string[] {
  return [
    join(home, ".omp", "extensions", "guardrails.json"),
    join(home, ".pi", "extensions", "guardrails.json"),
  ];
}

function localCandidates(dir: string): string[] {
  return [
    join(dir, ".omp", "extensions", "guardrails.json"),
    join(dir, ".pi", "extensions", "guardrails.json"),
  ];
}

/**
 * Loads the effective policy, searching from the staged files' directories
 * up to the repo root (nearest marker wins, like the extension loader).
 * Throws on present-but-invalid config instead of silently disabling.
 */
export async function loadLocalPolicy(
  root: string,
  read: ReadFile = (path) => readFile(path, "utf8"),
  home: string = homedir(),
  startDirs: readonly string[] = [root],
): Promise<LoadedPolicy | null> {
  const malformed: string[] = [];
  let global: RawConfig | null = null;
  for (const candidate of globalCandidates(home)) {
    global = (await readRaw(candidate, read, malformed)) ?? global;
    if (global) break;
  }
  const ordered = [...new Set([root, ...startDirs])].sort(
    (a, b) => b.length - a.length,
  );
  const checked = new Set<string>();
  for (const start of ordered) {
    let dir = start.startsWith(root) ? start : root;
    while (true) {
      if (checked.has(dir)) {
        dir = root;
        break;
      }
      checked.add(dir);
      for (const candidate of localCandidates(dir)) {
        const local = await readRaw(candidate, read, malformed);
        if (local) {
          const policy = buildPolicy(local, global);
          if (policy) return { policy, source: candidate };
          // Config found but feature disabled — this marker shadows
          // parent configs for this subtree.  Stop walking up but let
          // other start dirs try their own nearest markers.
          break;
        }
      }
      if (dir === root) break;
      const parent = dirname(dir);
      if (parent.length >= dir.length) break;
      dir = parent;
    }
  }
  if (malformed.length > 0) {
    throw new Error(`invalid guardrails config: ${malformed.join(", ")}`);
  }
  return null;
}

function verdictOf(
  rawPath: string,
  kind: "file" | "directory",
  root: string,
  policy: RootArtifactPolicy,
): StagedVerdict | undefined {
  const decision = evaluateRootArtifactTarget({ rawPath, kind }, root, policy);
  if (decision.allowed) return undefined;
  return {
    path: decision.relativePath || rawPath,
    reason: decision.reason ?? decision.matchedRule,
  };
}

export function checkStaged(
  staged: readonly string[],
  root: string,
  policy: RootArtifactPolicy,
): StagedVerdict[] {
  const blocked: StagedVerdict[] = [];
  const seen = new Set<string>();
  for (const raw of staged) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const verdict = verdictOf(path, "file", root, policy);
    if (verdict) blocked.push(verdict);
  }
  return blocked.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { sensitivity: "base" }),
  );
}

export async function checkWorktree(
  root: string,
  policy: RootArtifactPolicy,
  list: (root: string) => Promise<string[]> = async (dir) =>
    (await readdir(dir, { withFileTypes: true })).map((entry) =>
      entry.isDirectory() ? `${entry.name}/` : entry.name,
    ),
): Promise<StagedVerdict[]> {
  const warnings: StagedVerdict[] = [];
  for (const name of await list(root)) {
    const verdict = verdictOf(
      name,
      name.endsWith("/") ? "directory" : "file",
      root,
      policy,
    );
    if (verdict) warnings.push(verdict);
  }
  return warnings;
}

export interface RunCheckOptions {
  root: string;
  staged: string[];
  includeWorktree: boolean;
  listWorktree?: (root: string) => Promise<string[]>;
}

export async function runCheck(
  policy: RootArtifactPolicy,
  options: RunCheckOptions,
): Promise<Pick<CheckRootResult, "blocked" | "warnings">> {
  const blocked = checkStaged(options.staged, options.root, policy);
  const warnings = options.includeWorktree
    ? await checkWorktree(options.root, policy, options.listWorktree)
    : [];
  return { blocked, warnings };
}

function printText(result: CheckRootResult): void {
  if (!result.configured) {
    console.log(
      `guard-kit check-root: root protection is not enabled for ${result.root}, skipping.`,
    );
    return;
  }
  if (result.blocked.length === 0 && result.warnings.length === 0) {
    console.log("guard-kit check-root: clean.");
    return;
  }
  for (const item of result.blocked) {
    console.log(`BLOCKED ${item.path} — ${item.reason}`);
  }
  for (const item of result.warnings) {
    console.log(`warning ${item.path} — ${item.reason}`);
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: {
    gitRoot?: (cwd: string) => string;
    stagedFiles?: (root: string) => string[];
    out?: (text: string) => void;
  } = {},
): Promise<number> {
  if (
    process.env.GUARD_KIT_SKIP === "1" ||
    process.env.GUARD_KIT_SKIP === "true"
  ) {
    (deps.out ?? console.log)(
      "guard-kit check-root: skipped (GUARD_KIT_SKIP=1).",
    );
    return 0;
  }
  let root = process.cwd();
  let includeWorktree = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--staged") continue;
    else if (arg === "--worktree") includeWorktree = true;
    else if (arg === "--format=json") json = true;
    else if (arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        (deps.out ?? console.error)(
          "guard-kit check-root: --root needs a directory.",
        );
        return 2;
      }
      root = resolve(value);
      index += 1;
    } else {
      (deps.out ?? console.error)(`guard-kit check-root: unknown flag ${arg}.`);
      return 2;
    }
  }
  const fail = (message: string): number => {
    (deps.out ?? console.error)(message);
    return 2;
  };
  try {
    root = deps.gitRoot
      ? deps.gitRoot(root)
      : execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: root,
          encoding: "utf8",
        }).trim();
  } catch {
    return fail("guard-kit check-root: not a git repository.");
  }
  let staged: string[];
  try {
    const raw: string | string[] = deps.stagedFiles
      ? deps.stagedFiles(root)
      : execFileSync(
          "git",
          ["diff", "--cached", "--diff-filter=ACMR", "--name-only", "-z"],
          { cwd: root, encoding: "utf8" },
        );
    staged = (typeof raw === "string" ? raw.split("\0") : raw).filter(
      (entry) => entry !== "",
    );
  } catch {
    return fail("guard-kit check-root: cannot list staged files.");
  }
  let loaded: LoadedPolicy | null;
  try {
    loaded = await loadLocalPolicy(
      root,
      undefined,
      homedir(),
      staged.map((entry) => resolve(root, dirname(entry))),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`guard-kit check-root: ${message}.`);
  }
  if (!loaded) {
    const result: CheckRootResult = {
      root,
      configured: false,
      blocked: [],
      warnings: [],
    };
    if (json) (deps.out ?? console.log)(JSON.stringify(result));
    else printText(result);
    return 0;
  }
  let blocked: StagedVerdict[];
  let warnings: StagedVerdict[];
  try {
    ({ blocked, warnings } = await runCheck(loaded.policy, {
      root,
      staged,
      includeWorktree,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`guard-kit check-root: check failed: ${message}.`);
  }
  const result: CheckRootResult = {
    root,
    configured: true,
    blocked,
    warnings,
  };
  if (json) (deps.out ?? console.log)(JSON.stringify(result, null, 2));
  else printText(result);
  if (blocked.length > 0 && !json) {
    (deps.out ?? console.error)(
      "guard-kit check-root: commit blocked — remove or allowlist the entries above.",
    );
  }
  return blocked.length > 0 ? 1 : 0;
}

const invokedAsCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) ===
    resolve(dirname(fileURLToPath(import.meta.url)), "check-root.js");
if (invokedAsCli) {
  process.exitCode = await main();
}
