---
"omp-guard-kit": minor
---

Commit gate for root artifacts: check-root CLI plus managed pre-commit hook

- New `guard-kit-check-root` bin evaluates staged root entries against
  the project-local policy with the same engine as the extension.
  Unconfigured projects pass silently; violations exit 1.
- The setup checklist offers to install a managed pre-commit hook that
  runs the staged check. Foreign hooks and custom `core.hooksPath`
  setups are never overwritten: they get a manual snippet instead.
