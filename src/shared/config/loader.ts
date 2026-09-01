import { existsSync, statSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildSchemaUrl,
  type Migration,
  type MigrationContext,
  type Scope,
} from "@aliou/pi-utils-settings";
import pkg from "../../../package.json" with { type: "json" };
import type { AllowedPath } from "../../core/paths/path";
import { DEFAULT_CONFIG } from "./defaults";
import { migrations } from "./migration";
import type {
  GuardrailsConfig,
  PolicyRule,
  ResolvedConfig,
  ResolvedRootArtifactsConfig,
  RootArtifactsConfig,
} from "./types";

export type ConfigRuntime = "pi" | "omp";
type LoaderOptions = { cwd?: string; home?: string };
type RawConfig = GuardrailsConfig | null;

type Fallbacks = Map<string, GuardrailsConfig>;

function ensureConfigVersion(config: GuardrailsConfig): GuardrailsConfig {
  if (typeof config.version === "string" && config.version.trim())
    return config;
  return { ...config, version: pkg.version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isRecord(value)) {
      if (!isRecord(target[key])) target[key] = {};
      deepMerge(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
}

function mergeMissing(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (target[key] === undefined) {
      target[key] = structuredClone(value);
    } else if (isRecord(target[key]) && isRecord(value)) {
      mergeMissing(target[key] as Record<string, unknown>, value);
    }
  }
}

function compareVersions(a: string | undefined, b: string | undefined): number {
  const parse = (value: string | undefined): [number, number, number] => {
    const parts = (value ?? "0.0.0")
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  };
  const left = parse(a);
  const right = parse(b);
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function normalizeRootArtifacts(
  resolved: ResolvedRootArtifactsConfig,
  ...layers: Array<RootArtifactsConfig | undefined>
): ResolvedRootArtifactsConfig {
  const raw = layers.reduce<Record<string, unknown>>((merged, layer) => {
    if (layer && typeof layer === "object") Object.assign(merged, layer);
    return merged;
  }, {});
  const strings = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : fallback;
  const mode =
    raw.mode === "replace"
      ? "replace"
      : raw.mode === "extend"
        ? "extend"
        : resolved.mode;
  const autoPrune =
    raw.autoPrune &&
    typeof raw.autoPrune === "object" &&
    "enabled" in raw.autoPrune
      ? { enabled: raw.autoPrune.enabled === true }
      : resolved.autoPrune;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : resolved.enabled,
    mode,
    allow: strings(raw.allow, resolved.allow),
    deny: strings(raw.deny, resolved.deny),
    allowedDirectories: Object.hasOwn(raw, "allowedDirectories")
      ? strings(raw.allowedDirectories, [])
      : resolved.allowedDirectories,
    ignorePatterns: strings(raw.ignorePatterns, resolved.ignorePatterns),
    trashPatterns: strings(raw.trashPatterns, resolved.trashPatterns),
    configPatterns: strings(raw.configPatterns, resolved.configPatterns),
    autoPrune,
  };
}

function findMarkerRoot(
  marker: ".pi" | ".omp",
  cwd: string,
  home: string,
): string | null {
  let directory = resolve(cwd);
  const homeDirectory = resolve(home);
  while (directory !== homeDirectory) {
    const markerPath = resolve(directory, marker);
    try {
      if (existsSync(markerPath) && statSync(markerPath).isDirectory()) {
        return directory;
      }
    } catch {
      // Treat an inaccessible marker as absent and continue searching upward.
    }
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function configPath(
  runtime: ConfigRuntime,
  scope: Scope,
  cwd: string,
  home: string,
): string | null {
  if (scope === "memory") return null;
  if (scope === "global") {
    const agentDirectory =
      runtime === "pi" && process.env.PI_CODING_AGENT_DIR
        ? process.env.PI_CODING_AGENT_DIR
        : join(home, runtime === "pi" ? ".pi" : ".omp", "agent");
    return resolve(agentDirectory, "extensions/guardrails.json");
  }
  const marker = runtime === "pi" ? ".pi" : ".omp";
  const root = findMarkerRoot(marker, cwd, home);
  return root ? resolve(root, marker, "extensions/guardrails.json") : null;
}

async function readJson(path: string): Promise<GuardrailsConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return null;
    const { $schema: _schema, ...config } = parsed;
    return config as GuardrailsConfig;
  } catch {
    return null;
  }
}

async function readJsonStrict(path: string): Promise<GuardrailsConfig> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("configuration must be a JSON object");
  const { $schema: _schema, ...config } = parsed;
  return config as GuardrailsConfig;
}

async function writeJson(
  path: string,
  config: GuardrailsConfig,
  schemaUrl: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ $schema: schemaUrl, ...config }, null, 2)}\n`,
    "utf8",
  );
}

async function writeJsonAtomically(
  path: string,
  config: GuardrailsConfig,
  schemaUrl: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeJson(temporaryPath, config, schemaUrl);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

class GuardrailsConfigLoader {
  private globalConfig: RawConfig = null;
  private localConfig: RawConfig = null;
  private memoryConfig: RawConfig = null;
  private resolved: ResolvedConfig | null = null;
  private pendingMessages: string[] = [];
  private localPath: string | null;
  private readonly globalPath: string;
  private readonly scopes: Scope[] = ["global", "local", "memory"];
  private readonly defaults = DEFAULT_CONFIG;
  private readonly schemaUrl = buildSchemaUrl(pkg.name, pkg.version);
  private readonly cwd: string;
  private readonly home: string;
  private readonly runtime: ConfigRuntime;
  private readonly migrationFallbacks: Fallbacks = new Map();

  constructor(runtime: ConfigRuntime, options: LoaderOptions = {}) {
    this.runtime = runtime;
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.home = resolve(options.home ?? homedir());
    this.globalPath = configPath(
      runtime,
      "global",
      this.cwd,
      this.home,
    ) as string;
    this.localPath = configPath(runtime, "local", this.cwd, this.home);
  }

  get hasStarted(): boolean {
    return this.resolved !== null;
  }

  async load(): Promise<void> {
    if (this.runtime === "omp") await this.migrateLegacyConfig();
    this.localPath =
      this.localPath ?? configPath(this.runtime, "local", this.cwd, this.home);
    this.globalConfig = await this.readWithFallback(this.globalPath);
    this.localConfig = this.localPath
      ? await this.readWithFallback(this.localPath)
      : null;
    this.memoryConfig = null;
    if (this.globalConfig) {
      this.globalConfig = await this.applyMigrations(
        this.globalConfig,
        this.globalPath,
      );
    }
    if (this.localConfig && this.localPath) {
      this.localConfig = await this.applyMigrations(
        this.localConfig,
        this.localPath,
      );
    }
    this.resolved = this.merge();
  }

  getConfig(): ResolvedConfig {
    if (!this.resolved)
      throw new Error("Config not loaded. Call load() first.");
    return this.resolved;
  }

  getRawConfig(scope: Scope): GuardrailsConfig | null {
    if (scope === "global") return this.globalConfig;
    if (scope === "local") return this.localConfig;
    return this.memoryConfig;
  }

  hasScope(scope: Scope): boolean {
    return this.scopes.includes(scope);
  }

  hasConfig(scope: Scope): boolean {
    if (!this.hasScope(scope)) return false;
    return this.getRawConfig(scope) !== null;
  }

  getEnabledScopes(): Scope[] {
    return [...this.scopes];
  }

  drainMessages(): string[] {
    return this.pendingMessages.splice(0);
  }

  async save(scope: Scope, config: GuardrailsConfig): Promise<void> {
    if (!this.hasScope(scope)) {
      throw new Error(`Scope "${scope}" is not enabled`);
    }
    if (scope === "memory") {
      this.memoryConfig = config;
      this.resolved = this.merge();
      return;
    }
    if (scope === "local" && !this.localPath) {
      const marker = this.runtime === "pi" ? ".pi" : ".omp";
      this.localPath = resolve(this.cwd, marker, "extensions/guardrails.json");
    }
    const path = scope === "global" ? this.globalPath : this.localPath;
    if (!path) throw new Error(`No path configured for scope "${scope}"`);
    await writeJson(path, ensureConfigVersion(config), this.schemaUrl);
    const savedMemory = this.memoryConfig;
    this.globalConfig = await this.readWithFallback(this.globalPath);
    this.localConfig = this.localPath
      ? await this.readWithFallback(this.localPath)
      : null;
    this.memoryConfig = savedMemory;
    this.resolved = this.merge();
  }

  private async readWithFallback(
    path: string,
  ): Promise<GuardrailsConfig | null> {
    const fallback = this.migrationFallbacks.get(path);
    const current = await readJson(path);
    return current ?? fallback ?? null;
  }

  private async migrateLegacyConfig(): Promise<void> {
    const localRoot = findMarkerRoot(".pi", this.cwd, this.home);
    const candidates: Array<[string, string]> = [];
    if (localRoot) {
      const destination = resolve(localRoot, ".omp/extensions/guardrails.json");
      this.localPath ??= destination;
      candidates.push([
        resolve(localRoot, ".pi/extensions/guardrails.json"),
        destination,
      ]);
    }
    candidates.push([
      configPath("pi", "global", this.cwd, this.home) as string,
      this.globalPath,
    ]);
    const seen = new Set<string>();
    for (const [source, destination] of candidates) {
      if (seen.has(source)) continue;
      seen.add(source);
      if (!existsSync(source)) continue;
      await this.migrateFile(source, destination);
    }
  }

  private async migrateFile(
    source: string,
    destination: string,
  ): Promise<void> {
    let legacy: GuardrailsConfig;
    try {
      legacy = await readJsonStrict(source);
    } catch (error) {
      this.recordMigrationFailure(
        source,
        `could not read legacy configuration: ${error}`,
      );
      return;
    }

    let existing: GuardrailsConfig | null = null;
    if (existsSync(destination)) {
      try {
        existing = await readJsonStrict(destination);
      } catch (error) {
        this.recordMigrationFailure(
          destination,
          `could not read OMP configuration: ${error}`,
          legacy,
          destination,
        );
        return;
      }
    }
    const merged = existing
      ? (structuredClone(existing) as GuardrailsConfig)
      : (structuredClone(legacy) as GuardrailsConfig);
    if (existing) {
      mergeMissing(
        merged as Record<string, unknown>,
        legacy as Record<string, unknown>,
      );
    }

    try {
      await writeJsonAtomically(destination, merged, this.schemaUrl);
    } catch (error) {
      this.recordMigrationFailure(
        destination,
        `could not write migrated configuration: ${error}`,
        merged,
        destination,
      );
      return;
    }
    try {
      await rm(source, { force: false });
    } catch (error) {
      this.recordMigrationFailure(
        source,
        `could not remove legacy configuration: ${error}`,
        merged,
        destination,
      );
      return;
    }
    await this.pruneEmptyLegacyDirectories(source);
  }

  private recordMigrationFailure(
    path: string,
    reason: string,
    fallback?: GuardrailsConfig,
    fallbackPath?: string,
  ): void {
    this.pendingMessages.push(
      `Could not migrate Guard Kit configuration at ${path}: ${reason} Legacy settings were preserved for retry.`,
    );
    if (fallback && fallbackPath)
      this.migrationFallbacks.set(fallbackPath, fallback);
  }

  private async pruneEmptyLegacyDirectories(source: string): Promise<void> {
    const extensionsDirectory = dirname(source);
    const markerDirectory = dirname(extensionsDirectory);
    if (resolve(markerDirectory).split(/[\\/]/).pop() !== ".pi") return;
    await rmdir(extensionsDirectory).catch(() => undefined);
    await rmdir(markerDirectory).catch(() => undefined);
  }

  private async applyMigrations(
    config: GuardrailsConfig,
    filePath: string,
  ): Promise<GuardrailsConfig> {
    let current = config;
    let currentVersion =
      typeof config.version === "string" ? config.version : "0.0.0";
    const appliedMigrations: string[] = [];
    let changed = false;
    for (const migration of migrations as Migration<GuardrailsConfig>[]) {
      const ctx: MigrationContext = {
        filePath,
        appliedMigrations,
        fromVersion: currentVersion,
        toVersion: migration.version ?? currentVersion,
      };
      const shouldRun = migration.shouldRun
        ? migration.shouldRun(current, ctx)
        : compareVersions(currentVersion, String(migration.version)) < 0;
      if (!shouldRun) continue;
      const before = current;
      try {
        current = await migration.run(current, filePath, ctx);
        changed = true;
        appliedMigrations.push(migration.name);
        if (
          migration.version !== undefined &&
          compareVersions(currentVersion, String(migration.version)) < 0
        ) {
          currentVersion = String(migration.version);
          current = { ...current, version: currentVersion };
        }
        const message = this.resolveMigrationMessage(
          migration,
          before,
          current,
          filePath,
          ctx,
        );
        if (message) this.pendingMessages.push(message);
      } catch (error) {
        console.error(
          `[settings] Migration "${migration.name}" failed for ${filePath}: ${error}`,
        );
        if (migration.version !== undefined) break;
      }
    }
    if (changed) {
      try {
        await writeJson(filePath, current, this.schemaUrl);
      } catch (error) {
        console.error(
          `[settings] Failed to save migrated config to ${filePath}: ${error}`,
        );
      }
    }
    return current;
  }

  private resolveMigrationMessage(
    migration: Migration<GuardrailsConfig>,
    before: GuardrailsConfig,
    after: GuardrailsConfig,
    filePath: string,
    ctx: MigrationContext,
  ): string | undefined {
    if (!migration.message) return undefined;
    try {
      return typeof migration.message === "function"
        ? migration.message(before, after, filePath, ctx)
        : migration.message;
    } catch (error) {
      console.error(
        `[settings] Failed to build migration message "${migration.name}" for ${filePath}: ${error}`,
      );
      return undefined;
    }
  }

  private merge(): ResolvedConfig {
    const resolved = structuredClone(this.defaults) as ResolvedConfig;
    if (this.globalConfig) {
      deepMerge(
        resolved as unknown as Record<string, unknown>,
        this.globalConfig as Record<string, unknown>,
      );
    }
    if (this.localConfig) {
      deepMerge(
        resolved as unknown as Record<string, unknown>,
        this.localConfig as Record<string, unknown>,
      );
    }
    if (this.memoryConfig) {
      deepMerge(
        resolved as unknown as Record<string, unknown>,
        this.memoryConfig as Record<string, unknown>,
      );
    }
    const ruleMap = new Map<string, PolicyRule>();
    if (resolved.applyBuiltinDefaults) {
      for (const rule of DEFAULT_CONFIG.policies.rules)
        ruleMap.set(rule.id, rule);
    }
    for (const layer of [
      this.globalConfig,
      this.localConfig,
      this.memoryConfig,
    ]) {
      for (const rule of layer?.policies?.rules ?? [])
        ruleMap.set(rule.id, rule);
    }
    resolved.policies.rules = [...ruleMap.values()];
    const customPatterns =
      this.memoryConfig?.permissionGate?.customPatterns ??
      this.localConfig?.permissionGate?.customPatterns ??
      this.globalConfig?.permissionGate?.customPatterns;
    if (customPatterns) {
      resolved.permissionGate.patterns = customPatterns;
      resolved.permissionGate.useBuiltinMatchers = false;
    }
    const mergedPaths = new Map<string, AllowedPath>();
    for (const paths of [
      this.globalConfig?.pathAccess?.allowedPaths,
      this.localConfig?.pathAccess?.allowedPaths,
      this.memoryConfig?.pathAccess?.allowedPaths,
    ]) {
      for (const entry of paths ?? []) {
        if (!entry || typeof entry !== "object") continue;
        const path = typeof entry.path === "string" ? entry.path.trim() : "";
        if (!path) continue;
        const kind = entry.kind === "directory" ? "directory" : "file";
        mergedPaths.set(`${kind}:${path}`, { kind, path });
      }
    }
    resolved.pathAccess.allowedPaths = [...mergedPaths.values()];
    resolved.rootArtifacts = normalizeRootArtifacts(
      resolved.rootArtifacts,
      this.globalConfig?.rootArtifacts,
      this.localConfig?.rootArtifacts,
      this.memoryConfig?.rootArtifacts,
    );
    return resolved;
  }
}

export function createGuardrailsConfigLoader(
  runtime: ConfigRuntime = "pi",
  options: LoaderOptions = {},
): GuardrailsConfigLoader {
  return new GuardrailsConfigLoader(runtime, options);
}

let singletonRuntime: ConfigRuntime = "pi";
export let configLoader = createGuardrailsConfigLoader(singletonRuntime);

export function configureConfigRuntime(runtime: ConfigRuntime): void {
  if (runtime === singletonRuntime) return;
  if (configLoader.hasStarted) {
    throw new Error(
      `Cannot switch Guard Kit config runtime from ${singletonRuntime} to ${runtime} after loading or saving configuration.`,
    );
  }
  singletonRuntime = runtime;
  configLoader = createGuardrailsConfigLoader(runtime);
}
