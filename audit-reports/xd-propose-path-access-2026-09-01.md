# `xd://propose` false path blocking

## Problem

`omp-guard-kit` has two independent pre-execution guards. The reported `allowedDirectories` error comes from root-artifact protection: its direct write-target collector treated every string in `path`/`file_path`/related fields as a filesystem path. For `write({ path: "xd://propose", ... })`, root policy normalization sees a root entry named `xd:` and can block it because `xd:` is not an allowed directory.

Path access had the same raw direct-target assumption, so the fix covers both guards. This matters when both features are enabled in a native OMP session.

## Grounded facts

| Fact | Evidence |
| --- | --- |
| OMP's write tool recognizes `xd://` targets and explicitly lists `xd://propose` as a resolution device. | `C:\Users\stigm\.omp\plugins\node_modules\@oh-my-pi\pi-coding-agent\src\tools\write.ts:509-515` |
| OMP emits `tool_call` before tool execution; hooks can block execution. | `C:\Users\stigm\.omp\plugins\node_modules\@oh-my-pi\pi-coding-agent\src\extensibility\hooks\types.ts:302-314` |
| A hook can block by returning `{ block, reason }`; the reason is returned as the tool error. | `C:\Users\stigm\.omp\plugins\node_modules\@oh-my-pi\pi-coding-agent\src\extensibility\shared-events.ts:306-318` |
| Root-artifact protection collects direct write-tool path fields before evaluating `allowedDirectories`. | `extensions/root-artifacts/index.ts:68-94`; `extensions/root-artifacts/index.ts:191-225` |
| Path access resolves direct file-tool fields against `cwd`. | `extensions/path-access/targets.ts:9-12` |
| Guard Kit already has a shared, case-insensitive URI-scheme detector. | `src/core/paths/plausibility.ts:24-25,46-52`; `src/shared/paths/bash-paths.ts:67-70` |

## Decision

Reuse `hasNonPathShape` before filesystem normalization in both direct-target paths:

- root-artifact direct writes skip URI-like values before `evaluateRootArtifactTarget`;
- path-access direct file tools skip the same URI-like values before `resolveFromCwd`.

This includes `xd://propose`, `xd://resolve`, and `xd://reject`, without hard-coding one device name. Real relative, absolute, home, Windows, and UNC paths remain subject to the existing guards.

No OMP hook, prompt, daemon, allowlist, or policy semantics changed. Existing fail-closed hook behavior remains intact for actual filesystem paths.

## Data flow

```text
raw direct-tool address
          |
          v
     hasNonPathShape
       | true                 | false
       v                      v
no filesystem target     existing path normalization
                              |
                              v
                       existing guard/policy
```

## Failure modes

| Input | Expected result | Reason |
| --- | --- | --- |
| `xd://propose` | no target in either guard; OMP receives the call | OMP device address |
| `xd://resolve`, `xd://reject` | no target | OMP device addresses |
| `XD://propose`, `https://…`, `file://…`, `s3://…` | no target | URI scheme is case-insensitive / non-filesystem |
| `../secret`, `/tmp/secret`, `~/secret` | filesystem target remains visible | real path checks must remain active |
| `C:\\tmp\\secret`, `\\\\server\\share\\secret` | filesystem target remains visible | Windows/UNC path behavior must remain active |

## Rejected alternatives

| Alternative | Rejection |
| --- | --- |
| Add `xd:` to `allowedDirectories` | Makes a device protocol look like a filesystem exception and leaves other device addresses exposed. |
| Special-case only `xd://propose` | Duplicates protocol knowledge and does not cover the other resolution devices. |
| Change `resolveFromCwd` globally | Path resolution is valid for filesystem callers; filtering belongs at target extraction. |
| Disable root-artifact or path-access protection for `write` | Removes protection from genuine writes. |

## Probe list

- No blocking probes. The OMP contract and both failing Guard Kit paths are locally available.
- Non-blocking: marketplace installation after publication should confirm the released bundle carries the same behavior as the local native bundle.

## Work order

1. Filter URI-shaped direct targets in root-artifact and path-access extraction.
2. Add edge cases for resolution devices, URI casing, and real path preservation.
3. Add mutation-boundary tests for both hooks and include them in `test:mutation`.
4. Bump the patch version, update marketplace metadata, build, and run all checks.
5. Release through the existing OMP-only GitHub/marketplace procedure.

## Acceptance scenarios

1. With root-artifact protection enabled and `allowedDirectories` not containing `xd:`, `write({path: "xd://propose"})` is not blocked by Guard Kit.
2. With path access also enabled, the same call is not blocked by the path guard.
3. Removing either URI filter fails its mutation-boundary test.
4. A genuine outside-workspace write remains a target and is still blocked.
5. The native OMP loader loads the built bundle and the E2E scenario proves the `xd://propose` call passes while real root writes remain blocked.
