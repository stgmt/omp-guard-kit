export const OMP_GUARD_KIT_COMMAND_NAMESPACE = "omp-guard-kit";

export const OMP_GUARD_KIT_COMMANDS = {
  onboarding: `${OMP_GUARD_KIT_COMMAND_NAMESPACE}:onboarding`,
  settings: `${OMP_GUARD_KIT_COMMAND_NAMESPACE}:settings`,
  examples: `${OMP_GUARD_KIT_COMMAND_NAMESPACE}:examples`,
} as const;

export type OmpGuardKitCommand = keyof typeof OMP_GUARD_KIT_COMMANDS;
