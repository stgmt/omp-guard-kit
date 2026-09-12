import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { OMP_GUARD_KIT_COMMANDS } from "../../../../src/shared/commands";
import { isRootSetupPending, registerGuardrailsSetupCommand } from "./index";

vi.mock("../../../dispatch/auto-setup", () => ({
  isRootSetupPending: vi.fn(() => true),
  maybeAutoSetup: vi.fn(async () => undefined),
}));

import { maybeAutoSetup } from "../../../dispatch/auto-setup";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

function registerHandler() {
  const registerCommand = vi.fn();
  const pi = { registerCommand } as unknown as ExtensionAPI;
  registerGuardrailsSetupCommand(pi);
  expect(registerCommand).toHaveBeenCalledTimes(1);
  expect(registerCommand.mock.calls[0]?.[0]).toBe(OMP_GUARD_KIT_COMMANDS.setup);
  return registerCommand.mock.calls[0]?.[1].handler as CommandHandler;
}

describe("registerGuardrailsSetupCommand", () => {
  it("registers the setup command", () => {
    registerHandler();
  });

  it("delegates to the checklist flow with force", async () => {
    const handler = registerHandler();
    const ctx = { hasUI: true } as unknown as Parameters<CommandHandler>[1];

    await handler("", ctx);

    expect(maybeAutoSetup).toHaveBeenCalledWith(ctx, { force: true });
  });
});

describe("isRootSetupPending", () => {
  it("is pending without local config", () => {
    expect(isRootSetupPending(null)).toBe(true);
  });
});
