import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  LEGACY_GUARDRAILS_COMMANDS,
  legacyCommandDescription,
  legacyCommandNotice,
  OMP_GUARD_KIT_COMMANDS,
  type OmpGuardKitCommand,
} from "../../../src/shared/commands";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

export function registerCommandWithLegacyAlias(
  pi: ExtensionAPI,
  command: OmpGuardKitCommand,
  description: string,
  handler: CommandHandler,
): void {
  pi.registerCommand(OMP_GUARD_KIT_COMMANDS[command], {
    description,
    handler,
  });
  pi.registerCommand(LEGACY_GUARDRAILS_COMMANDS[command], {
    description: legacyCommandDescription(command),
    handler: async (args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `[OMP Guard Kit] ${legacyCommandNotice(command)}`,
          "warning",
        );
      }
      return handler(args, ctx);
    },
  });
}
