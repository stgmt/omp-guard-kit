import { mkdir, readFile } from "node:fs/promises";
import { vol } from "memfs";
import { describe, expect, it } from "vitest";
import {
  createRootArtifactPolicy,
  evaluateRootArtifactTarget,
  findStaleAllowEntries,
  isSafeBasename,
  pruneStaleAllowEntries,
  scanRootArtifacts,
  writeJsonAtomically,
} from "../../src/root-artifacts";
import type { ResolvedRootArtifactsConfig } from "../../src/shared/config/types";

function config(
  overrides: Partial<ResolvedRootArtifactsConfig> = {},
): ResolvedRootArtifactsConfig {
  return {
    enabled: true,
    mode: "extend",
    allow: [],
    deny: [],
    allowedDirectories: undefined,
    ignorePatterns: [],
    trashPatterns: [],
    configPatterns: [],
    autoPrune: { enabled: false },
    ...overrides,
  };
}

describe("root artifact policy", () => {
  it("preserves built-in allowlist, classifies unknown files, and honors deny priority", () => {
    const policy = createRootArtifactPolicy(
      config({ allow: ["scratch.txt"], deny: ["scratch.*"] }),
    );
    expect(
      evaluateRootArtifactTarget(
        { rawPath: "package.json", kind: "file" },
        "/workspace",
        policy,
      ).allowed,
    ).toBe(true);
    const denied = evaluateRootArtifactTarget(
      { rawPath: "scratch.txt", kind: "file" },
      "/workspace",
      policy,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.matchedRule).toBe("deny:scratch.*");
    expect(denied.classification).toBe("unknown");
  });

  it("supports replace mode and case-insensitive glob matching", () => {
    const policy = createRootArtifactPolicy(
      config({ mode: "replace", allow: ["REPORT.TXT"] }),
    );
    expect(
      evaluateRootArtifactTarget(
        { rawPath: "report.txt", kind: "file" },
        "/workspace",
        policy,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateRootArtifactTarget(
        { rawPath: "README.md", kind: "file" },
        "/workspace",
        policy,
      ).allowed,
    ).toBe(false);
  });

  it("enforces project boundaries and allowed directories for nested targets", () => {
    const policy = createRootArtifactPolicy(
      config({ allowedDirectories: ["src", "tests"] }),
    );
    expect(
      evaluateRootArtifactTarget(
        { rawPath: "src/new.ts", kind: "file" },
        "/workspace",
        policy,
      ).allowed,
    ).toBe(true);
    const deniedDirectory = evaluateRootArtifactTarget(
      { rawPath: "docs/new.md", kind: "file" },
      "/workspace",
      policy,
    );
    expect(deniedDirectory.allowed).toBe(false);
    expect(deniedDirectory.matchedRule).toBe("allowed-directories");
    expect(
      evaluateRootArtifactTarget(
        { rawPath: "../outside.txt", kind: "file" },
        "/workspace",
        policy,
      ).matchedRule,
    ).toBe("project-boundary");
    expect(
      evaluateRootArtifactTarget(
        { rawPath: "$OUT", kind: "file", unresolved: true },
        "/workspace",
        policy,
      ).matchedRule,
    ).toBe("unresolved-shell-path");
  });

  it("scans sorted root entries while skipping VCS metadata", async () => {
    vol.fromJSON({
      "/workspace/package.json": "{}",
      "/workspace/zeta.txt": "z",
      "/workspace/Alpha.txt": "a",
    });
    await mkdir("/workspace/.git");
    const violations = await scanRootArtifacts(
      "/workspace",
      createRootArtifactPolicy(config()),
    );
    expect(violations.map((item) => item.name)).toEqual([
      "Alpha.txt",
      "zeta.txt",
    ]);
  });

  it("rejects unsafe stale allowlist basenames", () => {
    expect(isSafeBasename("missing.txt")).toBe(true);
    expect(isSafeBasename("../outside.txt")).toBe(false);
    expect(isSafeBasename("CON.txt")).toBe(false);
    expect(isSafeBasename("trailing.")).toBe(false);
  });

  it("prunes only safe stale entries through an atomic JSON replacement", async () => {
    vol.fromJSON({ "/workspace/README.md": "readme" });
    await mkdir("/workspace/.pi/extensions", { recursive: true });
    const configPath = "/workspace/.pi/extensions/guardrails.json";
    const rawConfig = { allow: ["missing.txt", "README.md", "../unsafe.txt"] };
    const fullConfig = {
      enabled: true,
      features: { rootArtifacts: true },
      rootArtifacts: rawConfig,
    };
    const stale = await findStaleAllowEntries("/workspace", rawConfig.allow);
    expect(stale).toEqual(["missing.txt"]);
    const pruned = await pruneStaleAllowEntries(
      configPath,
      "/workspace",
      rawConfig,
      async (path, nextRootArtifacts) =>
        writeJsonAtomically(path, {
          ...fullConfig,
          rootArtifacts: nextRootArtifacts,
        }),
    );
    expect(pruned).toEqual(["missing.txt"]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      enabled: true,
      features: { rootArtifacts: true },
      rootArtifacts: { allow: ["README.md", "../unsafe.txt"] },
    });
  });
});
