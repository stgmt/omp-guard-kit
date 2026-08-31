export const OMP_GUARD_KIT_COMMAND_NAMESPACE = "omp-guard-kit";
export const LEGACY_GUARDRAILS_COMMAND_NAMESPACE = "guardrails";

export const OMP_GUARD_KIT_COMMANDS = {
  onboarding: `${OMP_GUARD_KIT_COMMAND_NAMESPACE}:onboarding`,
  settings: `${OMP_GUARD_KIT_COMMAND_NAMESPACE}:settings`,
  examples: `${OMP_GUARD_KIT_COMMAND_NAMESPACE}:examples`,
} as const;

export const LEGACY_GUARDRAILS_COMMANDS = {
  onboarding: `${LEGACY_GUARDRAILS_COMMAND_NAMESPACE}:onboarding`,
  settings: `${LEGACY_GUARDRAILS_COMMAND_NAMESPACE}:settings`,
  examples: `${LEGACY_GUARDRAILS_COMMAND_NAMESPACE}:examples`,
} as const;

export type OmpGuardKitCommand = keyof typeof OMP_GUARD_KIT_COMMANDS;

export function legacyCommandDescription(command: OmpGuardKitCommand): string {
  return `Legacy alias for /${OMP_GUARD_KIT_COMMANDS[command]}; use the canonical command instead.`;
}

export function legacyCommandNotice(command: OmpGuardKitCommand): string {
  return `/${LEGACY_GUARDRAILS_COMMANDS[command]} is deprecated. Use /${OMP_GUARD_KIT_COMMANDS[command]} instead.`;
}
