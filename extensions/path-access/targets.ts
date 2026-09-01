import { resolveFromCwd } from "../../src/core/paths";
import { hasNonPathShape } from "../../src/core/paths/plausibility";
import { extractBashPathCandidates } from "../../src/shared/paths";

export async function targetsForTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<string[]> {
  if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) {
    const raw = String(input.file_path ?? input.path ?? "").trim();
    if (!raw || hasNonPathShape(raw)) return [];
    return [resolveFromCwd(raw, cwd)];
  }

  if (toolName === "bash") {
    return extractBashPathCandidates(String(input.command ?? ""), cwd);
  }

  return [];
}
