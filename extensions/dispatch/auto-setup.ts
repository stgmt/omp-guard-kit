import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createRootArtifactPolicy,
  evaluateRootArtifactTarget,
  isVcsEntry,
} from "../../src/root-artifacts";
import {
  installPreCommitHook,
  manualSnippet,
} from "../../src/root-artifacts/hook";
import { OMP_GUARD_KIT_COMMANDS } from "../../src/shared/commands";
import { configLoader } from "../../src/shared/config";
import type { GuardrailsConfig } from "../../src/shared/config/types";

/** True when this project has not enabled root-artifact protection yet. */
export function isRootSetupPending(
  localConfig: GuardrailsConfig | null,
): boolean {
  if (!localConfig?.rootArtifacts) return true;
  return localConfig.rootArtifacts.enabled !== true;
}
const KEEP_QUESTION_ID = "keep";
const ENABLE_QUESTION_ID = "enable";
const ENABLE_LABEL = "Enable protection";
const LATER_LABEL = "Not now";
const HOOK_QUESTION_ID = "hook";
const INSTALL_LABEL = "Install hook";
const SKIP_LABEL = "Skip";
const MAX_CHECK_OPTIONS = 40;

/**
 * Structural mirror of the runtime `askDialog` surface
 * (`@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts`).
 * The pinned dev dependency does not declare it yet, so detect by shape.
 */
interface AskDialogOption {
  label: string;
  description?: string;
}

interface AskDialogQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskDialogOption[];
  multi?: boolean;
  recommended?: number;
}

interface AskDialogResultItem {
  id: string;
  selectedOptions: string[];
}

type AskDialogResult =
  | { kind: "submit"; results: AskDialogResultItem[] }
  | { kind: "chat" };

type AskDialogFn = (
  questions: AskDialogQuestion[],
) => Promise<AskDialogResult | undefined>;

function askDialogOf(ctx: ExtensionContext): AskDialogFn | undefined {
  if (!ctx.ui || typeof ctx.ui !== "object" || !("askDialog" in ctx.ui)) {
    return undefined;
  }
  const candidate = ctx.ui.askDialog;
  if (typeof candidate !== "function") return undefined;
  // Dev dependency predates the runtime askDialog declaration; shape mirrors it.
  const ask: AskDialogFn = candidate as AskDialogFn;
  return ask;
}

const attemptedCwds = new Set<string>();

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function nagFallback(ctx: ExtensionContext): void {
  ctx.ui.notify(
    `[OMP Guard Kit] root protection is off for this project. Run /${OMP_GUARD_KIT_COMMANDS.setup} to enable it.`,
    "warning",
  );
}

async function saveSetup(
  base: GuardrailsConfig,
  keep: readonly string[],
): Promise<void> {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const name of new Set(keep)) {
    if (name.endsWith("/")) dirs.push(name.slice(0, -1));
    else files.push(name);
  }
  const prev = base.rootArtifacts ?? {};
  await configLoader.save("local", {
    ...base,
    features: { ...base.features, rootArtifacts: true },
    rootArtifacts: {
      ...prev,
      enabled: true,
      mode: prev.mode ?? "extend",
      allow: [...new Set([...strings(prev.allow), ...files])],
      allowedDirectories:
        dirs.length > 0 || prev.allowedDirectories !== undefined
          ? [...new Set([...strings(prev.allowedDirectories), ...dirs])]
          : undefined,
    },
  });
  await configLoader.load();
}

async function autoSetup(
  ctx: ExtensionContext,
  opts?: { force?: boolean },
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  if (!isRootSetupPending(configLoader.getRawConfig("local"))) return;
  if (!opts?.force) {
    if (attemptedCwds.has(ctx.cwd)) return;
    attemptedCwds.add(ctx.cwd);
  }
  const ask = askDialogOf(ctx);
  if (!ask) {
    nagFallback(ctx);
    return;
  }

  const policy = createRootArtifactPolicy(
    configLoader.getConfig().rootArtifacts,
  );
  const entries = (await readdir(ctx.cwd, { withFileTypes: true })).sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const flagged: Array<{ name: string; description: string }> = [];
  let greenCount = 0;
  for (const entry of entries) {
    if (isVcsEntry(entry.name)) continue;
    const decision = evaluateRootArtifactTarget(
      {
        rawPath: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
      },
      ctx.cwd,
      policy,
    );
    if (decision.allowed) {
      greenCount += 1;
      continue;
    }
    flagged.push({
      name: entry.isDirectory() ? `${entry.name}/` : entry.name,
      description:
        decision.classification && decision.reason
          ? `${decision.classification}: ${decision.reason}`
          : (decision.reason ?? decision.matchedRule),
    });
  }

  if (flagged.length === 0) {
    const enable = await ctx.ui.confirm(
      "Enable root protection?",
      "Nothing in this root would be blocked. Enable protection for future files?",
    );
    if (!enable) return;
    await saveSetup(configLoader.getRawConfig("local") ?? {}, []);
    ctx.ui.notify(
      "[OMP Guard Kit] root protection enabled for this project.",
      "info",
    );
    return;
  }

  const shown = flagged.slice(0, MAX_CHECK_OPTIONS);
  const overflow =
    flagged.length > shown.length
      ? ` Showing the first ${shown.length} of ${flagged.length}; run /${OMP_GUARD_KIT_COMMANDS.setup} for the full list.`
      : "";
  const result = await ask.call(ctx.ui, [
    {
      id: KEEP_QUESTION_ID,
      header: `Unchanged: ${greenCount} · Would be blocked: ${flagged.length}.${overflow}`,
      question:
        "Which flagged root entries should stay? The rest will be blocked.",
      options: shown.map((entry) => ({
        label: entry.name,
        description: entry.description,
      })),
      multi: true,
    },
    {
      id: ENABLE_QUESTION_ID,
      question: "Enable root protection with this allowlist?",
      options: [{ label: ENABLE_LABEL }, { label: LATER_LABEL }],
      recommended: 0,
    },
    {
      id: HOOK_QUESTION_ID,
      question: "Install a git pre-commit hook that blocks bad commits?",
      options: [{ label: INSTALL_LABEL }, { label: SKIP_LABEL }],
      recommended: 0,
    },
  ]);

  if (!result) {
    nagFallback(ctx);
    return;
  }
  if (result.kind !== "submit") {
    ctx.ui.notify(
      `[OMP Guard Kit] setup postponed. Run /${OMP_GUARD_KIT_COMMANDS.setup} when ready.`,
      "info",
    );
    return;
  }
  const answers = new Map(result.results.map((item) => [item.id, item]));
  const enable = answers
    .get(ENABLE_QUESTION_ID)
    ?.selectedOptions.includes(ENABLE_LABEL);
  if (!enable) return;
  const keep = answers.get(KEEP_QUESTION_ID)?.selectedOptions ?? [];
  await saveSetup(configLoader.getRawConfig("local") ?? {}, keep);
  ctx.ui.notify(
    "[OMP Guard Kit] root protection enabled for this project.",
    "info",
  );
  const installHook = answers
    .get(HOOK_QUESTION_ID)
    ?.selectedOptions.includes(INSTALL_LABEL);
  if (installHook) installHookGate(ctx);
}

function installHookGate(ctx: ExtensionContext): void {
  const distPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../dist/check-root.js",
  );
  if (!existsSync(distPath)) {
    ctx.ui.notify(
      `[OMP Guard Kit] bundle not built yet. ${manualSnippet(distPath)}`,
      "warning",
    );
    return;
  }
  const installed = installPreCommitHook({ cwd: ctx.cwd, distPath });
  if (installed.status === "installed") {
    ctx.ui.notify(
      `[OMP Guard Kit] pre-commit hook installed at ${installed.detail}.`,
      "info",
    );
  } else {
    ctx.ui.notify(
      `[OMP Guard Kit] hook not installed: ${installed.detail}.`,
      "warning",
    );
    if (installed.manualSnippet) ctx.ui.notify(installed.manualSnippet, "info");
  }
}
/** Fail-open wrapper: setup must never break session start. */
export async function maybeAutoSetup(
  ctx: ExtensionContext,
  opts?: { force?: boolean },
): Promise<void> {
  try {
    await autoSetup(ctx, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`[OMP Guard Kit] auto setup failed: ${message}`, "warning");
  }
}
