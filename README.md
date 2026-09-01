# OMP Guard Kit

OMP Guard Kit adds safety checks to Pi so agents are less likely to read secrets, write protected files, access paths outside the workspace, or run dangerous shell commands by accident.

This package installs five Pi/OMP extensions:

- **guardrails** for file protection policies, settings, onboarding, and examples.
- **path-access** for controlling access outside the current workspace.
- **permission-gate** for confirming or blocking risky shell commands.
- **herdr** for reporting OMP Guard Kit approval prompts to Herdr.
- **root-artifacts** for deterministic protection of unexpected project-root files and directories.
## Install

For OMP, add the GitHub marketplace and install the pinned release:

```bash
omp plugin marketplace add https://github.com/stgmt/omp-guard-kit
omp plugin install omp-guard-kit@omp-guard-kit --scope project
```

For a project-specific guard, keep the plugin project-scoped as shown above. Use `--scope user` only when you want the plugin available in every project.
Pi can load the same package from the tagged GitHub release:

```bash
pi install https://github.com/stgmt/omp-guard-kit#v0.22.0
```

## First run

After installing, run the onboarding command to choose a starting setup:

```text
/omp-guard-kit:onboarding
```


You can change everything later with:

```text
/omp-guard-kit:settings
```

## What to do first

1. Start OMP from the project directory you want to protect.
2. Run `/omp-guard-kit:onboarding` and choose the protections you want enabled.
3. Open `/omp-guard-kit:settings` whenever you need to change a rule.
4. Use `/omp-guard-kit:examples` to add a preset without replacing existing settings.
5. Try a harmless write. A disallowed root file is blocked before the tool runs; an allowed nested path continues normally.
## Command namespace

The public command namespace follows the package name:

- `/omp-guard-kit:onboarding` starts the first-run wizard.
- `/omp-guard-kit:settings` opens the settings editor.
- `/omp-guard-kit:examples` adds presets without replacing existing settings.

The `omp-guard-kit:` namespace is the only registered public command namespace.

## Included extensions

### guardrails

The `guardrails` extension owns file protection policies and the user-facing commands.

Use it to protect files like `.env`, private keys, local credentials, generated logs, database dumps, or any project-specific path you do not want Pi to read or modify without clear intent.


Useful commands:

```text
/omp-guard-kit:settings
/omp-guard-kit:onboarding
/omp-guard-kit:examples
```

#### Herdr integration

The included Herdr adapter reports active OMP Guard Kit approval prompts through Herdr's `herdr:blocked` event. Herdr can then show the Pi pane as blocked while it waits for a permission-gate or path-access decision.

The adapter has no configuration or direct Herdr dependency. Its emitted events have no effect unless Herdr's Pi integration is active.

### path-access

The `path-access` extension checks tool calls that target paths outside the current working directory.

It can allow, block, or ask before Pi accesses files elsewhere on your machine. In ask mode, you can allow one file or a directory once, for the session, or always.

Granted paths are stored in `pathAccess.allowedPaths` as explicit `{ kind, path }` entries: `file` matches the exact path, `directory` matches the directory and its descendants. Edit them through `/omp-guard-kit:settings` (Path Access → Allowed paths, Tab toggles file/directory) or directly in the settings file. Paths support `~/` for home. Existing configs using the legacy string form (trailing `/` for directories) are migrated automatically.


### permission-gate

The `permission-gate` extension detects dangerous bash commands before they run.

It catches built-in risky patterns like recursive deletes, privileged commands, disk formatting, broad permission changes, and configured custom patterns. You can allow once, allow for the session, deny, decline and stop (which also aborts the current turn), or configure auto-deny rules.

### root-artifacts

The `root-artifacts` extension is disabled by default and only activates from a project-local Guard Kit settings file with `rootArtifacts.enabled: true`. Ordinary Pi stores it at `.pi/extensions/guardrails.json`; native OMP stores it at `.omp/extensions/guardrails.json`. It checks write/edit tool calls before execution and blocks root files outside the configured allowlist, root directories outside `allowedDirectories`, unresolved shell destinations, and paths that escape the project.

Its policy is deterministic: deny patterns take priority, matching is case-insensitive, `.git`, `.svn`, and `.hg` are skipped, and root entries are classified as `trash`, `config`, or `unknown` for diagnostics. `autoPrune.enabled` is opt-in and atomically removes only safe stale basename entries from the local `allow` list.

Relevant configuration fields are `mode` (`extend` or `replace`), `allow`, `deny`, `allowedDirectories`, `ignorePatterns`, `trashPatterns`, `configPatterns`, and `autoPrune`.

For a project-local root-artifact guard, create the Guard Kit settings file in the project. Use `.pi/extensions/guardrails.json` for ordinary Pi or `.omp/extensions/guardrails.json` for native OMP:

```json
{
  "enabled": true,
  "features": {
    "rootArtifacts": true
  },
  "rootArtifacts": {
    "enabled": true,
    "mode": "extend",
    "allow": ["README.md", "package.json"],
    "deny": [],
    "allowedDirectories": [".pi", ".omp", "src", "tests"],
    "ignorePatterns": [],
    "trashPatterns": [],
    "configPatterns": [],
    "autoPrune": {
      "enabled": false
    }
  }
}
```

How the fields behave:

- `mode: "extend"` keeps the built-in safe file allowlist and adds your `allow` entries. `mode: "replace"` uses only your `allow` entries.
- `allow` and `deny` match root-level file names and simple glob patterns, case-insensitively. `deny` always wins.
- `allowedDirectories` controls immediate directories at the project root. Once a directory is allowed, its descendants are allowed.
- `ignorePatterns` hides matching file violations; it does not allow an unknown root directory.
- `trashPatterns` and `configPatterns` label diagnostics. They do not grant access.
- `autoPrune.enabled` removes only safe, stale basename entries from the local `allow` list. Keep it false unless you want that cleanup.

With the example above:

| Operation | Result |
| --- | --- |
| `echo x > unexpected.txt` | Blocked before execution. |
| `echo x > src/file.txt` | Allowed because `src` is an allowed directory. |
| `mkdir tmp` | Blocked because `tmp` is not in `allowedDirectories`. |
| `echo x > "$OUT/file.txt"` | Blocked because the shell destination is unresolved. |
## Extension events

OMP Guard Kit emits paired prompt lifecycle events on Pi's shared event bus:

- `guardrails:prompt:opened` when an interactive OMP Guard Kit prompt starts waiting for input.
- `guardrails:prompt:closed` when that prompt stops waiting, including when the UI throws.

Both events include the same `prompt.id` for correlation.

## Configuration

Most configuration should happen through the interactive settings UI:

```text
/omp-guard-kit:settings
```

Advanced users can edit the settings file directly:

- Pi global: `~/.pi/agent/extensions/guardrails.json`
- Pi project: `.pi/extensions/guardrails.json`
- OMP global: `~/.omp/agent/extensions/guardrails.json`
- OMP project: `.omp/extensions/guardrails.json`

Native OMP plugin-manager state remains under `.omp/plugins`; the JSON above is extension-owned configuration. When OMP first starts after this storage split, an existing `guardrails.json` is migrated from the matching Pi path automatically. OMP values win when both files exist, and legacy files are retained if migration cannot complete.

OMP Guard Kit writes a `$schema` field to saved settings files, so modern editors provide autocomplete and validation. The generated schema is committed at [`schema.json`](schema.json).

Choose the settings scope deliberately:

- Use the project file for rules that protect one repository. This is the recommended location for `rootArtifacts`.
- Use the global file for defaults that should apply across projects.
- If both scopes exist, start with the project file when diagnosing a rule for the current repository.
## Troubleshooting

- Nothing is blocked: confirm that the session was started in the project directory and that top-level `enabled`, `features.rootArtifacts`, and `rootArtifacts.enabled` are all `true`.
- A root file is blocked: add its file name to `rootArtifacts.allow`, or use `mode: "replace"` only if you want to maintain the complete file allowlist yourself.
- A root directory is blocked: add the directory name to `rootArtifacts.allowedDirectories`. Adding a nested path to `allow` does not allow its parent directory.
- A command is blocked as unresolved: shell variables and command substitutions cannot be proven safe; use a concrete path or keep the command blocked.
- To see the current settings and edit them interactively, run `/omp-guard-kit:settings`. The guard emits a diagnostic event when it scans the project or blocks a write.

## Examples

Use the examples command to add common policy and command presets without replacing your existing config:

```text
/omp-guard-kit:examples
```


The available presets live in [`extensions/guardrails/commands/settings/examples.ts`](extensions/guardrails/commands/settings/examples.ts).

## Similar but different

Pi is designed to make agent safety extensible. OMP Guard Kit focuses on deterministic, configurable file policies, outside-workspace path access, and dangerous-command prompts. Other packages tend to fall into two useful groups.

See [pi.dev/packages](https://pi.dev/packages) for the full registry of Pi extensions.

### Make one yourself!

If OMP Guard Kit or the alternatives below do not fit your needs, you can also make your own. Start from the [Pi permission gate example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts), then ask Pi to customize it for your workflow.

### Permission and policy gates

These packages add checks around tool calls before they run. They are closest to OMP Guard Kit when you want policy enforcement without changing where Pi executes.

- [@gotgenes/pi-permission-system](https://pi.dev/packages/%40gotgenes/pi-permission-system): broad permission enforcement for Pi tool calls.
- [@vtstech/pi-security](https://pi.dev/packages/%40vtstech/pi-security): command, path, network, mode, and audit controls.
- [pi-control](https://github.com/mcowger/pi-control/blob/main/README.md): location-scoped, action-based policies for tool calls, with allow, log, ask, and deny outcomes before execution.
- [@casualjim/pi-heimdall](https://pi.dev/packages/%40casualjim/pi-heimdall): secret exposure guards, command policies, protected `.env` files, and a sandbox guard.
- [pi-file-permissions](https://pi.dev/packages/pi-file-permissions): file-level permissions for read, write, edit, find, grep, and ls tools.
- [pi-secret-guard](https://pi.dev/packages/pi-secret-guard): focused protection against committing or pushing secrets to git.

### Sandboxes and containment

These packages reduce blast radius by running Pi, subagents, or tool calls inside a constrained environment. They can be a better fit when you want isolation first and prompts second.

- [Pi + Gondolin sandbox example](https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts): upstream example that runs Pi tools inside a Gondolin micro-VM.
- [pi-sandbox](https://pi.dev/packages/pi-sandbox): OS-level sandboxing for bash, with allow/deny checks and prompts for file tools.
- [pi-container-sandbox](https://pi.dev/packages/pi-container-sandbox): runs read, write, edit, bash, and user bash operations inside a Docker or Apple container session.
- [@alexanderfortin/pi-freestyle-sandbox](https://pi.dev/packages/%40alexanderfortin/pi-freestyle-sandbox): runs sandboxed subagents in Freestyle cloud VMs.
- [@the-agency/vmpi](https://pi.dev/packages/%40the-agency/vmpi): runs Pi inside a QEMU microVM with limited filesystem and network access.
- [pi-claude-sandbox](https://pi.dev/packages/pi-claude-sandbox): Claude-style OS sandboxing with interactive permission prompts.

## Development

```bash
pnpm test         # Run tests
pnpm test:watch   # Run tests in watch mode
pnpm typecheck    # Type check
pnpm lint         # Lint
pnpm format       # Format
pnpm gen:schema   # Regenerate schema.json
pnpm check:schema # Verify schema.json is current
```
