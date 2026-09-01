import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { vol } from "memfs";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import {
  configLoader,
  configureConfigRuntime,
  createGuardrailsConfigLoader,
} from "./loader";

const cwd = "/workspace/project";
const home = "/home/test-user";

function localPath(marker: ".pi" | ".omp"): string {
  return join(cwd, marker, "extensions/guardrails.json");
}

function globalPath(marker: ".pi" | ".omp"): string {
  return join(home, marker, "agent/extensions/guardrails.json");
}

function config(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: pkg.version, ...overrides };
}

describe("guardrails config persistence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("adds the current config version when saving a new partial local config", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-agent-config-save");
    const configPath = localPath(".pi");
    vol.fromJSON({ [join(cwd, ".pi", ".keep")]: "" });

    const configLoader = createGuardrailsConfigLoader("pi", { cwd, home });
    await configLoader.load();
    await configLoader.save("local", {
      pathAccess: {
        allowedPaths: [{ kind: "directory", path: "/tmp/outside" }],
      },
    });

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.version).toBe(pkg.version);
    expect(saved.pathAccess.allowedPaths).toEqual([
      { kind: "directory", path: "/tmp/outside" },
    ]);
    await configLoader.load();
    expect(existsSync(join(cwd, ".pi", "extensions/guardrails.v0.json"))).toBe(
      false,
    );
  });

  it("preserves an existing config version when saving", async () => {
    const configPath = localPath(".pi");
    vol.fromJSON({ [join(cwd, ".pi", ".keep")]: "" });

    const configLoader = createGuardrailsConfigLoader("pi", { cwd, home });
    await configLoader.load();
    await configLoader.save("local", {
      version: "0.9.0-20260327",
      enabled: false,
      pathAccess: {
        allowedPaths: [{ kind: "directory", path: "/tmp/existing" }],
      },
    });

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved).toMatchObject({
      version: "0.9.0-20260327",
      enabled: false,
      pathAccess: {
        allowedPaths: [{ kind: "directory", path: "/tmp/existing" }],
      },
    });
  });

  it("queues migration messages via drainMessages() when migrations run", async () => {
    const configPath = localPath(".pi");
    vol.fromJSON({
      [configPath]: JSON.stringify({
        version: "0.12.2-20260521",
        pathAccess: { mode: "ask", allowedPaths: ["/tmp/outside/"] },
      }),
    });

    const configLoader = createGuardrailsConfigLoader("pi", { cwd, home });
    await configLoader.load();

    const messages = configLoader.drainMessages();
    expect(messages).toContain(
      "pathAccess.allowedPaths was migrated from path strings to { kind, path } objects.",
    );
    expect(configLoader.drainMessages()).toEqual([]);
  });

  it("keeps Pi local settings in .pi and never creates .omp", async () => {
    vol.fromJSON({ [join(cwd, ".pi", ".keep")]: "" });
    const loader = createGuardrailsConfigLoader("pi", { cwd, home });

    await loader.load();
    await loader.save("local", { enabled: false });

    expect(existsSync(localPath(".pi"))).toBe(true);
    expect(existsSync(localPath(".omp"))).toBe(false);
  });

  it("writes OMP local settings only in .omp", async () => {
    vol.fromJSON({ [join(cwd, ".omp", ".keep")]: "" });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();
    await loader.save("local", { enabled: false });

    expect(existsSync(localPath(".omp"))).toBe(true);
    expect(existsSync(localPath(".pi"))).toBe(false);
  });

  it("writes OMP global settings only in the OMP agent directory", async () => {
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();
    await loader.save("global", { enabled: false });

    expect(existsSync(globalPath(".omp"))).toBe(true);
    expect(existsSync(globalPath(".pi"))).toBe(false);
  });

  it("migrates a local Pi file and prunes only empty legacy directories", async () => {
    const source = localPath(".pi");
    vol.fromJSON({
      [source]: JSON.stringify(config({ enabled: false })),
    });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(source)).toBe(false);
    expect(existsSync(localPath(".omp"))).toBe(true);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect(loader.getRawConfig("local")).toMatchObject({ enabled: false });
  });

  it("migrates a global Pi file to the OMP agent directory", async () => {
    const source = globalPath(".pi");
    vol.fromJSON({ [source]: JSON.stringify(config({ enabled: false })) });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(source)).toBe(false);
    expect(existsSync(globalPath(".omp"))).toBe(true);
    expect(loader.getRawConfig("global")).toMatchObject({ enabled: false });
  });

  it("keeps OMP values and fills missing values from a conflicting Pi file", async () => {
    const source = localPath(".pi");
    const destination = localPath(".omp");
    vol.fromJSON({
      [source]: JSON.stringify(
        config({ enabled: false, features: { rootArtifacts: true } }),
      ),
      [destination]: JSON.stringify(
        config({ enabled: true, features: { policies: false } }),
      ),
    });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(source)).toBe(false);
    expect(loader.getRawConfig("local")).toMatchObject({
      enabled: true,
      features: { policies: false, rootArtifacts: true },
    });
    expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({
      enabled: true,
      features: { policies: false, rootArtifacts: true },
    });
  });

  it("retries invalid legacy JSON without deleting it", async () => {
    const source = localPath(".pi");
    vol.fromJSON({ [source]: "not-json" });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(source)).toBe(true);
    expect(existsSync(localPath(".omp"))).toBe(false);
    expect(loader.drainMessages()).toHaveLength(1);
  });

  it("uses the legacy config for this run when migration cannot write", async () => {
    const source = localPath(".pi");
    vol.fromJSON({
      [source]: JSON.stringify(config({ enabled: false })),
      [join(cwd, ".omp", "extensions")]: "not-a-directory",
    });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(source)).toBe(true);
    expect(loader.getRawConfig("local")).toMatchObject({ enabled: false });
    expect(loader.drainMessages()).toHaveLength(1);
  });

  it("keeps the legacy file when deleting it fails after atomic migration", async () => {
    const source = localPath(".pi");
    vol.fromJSON({ [source]: JSON.stringify(config({ enabled: false })) });
    vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(new Error("locked"));
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(source)).toBe(true);
    expect(existsSync(localPath(".omp"))).toBe(true);
    expect(loader.getRawConfig("local")).toMatchObject({ enabled: false });
    expect(loader.drainMessages()).toHaveLength(1);
  });

  it("does not prune a legacy .pi tree that still contains user files", async () => {
    const source = localPath(".pi");
    const retained = join(cwd, ".pi", "settings.json");
    vol.fromJSON({
      [source]: JSON.stringify(config()),
      [retained]: "{}",
    });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(source)).toBe(false);
    expect(existsSync(retained)).toBe(true);
    expect(existsSync(join(cwd, ".pi"))).toBe(true);
  });

  it("is idempotent after the first OMP migration", async () => {
    const source = localPath(".pi");
    const destination = localPath(".omp");
    vol.fromJSON({ [source]: JSON.stringify(config({ enabled: false })) });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();
    const first = await readFile(destination, "utf8");
    await loader.load();

    expect(await readFile(destination, "utf8")).toBe(first);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });

  it("migrates a custom Pi global agent directory", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "custom-pi-agent"));
    const source = join(home, "custom-pi-agent", "extensions/guardrails.json");
    const destination = globalPath(".omp");
    vol.fromJSON({ [source]: JSON.stringify(config({ enabled: false })) });
    const loader = createGuardrailsConfigLoader("omp", { cwd, home });

    await loader.load();

    expect(existsSync(source)).toBe(false);
    expect(existsSync(destination)).toBe(true);
    expect(loader.getRawConfig("global")).toMatchObject({ enabled: false });
  });

  it("rejects switching the singleton after it has loaded", async () => {
    configureConfigRuntime("pi");
    vol.fromJSON({ [join(cwd, ".pi", ".keep")]: "" });
    const loader = createGuardrailsConfigLoader("pi", { cwd, home });
    await loader.load();

    await configLoader.load();
    expect(() => configureConfigRuntime("omp")).toThrow(
      /after loading or saving/,
    );
  });
});
