# OMP extension contract audit

Date: 2026-08-31
Repository: `stgmt/omp-guard-kit`
Source baseline: `aliou/pi-guardrails` tag `v0.17.1` (`bec4c8be8ed93cf9ba28e3034ec8553e0b5cea6c`)
Active OMP: `omp/18.0.10`

## Host evidence

The active runtime source is under `C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent`.

- `src/extensibility/hooks/types.ts:306-314` defines `ToolCallEvent` as `{ type: "tool_call", toolName, toolCallId, input }`, where `input` is `Record<string, unknown>`.
- `src/extensibility/shared-events.ts:306-332` defines `ToolCallEventResult`; a handler may return `block?: boolean`, `reason?: string`, or replacement `input`.
- `src/extensibility/extensions/runner.ts:1444-1485` implements `emitToolCall()`. It invokes registered handlers sequentially and returns immediately when a result has `block: true`. Handler timeout/error is converted to a blocking result at lines 1456-1469.
- `src/extensibility/hooks/tool-wrapper.ts:42-74` emits `tool_call` before the underlying tool and throws the returned reason before execution at lines 57-60. Therefore a blocked write cannot reach the tool implementation.
- `src/extensibility/extensions/loader.ts:439-465` implements `loadExtensions()` and binds extension factories in configured path order.
- `src/extensibility/extensions/loader.ts:474-480` reads `package.json`, selecting `pkg.omp ?? pkg.pi`; `:491-492` accepts `.ts` and `.js`; `:498-515` resolves manifest extension entries.
- `src/extensibility/extensions/runner.ts:629-631` exposes the live session `cwd`; `:633-642` exposes the stable `sessionId`.
- `src/extensibility/hooks/types.ts:281-287` defines `BeforeAgentStartEvent` with only `type`, `prompt`, and optional `images`; it has no `systemPromptOptions` or `skills` field.

## Design consequence

Root-artifact decisions are deterministic policy decisions made in a pre-tool `tool_call` handler. They do not depend on an LLM response: OMP stops at the first blocking handler result, and the wrapped tool is not executed. Any classifier text is diagnostic only and cannot override the returned `{ block: true, reason }`.

The adapter must preserve the legacy `pi.extensions` entries for Pi hosts and expose a compiled `omp.extensions` entry for OMP. The path-access extension must treat the absent `systemPromptOptions.skills` field as normal for OMP 18.0.10 and retain its dynamic-resource fallback.
