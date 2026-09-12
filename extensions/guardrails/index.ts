import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkAction } from "../../src/core";
import { configLoader } from "../../src/shared/config";
import {
  emitActionBlocked,
  GUARDRAILS_FEATURE_REGISTER_EVENT,
  type GuardrailsFeatureId,
  type GuardrailsFeatureRegisterPayload,
} from "../../src/shared/events";
import { registerGuardrailsExamplesCommand } from "./commands/examples";
import { registerGuardrailsOnboardingCommand } from "./commands/onboarding";
import { isOnboardingPending } from "./commands/onboarding/config";
import { registerGuardrailsSettings } from "./commands/settings";
import { registerGuardrailsSetupCommand } from "./commands/setup";
import {
  BLOCKED_TOOLS,
  compilePolicies,
  createPolicyRules,
  protectionRank,
} from "./rules";
import { extractTargets } from "./targets";

export async function checkPoliciesToolCall(
  pi: ExtensionAPI,
  event: { toolName: string; input: unknown },
  ctx: { cwd: string },
): Promise<{ block: true; reason: string } | undefined> {
  const config = configLoader.getConfig();
  if (!config.enabled || !config.features.policies) return;

  const policies = compilePolicies(config.policies.rules)
    .filter((policy) => BLOCKED_TOOLS[policy.protection].has(event.toolName))
    .sort(
      (a, b) => protectionRank(b.protection) - protectionRank(a.protection),
    );
  if (policies.length === 0) return;

  const input = event.input as Record<string, unknown>;
  const targets = await extractTargets(
    { toolName: event.toolName, input },
    ctx.cwd,
    policies,
  );
  const rules = createPolicyRules(policies, ctx.cwd);

  for (const target of targets) {
    const safety = await checkAction(
      {
        kind: "file",
        path: target.path,
        unresolved: target.unresolved,
        origin: event.toolName,
      },
      rules,
    );
    if (safety.kind === "safe") continue;

    emitActionBlocked(pi, {
      feature: "policies",
      action: safety.action,
      reason: safety.reason,
      block: { source: "policy", metadata: safety.metadata },
      context: { toolName: event.toolName, input },
    });
    return { block: true, reason: safety.reason };
  }
}

const loadedFeatures = new Set<GuardrailsFeatureId>(["policies"]);

export function resetLoadedFeatures(): void {
  loadedFeatures.clear();
  loadedFeatures.add("policies");
}

export default async function guardrails(pi: ExtensionAPI) {
  await configLoader.load();

  pi.events.on(GUARDRAILS_FEATURE_REGISTER_EVENT, (data: unknown) => {
    const payload = data as GuardrailsFeatureRegisterPayload;
    loadedFeatures.add(payload.feature.id);
  });

  registerGuardrailsSettings(pi, {
    getLoadedFeatures: () => loadedFeatures,
  });

  registerGuardrailsExamplesCommand(pi);
  registerGuardrailsSetupCommand(pi);
  if (isOnboardingPending(configLoader.getRawConfig("global"))) {
    registerGuardrailsOnboardingCommand(pi);
  }
}
