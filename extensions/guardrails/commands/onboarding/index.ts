import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OMP_GUARD_KIT_COMMANDS } from "../../../../src/shared/commands";
import { configLoader } from "../../../../src/shared/config";
import {
  createOnboardingWizard,
  type OnboardingResult,
} from "../../components/onboarding-wizard";
import { registerCommandWithLegacyAlias } from "../registration";
import { isOnboardingPending, mergeOnboardingConfig } from "./config";

export function registerGuardrailsOnboardingCommand(
  pi: ExtensionAPI,
  onCompleted?: () => void,
): void {
  registerCommandWithLegacyAlias(
    pi,
    "onboarding",
    "Run OMP Guard Kit onboarding",
    async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const globalConfig = configLoader.getRawConfig("global");
      if (!isOnboardingPending(globalConfig)) {
        ctx.ui.notify(
          "[OMP Guard Kit] onboarding already completed. Use /" +
            OMP_GUARD_KIT_COMMANDS.settings +
            " to update behavior.",
          "info",
        );
        return;
      }

      const result = await ctx.ui.custom<OnboardingResult>(
        (_tui, theme, _keybindings, done) =>
          createOnboardingWizard(theme, done),
        { overlay: true },
      );

      if (!result.completed || result.applyBuiltinDefaults === null) {
        ctx.ui.notify("[OMP Guard Kit] onboarding cancelled.", "warning");
        return;
      }

      const merged = mergeOnboardingConfig(
        globalConfig,
        result.applyBuiltinDefaults,
        result.pathAccessEnabled,
      );
      await configLoader.save("global", merged);
      await configLoader.load();

      onCompleted?.();
      ctx.ui.notify("[OMP Guard Kit] onboarding completed.", "info");
    },
  );
}
