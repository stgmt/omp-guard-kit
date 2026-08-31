import { existsSync } from "node:fs";
import { readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { ResolvedRootArtifactsConfig } from "../shared/config/types";

export type RootArtifactKind = "file" | "directory";
export type RootArtifactClassification = "trash" | "config" | "unknown";

export interface RootArtifactPolicy {
  mode: "extend" | "replace";
  allow: string[];
  deny: string[];
  allowedDirectories?: string[];
  ignorePatterns: string[];
  trashPatterns: string[];
  configPatterns: string[];
}

export interface RootArtifactTarget {
  rawPath: string;
  kind: RootArtifactKind;
  unresolved?: boolean;
}

export interface RootArtifactDecision {
  allowed: boolean;
  relativePath: string;
  classification?: RootArtifactClassification;
  matchedRule: string;
  reason?: string;
}

export interface RootArtifactViolation {
  name: string;
  kind: RootArtifactKind;
  classification?: RootArtifactClassification;
  matchedRule: string;
  reason: string;
}

export interface AtomicConfig {
  allow?: unknown;
  [key: string]: unknown;
}

const VCS_ENTRIES: Record<string, true> = {
  ".git": true,
  ".svn": true,
  ".hg": true,
};

const DEFAULT_ALLOWED_FILES = [
  ".cursorrules",
  ".dockerignore",
  ".gitattributes",
  ".gitignore",
  ".gitlab-ci.yml",
  ".pre-commit-config.yaml",
  ".root-artifacts.yaml",
  ".yamllint",
  "AGENTS.md",
  "CLAUDE.md",
  "Directory.Build.props",
  "docker-compose.prod.yml",
  "docker-compose.tests.yml",
  "docker-compose.yml",
  "LICENSE",
  "Makefile",
  "package-lock.json",
  "package.json",
  "README.md",
  "tsconfig.json",
];

const DEFAULT_ALLOWED_PATTERNS = ["*.sln", "*.csproj"];

const DEFAULT_TRASH_PATTERNS = [
  "*.tmp",
  "*.temp",
  "*.bak",
  "*.swp",
  "*.swo",
  "*.orig",
  "*.backup",
  "*~",
  "*.old",
  "*.log",
  "*.logs",
  "npm-debug.log*",
  "yarn-debug.log*",
  "yarn-error.log*",
  "lerna-debug.log*",
  "debug.log",
  "*.cache",
  "*.pyc",
  "*.pyo",
  "*.pyd",
  "__pycache__",
  "*.class",
  "*.o",
  "*.obj",
  "*.exe",
  "*.dll",
  "*.so",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "*.lnk",
  "*.sublime-workspace",
  ".idea",
  "*.iml",
  "*.cal",
  "*.bkp",
  "*.gho",
  "*.iso",
  "*.min.js",
  "*.min.css",
  "*.map",
  "coverage",
  ".nyc_output",
  "junit.xml",
  "*.json.bak",
  "*.json.tmp",
  "*.json.old",
  ".progress.json",
  "*.vssscc",
  "*.vspscc",
  "*.testsettings",
  "UpgradeLog*.htm",
  "UpgradeLog*.XML",
  "*.suo",
  "*.user",
];

const DEFAULT_CONFIG_PATTERNS = [
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "*.config.js",
  "*.config.ts",
  "*.config.mjs",
  "*.yaml",
  "*.yml",
  "*.toml",
  "Makefile",
  "Dockerfile*",
  "docker-compose*",
  "*.md",
  "LICENSE*",
  "CHANGELOG*",
  "*.env",
  "*.env.*",
  "*.sh",
  "*.ps1",
  "*.bat",
  "*.cmd",
];

const WINDOWS_RESERVED_NAMES: Record<string, true> = {
  CON: true,
  PRN: true,
  AUX: true,
  NUL: true,
  COM1: true,
  COM2: true,
  COM3: true,
  COM4: true,
  COM5: true,
  COM6: true,
  COM7: true,
  COM8: true,
  COM9: true,
  LPT1: true,
  LPT2: true,
  LPT3: true,
  LPT4: true,
  LPT5: true,
  LPT6: true,
  LPT7: true,
  LPT8: true,
  LPT9: true,
};

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function globToRegExp(pattern: string): RegExp | null {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) return null;
      let content = pattern.slice(index + 1, close);
      if (content.startsWith("!")) content = `^${content.slice(1)}`;
      source += `[${content}]`;
      index = close;
      continue;
    }
    source += char.replace(/[\\^$+?.()|{}]/g, "\\$&");
  }
  try {
    return new RegExp(`${source}$`, "i");
  } catch {
    return null;
  }
}

export function matchesRootPattern(
  name: string,
  patterns: readonly string[],
): string | undefined {
  for (const pattern of patterns) {
    const normalized = pattern.trim();
    if (!normalized) continue;
    const regex = globToRegExp(normalized);
    if (regex?.test(name)) return normalized;
  }
  return undefined;
}

export function createRootArtifactPolicy(
  config: ResolvedRootArtifactsConfig,
): RootArtifactPolicy {
  const mode = config.mode === "replace" ? "replace" : "extend";
  return {
    mode,
    allow: strings(config.allow),
    deny: strings(config.deny),
    allowedDirectories:
      config.allowedDirectories === undefined
        ? undefined
        : strings(config.allowedDirectories),
    ignorePatterns: strings(config.ignorePatterns),
    trashPatterns: unique([
      ...strings(config.trashPatterns),
      ...DEFAULT_TRASH_PATTERNS,
    ]),
    configPatterns: unique([
      ...strings(config.configPatterns),
      ...DEFAULT_CONFIG_PATTERNS,
    ]),
  };
}

function isWindowsPath(input: string, cwd: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(input) ||
    /^\\\\/.test(input) ||
    /^[A-Za-z]:[\\/]/.test(cwd) ||
    /^\\\\/.test(cwd)
  );
}

function portableResolve(
  input: string,
  cwd: string,
): { absolute: string; relative: string } {
  const pathApi = isWindowsPath(input, cwd) ? win32 : posix;
  const absolute = pathApi.resolve(
    cwd,
    input.replaceAll("\\", pathApi === win32 ? "\\" : "/"),
  );
  const relativePath = pathApi.relative(pathApi.resolve(cwd), absolute);
  return {
    absolute,
    relative: relativePath.replaceAll("\\", "/"),
  };
}

function isRootRelative(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (!relativePath.startsWith("../") && relativePath !== "..")
  );
}

function basename(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.at(-1) ?? "";
}

function rootEntryName(relativePath: string): string {
  return relativePath.split("/")[0] ?? "";
}

function isVcsEntry(name: string): boolean {
  return VCS_ENTRIES[name.toLowerCase()] === true;
}

function allowedByPatterns(
  name: string,
  patterns: readonly string[],
): string | undefined {
  return matchesRootPattern(name, patterns);
}

function classify(
  name: string,
  policy: RootArtifactPolicy,
): RootArtifactClassification {
  if (matchesRootPattern(name, policy.trashPatterns)) return "trash";
  if (matchesRootPattern(name, policy.configPatterns)) return "config";
  return "unknown";
}

export function classifyRootFile(
  name: string,
  policy: RootArtifactPolicy,
): RootArtifactClassification {
  return classify(name, policy);
}

function evaluateRootFile(
  name: string,
  policy: RootArtifactPolicy,
): RootArtifactDecision {
  const deniedBy = allowedByPatterns(name, policy.deny);
  if (deniedBy) {
    return {
      allowed: false,
      relativePath: name,
      classification: classify(name, policy),
      matchedRule: `deny:${deniedBy}`,
      reason: `root file is explicitly denied by ${deniedBy}`,
    };
  }

  const builtinAllow = policy.mode === "extend" ? DEFAULT_ALLOWED_FILES : [];
  const builtinPatterns =
    policy.mode === "extend" ? DEFAULT_ALLOWED_PATTERNS : [];
  const explicitAllow = allowedByPatterns(name, policy.allow);
  if (
    builtinAllow.some((entry) => entry.toLowerCase() === name.toLowerCase())
  ) {
    return { allowed: true, relativePath: name, matchedRule: "builtin-allow" };
  }
  if (explicitAllow) {
    return {
      allowed: true,
      relativePath: name,
      matchedRule: `allow:${explicitAllow}`,
    };
  }
  const builtinPattern = allowedByPatterns(name, builtinPatterns);
  if (builtinPattern) {
    return {
      allowed: true,
      relativePath: name,
      matchedRule: `builtin-pattern:${builtinPattern}`,
    };
  }
  if (matchesRootPattern(name, policy.ignorePatterns)) {
    return { allowed: true, relativePath: name, matchedRule: "ignore-pattern" };
  }

  const classification = classify(name, policy);
  return {
    allowed: false,
    relativePath: name,
    classification,
    matchedRule: "root-allowlist",
    reason: `root file is not allowed (classification: ${classification})`,
  };
}

function evaluateRootDirectory(
  name: string,
  policy: RootArtifactPolicy,
): RootArtifactDecision {
  if (isVcsEntry(name)) {
    return { allowed: true, relativePath: name, matchedRule: "vcs-entry" };
  }
  const deniedBy = allowedByPatterns(name, policy.deny);
  if (deniedBy) {
    return {
      allowed: false,
      relativePath: `${name}/`,
      matchedRule: `deny:${deniedBy}`,
      reason: `root directory is explicitly denied by ${deniedBy}`,
    };
  }
  if (policy.allowedDirectories === undefined) {
    return {
      allowed: true,
      relativePath: name,
      matchedRule: "directories-unrestricted",
    };
  }
  const allowed = allowedByPatterns(name, policy.allowedDirectories);
  if (allowed) {
    return {
      allowed: true,
      relativePath: name,
      matchedRule: `allowed-directory:${allowed}`,
    };
  }
  return {
    allowed: false,
    relativePath: `${name}/`,
    matchedRule: "allowed-directories",
    reason: `root directory is not in allowedDirectories`,
  };
}

export function evaluateRootArtifactTarget(
  target: RootArtifactTarget,
  cwd: string,
  policy: RootArtifactPolicy,
): RootArtifactDecision {
  if (target.unresolved) {
    return {
      allowed: false,
      relativePath: target.rawPath,
      matchedRule: "unresolved-shell-path",
      reason:
        "shell expansion prevents proving the target stays inside the active project",
    };
  }

  let resolved: { absolute: string; relative: string };
  try {
    resolved = portableResolve(target.rawPath, cwd);
  } catch {
    return {
      allowed: false,
      relativePath: target.rawPath,
      matchedRule: "invalid-path",
      reason: "target path is invalid",
    };
  }
  const relativePath = resolved.relative;
  if (!isRootRelative(relativePath)) {
    return {
      allowed: false,
      relativePath,
      matchedRule: "project-boundary",
      reason: "target path escapes the active project",
    };
  }
  if (relativePath === "") {
    return { allowed: true, relativePath, matchedRule: "project-root" };
  }

  const name = rootEntryName(relativePath);
  if (relativePath.includes("/")) {
    const directoryDecision = evaluateRootDirectory(name, policy);
    if (!directoryDecision.allowed) {
      return { ...directoryDecision, relativePath };
    }
    return { allowed: true, relativePath, matchedRule: "nested-path" };
  }
  return target.kind === "directory"
    ? evaluateRootDirectory(name, policy)
    : evaluateRootFile(basename(relativePath), policy);
}

export async function scanRootArtifacts(
  cwd: string,
  policy: RootArtifactPolicy,
): Promise<RootArtifactViolation[]> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const violations: RootArtifactViolation[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  )) {
    if (isVcsEntry(entry.name)) continue;
    const decision = evaluateRootArtifactTarget(
      {
        rawPath: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
      },
      cwd,
      policy,
    );
    if (!decision.allowed) {
      violations.push({
        name: entry.isDirectory() ? `${entry.name}/` : entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
        classification: decision.classification,
        matchedRule: decision.matchedRule,
        reason: decision.reason ?? "root artifact is not allowed",
      });
    }
  }
  return violations;
}

export function isSafeBasename(entry: string): boolean {
  if (!entry) return false;
  if (
    entry.includes("/") ||
    entry.includes("\\") ||
    /[:<>&"|*?]/.test(entry) ||
    entry.includes(String.fromCharCode(0)) ||
    entry.includes("..")
  )
    return false;
  const base = entry.split(".", 1)[0]?.toUpperCase() ?? "";
  if (WINDOWS_RESERVED_NAMES[base]) return false;
  return !entry.endsWith(" ") && !entry.endsWith(".");
}

export async function findStaleAllowEntries(
  repoRoot: string,
  allowList: readonly unknown[],
): Promise<string[]> {
  const stale: string[] = [];
  const pathApi = isWindowsPath(repoRoot, repoRoot) ? win32 : posix;
  for (const entry of allowList) {
    if (typeof entry !== "string") continue;
    if (!isSafeBasename(entry)) continue;
    try {
      await stat(pathApi.join(repoRoot, entry));
    } catch {
      stale.push(entry);
    }
  }
  return stale.sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

export async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export async function pruneStaleAllowEntries(
  configPath: string,
  repoRoot: string,
  rawConfig: AtomicConfig,
  writeAtomic: (
    path: string,
    value: unknown,
  ) => Promise<void> = writeJsonAtomically,
): Promise<string[]> {
  const allowList = Array.isArray(rawConfig.allow) ? rawConfig.allow : [];
  const stale = await findStaleAllowEntries(repoRoot, allowList);
  if (stale.length === 0) return [];
  const staleSet = new Set(stale);
  const nextConfig = {
    ...rawConfig,
    allow: allowList.filter(
      (entry) => typeof entry !== "string" || !staleSet.has(entry),
    ),
  };
  await writeAtomic(configPath, nextConfig);
  return stale;
}

export function findNearestLocalConfigPath(cwd: string): string | null {
  const windows = isWindowsPath(cwd, cwd);
  const pathApi = windows ? win32 : posix;
  let current = pathApi.resolve(cwd);
  while (true) {
    const candidate = pathApi.join(
      current,
      ".pi",
      "extensions",
      "guardrails.json",
    );
    if (existsSync(candidate)) return candidate;
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
