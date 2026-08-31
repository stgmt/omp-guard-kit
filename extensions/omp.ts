import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import guardrails from "./guardrails";
import herdr from "./herdr";
import pathAccess from "./path-access";
import permissionGate from "./permission-gate";
import rootArtifacts from "./root-artifacts";

export default async function omp(pi: ExtensionAPI): Promise<void> {
  await guardrails(pi);
  await herdr(pi);
  await pathAccess(pi);
  await permissionGate(pi);
  await rootArtifacts(pi);
}
