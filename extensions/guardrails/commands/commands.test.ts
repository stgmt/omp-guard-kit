import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_GUARDRAILS_COMMANDS,
  OMP_GUARD_KIT_COMMANDS,
} from "../../../src/shared/commands";
import { registerGuardrailsExamplesCommand } from "./examples";
import { registerGuardrailsOnboardingCommand } from "./onboarding";
import { registerCommandWithLegacyAlias } from "./registration";
import { registerGuardrailsSettings } from "./settings";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

function createCommandRecorder() {
  const registerCommand = vi.fn();
  const pi = { registerCommand } as unknown as ExtensionAPI;
  return { pi, registerCommand };
}

describe("OMP Guard Kit command namespace", () => {
  it("registers canonical commands and legacy aliases", () => {
    const { pi, registerCommand } = createCommandRecorder();

    registerGuardrailsOnboardingCommand(pi);
    registerGuardrailsSettings(pi);
    registerGuardrailsExamplesCommand(pi);

    expect(registerCommand.mock.calls.map(([name]) => name)).toEqual([
      OMP_GUARD_KIT_COMMANDS.onboarding,
      LEGACY_GUARDRAILS_COMMANDS.onboarding,
      OMP_GUARD_KIT_COMMANDS.settings,
      LEGACY_GUARDRAILS_COMMANDS.settings,
      OMP_GUARD_KIT_COMMANDS.examples,
      LEGACY_GUARDRAILS_COMMANDS.examples,
    ]);
  });

  it("marks legacy aliases in command descriptions", () => {
    const { pi, registerCommand } = createCommandRecorder();

    registerGuardrailsOnboardingCommand(pi);
    registerGuardrailsSettings(pi);
    registerGuardrailsExamplesCommand(pi);

    const descriptions = registerCommand.mock.calls.map(
      ([, options]) => options.description,
    );
    expect(descriptions).toEqual([
      "Run OMP Guard Kit onboarding",
      "Legacy alias for /omp-guard-kit:onboarding; use the canonical command instead.",
      "Configure OMP Guard Kit settings",
      "Legacy alias for /omp-guard-kit:settings; use the canonical command instead.",
      "Apply OMP Guard Kit example presets",
      "Legacy alias for /omp-guard-kit:examples; use the canonical command instead.",
    ]);
  });
  it("forwards legacy aliases with migration guidance", async () => {
    const { pi, registerCommand } = createCommandRecorder();
    const handler = vi.fn(
      async (_args: string, _ctx: Parameters<CommandHandler>[1]) => {},
    );

    registerCommandWithLegacyAlias(
      pi,
      "settings",
      "Configure settings",
      handler,
    );

    const legacyOptions = registerCommand.mock.calls[1]?.[1] as {
      handler: CommandHandler;
    };
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      ui: { notify },
    } as unknown as Parameters<CommandHandler>[1];

    await legacyOptions.handler("args", ctx);

    expect(notify).toHaveBeenCalledWith(
      "[OMP Guard Kit] /guardrails:settings is deprecated. Use /omp-guard-kit:settings instead.",
      "warning",
    );
    expect(handler).toHaveBeenCalledWith("args", ctx);
  });
});
