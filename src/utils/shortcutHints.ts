import keybindings from "../../package.json";

interface KeybindingEntry {
  command: string;
  key: string;
  mac?: string;
}

const SHORTCUTS: Record<string, string> = Object.fromEntries(
  ((keybindings.contributes?.keybindings ?? []) as KeybindingEntry[]).map((binding) => [
    binding.command,
    process.platform === "darwin" && binding.mac ? binding.mac : binding.key,
  ])
);
export function shortcutHint(command: string): string { return SHORTCUTS[command] ? ` (${SHORTCUTS[command]})` : ""; }
