import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isRootSetupPending,
  maybeAutoSetup,
} from "../../../dispatch/auto-setup";
import { registerGuardKitCommand } from "../registration";

export { isRootSetupPending };

export function registerGuardrailsSetupCommand(pi: ExtensionAPI): void {
  registerGuardKitCommand(
    pi,
    "setup",
    "Enable root-artifact protection for this project",
    async (_args, ctx) => {
      await maybeAutoSetup(ctx, { force: true });
    },
  );
}
