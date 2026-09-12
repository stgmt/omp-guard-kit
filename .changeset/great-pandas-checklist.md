---
"omp-guard-kit": minor
---

Automatic root-setup checklist on first session

- When root-artifact protection is off, the first interactive session
  shows an `askDialog` checklist of flagged root entries (green count vs
  would-be-blocked with classification reasons) plus an enable question.
- Answering enables protection and writes the local allowlist; declining
  or postponing leaves state untouched so the hook asks again next
  session. Cancelling falls back to the `/omp-guard-kit:setup` hint.
- The `/omp-guard-kit:setup` command now runs the same checklist on
  demand. The flow is fail-open and never fires twice per project per
  process.
