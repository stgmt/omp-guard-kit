export type {
  AtomicConfig,
  RootArtifactClassification,
  RootArtifactDecision,
  RootArtifactKind,
  RootArtifactPolicy,
  RootArtifactTarget,
  RootArtifactViolation,
} from "./policy";
export {
  classifyRootFile,
  createRootArtifactPolicy,
  evaluateRootArtifactTarget,
  findNearestLocalConfigPath,
  findStaleAllowEntries,
  isSafeBasename,
  matchesRootPattern,
  pruneStaleAllowEntries,
  scanRootArtifacts,
  writeJsonAtomically,
} from "./policy";
