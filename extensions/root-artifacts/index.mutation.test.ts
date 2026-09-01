import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createMock, type DeepMocked } from "@golevelup/ts-vitest";
import { describe, expect, it, vi } from "vitest";
import rootArtifacts from "./index";

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    load: vi.fn(async () => undefined),
    getRawConfig: vi.fn(() => ({ rootArtifacts: { enabled: true } })),
    getConfig: vi.fn(() => ({
      enabled: true,
      features: {
        policies: false,
        permissionGate: false,
        pathAccess: false,
        rootArtifacts: true,
      },
      rootArtifacts: {
        enabled: true,
        mode: "replace",
        allow: [],
        deny: [],
        allowedDirectories: [],
        ignorePatterns: [],
        trashPatterns: [],
        configPatterns: [],
        autoPrune: { enabled: false },
      },
    })),
  },
}));

const deviceAddresses = [
  "xd://propose",
  "xd://resolve",
  "xd://reject",
  "XD://propose",
  "https://example.test/plan.md",
  "file://localhost/tmp/plan.md",
  "s3://bucket/plan.md",
];

type ToolCallHandler = (
  event: {
    type: "tool_call";
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  },
  ctx: ExtensionContext,
) => Promise<unknown>;

function registeredToolCallHandler(
  pi: DeepMocked<ExtensionAPI>,
): ToolCallHandler | undefined {
  const calls = pi.on.mock.calls as unknown as Array<[string, ToolCallHandler]>;
  return calls.find(([event]) => event === "tool_call")?.[1];
}

describe("root-artifacts direct target mutation boundaries", () => {
  it.each(deviceAddresses)("does not block device address %s", async (path) => {
    const pi = createMock<ExtensionAPI>();
    const ctx = createMock<ExtensionContext>({ cwd: "/workspace" });
    await rootArtifacts(pi);

    const handler = registeredToolCallHandler(pi);
    expect(handler).toEqual(expect.any(Function));
    if (!handler) throw new Error("tool_call handler was not registered");
    await expect(
      handler(
        {
          type: "tool_call",
          toolName: "write",
          toolCallId: `device-${path}`,
          input: { path, content: "plan" },
        },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });

  it("still blocks a real root file outside the allowlist", async () => {
    const pi = createMock<ExtensionAPI>();
    const ctx = createMock<ExtensionContext>({ cwd: "/workspace" });
    await rootArtifacts(pi);

    const handler = registeredToolCallHandler(pi);
    expect(handler).toEqual(expect.any(Function));
    if (!handler) throw new Error("tool_call handler was not registered");
    await expect(
      handler(
        {
          type: "tool_call",
          toolName: "write",
          toolCallId: "real-root-file",
          input: { path: "blocked.txt", content: "plan" },
        },
        ctx,
      ),
    ).resolves.toMatchObject({ block: true });
  });
});
