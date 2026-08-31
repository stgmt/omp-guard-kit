# OMP Guard Kit command namespace rename

Date: 2026-08-31
Status: approved implementation design

## Decision

Register only /omp-guard-kit:onboarding, /omp-guard-kit:settings, and /omp-guard-kit:examples. Do not register compatibility aliases or any fallback namespace. Unknown commands from the previous namespace must fail explicitly so the package has one unambiguous public command surface.

Update every active user-facing reference and message to the canonical namespace. Do not rename configuration keys, event IDs, feature IDs, or internal source directories: guardrails remains the feature name and those identifiers are existing persisted/runtime contracts, not slash-command UX.

## Grounded facts

| Claim | Evidence |
| --- | --- |
| OMP extensions register a command by an arbitrary string name plus description and handler. | `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts:1321-1329` |
| The extension loader stores the command under the exact supplied name in a `Map`. | `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/loader.ts:195-204` |
| The runner enumerates registered commands and resolves a command by exact name. | `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/runner.ts:1094-1120` |
| The settings helper accepts a string `commandName` and registers it unchanged. | `C:/Users/stigm/.omp/plugins/node_modules/@aliou/pi-utils-settings/src/settings-command.ts:102-113`, `:222-225` |
| Canonical onboarding command is registered through the centralized command catalog. | E:/repos/omp-repo-guard/extensions/guardrails/commands/onboarding/index.ts:15-20 |
| Canonical settings command is registered with the settings helper. | E:/repos/omp-repo-guard/extensions/guardrails/commands/settings/index.ts:657-661 |
| Canonical examples command is registered through the centralized command catalog. | E:/repos/omp-repo-guard/extensions/guardrails/commands/examples/index.ts:492-496 |
| Onboarding UX embeds the canonical settings command in its completion notice. | E:/repos/omp-repo-guard/extensions/guardrails/commands/onboarding/index.ts:24-27 |

## Architecture

```text
central command catalog
  ├── canonical: omp-guard-kit:onboarding/settings/examples
          │
          ├── onboarding command registration
          ├── settings helper registration
          └── examples command registration
          │
          └── current wizard, config store, and policy behavior unchanged
```

The catalog is data-only. Each command implementation remains responsible for its existing handler/UI. There is no compatibility registration and no duplicate policy or configuration logic.

## Failure modes

| Case | Expected behavior | Disposition |
| --- | --- | --- |
| Canonical command lookup | Resolves exact omp-guard-kit:* key. | Blocking acceptance case |
| Previous namespace lookup | Is not registered; OMP returns an unknown-command result. | Blocking acceptance case |
| Duplicate registration | Impossible for the three canonical names because the catalog is unique; OMP exact-name map semantics are covered by the source evidence above. | Blocking acceptance case |
| Settings command | Opens the existing scope tabs, editor, save behavior, and config store. | Blocking acceptance case |
| Non-UI/print invocation | Existing handlers retain their current no-op behavior when ctx.hasUI is false. | Non-regression case |
| Long namespace in command palette | Functional registration is grounded; visual width and wrapping require a real OMP UI smoke check. | Non-blocking probe |

## Rejected alternatives

| Alternative | Reason rejected |
| --- | --- |
| Rename to /omp:* | Shorter, but does not match the installed package identity and creates another product namespace. |
| Keep compatibility aliases | Rejected: the public surface must have no fallback commands or duplicate names. |
| Rename config/event identifiers too | Unrelated to slash-command UX and risks persisted configuration, event consumers, and integrations. |

## Probe list

- Z-1, non-blocking: visually inspect command palette rendering with the omp-guard-kit namespace in a real OMP TUI.
- Z-2, blocking before release: verify the compiled bundle's extension command map contains exactly the three canonical names and no legacy names.
- Z-3, blocking before release: invoke canonical registration handlers through the OMP runner and prove previous namespace lookups do not resolve.

## Work order

1. Add the centralized canonical-only command catalog.
2. Register only canonical names in onboarding, settings, and examples.
3. Replace active docs, notifications, and examples with canonical names; remove migration-only alias guidance.
4. Add unit/loader coverage for the three registered names and absence of legacy names.
5. Build and run package tests plus the active OMP loader/runner E2E.
6. Verify the target project has no stale active command references, then publish a semver-minor direct-cutover release.

## Acceptance scenarios

1. A fresh project user reads README and uses /omp-guard-kit:onboarding, /omp-guard-kit:settings, and /omp-guard-kit:examples successfully.
2. A previous-namespace command lookup fails as unknown instead of invoking a fallback.
3. The loaded compiled extension exposes exactly the three canonical names and no legacy aliases.
4. Existing root-artifact, policy, path-access, permission-gate, and Herdr behavior is unchanged.
