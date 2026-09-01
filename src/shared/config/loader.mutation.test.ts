import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { vol } from "memfs";
import { describe, expect, it } from "vitest";
import { createGuardrailsConfigLoader } from "./loader";

const cwd = "/mutation/project";
const home = "/mutation/home";
const piLocal = join(cwd, ".pi", "extensions/guardrails.json");
const ompLocal = join(cwd, ".omp", "extensions/guardrails.json");

const saved = (value: Record<string, unknown>) =>
  JSON.stringify({ version: "0.21.0", ...value });

describe("configuration storage mutation boundaries", () => {
  it("distinguishes OMP and Pi local paths", async () => {
    vol.fromJSON({ [join(cwd, ".omp", ".keep")]: "" });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();
    await loader.save("local", { enabled: false });

    expect(existsSync(ompLocal)).toBe(true);
    expect(existsSync(piLocal)).toBe(false);
  });

  it("does not swap OMP global and local destinations", async () => {
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();
    await loader.save("global", { enabled: false });
    await loader.save("local", { enabled: true });

    expect(
      existsSync(join(home, ".omp", "agent/extensions/guardrails.json")),
    ).toBe(true);
    expect(existsSync(ompLocal)).toBe(true);
    expect(JSON.parse(await readFile(ompLocal, "utf8")).enabled).toBe(true);
  });

  it("creates the migration destination before removing legacy state", async () => {
    vol.fromJSON({ [piLocal]: saved({ enabled: false }) });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(ompLocal)).toBe(true);
    expect(existsSync(piLocal)).toBe(false);
  });

  it("never lets legacy state overwrite explicit OMP values", async () => {
    vol.fromJSON({
      [piLocal]: saved({ enabled: false, features: { rootArtifacts: true } }),
      [ompLocal]: saved({ enabled: true, features: { policies: false } }),
    });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    const result = loader.getRawConfig("local");
    expect(result?.enabled).toBe(true);
    expect(result?.features).toMatchObject({
      policies: false,
      rootArtifacts: true,
    });
  });

  it("does not retry migration when the legacy source is gone", async () => {
    vol.fromJSON({ [piLocal]: saved({ enabled: false }) });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();
    const first = await readFile(ompLocal, "utf8");
    await loader.load();

    expect(await readFile(ompLocal, "utf8")).toBe(first);
    expect(existsSync(piLocal)).toBe(false);
  });

  it("retains non-empty legacy directories", async () => {
    const retained = join(cwd, ".pi", "other-extension.json");
    vol.fromJSON({
      [piLocal]: saved({ enabled: false }),
      [retained]: "{}",
    });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(retained)).toBe(true);
    expect(existsSync(join(cwd, ".pi"))).toBe(true);
  });

  it("keeps a legacy source when the destination is invalid", async () => {
    vol.fromJSON({
      [piLocal]: saved({ enabled: false }),
      [join(cwd, ".omp", "extensions")]: "blocked",
    });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(piLocal)).toBe(true);
    expect(loader.drainMessages()).toHaveLength(1);
  });

  it("uses the OMP file when both files have the same field", async () => {
    vol.fromJSON({
      [piLocal]: saved({ enabled: false }),
      [ompLocal]: saved({ enabled: true }),
    });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(loader.getRawConfig("local")?.enabled).toBe(true);
  });
});
