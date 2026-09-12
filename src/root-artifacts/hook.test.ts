import { vol } from "memfs";
import { describe, expect, it } from "vitest";
import {
  type GitRun,
  HOOK_MARKER,
  hookScript,
  installPreCommitHook,
} from "./hook";

function makeRun(layout: {
  topLevel: string;
  hooksPath?: string;
  gitDir?: string;
}): GitRun {
  return (args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return `${layout.topLevel}\n`;
    if (args[0] === "config") {
      if (layout.hooksPath === undefined) throw new Error("no value");
      return `${layout.hooksPath}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--git-dir")
      return `${layout.gitDir ?? ".git"}\n`;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

const DIST = "/pkg/dist/check-root.js";

describe("installPreCommitHook", () => {
  it("installs into a clean hooks dir", () => {
    vol.fromJSON({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const result = installPreCommitHook({
      cwd: "/repo",
      distPath: DIST,
      run: makeRun({ topLevel: "/repo" }),
    });

    expect(result.status).toBe("installed");
    const content = vol.readFileSync(
      "/repo/.git/hooks/pre-commit",
      "utf8",
    ) as string;
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain(`node "${DIST}" --staged`);
  });

  it("rewrites its own managed hook", () => {
    vol.fromJSON({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const run = makeRun({ topLevel: "/repo" });
    const first = installPreCommitHook({
      cwd: "/repo",
      distPath: DIST,
      run,
    });
    const second = installPreCommitHook({
      cwd: "/repo",
      distPath: DIST,
      run,
    });

    expect(first.status).toBe("installed");
    expect(second.status).toBe("installed");
    expect(second.detail).toBe(first.detail);
  });

  it("refuses a foreign hook and leaves it untouched", () => {
    const foreign = "#!/bin/sh\necho foreign\n";
    vol.fromJSON({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/.git/hooks/pre-commit": foreign,
    });
    const result = installPreCommitHook({
      cwd: "/repo",
      distPath: DIST,
      run: makeRun({ topLevel: "/repo" }),
    });

    expect(result.status).toBe("occupied");
    expect(vol.readFileSync("/repo/.git/hooks/pre-commit", "utf8")).toBe(
      foreign,
    );
    expect(result.manualSnippet).toContain("guard-kit-check-root");
  });

  it("refuses when core.hooksPath is managed elsewhere", () => {
    vol.fromJSON({ "/repo/.git/HEAD": "ref: refs/heads/main\n" });
    const result = installPreCommitHook({
      cwd: "/repo",
      distPath: DIST,
      run: makeRun({ topLevel: "/repo", hooksPath: ".beads/hooks" }),
    });

    expect(result.status).toBe("occupied");
    expect(result.manualSnippet).toContain("guard-kit-check-root");
    expect(vol.existsSync("/repo/.beads/hooks/pre-commit")).toBe(false);
  });

  it("reports no-git without touching anything", () => {
    const result = installPreCommitHook({
      cwd: "/repo",
      distPath: DIST,
      run: () => {
        throw new Error("not a repo");
      },
    });

    expect(result.status).toBe("no-git");
  });

  it("renders a runnable script", () => {
    const script = hookScript(DIST);
    expect(script.startsWith("#!/bin/sh")).toBe(true);
    expect(script).toContain("|| exit 1");
  });
});
