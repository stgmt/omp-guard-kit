---
"omp-guard-kit": minor
---

Single tool_call/session_start dispatcher with per-project root setup

- One `tool_call` handler fans out to policies, pathAccess,
  permissionGate and rootArtifacts in historical order with first-block-wins,
  replacing four independent registrations.
- One `session_start` handler owns feature discovery, config warnings,
  root diagnostics and a once-per-project setup hint.
- New `omp-guard-kit:setup` command enables root-artifact protection for
  the current project (local `rootArtifacts.enabled` + mode) in two answers.
