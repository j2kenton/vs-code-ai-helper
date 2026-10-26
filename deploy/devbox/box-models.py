#!/usr/bin/env python3
"""Print each Ensemble stage's models as the runner window's settings resolve them.

Reads the runner's own user settings (the file Settings Sync writes on the
box), so it answers "has my change reached the box yet?" without opening the
runner window. Strictly read-only: it opens one file for reading and prints.

    python3 ~/box-models.py            (from a laptop: box models)

It mirrors Ensemble's own resolution, file by file:
  - settings.ts readSetting: an "ensemble.<key>" value wins; otherwise the
    legacy "vs-code-ai-helper.<key>" value is used.
  - settings.ts getModelSettings + modelFallback.ts normalizeBackupChain:
    backups must be a list of non-blank strings, trimmed, de-duplicated (the
    first occurrence keeps its on/off flag), capped at 10; a stage with no
    entry at all imports the legacy aiModelDefaults value as its primary.
  - modelSelection.ts skipFilteredChainOf: switched-off backups are dropped;
    a primary with primaryEnabled false is skipped and the first enabled
    backup runs first instead.
  - modelSelection.ts resolveEffectiveStageChainV1: a stage with nothing
    configured at all borrows the Task Description chain; a configured stage
    whose models are all switched off does not.
  - settings.ts isModelProviderEnabled (+ providers.ts parse rules): a
    resolved model whose provider is switched off is BLOCKED; Ensemble then
    refuses the stage rather than moving on to a backup.
Not mirrored: legacy model-name aliases, workspace-scope settings, and a
task's own active fallback reservation, any of which can change what runs.
"""
import datetime
import json
import os
import sys

SETTINGS = os.path.expanduser("~/.config/Code/User/settings.json")
SECTION, LEGACY_SECTION = "ensemble", "vs-code-ai-helper"
GENERAL_STAGE = "desc"
BACKUP_CAP = 10
STAGES = [
    ("desc", "Task Description"),
    ("plan", "Plan"),
    ("plan-high-review", "High-Level Review (Plan)"),
    ("plan-low-review", "Low-Level Review (Plan)"),
    ("impl", "Implementation"),
    ("impl-high-review", "High-Level Code Review"),
    ("impl-low-review", "Low-Level Code Review"),
    ("publish", "Publish"),
]
CLI_PROVIDERS = {
    "antigravity-cli", "claude-cli", "cline-cli", "codex-cli", "devpass-cli",
    "gemini-cli", "kimi-cli", "kiro-cli", "opencode-cli",
}


def strip_jsonc(text):
    """Remove // and /* */ comments and trailing commas, outside strings only."""
    out = []
    i, n = 0, len(text)
    in_string = False
    while i < n:
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end == -1 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
        elif ch == ",":
            # A comma followed only by whitespace/comments and then } or ]
            # is a trailing comma: drop it.
            j = i + 1
            while j < n:
                if text[j] in " \t\r\n":
                    j += 1
                elif text.startswith("//", j):
                    end = text.find("\n", j)
                    j = n if end == -1 else end
                elif text.startswith("/*", j):
                    end = text.find("*/", j + 2)
                    j = n if end == -1 else end + 2
                else:
                    break
            if j < n and text[j] in "}]":
                i += 1
            else:
                out.append(ch)
                i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def read_setting(settings, key, fallback):
    for section in (SECTION, LEGACY_SECTION):
        name = f"{section}.{key}"
        if name in settings:
            return settings[name], True
    return fallback, False


def clean_id(value):
    """A backup entry: normalizeBackupChain trims it."""
    return value.strip() if isinstance(value, str) and value.strip() else None


def present_id(value):
    """A primary, single backup or legacy default: getModelSettings only
    checks it is non-blank and keeps it as written (whitespace included)."""
    return value if isinstance(value, str) and value.strip() else None


def normalize_stage(entry):
    """getModelSettings' read boundary for one stage entry (a dict)."""
    raw_backups = entry.get("backups")
    flags = entry.get("backupsEnabled")
    flags = flags if isinstance(flags, list) else None
    backups, backup_flags = None, None
    if isinstance(raw_backups, list):
        backups, backup_flags, seen = [], [], set()
        for index, value in enumerate(raw_backups):
            model = clean_id(value)
            if model is None or model in seen:
                continue
            seen.add(model)
            backups.append(model)
            backup_flags.append(not (flags is not None and index < len(flags) and flags[index] is False))
        backups, backup_flags = backups[:BACKUP_CAP], backup_flags[:BACKUP_CAP]
    return {
        "primary": present_id(entry.get("primary")),
        "backup": present_id(entry.get("backup")),
        "backups": backups,
        "backupsEnabled": backup_flags,
        "primaryEnabled": entry.get("primaryEnabled") is not False,
    }


def skip_filtered_chain(setting):
    """skipFilteredChainOf: (effective primary, remaining backups)."""
    if not setting:
        return None, []
    configured = setting["backups"] if setting["backups"] else ([setting["backup"]] if setting["backup"] else [])
    flags = setting["backupsEnabled"] if setting["backups"] else None
    seen, backups = set(), []
    for index, model in enumerate(configured):
        if flags is not None and index < len(flags) and flags[index] is False:
            continue
        if model in seen:
            continue
        seen.add(model)
        backups.append(model)
    primary = setting["primary"] if setting["primaryEnabled"] else None
    if not primary and backups:
        primary, backups = backups[0], backups[1:]
    return primary, [model for model in backups if model != primary]


def has_any_configured_candidate(setting):
    return bool(setting and (setting["primary"] or setting["backup"] or setting["backups"]))


def provider_account(model_id):
    """providerAccountIdForModelId: the Provider Selection row for a stored id."""
    prefix, sep, rest = model_id.partition(":")
    if not sep or not prefix:
        return "copilot"
    if prefix == "copilot":
        return "copilot"
    if prefix not in CLI_PROVIDERS:
        return "copilot"
    if prefix != "opencode-cli":
        return prefix
    if rest.startswith("opencode-go/"):
        return "opencode-go"
    if rest.startswith("opencode/"):
        return "opencode-zen"
    return "opencode-cli"


def enabled_providers(settings):
    """getEnabledProviders, with the legacy single opencode-cli checkbox."""
    configured, present = read_setting(settings, "enabledProviders", {})
    configured = configured if isinstance(configured, dict) else {}
    if "opencode-cli" in configured:
        configured = dict(configured)
        configured.setdefault("opencode-zen", configured["opencode-cli"])
        configured.setdefault("opencode-go", configured["opencode-cli"])
    return configured, present


def provider_enabled(model_id, enabled):
    """isModelProviderEnabled: literal true required, except Copilot."""
    account = provider_account(model_id)
    if account == "copilot":
        return enabled.get("copilot") is not False
    return enabled.get(account) is True


def main():
    global SETTINGS
    # Settings values are printed as-is; never let an unencodable character
    # (e.g. a lone surrogate from a "\ud800" escape) crash the report.
    sys.stdout.reconfigure(errors="backslashreplace")
    if len(sys.argv) > 1:
        SETTINGS = sys.argv[1]  # another settings file, e.g. to check a copy
    try:
        with open(SETTINGS, encoding="utf-8") as handle:
            settings = json.loads(strip_jsonc(handle.read()))
    except (OSError, ValueError) as error:
        print(f"Cannot read {SETTINGS}: {error}")
        return 1
    if not isinstance(settings, dict):
        print(f"Unexpected content in {SETTINGS}.")
        return 1

    written = datetime.datetime.fromtimestamp(os.path.getmtime(SETTINGS))
    print(f"Runner user settings last written {written:%Y-%m-%d %H:%M:%S} (box time).")
    print("Prediction from user settings only: workspace settings and a task's own")
    print("active fallback can change what actually runs.\n")

    raw_stages, _ = read_setting(settings, "modelSettings", {})
    raw_stages = raw_stages if isinstance(raw_stages, dict) else {}
    legacy_defaults, _ = read_setting(settings, "aiModelDefaults", {})
    legacy_defaults = legacy_defaults if isinstance(legacy_defaults, dict) else {}
    enabled, selection_configured = enabled_providers(settings)

    stages = {}
    for key, _ in STAGES:
        entry = raw_stages.get(key)
        if isinstance(entry, dict):
            stages[key] = normalize_stage(entry)
        else:
            legacy = present_id(legacy_defaults.get(key))
            stages[key] = normalize_stage({"primary": legacy}) if legacy else None

    for key, label in STAGES:
        setting = stages[key]
        primary, backups = skip_filtered_chain(setting)
        source = ""
        if not primary and key != GENERAL_STAGE and not has_any_configured_candidate(setting):
            primary, backups = skip_filtered_chain(stages[GENERAL_STAGE])
            if primary:
                source = " (nothing set here, so it borrows Task Description's models)"

        if not primary:
            headline = "NOTHING CAN RUN - no model switched on"
        elif selection_configured and not provider_enabled(primary, enabled):
            headline = (f"BLOCKED - {primary} would run first, but its provider is switched off "
                        "in Provider Selection (Ensemble refuses rather than skipping to a backup)")
        else:
            headline = f"runs {primary} first{source}"
        print(f"{label}: {headline}")

        rows = []
        if setting:
            if setting["primary"]:
                rows.append(("primary", setting["primary"], setting["primaryEnabled"]))
            if setting["backups"]:
                rows.extend(("backup", m, on) for m, on in zip(setting["backups"], setting["backupsEnabled"]))
            elif setting["backup"]:
                rows.append(("backup", setting["backup"], True))
        for kind, model, on in rows:
            note = ""
            if on and selection_configured and not provider_enabled(model, enabled):
                note = "  (provider switched off in Provider Selection)"
            print(f"   {'ON ' if on else 'off'} {kind:7} {model}{note}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
