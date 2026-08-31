import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OMP_GUARD_KIT_COMMANDS,
  type OmpGuardKitCommand,
} from "../../../src/shared/commands";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

export function registerGuardKitCommand(
  pi: ExtensionAPI,
  command: OmpGuardKitCommand,
  description: string,
  handler: CommandHandler,
): void {
  pi.registerCommand(OMP_GUARD_KIT_COMMANDS[command], {
    description,
    handler,
  });
}
