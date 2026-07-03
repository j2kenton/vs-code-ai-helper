# VS Code AI Helper

VS Code AI Helper turns ad-hoc "let's plan this out" conversations into a repeatable, file-based workflow. Every task gets its own dated folder with a task description, a plan, plan reviews, and a final approved plan — either written by hand or generated with your existing GitHub Copilot subscription, no API key required.

## Marketplace

Install from the Visual Studio Marketplace:

https://marketplace.visualstudio.com/items?itemName=j2kenton.vs-code-ai-helper

## Requirements

- VS Code 1.93.0 or higher
- A workspace folder open (the extension stores everything relative to your workspace)
- Optional: an active GitHub Copilot subscription, signed in to VS Code, if you want to use the "with AI" commands

## Quick Start

1. **Point the extension at a folder.** Run `AI Helper: Select Meta Resources Folder` from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and choose a folder inside your workspace (e.g. `.ai-helper/` or `docs/tasks/`). This is where all task folders will be created.
2. **Start a task.** Run `AI Helper: Start New Task`. This creates a folder named `YYYY-MM-DD_task_N` (numbered per day) and opens `task.md` for you to describe what you want done — the goal, scope, and any constraints.
3. **Get a plan.** Either:
   - Write `plan.md` yourself, or
   - Run `AI Helper: Generate Plan with AI` to have Copilot draft it from your `task.md` and currently open editors in the workspace.
4. **Review the plan.** Either write `plan-review.md` yourself, or run `AI Helper: Review Plan with AI` to have Copilot critique the plan for blocking issues, gaps, and scope creep.
5. **Iterate if needed.** Either write `plan-updated.md` yourself, or run `AI Helper: Update Plan with AI` to have Copilot revise the plan based on the review. Then either write `plan-updated-review.md` yourself, or run `AI Helper: Review Updated Plan with AI` to have Copilot review the revision. Repeat manually as many times as you need.
6. **Finalize.** Once you're happy with a plan, the workflow copies it to `plan-final.md` and marks the task `completed`. Promoting to `plan-final.md` is always a manual, human step — no command auto-approves a plan.
7. **Come back later.** If you stop partway through (or just close VS Code), run `AI Helper: Resume Task` — it picks up exactly where you left off, using `task-progress.json` to know the current stage.

Everything the extension writes is a plain Markdown or JSON file in your task folder, so you can read, edit, or hand it to a different tool at any point — nothing is locked into the extension.

## Commands

| Command | What it does |
| --- | --- |
| `AI Helper: Select Meta Resources Folder` | Choose where task folders are stored for this workspace. Run this once per workspace before anything else. |
| `AI Helper: Start New Task` | Creates a new `YYYY-MM-DD_task_N` folder, opens `task.md`, then walks you through the manual plan → review → update → final-plan prompts. |
| `AI Helper: Resume Task` | Lists incomplete tasks and continues the manual workflow from wherever it was left off. |
| `AI Helper: Generate Plan with AI` | Uses your Copilot access to draft `plan.md` from `task.md` and a generated `context-pack.md`. Only offered for tasks that don't have a plan yet (or are re-generating the current one), so it can't overwrite later-stage work. |
| `AI Helper: Review Plan with AI` | Uses Copilot to critique the existing `plan.md` and write `plan-review.md`. Only offered once a plan exists. |
| `AI Helper: Update Plan with AI` | Uses Copilot to revise the plan based on `plan-review.md`, writing `plan-updated.md`. Only offered once a plan review exists. |
| `AI Helper: Review Updated Plan with AI` | Uses Copilot to critique `plan-updated.md`, writing `plan-updated-review.md`. Only offered once an updated plan exists. |
| `AI Helper: Set Task Stage` | Manually set which stage a task is tracked at, moving it backward or forward. Use this when the auto-tracked stage has gotten ahead of where you actually are. Only changes `task-progress.json` — it doesn't touch or delete any artifact files. |
| `AI Helper: Hello World` | Sanity-check command confirming the extension is active. |

Every "with AI" command asks for confirmation before overwriting an existing artifact, is only offered when the task is at (or just past) the right stage — so it can never regress a task or clobber later-stage work — and falls back with a clear message (no crash, no silent failure) if Copilot isn't signed in, has no available model, or you're out of quota. The manual `Start New Task` / `Resume Task` flow always works regardless. Promoting a plan to `plan-final.md` is intentionally not automatable yet — it's the one human approval gate the workflow always stops for.

## What gets created in a task folder

```
YYYY-MM-DD_task_N/
├── task-progress.json    # Machine-readable stage tracker (used by Resume Task)
├── task.md                # Your request: goal, scope, constraints
├── context-pack.md        # Auto-generated snapshot sent to Copilot (workspace root, open files, task.md)
├── plan.md                # Initial plan
├── plan-review.md         # Review of the initial plan
├── plan-updated.md        # Revised plan, after review
├── plan-updated-review.md # Review of the revised plan
├── plan-final.md          # The plan you settled on
└── runs/
    └── 001-copilot-lm-plan.md   # Log of each AI run: prompt sent + result
```

`runs/` gives you a paper trail of exactly what was asked and what came back each time you use an AI command, separate from the artifact itself.

## Settings

| Setting | Description |
| --- | --- |
| `vs-code-ai-helper.metaResourcesPath` | Workspace-relative path where task folders are stored. Set via `AI Helper: Select Meta Resources Folder`. |
| `vs-code-ai-helper.promptDismissed` | When `true`, suppresses the one-time activation prompt asking you to configure a folder. |

## Screenshots

| Command Palette | Task Planning |
| --- | --- |
| ![AI Helper commands in the Command Palette](images/screenshots/screenshot-1.jpeg) | ![Task planning prompt](images/screenshots/screenshot-2.jpeg) |

## Development

### Setup

```bash
# Install dependencies
pnpm install

# Compile the extension
pnpm run compile
```

### Running the Extension

1. Press `F5` to open a new VS Code window (the "Extension Development Host") with the extension loaded
2. Open a folder as your workspace in that window
3. Run `AI Helper: Select Meta Resources Folder`, then `AI Helper: Start New Task` from the Command Palette (`Ctrl+Shift+P`) to exercise the full workflow described in [Quick Start](#quick-start)

### Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm run compile` | Compile the extension |
| `pnpm run watch` | Watch for changes and recompile |
| `pnpm run package` | Package the extension for production |
| `pnpm run lint` | Run ESLint |
| `pnpm run lint:fix` | Run ESLint with auto-fix |
| `pnpm run test` | Run tests |

## Project Structure

```
vs-code-ai-helper/
├── .vscode/                     # VS Code configuration
│   ├── launch.json              # Debug configurations
│   └── tasks.json               # Build tasks
├── resources/
│   └── prompts/                 # Prompt templates used by the AI commands
├── src/
│   ├── extension.ts             # Extension entry point / command registration
│   ├── commands/                # One file per command (startNewTask, resumeTask, generatePlanWithAI, ...)
│   ├── runners/                 # AI provider adapters (currently: Copilot Language Model API)
│   ├── config/                  # Workspace settings helpers
│   ├── types/                   # Shared types (TaskProgress, AgentRunner, ...)
│   └── utils/                   # Task-progress, context-pack, and run-log helpers
├── dist/                        # Compiled output (git-ignored)
├── package.json                 # Extension manifest
├── tsconfig.json                # TypeScript configuration
├── .eslintrc.json               # ESLint configuration
└── esbuild.js                   # Build configuration
```

## License

MIT
