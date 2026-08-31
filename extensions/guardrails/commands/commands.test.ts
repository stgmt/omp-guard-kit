import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { OMP_GUARD_KIT_COMMANDS } from "../../../src/shared/commands";
import { registerGuardrailsExamplesCommand } from "./examples";
import { registerGuardrailsOnboardingCommand } from "./onboarding";
import { registerGuardKitCommand } from "./registration";
import { registerGuardrailsSettings } from "./settings";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

function createCommandRecorder() {
  const registerCommand = vi.fn();
  const pi = { registerCommand } as unknown as ExtensionAPI;
  return { pi, registerCommand };
}

describe("OMP Guard Kit command namespace", () => {
  it("registers canonical commands only", () => {
    const { pi, registerCommand } = createCommandRecorder();

    registerGuardrailsOnboardingCommand(pi);
    registerGuardrailsSettings(pi);
    registerGuardrailsExamplesCommand(pi);

    expect(registerCommand.mock.calls.map(([name]) => name)).toEqual([
      OMP_GUARD_KIT_COMMANDS.onboarding,
      OMP_GUARD_KIT_COMMANDS.settings,
      OMP_GUARD_KIT_COMMANDS.examples,
    ]);
  });

  it("uses the canonical product descriptions", () => {
    const { pi, registerCommand } = createCommandRecorder();

    registerGuardrailsOnboardingCommand(pi);
    registerGuardrailsSettings(pi);
    registerGuardrailsExamplesCommand(pi);

    const descriptions = registerCommand.mock.calls.map(
      ([, options]) => options.description,
    );
    expect(descriptions).toEqual([
      "Run OMP Guard Kit onboarding",
      "Configure OMP Guard Kit settings",
      "Apply OMP Guard Kit example presets",
    ]);
  });

  it("forwards canonical handler arguments and context", async () => {
    const { pi, registerCommand } = createCommandRecorder();
    const handler = vi.fn(
      async (_args: string, _ctx: Parameters<CommandHandler>[1]) => {},
    );

    registerGuardKitCommand(pi, "settings", "Configure settings", handler);

    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledWith(
      OMP_GUARD_KIT_COMMANDS.settings,
      expect.objectContaining({ description: "Configure settings" }),
    );

    const options = registerCommand.mock.calls[0]?.[1] as {
      handler: CommandHandler;
    };
    const ctx = { hasUI: false } as unknown as Parameters<CommandHandler>[1];
    await options.handler("args", ctx);
    expect(handler).toHaveBeenCalledWith("args", ctx);
  });
});
