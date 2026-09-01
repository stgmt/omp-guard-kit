import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot =
  process.env.OMP_RUNTIME_ROOT ??
  "C:/Users/stigm/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent";
const runtimeModule = (relativePath: string) => {
  const packagedRuntimePaths: Record<string, string> = {
    "src/extensibility/extensions/loader.ts": "dist/core/extensions/loader.js",
    "src/extensibility/extensions/runner.ts": "dist/core/extensions/runner.js",
    "src/utils/event-bus.ts": "dist/core/event-bus.js",
    "src/session/session-manager.ts": "dist/core/session-manager.js",
  };
  const resolvedPath =
    process.env.OMP_RUNTIME_DIST === "true"
      ? packagedRuntimePaths[relativePath]
      : relativePath;
  if (!resolvedPath) throw new Error(`No packaged runtime mapping for ${relativePath}`);
  return import(pathToFileURL(join(runtimeRoot, resolvedPath)).href);
};
const originalCwd = process.cwd();

const projectRoot = await mkdtemp(join(tmpdir(), "omp-root-artifacts-e2e-"));
const ompConfigPath = join(projectRoot, ".omp", "extensions", "guardrails.json");
await mkdir(join(projectRoot, ".omp", "extensions"), { recursive: true });
await writeFile(
  ompConfigPath,
  `${JSON.stringify(
    {
      enabled: true,
      features: {
        policies: false,
        permissionGate: false,
        pathAccess: false,
        rootArtifacts: true,
      },
      rootArtifacts: {
        enabled: true,
        mode: "replace",
        allow: ["allowed.txt"],
        deny: [],
        allowedDirectories: [".omp", "src"],
        ignorePatterns: [],
        autoPrune: { enabled: false },
      },
    },
    null,
    2,
  )}\n`,
);

process.chdir(projectRoot);
const [{ loadExtensions }, { ExtensionRunner }, { EventBus }, { SessionManager }] =
  await Promise.all([
    runtimeModule("src/extensibility/extensions/loader.ts"),
    runtimeModule("src/extensibility/extensions/runner.ts"),
    runtimeModule("src/utils/event-bus.ts"),
    runtimeModule("src/session/session-manager.ts"),
  ]);

async function loadNativeExtension() {
  const eventBus = new EventBus();
  const diagnostics: unknown[] = [];
  eventBus.on("guardrails:root-artifacts:diagnostic", (data: unknown) => {
    diagnostics.push(data);
  });
  const extensionPath =
    process.env.OMP_EXTENSION_PATH ?? join(repoRoot, "dist", "extension.js");
  assert.equal(existsSync(extensionPath), true, "compiled OMP extension is missing");
  const loaded = await loadExtensions([extensionPath], projectRoot, eventBus);
  assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
  assert.equal(loaded.extensions.length, 1, "OMP loader did not bind the bundle");
  const registeredCommandNames = [...loaded.extensions[0].commands.keys()].sort();
  assert.deepEqual(registeredCommandNames, [
    "omp-guard-kit:examples",
    "omp-guard-kit:onboarding",
    "omp-guard-kit:settings",
  ]);
  const sessionManager = SessionManager.inMemory(projectRoot);
  const modelRegistry = { getAvailable: () => [] };
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    projectRoot,
    sessionManager,
    modelRegistry,
  );
  for (const commandName of registeredCommandNames) {
    assert.equal(runner.getCommand(commandName)?.name, commandName);
  }
  return { diagnostics, runner };
}

try {
  assert.equal(existsSync(join(projectRoot, ".pi")), false);
  let { diagnostics, runner } = await loadNativeExtension();
  await runner.emitBeforeAgentStart("compatibility probe", undefined, ["system"]);
  await runner.emit({ type: "session_start" });
  assert.equal(diagnostics.length > 0, true, "session diagnostic event was not emitted");
  assert.equal(existsSync(join(projectRoot, ".pi")), false);

  const blockedBash = await runner.emitToolCall({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "e2e-blocked-bash",
    input: { command: "echo marker > unexpected.txt" },
  });
  assert.equal(blockedBash?.block, true);
  assert.match(blockedBash?.reason ?? "", /unexpected\.txt/);
  assert.equal(existsSync(join(projectRoot, "unexpected.txt")), false);

  const blockedDirect = await runner.emitToolCall({
    type: "tool_call",
    toolName: "write",
    toolCallId: "e2e-blocked-write",
    input: { file_path: "blocked.txt", content: "marker" },
  });
  assert.equal(blockedDirect?.block, true);
  assert.match(blockedDirect?.reason ?? "", /blocked\.txt/);
  assert.equal(existsSync(join(projectRoot, "blocked.txt")), false);

  const allowedNested = await runner.emitToolCall({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "e2e-allowed-bash",
    input: { command: "echo marker > src/allowed.txt" },
  });
  assert.equal(allowedNested, undefined);
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "src", "allowed.txt"), "marker\n");
  assert.equal(existsSync(join(projectRoot, "src", "allowed.txt")), true);

  await rm(ompConfigPath);
  await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(projectRoot, ".pi", "extensions", "guardrails.json"),
    JSON.stringify({ version: "0.21.0", enabled: false }),
  );
  await loadNativeExtension();
  assert.equal(existsSync(join(projectRoot, ".pi", "extensions", "guardrails.json")), false);
  assert.equal(existsSync(ompConfigPath), true);
  assert.equal(JSON.parse(await readFile(ompConfigPath, "utf8")).enabled, false);

  await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(projectRoot, ".pi", "extensions", "guardrails.json"),
    JSON.stringify({ version: "0.21.0", enabled: false, features: { rootArtifacts: false } }),
  );
  await writeFile(
    ompConfigPath,
    JSON.stringify({ version: "0.21.0", enabled: true, features: { rootArtifacts: true } }),
  );
  await loadNativeExtension();
  assert.equal(existsSync(join(projectRoot, ".pi", "extensions", "guardrails.json")), false);
  assert.equal(JSON.parse(await readFile(ompConfigPath, "utf8")).enabled, true);

  await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(projectRoot, ".pi", "extensions", "guardrails.json"),
    "not-json",
  );
  ({ diagnostics, runner } = await loadNativeExtension());
  assert.equal(existsSync(join(projectRoot, ".pi", "extensions", "guardrails.json")), true);
  assert.equal(existsSync(ompConfigPath), true);

  console.log(
    JSON.stringify(
      {
        loader: "omp.loadExtensions",
        runner: "ExtensionRunner.emitToolCall",
        projectRoot,
        blocked: ["unexpected.txt", "blocked.txt"],
        allowed: "src/allowed.txt",
        migration: "local Pi config migrated; OMP wins conflicts",
        failure: "invalid legacy config retained",
        diagnostics: diagnostics.length,
      },
      null,
      2,
    ),
  );
} finally {
  process.chdir(originalCwd);
  await rm(projectRoot, { recursive: true, force: true });
}
