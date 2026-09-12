import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupDispatcher } from "./index";

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    load: vi.fn(async () => undefined),
    getConfig: vi.fn(() => ({})),
    getRawConfig: vi.fn(() => null),
    drainMessages: vi.fn(() => [] as string[]),
  },
}));

vi.mock("../guardrails", () => ({
  checkPoliciesToolCall: vi.fn(async () => undefined),
  resetLoadedFeatures: vi.fn(),
}));

vi.mock("../permission-gate", () => ({
  checkPermissionGateToolCall: vi.fn(async () => undefined),
}));

vi.mock("../root-artifacts", () => ({
  checkRootArtifactsToolCall: vi.fn(async () => undefined),
  isRootArtifactsConfigured: vi.fn(() => false),
  runSessionDiagnostics: vi.fn(async () => undefined),
}));

vi.mock("./auto-setup", () => ({
  maybeAutoSetup: vi.fn(async () => undefined),
}));

import { checkPoliciesToolCall } from "../guardrails";
import { checkPermissionGateToolCall } from "../permission-gate";
import {
  checkRootArtifactsToolCall,
  isRootArtifactsConfigured,
  runSessionDiagnostics,
} from "../root-artifacts";
import { maybeAutoSetup } from "./auto-setup";

function createPi() {
  return {
    on: vi.fn(),
    events: { on: vi.fn(), emit: vi.fn() },
  } as unknown as ExtensionAPI & { on: ReturnType<typeof vi.fn> };
}

function handlerFor(pi: { on: ReturnType<typeof vi.fn> }, event: string) {
  return pi.on.mock.calls.find(([name]) => name === event)?.[1] as (
    event: { toolName: string; input: unknown },
    ctx: unknown,
  ) => Promise<unknown>;
}

function createCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/workspace/project-a",
    hasUI: true,
    mode: "tui",
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

describe("setupDispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers exactly one tool_call and one session_start handler", async () => {
    const pi = createPi();
    await setupDispatcher(pi, { checkPathAccess: vi.fn() });

    const toolCalls = pi.on.mock.calls.filter(([n]) => n === "tool_call");
    const starts = pi.on.mock.calls.filter(([n]) => n === "session_start");
    expect(toolCalls).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });

  it("ignores a second setup on the same host (reload-safe)", async () => {
    const pi = createPi();
    const checkPathAccess = vi.fn(async () => undefined);
    await setupDispatcher(pi, { checkPathAccess });
    await setupDispatcher(pi, { checkPathAccess });

    expect(pi.on.mock.calls.filter(([n]) => n === "tool_call")).toHaveLength(1);
  });

  it("first block wins and later checkers do not run", async () => {
    const pi = createPi();
    const checkPathAccess = vi.fn(async () => undefined);
    await setupDispatcher(pi, { checkPathAccess });
    vi.mocked(checkPoliciesToolCall).mockResolvedValueOnce({
      block: true,
      reason: "policy",
    });

    const result = await handlerFor(pi, "tool_call")(
      { toolName: "write", input: {} },
      createCtx(),
    );

    expect(result).toEqual({ block: true, reason: "policy" });
    expect(checkPathAccess).not.toHaveBeenCalled();
    expect(checkPermissionGateToolCall).not.toHaveBeenCalled();
    expect(checkRootArtifactsToolCall).not.toHaveBeenCalled();
  });

  it("runs checkers in registration order and returns undefined when all pass", async () => {
    const pi = createPi();
    const order: string[] = [];
    vi.mocked(checkPoliciesToolCall).mockImplementationOnce(async () => {
      order.push("policies");
      return undefined;
    });
    const checkPathAccess = vi.fn(async () => {
      order.push("pathAccess");
      return undefined;
    });
    vi.mocked(checkPermissionGateToolCall).mockImplementationOnce(async () => {
      order.push("permissionGate");
      return undefined;
    });
    vi.mocked(checkRootArtifactsToolCall).mockImplementationOnce(async () => {
      order.push("rootArtifacts");
      return undefined;
    });
    await setupDispatcher(pi, { checkPathAccess });

    const result = await handlerFor(pi, "tool_call")(
      { toolName: "write", input: {} },
      createCtx(),
    );

    expect(result).toBeUndefined();
    expect(order).toEqual([
      "policies",
      "pathAccess",
      "permissionGate",
      "rootArtifacts",
    ]);
  });

  it("runs diagnostics on session_start only when root artifacts are configured", async () => {
    const pi = createPi();
    await setupDispatcher(pi, { checkPathAccess: vi.fn() });
    vi.mocked(isRootArtifactsConfigured).mockReturnValueOnce(true);

    await handlerFor(pi, "session_start")(
      { toolName: "", input: {} },
      createCtx(),
    );

    expect(runSessionDiagnostics).toHaveBeenCalledTimes(1);
    expect(maybeAutoSetup).not.toHaveBeenCalled();
  });

  it("delegates to auto setup when root artifacts are not configured", async () => {
    const pi = createPi();
    await setupDispatcher(pi, { checkPathAccess: vi.fn() });
    const ctx = createCtx();

    await handlerFor(pi, "session_start")({ toolName: "", input: {} }, ctx);

    expect(runSessionDiagnostics).not.toHaveBeenCalled();
    expect(maybeAutoSetup).toHaveBeenCalledWith(ctx);
  });
});
