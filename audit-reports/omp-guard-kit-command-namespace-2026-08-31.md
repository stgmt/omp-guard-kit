# OMP Guard Kit command namespace rename

Date: 2026-08-31
Status: approved implementation design

## Decision

Make `/omp-guard-kit:onboarding`, `/omp-guard-kit:settings`, and `/omp-guard-kit:examples` the canonical public commands. Keep the three `/guardrails:*` names as one-release compatibility aliases with explicit legacy descriptions, so existing users do not receive an unknown-command failure during migration.

Update every active user-facing reference and message to the canonical namespace. Do not rename configuration keys, event IDs, feature IDs, or internal source directories: `guardrails` remains the feature name and those identifiers are existing persisted/runtime contracts, not slash-command UX.

## Grounded facts

| Claim | Evidence |
| --- | --- |
| OMP extensions register a command by an arbitrary string name plus description and handler. | `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:1321-1329` |
| The extension loader stores the command under the exact supplied name in a `Map`. | `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/loader.ts:195-204` |
| The runner enumerates registered commands and resolves a command by exact name. | `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:1094-1120` |
| The settings helper accepts a string `commandName` and registers it unchanged. | `C:/Users/stigm/.omp/plugins/node_modules/@aliou/pi-utils-settings/src/settings-command.ts:102-113`, `:222-225` |
| Current onboarding command is registered as `guardrails:onboarding`. | `E:/repos/omp-repo-guard/extensions/guardrails/commands/onboarding/index.ts:13` |
| Current settings command is registered as `guardrails:settings`. | `E:/repos/omp-repo-guard/extensions/guardrails/commands/settings/index.ts:289-292` |
| Current examples command is registered as `guardrails:examples`. | `E:/repos/omp-repo-guard/extensions/guardrails/commands/examples/index.ts:490-492` |
| Current onboarding UX embeds the old settings command in its completion notice. | `E:/repos/omp-repo-guard/extensions/guardrails/commands/onboarding/index.ts:20-22` |

## Architecture

```text
central command catalog
  ├── canonical: omp-guard-kit:onboarding/settings/examples
  └── legacy:    guardrails:onboarding/settings/examples
          │
          ├── onboarding command registration
          ├── settings helper registration (canonical + legacy)
          └── examples command registration
          │
          └── current wizard, config store, and policy behavior unchanged
```

The catalog is data-only. Each command implementation remains responsible for its existing handler/UI. The compatibility registrations reuse the same behavior; they do not fork policy or configuration logic.

## Failure modes

| Case | Expected behavior | Disposition |
| --- | --- | --- |
| Canonical command lookup | Resolves exact `omp-guard-kit:*` key. | Blocking acceptance case |
| Existing `/guardrails:*` input | Resolves compatibility alias and shows migration guidance. | Blocking acceptance case |
| Duplicate registration | Impossible for the six names because the catalog is unique; OMP exact-name map semantics are covered by the source evidence above. | Blocking acceptance case |
| Settings opened through either name | Same scope tabs, editor, save behavior, and config store. | Blocking acceptance case |
| Non-UI/print invocation | Existing handlers retain their current no-op behavior when `ctx.hasUI` is false. | Non-regression case |
| Long namespace in command palette | Functional registration is grounded; visual width and wrapping require a real OMP UI smoke check. | Non-blocking probe |

## Rejected alternatives

| Alternative | Reason rejected |
| --- | --- |
| Rename to `/omp:*` | Shorter, but does not match the installed package identity and creates another product namespace. |
| Remove old commands immediately | Breaks existing user sessions and creates the exact frustration this change is intended to avoid. |
| Rename config/event identifiers too | Unrelated to slash-command UX and risks persisted configuration, event consumers, and integrations. |
| Duplicate wizard or settings implementation for aliases | Creates behavioral drift; aliases must call the same existing implementation. |

## Probe list

- **Z-1, non-blocking:** visually inspect command palette rendering with the `omp-guard-kit` namespace in a real OMP TUI.
- **Z-2, blocking before release:** verify the compiled bundle's extension command map contains all three canonical names and all three aliases.
- **Z-3, blocking before release:** invoke registration handlers through the OMP runner and prove both namespaces resolve without loader errors.

## Work order

1. Add the centralized canonical/legacy command catalog.
2. Register canonical names and compatibility aliases in onboarding, settings, and examples.
3. Replace active docs, notifications, and examples with canonical names; document aliases as migration-only.
4. Add unit/loader coverage for the six registered names.
5. Build and run package tests plus the active OMP loader/runner E2E.
6. Verify the target project has no stale active command references, then publish a semver-minor release with migration notes.

## Acceptance scenarios

1. A fresh project user reads README and uses `/omp-guard-kit:onboarding`, `/omp-guard-kit:settings`, and `/omp-guard-kit:examples` successfully.
2. A migrated user enters `/guardrails:settings` and receives the same settings UI with a clear canonical-command hint.
3. The loaded compiled extension exposes exactly the canonical commands plus their three documented legacy aliases; no old name remains in active README or notification text except the migration section.
4. Existing root-artifact, policy, path-access, permission-gate, and Herdr behavior is unchanged.
