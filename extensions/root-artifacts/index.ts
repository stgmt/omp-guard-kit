import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AtomicConfig,
  createRootArtifactPolicy,
  evaluateRootArtifactTarget,
  findNearestLocalConfigPath,
  pruneStaleAllowEntries,
  type RootArtifactTarget,
  scanRootArtifacts,
  writeJsonAtomically,
} from "../../src/root-artifacts";
import { configLoader } from "../../src/shared/config";
import type { ResolvedConfig } from "../../src/shared/config/types";
import {
  createFeatureRegisterPayload,
  GUARDRAILS_FEATURE_REGISTER_EVENT,
  GUARDRAILS_FEATURE_REQUEST_EVENT,
} from "../../src/shared/events";
import { extractWriteTargets } from "./targets";

export const ROOT_ARTIFACTS_DIAGNOSTIC_EVENT =
  "guardrails:root-artifacts:diagnostic";

const DIRECT_WRITE_TOOLS: Record<string, true> = {
  apply_patch: true,
  copy: true,
  create_directory: true,
  create_file: true,
  edit: true,
  install: true,
  mkdir: true,
  move: true,
  write: true,
  write_file: true,
};

const INPUT_PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "filename",
  "target",
] as const;

function isAtomicConfig(value: unknown): value is AtomicConfig {
  if (!value || typeof value !== "object") return false;
  if (!("allow" in value)) return true;
  return Array.isArray(value.allow);
}

function localRootArtifactsEnabled(): boolean {
  const raw = configLoader.getRawConfig("local");
  if (!raw || typeof raw !== "object" || !("rootArtifacts" in raw))
    return false;
  const rootArtifacts = raw.rootArtifacts;
  if (
    !rootArtifacts ||
    typeof rootArtifacts !== "object" ||
    !("enabled" in rootArtifacts)
  )
    return false;
  return rootArtifacts.enabled === true;
}

function directWriteTargets(
  toolName: string,
  input: Record<string, unknown>,
): RootArtifactTarget[] {
  if (!DIRECT_WRITE_TOOLS[toolName]) return [];
  const kind =
    toolName === "create_directory" || toolName === "mkdir"
      ? "directory"
      : "file";
  const targets: RootArtifactTarget[] = [];
  for (const key of INPUT_PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim())
      targets.push({ rawPath: value, kind });
  }
  const patch = input.patch;
  if (typeof patch === "string") {
    for (const match of patch.matchAll(
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    )) {
      const path = match[1];
      if (typeof path === "string") {
        targets.push({ rawPath: path.trim(), kind: "file" });
      }
    }
  }
  return targets;
}

function targetsForTool(
  toolName: string,
  input: Record<string, unknown>,
): RootArtifactTarget[] {
  if (toolName === "bash") {
    const command = input.command;
    return typeof command === "string" ? extractWriteTargets(command) : [];
  }
  return directWriteTargets(toolName, input);
}

function formatViolation(path: string, reason: string): string {
  return `Root artifact blocked: ${path} — ${reason}`;
}

async function runSessionDiagnostics(
  pi: ExtensionAPI,
  cwd: string,
  config: ResolvedConfig,
  ctx: ExtensionContext,
): Promise<void> {
  const policy = createRootArtifactPolicy(config.rootArtifacts);
  let pruned: string[] = [];
  if (config.rootArtifacts.autoPrune.enabled) {
    const rawLocal = configLoader.getRawConfig("local");
    const localConfig =
      rawLocal && typeof rawLocal === "object" ? rawLocal : {};
    const rawRootArtifacts =
      "rootArtifacts" in localConfig ? localConfig.rootArtifacts : undefined;
    const configPath = findNearestLocalConfigPath(cwd);
    if (configPath && isAtomicConfig(rawRootArtifacts)) {
      try {
        pruned = await pruneStaleAllowEntries(
          configPath,
          cwd,
          rawRootArtifacts,
          async (path, nextRootArtifacts) =>
            writeJsonAtomically(path, {
              ...localConfig,
              rootArtifacts: nextRootArtifacts,
            }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Root artifact auto-prune failed: ${message}`, "error");
      }
    }
  }

  const violations = await scanRootArtifacts(cwd, policy);
  pi.events.emit(ROOT_ARTIFACTS_DIAGNOSTIC_EVENT, {
    cwd,
    pruned,
    violations,
  });
  if (pruned.length > 0) {
    ctx.ui.notify(
      `Removed stale root-artifact allow entries: ${pruned.join(", ")}`,
      "warning",
    );
  }
  if (violations.length > 0) {
    ctx.ui.notify(
      [
        "Root artifacts outside the allowlist:",
        ...violations.map((violation) => `- ${violation.name}`),
      ].join("\n"),
      "warning",
    );
  }
}

export default async function rootArtifacts(pi: ExtensionAPI): Promise<void> {
  await configLoader.load();

  pi.events.on(GUARDRAILS_FEATURE_REQUEST_EVENT, () => {
    pi.events.emit(
      GUARDRAILS_FEATURE_REGISTER_EVENT,
      createFeatureRegisterPayload("rootArtifacts"),
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = configLoader.getConfig();
    if (
      !config.enabled ||
      !config.features.rootArtifacts ||
      !config.rootArtifacts.enabled ||
      !localRootArtifactsEnabled()
    )
      return;
    await runSessionDiagnostics(pi, ctx.cwd, config, ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = configLoader.getConfig();
    if (
      !config.enabled ||
      !config.features.rootArtifacts ||
      !config.rootArtifacts.enabled ||
      !localRootArtifactsEnabled()
    )
      return;

    const policy = createRootArtifactPolicy(config.rootArtifacts);
    const targets = targetsForTool(event.toolName, event.input).sort(
      (left, right) =>
        left.rawPath.localeCompare(right.rawPath, undefined, {
          sensitivity: "base",
        }),
    );
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.kind}:${target.rawPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const decision = evaluateRootArtifactTarget(target, ctx.cwd, policy);
      if (decision.allowed) continue;
      const reason = formatViolation(
        decision.relativePath || target.rawPath,
        decision.reason ?? decision.matchedRule,
      );
      pi.events.emit(ROOT_ARTIFACTS_DIAGNOSTIC_EVENT, {
        cwd: ctx.cwd,
        toolName: event.toolName,
        target,
        decision,
      });
      return { block: true, reason };
    }
  });
}
