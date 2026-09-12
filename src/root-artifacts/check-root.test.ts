import { vol } from "memfs";
import { describe, expect, it } from "vitest";
import { checkStaged, loadLocalPolicy, main } from "./check-root";

function replacePolicy() {
  return {
    enabled: true,
    mode: "replace" as const,
    allow: ["allowed.txt"],
    deny: [] as string[],
    allowedDirectories: undefined,
    ignorePatterns: [] as string[],
    trashPatterns: [] as string[],
    configPatterns: [] as string[],
    autoPrune: { enabled: false },
  };
}

describe("loadLocalPolicy", () => {
  it("returns null without a local file", async () => {
    const policy = await loadLocalPolicy("/nowhere", async () => {
      throw new Error("missing");
    });
    expect(policy).toBeNull();
  });

  it("returns null when disabled", async () => {
    const policy = await loadLocalPolicy("/repo", async () =>
      JSON.stringify({ rootArtifacts: { enabled: false } }),
    );
    expect(policy).toBeNull();
  });

  it("returns null on explicit feature opt-out", async () => {
    const policy = await loadLocalPolicy("/repo", async () =>
      JSON.stringify({
        features: { rootArtifacts: false },
        rootArtifacts: { enabled: true },
      }),
    );
    expect(policy).toBeNull();
  });

  it("builds the extension policy when enabled", async () => {
    const policy = await loadLocalPolicy("/repo", async () =>
      JSON.stringify({
        features: { rootArtifacts: true },
        rootArtifacts: { enabled: true, mode: "replace", allow: [] },
      }),
    );
    expect(policy).not.toBeNull();
    if (!policy) throw new Error("expected policy");
    expect(checkStaged(["blocked.txt"], "/repo", policy)).toHaveLength(1);
  });
});

describe("checkStaged", () => {
  it("blocks only root entries outside the allowlist", () => {
    const blocked = checkStaged(
      ["blocked.txt", "allowed.txt", "src/nested.txt", "", "blocked.txt"],
      "/repo",
      { ...replacePolicy(), mode: "replace" },
    );
    expect(blocked.map((item) => item.path)).toEqual(["blocked.txt"]);
  });
});

describe("main", () => {
  it("passes silently without local config", async () => {
    const out: string[] = [];
    const code = await main([], {
      gitRoot: () => "/repo",
      stagedFiles: () => [],
      out: (text) => out.push(text),
    });
    expect(code).toBe(0);
  });

  it("fails closed on staged violations from a local config file", async () => {
    vol.fromJSON({
      "/repo/.omp/extensions/guardrails.json": JSON.stringify({
        features: { rootArtifacts: true },
        rootArtifacts: { enabled: true, mode: "replace", allow: [] },
      }),
    });
    const out: string[] = [];
    const code = await main(["--format=json"], {
      gitRoot: () => "/repo",
      stagedFiles: () => ["blocked.txt"],
      out: (text) => out.push(text),
    });
    expect(code).toBe(1);
    expect(JSON.parse(out.join("\n")).blocked).toHaveLength(1);
  });
  it("returns 2 outside a git repository", async () => {
    const code = await main([], {
      gitRoot: () => {
        throw new Error("no repo");
      },
      out: () => {},
    });
    expect(code).toBe(2);
  });
});
