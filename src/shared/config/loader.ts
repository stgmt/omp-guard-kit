import {
  buildSchemaUrl,
  ConfigLoader,
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

class GuardrailsConfigLoader extends ConfigLoader<
  GuardrailsConfig,
  ResolvedConfig
> {
  override async save(scope: Scope, config: GuardrailsConfig): Promise<void> {
    await super.save(scope, ensureConfigVersion(config));
  }
}

function ensureConfigVersion(config: GuardrailsConfig): GuardrailsConfig {
  if (typeof config.version === "string" && config.version.trim()) {
    return config;
  }
  return { ...config, version: pkg.version };
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
export function createGuardrailsConfigLoader(): GuardrailsConfigLoader {
  return new GuardrailsConfigLoader("guardrails", DEFAULT_CONFIG, {
    scopes: ["global", "local", "memory"],
    migrations,
    schemaUrl: buildSchemaUrl(pkg.name, pkg.version),
    afterMerge: (resolved, global, local, memory) => {
      const ruleMap = new Map<string, PolicyRule>();

      if (resolved.applyBuiltinDefaults) {
        for (const rule of DEFAULT_CONFIG.policies.rules) {
          ruleMap.set(rule.id, rule);
        }
      }
      if (global?.policies?.rules) {
        for (const rule of global.policies.rules) {
          ruleMap.set(rule.id, rule);
        }
      }
      if (local?.policies?.rules) {
        for (const rule of local.policies.rules) {
          ruleMap.set(rule.id, rule);
        }
      }
      if (memory?.policies?.rules) {
        for (const rule of memory.policies.rules) {
          ruleMap.set(rule.id, rule);
        }
      }
      resolved.policies.rules = [...ruleMap.values()];

      const customPatterns =
        memory?.permissionGate?.customPatterns ??
        local?.permissionGate?.customPatterns ??
        global?.permissionGate?.customPatterns;
      if (customPatterns) {
        resolved.permissionGate.patterns = customPatterns;
        resolved.permissionGate.useBuiltinMatchers = false;
      }

      const mergedPaths = new Map<string, AllowedPath>();
      for (const paths of [
        global?.pathAccess?.allowedPaths,
        local?.pathAccess?.allowedPaths,
        memory?.pathAccess?.allowedPaths,
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
        global?.rootArtifacts,
        local?.rootArtifacts,
        memory?.rootArtifacts,
      );

      return resolved;
    },
  });
}

export const configLoader = createGuardrailsConfigLoader();
