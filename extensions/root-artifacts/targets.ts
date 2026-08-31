import { parse, type Redirect, type SimpleCommand, type Word } from "@aliou/sh";
import {
  walkCommands,
  wordHasExpansion,
  wordToString,
} from "../../src/core/shell";
import type {
  RootArtifactKind,
  RootArtifactTarget,
} from "../../src/root-artifacts";

type ExtractedWriteTarget = RootArtifactTarget & {
  operation: string;
};

const DIRECT_WRITE_COMMANDS: Record<string, RootArtifactKind | "destination"> =
  {
    tee: "file",
    touch: "file",
    mkdir: "directory",
    cp: "destination",
    mv: "destination",
    install: "destination",
  };

const SHELL_COMMANDS: Record<string, true> = {
  sh: true,
  bash: true,
  zsh: true,
  dash: true,
};

function commandName(words: string[]): string {
  const command = words[0] ?? "";
  return command.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function isOption(word: string): boolean {
  return word.startsWith("-") && word !== "-";
}

function addTarget(
  targets: Map<string, ExtractedWriteTarget>,
  rawPath: string,
  kind: RootArtifactKind,
  operation: string,
  unresolved: boolean,
): void {
  const path = rawPath.trim();
  if (!path || path === "-") return;
  const key = `${kind}:${path}`;
  const existing = targets.get(key);
  if (existing) {
    existing.unresolved ||= unresolved;
    return;
  }
  targets.set(key, { rawPath: path, kind, operation, unresolved });
}

function commandArguments(
  words: string[],
  wordUnresolved: boolean[],
): Array<{ value: string; unresolved: boolean }> {
  return words.slice(1).flatMap((value, index) => {
    if (isOption(value)) return [];
    return [{ value, unresolved: wordUnresolved[index + 1] ?? false }];
  });
}

function redirectWrites(
  redirects: readonly Redirect[] | undefined,
  targets: Map<string, ExtractedWriteTarget>,
): void {
  for (const redirect of redirects ?? []) {
    if (!redirect.op.includes(">") && redirect.op !== "<>") continue;
    addTarget(
      targets,
      wordToString(redirect.target),
      "file",
      `redirect:${redirect.op}`,
      wordHasExpansion(redirect.target),
    );
  }
}

function collectSimpleCommand(
  command: SimpleCommand,
  targets: Map<string, ExtractedWriteTarget>,
  nestedScripts: string[],
): void {
  const words: Word[] = command.words ?? [];
  if (words.length === 0) return;
  const values = words.map(wordToString);
  const wordUnresolved = words.map(wordHasExpansion);
  const name = commandName(values);
  redirectWrites(command.redirects, targets);

  if (SHELL_COMMANDS[name]) {
    const commandIndex = values.findIndex(
      (word) => word === "-c" || word === "--command",
    );
    const nested = values[commandIndex + 1];
    if (commandIndex >= 0 && nested) nestedScripts.push(nested);
  }

  const kind = DIRECT_WRITE_COMMANDS[name];
  if (!kind) return;
  const args = commandArguments(values, wordUnresolved);
  if (kind === "destination") {
    const destination = args.at(-1);
    if (destination)
      addTarget(
        targets,
        destination.value,
        "file",
        `${name}:destination`,
        destination.unresolved,
      );
    return;
  }
  for (const argument of args) {
    addTarget(targets, argument.value, kind, name, argument.unresolved);
  }
}

function fallbackTargets(command: string): ExtractedWriteTarget[] {
  const targets = new Map<string, ExtractedWriteTarget>();
  const tokenRegex = /"([^"]*)"|'([^']*)'|([^\s"'`<>|;&]+)/g;
  const tokens = [...command.matchAll(tokenRegex)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  const operation = tokens.find(
    (token) => DIRECT_WRITE_COMMANDS[commandName([token])],
  );
  const redirectRegex =
    /(?:>>|>|<>)[ \t]*"([^"]+)"|(?:>>|>|<>)[ \t]*'([^']+)'|(?:>>|>|<>)[ \t]*([^\s;&|]+)/g;
  for (const match of command.matchAll(redirectRegex)) {
    addTarget(
      targets,
      match[1] ?? match[2] ?? match[3] ?? "",
      "file",
      "redirect",
      false,
    );
  }
  if (operation) {
    const start = tokens.indexOf(operation) + 1;
    const args = tokens.slice(start).filter((token) => !isOption(token));
    const kind = DIRECT_WRITE_COMMANDS[commandName([operation])];
    const selected = kind === "destination" ? args.slice(-1) : args;
    for (const arg of selected) {
      addTarget(
        targets,
        arg,
        kind === "directory" ? "directory" : "file",
        commandName([operation]),
        false,
      );
    }
  }
  return [...targets.values()];
}

export function extractWriteTargets(
  command: string,
  depth = 0,
): ExtractedWriteTarget[] {
  if (!command.trim() || depth > 3) return [];
  const targets = new Map<string, ExtractedWriteTarget>();
  const nestedScripts: string[] = [];
  try {
    const { ast } = parse(command);
    walkCommands(ast, (simpleCommand) => {
      collectSimpleCommand(simpleCommand, targets, nestedScripts);
      return false;
    });
  } catch {
    return fallbackTargets(command);
  }
  for (const script of nestedScripts) {
    for (const target of extractWriteTargets(script, depth + 1)) {
      addTarget(
        targets,
        target.rawPath,
        target.kind,
        target.operation,
        target.unresolved ?? false,
      );
    }
  }
  return [...targets.values()];
}
