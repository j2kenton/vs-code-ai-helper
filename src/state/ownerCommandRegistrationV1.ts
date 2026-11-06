import { runWithOwnerOriginV1 } from "./automationDispatchContextV1";

const INSTALLED = Symbol.for("ensemble.ownerOriginCommandRegistrationV1");

interface CommandsLikeV1 {
  registerCommand: (command: string, callback: (...args: unknown[]) => unknown, thisArg?: unknown) => unknown;
}

/**
 * review1 Step 24 (shared boundary): every command a person can run starts an owner-origin call tree, so the
 * work-admission layer can tell it from automation. Installed once at activation, before any command is
 * registered, it wraps `registerCommand` so each handler runs inside `runWithOwnerOriginV1`. Automatic origin
 * still wins inside it (a chain that executes a command stays automatic), and a path nobody marked counts as
 * automatic. Returns true when it installed the wrapper, false when already installed or not writable.
 */
export function installOwnerOriginCommandRegistrationV1(commands: CommandsLikeV1): boolean {
  const marked = commands as unknown as Record<symbol, true | undefined>;
  if (marked[INSTALLED] === true) return false;
  const original = commands.registerCommand.bind(commands);
  try {
    commands.registerCommand = (command, callback, thisArg) =>
      original(command, (...args: unknown[]) => runWithOwnerOriginV1(() => callback.apply(thisArg, args)));
    marked[INSTALLED] = true;
    return true;
  } catch {
    return false;
  }
}
