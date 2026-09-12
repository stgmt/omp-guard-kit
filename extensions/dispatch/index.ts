import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { configLoader } from "../../src/shared/config";
import {
  createFeatureRequestPayload,
  GUARDRAILS_FEATURE_REQUEST_EVENT,
} from "../../src/shared/events";
import { checkPoliciesToolCall, resetLoadedFeatures } from "../guardrails";
import { checkPermissionGateToolCall } from "../permission-gate";
import {
  checkRootArtifactsToolCall,
  isRootArtifactsConfigured,
  runSessionDiagnostics,
} from "../root-artifacts";
import { maybeAutoSetup } from "./auto-setup";

const registeredHosts = new WeakSet<object>();

function notifyConfigWarnings(ctx: Pick<ExtensionContext, "ui">): void {
  const warnings = configLoader.drainMessages();
  if (warnings.length === 1) {
    ctx.ui.notify(warnings[0], "warning");
  } else if (warnings.length > 1) {
    ctx.ui.notify(
      ["Guardrails warnings:", ...warnings.map((w) => `- ${w}`)].join("\n"),
      "warning",
    );
  }
}
export type ToolCheck = (
  pi: ExtensionAPI,
  event: { toolName: string; input: unknown },
  ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined>;

export interface DispatcherDeps {
  checkPathAccess: (
    event: { toolName: string; input: unknown },
    ctx: ExtensionContext,
  ) => Promise<{ block: true; reason: string } | undefined>;
}

/**
 * Single registration point for `tool_call` and `session_start`.
 * Feature checkers run in historical registration order
 * (policies → pathAccess → permissionGate → rootArtifacts);
 * the first block wins, matching runner semantics.
 */
export async function setupDispatcher(
  pi: ExtensionAPI,
  deps: DispatcherDeps,
): Promise<void> {
  if (registeredHosts.has(pi)) return;
  registeredHosts.add(pi);

  pi.on("tool_call", async (event, ctx) => {
    const pathAccessCheck: ToolCheck = (_pi, checkEvent, checkCtx) =>
      deps.checkPathAccess(checkEvent, checkCtx);
    const checks: ToolCheck[] = [
      checkPoliciesToolCall,
      pathAccessCheck,
      checkPermissionGateToolCall,
      checkRootArtifactsToolCall,
    ];
    for (const check of checks) {
      const result = await check(pi, event, ctx);
      if (result?.block) return result;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    resetLoadedFeatures();
    pi.events.emit(
      GUARDRAILS_FEATURE_REQUEST_EVENT,
      createFeatureRequestPayload(),
    );
    notifyConfigWarnings(ctx);

    const config = configLoader.getConfig();
    if (isRootArtifactsConfigured(config)) {
      await runSessionDiagnostics(pi, ctx.cwd, config, ctx);
    } else {
      await maybeAutoSetup(ctx);
    }
  });
}
