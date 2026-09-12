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

/** Local-only mirror of the extension gate: project opts in, project decides. */
export async function loadLocalPolicy(
  root: string,
  read: ReadFile = (path) => readFile(path, "utf8"),
): Promise<RootArtifactPolicy | null> {
  const candidates = [
    join(root, ".omp", "extensions", "guardrails.json"),
    join(root, ".pi", "extensions", "guardrails.json"),
  ];
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await read(candidate);
    } catch {
      continue;
    }
    let raw: {
      enabled?: unknown;
      features?: Record<string, unknown>;
      rootArtifacts?: Record<string, unknown>;
    };
    try {
      raw = JSON.parse(text) as typeof raw;
    } catch {
      continue;
    }
    if (raw.enabled === false) continue;
    const features = raw.features ?? {};
    const artifacts = raw.rootArtifacts ?? {};
    if (artifacts.enabled !== true) continue;
    if (features.rootArtifacts === false) continue;
    return createRootArtifactPolicy({
      enabled: true,
      mode: artifacts.mode === "replace" ? "replace" : "extend",
      allow: unique(strings(artifacts.allow)),
      deny: unique(strings(artifacts.deny)),
      allowedDirectories:
        artifacts.allowedDirectories === undefined
          ? undefined
          : unique(strings(artifacts.allowedDirectories)),
      ignorePatterns: unique(strings(artifacts.ignorePatterns)),
      trashPatterns: unique(strings(artifacts.trashPatterns)),
      configPatterns: unique(strings(artifacts.configPatterns)),
      autoPrune: { enabled: false },
    });
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
  let root = process.cwd();
  let includeWorktree = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--worktree") includeWorktree = true;
    else if (arg === "--format=json") json = true;
    else if (arg === "--root") {
      root = resolve(argv[index + 1] ?? root);
      index += 1;
    }
  }
  try {
    root = deps.gitRoot
      ? deps.gitRoot(root)
      : execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: root,
          encoding: "utf8",
        }).trim();
  } catch {
    (deps.out ?? console.error)("guard-kit check-root: not a git repository.");
    return 2;
  }
  const policy = await loadLocalPolicy(root);
  if (!policy) {
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
  let staged: string[];
  try {
    staged = deps.stagedFiles
      ? deps.stagedFiles(root)
      : execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
          cwd: root,
          encoding: "utf8",
        }).split("\0");
  } catch {
    (deps.out ?? console.error)(
      "guard-kit check-root: cannot list staged files.",
    );
    return 2;
  }
  const { blocked, warnings } = await runCheck(policy, {
    root,
    staged,
    includeWorktree,
  });
  const result: CheckRootResult = { root, configured: true, blocked, warnings };
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
