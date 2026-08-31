import { describe, expect, it } from "vitest";
import { createRootArtifactPolicy, evaluateRootArtifactTarget } from "../src/root-artifacts";
import type { ResolvedRootArtifactsConfig } from "../src/shared/config/types";
import { extractWriteTargets } from "../extensions/root-artifacts/targets";

const policy = createRootArtifactPolicy({
  enabled: true,
  mode: "extend",
  allow: [],
  deny: [],
  allowedDirectories: [],
  ignorePatterns: [],
  trashPatterns: [],
  configPatterns: [],
  autoPrune: { enabled: false },
} satisfies ResolvedRootArtifactsConfig);

const commands = [
  "echo marker > marker.txt",
  "printf marker > marker.txt",
  "cat source.txt > marker.txt",
  "tee marker.txt",
  "touch marker.txt",
  "mkdir marker-dir",
  "cp source.txt marker.txt",
  "mv source.txt marker.txt",
  "install source.txt marker.txt",
  'sh -c "echo marker > marker.txt"',
  "(echo marker > marker.txt)",
  "cat < input.txt > marker.txt",
  "echo marker > first.txt && printf marker > second.txt",
  "echo marker | tee piped.txt",
];

describe("root artifact mutation targets", () => {
  it.each(commands)("blocks root writes from %s", (command) => {
    const targets = extractWriteTargets(command);
    expect(targets.length, command).toBeGreaterThan(0);
    for (const target of targets) {
      const decision = evaluateRootArtifactTarget(target, "/workspace", policy);
      expect(decision.allowed, `${command} -> ${target.rawPath}`).toBe(false);
    }
  });

  it("blocks unresolved and escaping shell destinations", () => {
    const unresolved = extractWriteTargets("echo marker > $OUTPUT");
    expect(unresolved.some((target) => target.unresolved)).toBe(true);
    expect(
      evaluateRootArtifactTarget(unresolved[0]!, "/workspace", policy).matchedRule,
    ).toBe("unresolved-shell-path");

    const outside = extractWriteTargets("echo marker > ../outside.txt");
    expect(outside[0]).toBeDefined();
    expect(
      evaluateRootArtifactTarget(outside[0]!, "/workspace", policy).matchedRule,
    ).toBe("project-boundary");
  });
});
