import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createMock } from "@golevelup/ts-vitest";
import { describe, expect, it, vi } from "vitest";
import rootArtifacts, { checkRootArtifactsToolCall } from "./index";

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

describe("root-artifacts direct target mutation boundaries", () => {
  it.each(deviceAddresses)("does not block device address %s", async (path) => {
    const pi = createMock<ExtensionAPI>();
    const ctx = createMock<ExtensionContext>({ cwd: "/workspace" });
    await rootArtifacts(pi);

    await expect(
      checkRootArtifactsToolCall(
        pi,
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

    await expect(
      checkRootArtifactsToolCall(
        pi,
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
