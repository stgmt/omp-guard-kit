import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configureConfigRuntime } from "../src/shared/config/loader";
import { setupDispatcher } from "./dispatch";
import guardrails from "./guardrails";
import herdr from "./herdr";
import pathAccess from "./path-access";
import permissionGate from "./permission-gate";
import rootArtifacts from "./root-artifacts";

export default async function omp(pi: ExtensionAPI): Promise<void> {
  configureConfigRuntime("omp");
  await guardrails(pi);
  await herdr(pi);
  const checkPathAccess = await pathAccess(pi);
  await permissionGate(pi);
  await rootArtifacts(pi);
  await setupDispatcher(pi, { checkPathAccess });
}
