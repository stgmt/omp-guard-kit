import { parse } from "@aliou/sh";
import { walkCommands, wordToString } from "../shell/ast";

/**
 * Dangerous command matchers for the permission gate.
 *
 * Built-in dangerous patterns are matched structurally via AST parsing.
 * Each matcher receives the parsed command words and returns a description
 * if the command is dangerous, or undefined if not matched.
 */

export type StructuralMatcher = (words: string[]) => string | undefined;

export interface CommandPattern {
  pattern: string;
  description?: string;
  regex?: boolean;
}

export interface CompiledCommandPattern {
  test: (input: string) => boolean;
  source: CommandPattern;
}

export interface DangerousCommandMatch {
  description: string;
  pattern: string;
}

export interface DangerousCommandCheckOptions {
  command: string;
  patterns: readonly CompiledCommandPattern[];
  useBuiltinMatchers: boolean;
  fallbackPatterns: readonly CommandPattern[];
}

/**
 * Helper to check if any word starts with a given prefix.
 */
function hasArg(words: string[], prefix: string): boolean {
  return words.some((w) => w.startsWith(prefix));
}

/**
 * Helper to check if short options contain specific flags.
 * Handles grouped short options like -rf, -fr, -Rfv, etc.
 */
function hasShortFlag(words: string[], flag: string): boolean {
  return words.some(
    (w) =>
      w === `-${flag}` ||
      (w.startsWith("-") && !w.startsWith("--") && w.includes(flag)),
  );
}

/**
 * Helper to check for long options.
 */
function hasLongOption(words: string[], option: string): boolean {
  return words.some((w) => w === `--${option}`);
}

// =============================================================================
// File/Directory Destruction
// =============================================================================

/**
 * rm -rf, rm -r -f, rm --recursive --force, etc.
 * Catches recursive force delete in any form.
 */
const rmMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "rm") return undefined;

  const hasRecursive =
    hasShortFlag(words, "r") ||
    hasShortFlag(words, "R") ||
    hasLongOption(words, "recursive") ||
    hasLongOption(words, "dir");

  const hasForce = hasShortFlag(words, "f") || hasLongOption(words, "force");

  return hasRecursive && hasForce ? "recursive force delete" : undefined;
};

/**
 * shred - secure file/device overwrite
 */
const shredMatcher: StructuralMatcher = (words) => {
  if (words[0] === "shred") return "secure file overwrite";
  return undefined;
};

// =============================================================================
// Privilege Escalation
// =============================================================================

/**
 * sudo - superuser command
 */
const sudoMatcher: StructuralMatcher = (words) => {
  if (words[0] === "sudo") return "superuser command";
  return undefined;
};

/**
 * doas - privilege escalation (OpenBSD-style sudo alternative)
 */
const doasMatcher: StructuralMatcher = (words) => {
  if (words[0] === "doas") return "privileged command execution";
  return undefined;
};

/**
 * pkexec - PolicyKit privilege escalation
 */
const pkexecMatcher: StructuralMatcher = (words) => {
  if (words[0] === "pkexec") return "privileged command execution";
  return undefined;
};

// =============================================================================
// Disk/Filesystem Operations
// =============================================================================

/**
 * dd of= - disk write operation
 * Any dd command with an output file is potentially dangerous.
 */
const ddMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "dd") return undefined;
  return hasArg(words, "of=") ? "disk write operation" : undefined;
};

/**
 * mkfs, mkfs.* - filesystem format
 */
const mkfsMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "mkfs" || cmd?.startsWith("mkfs.")) return "filesystem format";
  return undefined;
};

/**
 * wipefs - filesystem signature wipe
 */
const wipefsMatcher: StructuralMatcher = (words) => {
  if (words[0] === "wipefs") return "filesystem signature wipe";
  return undefined;
};

/**
 * blkdiscard - block device discard (destroys data)
 */
const blkdiscardMatcher: StructuralMatcher = (words) => {
  if (words[0] === "blkdiscard") return "block device discard";
  return undefined;
};

// =============================================================================
// Disk Partitioning
// =============================================================================

/**
 * fdisk, sfdisk, cfdisk - disk partitioning
 */
const fdiskMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "fdisk" || cmd === "sfdisk" || cmd === "cfdisk") {
    return "disk partitioning";
  }
  return undefined;
};

/**
 * parted, sgdisk - advanced disk partitioning
 */
const partedMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "parted" || cmd === "sgdisk") return "disk partitioning";
  return undefined;
};

// =============================================================================
// Permission Changes
// =============================================================================

/**
 * chmod -R 777, chmod --recursive 777, chmod -R 0777, etc.
 * Insecure recursive world-writable permissions.
 */
const chmodMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "chmod") return undefined;

  const hasRecursive =
    hasShortFlag(words, "R") || hasLongOption(words, "recursive");

  const hasWorldWritable = words.some(
    (w) =>
      w === "777" ||
      w === "0777" ||
      w === "a+rwx" ||
      w === "ugo+rwx" ||
      w === "7777" || // setuid/setgid/sticky + world writable
      w === "1777", // sticky + world writable
  );

  return hasRecursive && hasWorldWritable
    ? "insecure recursive permissions"
    : undefined;
};

/**
 * chown -R, chown --recursive - recursive ownership change
 */
const chownMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "chown") return undefined;

  const hasRecursive =
    hasShortFlag(words, "R") || hasLongOption(words, "recursive");

  return hasRecursive ? "recursive ownership change" : undefined;
};

// =============================================================================
// Container Escape / Dangerous Container Operations
// =============================================================================

/**
 * Docker/Podman dangerous run/create patterns.
 * Flags: --privileged, --pid=host, --network=host, --userns=host,
 *        --uts=host, --ipc=host, -v /:/host, docker socket mounts
 */
const containerMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (!cmd) return undefined;

  // Match docker or podman commands
  const isDocker = cmd === "docker" || cmd === "podman";
  if (!isDocker) return undefined;

  // Only check run and create commands (not build, pull, etc.)
  const subcommand = words[1];
  if (subcommand !== "run" && subcommand !== "create") return undefined;

  // Check for dangerous flags
  const hasPrivileged = words.some(
    (w) => w === "--privileged" || w.startsWith("--privileged="),
  );

  const hasHostPid = words.some(
    (w) => w === "--pid=host" || w.startsWith("--pid=host"),
  );

  const hasHostNetwork = words.some(
    (w) => w === "--network=host" || w.startsWith("--network=host"),
  );

  const hasHostUsers = words.some(
    (w) => w === "--userns=host" || w.startsWith("--userns=host"),
  );

  const hasHostUts = words.some(
    (w) => w === "--uts=host" || w.startsWith("--uts=host"),
  );

  const hasHostIpc = words.some(
    (w) => w === "--ipc=host" || w.startsWith("--ipc=host"),
  );

  // Check for root filesystem bind mount
  const hasRootMount = words.some(
    (w) =>
      w.startsWith("-v/:") ||
      w.startsWith("-v/=>") ||
      w.startsWith("--volume=/:") ||
      w.startsWith("--mount=type=bind,source=/,"),
  );

  // Check for docker socket mount
  const hasDockerSocket = words.some(
    (w) =>
      w.includes("/var/run/docker.sock") ||
      w.includes("/run/docker.sock") ||
      w.includes("/var/run/podman.sock") ||
      w.includes("/run/podman.sock"),
  );

  if (hasPrivileged) return "container with privileged mode";
  if (hasHostPid) return "container with host PID namespace";
  if (hasHostNetwork) return "container with host network";
  if (hasHostUsers) return "container with host user namespace";
  if (hasHostUts) return "container with host UTS namespace";
  if (hasHostIpc) return "container with host IPC";
  if (hasRootMount) return "container with root filesystem mount";
  if (hasDockerSocket) return "container with docker socket access";

  return undefined;
};
// =============================================================================
// Host Runtime Protection
// =============================================================================

/**
 * Image names that host live agent sessions. All OMP sessions share the
 * `omp` image name, so killing by image kills siblings, not just one agent.
 */
const HOST_RUNTIME_IMAGES = new Set(["omp", "bun", "node"]);

function hostRuntimeImage(word: string): boolean {
  const base = word.toLowerCase().split(/[\\/]/).at(-1) ?? "";
  const stem = base.replace(/\.(exe|cmd|bat|ps1)$/, "");
  return HOST_RUNTIME_IMAGES.has(stem);
}

function isFlag(word: string): boolean {
  return word.startsWith("-") || word.startsWith("/");
}

/**
 * taskkill /IM <host image> (any casing). PID kills (`/PID`, no `/IM`)
 * address a single tree and keep working.
 */
function taskkillMatcher(words: string[]): string | undefined {
  if ((words[0] ?? "").toLowerCase() !== "taskkill") return undefined;
  const args = words.slice(1);
  if (!args.some((word) => word.toLowerCase() === "/im")) return undefined;
  if (!args.some(hostRuntimeImage)) return undefined;
  return "host runtime mass kill (taskkill /IM against omp/bun/node)";
}

/**
 * pkill/killall <host image>. Flag-only invocations (pids, signals)
 * do not name an image and keep working.
 */
function nameKillMatcher(words: string[]): string | undefined {
  const name = (words[0] ?? "").toLowerCase();
  if (name !== "pkill" && name !== "killall") return undefined;
  if (words.slice(1).some((word) => !isFlag(word) && hostRuntimeImage(word))) {
    return `host runtime mass kill (${name} against omp/bun/node)`;
  }
  return undefined;
}

/**
 * Stop-Process -Name <host image> (any casing). -Id kills address a
 * single process and keep working.
 */
function stopProcessMatcher(words: string[]): string | undefined {
  if ((words[0] ?? "").toLowerCase() !== "stop-process") return undefined;
  const args = words.slice(1);
  const namesNameFlag = (word: string): boolean => {
    const flag = word.toLowerCase();
    return flag === "-name" || flag === "-processname" || flag === "/name";
  };
  if (
    args.some(
      (word, index) =>
        namesNameFlag(word) &&
        args
          .slice(index + 1)
          .some((value) => !isFlag(value) && hostRuntimeImage(value)),
    )
  ) {
    return "host runtime mass kill (Stop-Process -Name against omp/bun/node)";
  }
  if (
    !args.some((word) => word.toLowerCase() === "-id") &&
    args.some((word) => !isFlag(word) && hostRuntimeImage(word))
  ) {
    return "host runtime mass kill (Stop-Process against omp/bun/node)";
  }
  return undefined;
}

// =============================================================================
// Matcher Registry
// =============================================================================

/**
 * All built-in dangerous command matchers.
 * Order matters - earlier matchers take precedence if multiple match.
 */
export const BUILTIN_MATCHERS: StructuralMatcher[] = [
  // Destruction (highest priority)
  rmMatcher,
  shredMatcher,

  // Privilege escalation
  sudoMatcher,
  doasMatcher,
  pkexecMatcher,

  // Disk/filesystem operations
  ddMatcher,
  mkfsMatcher,
  wipefsMatcher,
  blkdiscardMatcher,
  fdiskMatcher,
  partedMatcher,

  // Permission changes
  chmodMatcher,
  chownMatcher,

  // Container escapes
  containerMatcher,

  // Host runtime protection
  taskkillMatcher,
  nameKillMatcher,
  stopProcessMatcher,
];

/**
 * Keywords for each built-in matcher, used for documentation/UI.
 * These should match the patterns in DEFAULT_CONFIG in config.ts.
 */
export const BUILTIN_KEYWORD_PATTERNS = new Set([
  "rm -rf",
  "sudo",
  "dd of=",
  "mkfs.",
  "chmod -R 777",
  "chown -R",
  "doas",
  "pkexec",
  "shred",
  "wipefs",
  "blkdiscard",
  "fdisk",
  "parted",
  "docker run --privileged",
  "taskkill /IM",
  "pkill",
  "killall",
  "Stop-Process",
]);

/**
 * Match a command against all built-in dangerous patterns.
 * Returns the first match found, or undefined if no match.
 */
export function matchDangerousCommand(
  words: string[],
): DangerousCommandMatch | undefined {
  for (const matcher of BUILTIN_MATCHERS) {
    const description = matcher(words);
    if (description) {
      // Use the command itself as the pattern identifier
      const pattern = words[0] ?? "unknown";
      return { description, pattern };
    }
  }
  return undefined;
}

export function compileCommandPattern(
  config: CommandPattern,
): CompiledCommandPattern {
  if (config.regex) {
    try {
      const re = new RegExp(config.pattern);
      return { test: (input) => re.test(input), source: config };
    } catch {
      return { test: () => false, source: config };
    }
  }

  return {
    test: (input) => input.includes(config.pattern),
    source: config,
  };
}

export function compileCommandPatterns(
  configs: readonly CommandPattern[],
): CompiledCommandPattern[] {
  return configs.map(compileCommandPattern);
}

function matchBuiltinDangerous(
  words: string[],
): DangerousCommandMatch | undefined {
  if (words.length === 0) return undefined;
  for (const matcher of BUILTIN_MATCHERS) {
    const description = matcher(words);
    if (description) return { description, pattern: "(structural)" };
  }
  return undefined;
}

export function checkDangerousCommand({
  command,
  patterns,
  useBuiltinMatchers,
  fallbackPatterns,
}: DangerousCommandCheckOptions): DangerousCommandMatch | undefined {
  let parsedSuccessfully = false;

  if (useBuiltinMatchers) {
    try {
      const { ast } = parse(command);
      parsedSuccessfully = true;
      let match: DangerousCommandMatch | undefined;
      walkCommands(ast, (cmd) => {
        const words = (cmd.words ?? []).map(wordToString);
        const result = matchBuiltinDangerous(words);
        if (result) {
          match = result;
          return true;
        }
        return false;
      });
      if (match) return match;
    } catch {
      for (const pattern of fallbackPatterns) {
        if (command.includes(pattern.pattern)) {
          return {
            description: pattern.description ?? pattern.pattern,
            pattern: pattern.pattern,
          };
        }
      }
    }
  }

  for (const compiled of patterns) {
    const source = compiled.source;
    if (
      useBuiltinMatchers &&
      parsedSuccessfully &&
      !source.regex &&
      BUILTIN_KEYWORD_PATTERNS.has(source.pattern)
    ) {
      continue;
    }

    if (compiled.test(command)) {
      return {
        description: source.description ?? source.pattern,
        pattern: source.pattern,
      };
    }
  }

  return undefined;
}
