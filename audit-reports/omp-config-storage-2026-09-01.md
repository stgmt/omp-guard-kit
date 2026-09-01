# OMP and Pi Configuration Storage Audit

Date: 2026-09-01

## Contract facts

| Fact | Evidence |
| --- | --- |
| Native OMP loads the omp manifest entry before the legacy-compatible pi entry. | Installed source: C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/loader.ts, lines 474-480; repository audit: audit-reports/omp-guard-kit-omp-contract.md. |
| The package native OMP entry is ./dist/extension.js. | package.json, omp.extensions. |
| Ordinary Pi continues to load the package pi.extensions entrypoints. | package.json, pi.extensions; Pi package documentation at https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/packages.md. |
| OMP project plugin state belongs under <project>/.omp/plugins. | OMP documentation: https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md. |
| The extension-owned Guard Kit JSON is separate from plugin-manager state. | OMP extension authoring documentation: https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md; implementation design below. |
| @aliou/pi-utils-settings has fixed Pi paths and no custom path option. | Upstream source: https://raw.githubusercontent.com/aliou/pi-utils-settings/main/src/config-loader.ts; its local fallback is .pi/extensions/{name}.json, and its global path is ~/.pi/agent/extensions/{name}.json. |

## Problem

The native OMP entrypoint currently calls the same feature modules as Pi. Those modules use the shared configLoader, which delegates path selection to @aliou/pi-utils-settings. Consequently, native OMP configuration can be written to .pi/extensions/guardrails.json even though plugin installation state is correctly stored under .omp/plugins.

## Design

src/shared/config/loader.ts owns path selection and preserves the existing ConfigStore surface and merge order. ConfigRuntime is either pi or omp:

- Pi global: ~/.pi/agent/extensions/guardrails.json.
- Pi local: nearest <project>/.pi/extensions/guardrails.json, with cwd fallback.
- OMP global: ~/.omp/agent/extensions/guardrails.json.
- OMP local: nearest <project>/.omp/extensions/guardrails.json, with cwd fallback.

The singleton remains Pi by default. extensions/omp.ts selects OMP before any feature loads. Switching after load/save is rejected to prevent mixed-runtime state.

## Migration and failure boundaries

On OMP startup, exact legacy files are migrated before configuration is read:

- .pi/extensions/guardrails.json to .omp/extensions/guardrails.json.
- ~/.pi/agent/extensions/guardrails.json to ~/.omp/agent/extensions/guardrails.json.

The destination is written atomically before the source is removed. When both exist, OMP values win and missing top-level legacy values are filled from Pi. Invalid JSON, read/write/delete failures preserve the legacy file, add one diagnostic, and keep it available as the current-run fallback. Empty legacy directories are pruned only after successful file deletion; non-empty .pi trees are retained. A second run with no legacy file is a no-op.

Migration is deliberately limited to guardrails.json; it does not move .pi/settings.json, other Pi extensions, or plugin-manager files.

## Acceptance scenarios

1. Pi local/global saves create only .pi configuration paths.
2. OMP local/global saves create only .omp configuration paths.
3. Existing local or global Pi Guard Kit settings migrate on first native OMP startup.
4. Conflicting files retain OMP values and fill only missing values from Pi.
5. Invalid legacy JSON and filesystem failures keep the legacy file and report one diagnostic.
6. Repeated OMP startup is idempotent and does not recreate .pi.
7. Real OMP loading executes the bundled native entrypoint; ordinary Pi entrypoints remain available.
8. Unit, mutation, E2E, typecheck, lint, schema, build, package, and release checks cover the changed contract.
