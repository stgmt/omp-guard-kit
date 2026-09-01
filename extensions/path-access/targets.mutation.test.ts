import { describe, expect, it } from "vitest";
import { targetsForTool } from "./targets";

const directTools = ["read", "write", "edit", "grep", "find", "ls"];
const deviceAddresses = [
  "xd://propose",
  "xd://resolve",
  "xd://reject",
  "XD://propose",
  "https://example.test/plan.md",
  "file://localhost/tmp/plan.md",
  "s3://bucket/plan.md",
];

describe("direct path target mutation boundaries", () => {
  it.each(
    directTools.flatMap((toolName) =>
      deviceAddresses.map((address) => [toolName, address] as const),
    ),
  )("does not classify %s %s as a filesystem target", async (toolName, address) => {
    await expect(
      targetsForTool(toolName, { path: address }, "/repo"),
    ).resolves.toEqual([]);
  });

  it.each(directTools)("keeps real outside paths for %s", async (toolName) => {
    await expect(
      targetsForTool(toolName, { path: "../secret.txt" }, "/repo"),
    ).resolves.toEqual(["/secret.txt"]);
  });

  it.each(
    directTools,
  )("returns no target for empty %s input", async (toolName) => {
    await expect(
      targetsForTool(toolName, { path: "   " }, "/repo"),
    ).resolves.toEqual([]);
  });
});
