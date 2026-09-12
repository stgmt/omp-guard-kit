import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installPreCommitHook } from "../../src/root-artifacts/hook";
import { configLoader } from "../../src/shared/config";
import { isRootSetupPending, maybeAutoSetup } from "./auto-setup";

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    load: vi.fn(async () => undefined),
    getConfig: vi.fn(() => ({
      enabled: true,
      features: { rootArtifacts: true },
      rootArtifacts: {
        enabled: false,
        mode: "extend",
        allow: [],
        deny: [],
        allowedDirectories: undefined,
        ignorePatterns: [],
        trashPatterns: [],
        configPatterns: [],
        autoPrune: { enabled: false },
      },
    })),
    getRawConfig: vi.fn(() => null),
    save: vi.fn(async () => undefined),
  },
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => [
    { name: "dump.log", isDirectory: () => false },
    { name: "README.md", isDirectory: () => false },
  ]),
}));

vi.mock("../../src/root-artifacts/hook", () => ({
  installPreCommitHook: vi.fn(() => ({
    status: "installed",
    detail: "/hooks/pre-commit",
  })),
  manualSnippet: vi.fn(() => "manual snippet"),
}));
type TestCtx = ExtensionContext & {
  ui: {
    askDialog: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
  };
};

function createCtx(overrides: Record<string, unknown> = {}): TestCtx {
  return {
    cwd: "/workspace/project-auto",
    hasUI: true,
    mode: "tui",
    ui: {
      askDialog: vi.fn(async () => undefined),
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
    },
    ...overrides,
  } as unknown as TestCtx;
}

function submitResult(
  selectedKeep: string[],
  enable: boolean,
  installHook = false,
) {
  return {
    kind: "submit",
    results: [
      {
        id: "keep",
        question: "keep",
        options: [],
        multi: true,
        selectedOptions: selectedKeep,
      },
      {
        id: "enable",
        question: "enable",
        options: [],
        multi: false,
        selectedOptions: enable ? ["Enable protection"] : [],
      },
      {
        id: "hook",
        question: "hook",
        options: [],
        multi: false,
        selectedOptions: installHook ? ["Install hook"] : [],
      },
    ],
  };
}

describe("maybeAutoSetup", () => {
  const distPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../dist/check-root.js",
  );
  beforeEach(() => {
    vi.clearAllMocks();
    vol.fromJSON({ [distPath]: "" });
  });
  it("saves the checked entries and enables protection on submit", async () => {
    const ctx = createCtx();
    vi.mocked(ctx.ui.askDialog).mockResolvedValueOnce(
      submitResult(["dump.log"], true),
    );

    await maybeAutoSetup(ctx, { force: true });

    expect(configLoader.save).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        features: expect.objectContaining({ rootArtifacts: true }),
        rootArtifacts: expect.objectContaining({
          enabled: true,
          mode: "extend",
          allow: ["dump.log"],
        }),
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("enabled"),
      "info",
    );
  });

  it("saves nothing when the user picks Not now", async () => {
    const ctx = createCtx();
    vi.mocked(ctx.ui.askDialog).mockResolvedValueOnce(
      submitResult(["dump.log"], false),
    );

    await maybeAutoSetup(ctx, { force: true });

    expect(configLoader.save).not.toHaveBeenCalled();
  });

  it("falls back to the setup hint when the dialog is cancelled", async () => {
    const ctx = createCtx();
    vi.mocked(ctx.ui.askDialog).mockResolvedValueOnce(undefined);

    await maybeAutoSetup(ctx, { force: true });

    expect(configLoader.save).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("omp-guard-kit:setup"),
      "warning",
    );
  });

  it("handles the chat redirect without saving", async () => {
    const ctx = createCtx();
    vi.mocked(ctx.ui.askDialog).mockResolvedValueOnce({ kind: "chat" });

    await maybeAutoSetup(ctx, { force: true });

    expect(configLoader.save).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("postponed"),
      "info",
    );
  });

  it("falls back to the hint when askDialog is unavailable", async () => {
    const ctx = createCtx({ ui: { notify: vi.fn() } });

    await maybeAutoSetup(ctx, { force: true });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("omp-guard-kit:setup"),
      "warning",
    );
  });

  it("stays silent without UI", async () => {
    const ctx = createCtx({ hasUI: false, ui: { notify: vi.fn() } });

    await maybeAutoSetup(ctx, { force: true });

    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("asks only once per project per process unless forced", async () => {
    const first = createCtx({ cwd: "/workspace/project-once" });
    const second = createCtx({ cwd: "/workspace/project-once" });

    await maybeAutoSetup(first);
    await maybeAutoSetup(second);

    expect(first.ui.askDialog).toHaveBeenCalledTimes(1);
    expect(second.ui.askDialog).not.toHaveBeenCalled();
  });

  it("installs the pre-commit hook when selected", async () => {
    const ctx = createCtx();
    vi.mocked(ctx.ui.askDialog).mockResolvedValueOnce(
      submitResult(["dump.log"], true, true),
    );

    await maybeAutoSetup(ctx, { force: true });

    expect(installPreCommitHook).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: ctx.cwd }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("pre-commit hook installed"),
      "info",
    );
  });

  it("skips the hook when not selected", async () => {
    const ctx = createCtx();
    vi.mocked(ctx.ui.askDialog).mockResolvedValueOnce(
      submitResult(["dump.log"], true, false),
    );

    await maybeAutoSetup(ctx, { force: true });

    expect(installPreCommitHook).not.toHaveBeenCalled();
  });
});

describe("isRootSetupPending", () => {
  it("is pending without local config", () => {
    expect(isRootSetupPending(null)).toBe(true);
    expect(isRootSetupPending({})).toBe(true);
    expect(isRootSetupPending({ rootArtifacts: { enabled: false } })).toBe(
      true,
    );
  });

  it("is not pending once enabled", () => {
    expect(isRootSetupPending({ rootArtifacts: { enabled: true } })).toBe(
      false,
    );
  });
});
