# Ensemble

Ensemble is an agentic workflow system for VS Code. It turns an idea into a supervised, reviewable implementation: capture the task, shape a plan, implement it with the AI provider you choose, and review the result before moving on.

## The workflow

The task → plan → implementation → review loop keeps human judgment in the driver’s seat:

1. **Task:** describe the goal, scope, constraints, and acceptance criteria in `task.md`.
2. **Plan:** draft or edit `plan.md`, then use high- and low-level reviews to improve it. Promote the approved plan to `plan-final.md` deliberately.
3. **Implementation:** generate an `implementation.md` checklist and work through it. AI implementation runs can edit workspace files, so supervise and inspect every change.
4. **Review:** review the changed files, apply fixes where appropriate, rerun checks, and complete the task only when the result is ready.

The Tasks view and status bar show the current task and stage. Every AI action has a manual counterpart, and task artifacts remain ordinary Markdown and JSON files that you can edit, inspect, or use with another tool.

## Screenshots

![Task view with model configuration](images/screenshots/screenshot-1.png)

![AI-generated low-level code review](images/screenshots/screenshot-2.png)

![Provider selection and fast-forward review settings](images/screenshots/screenshot-3.png)

## Requirements

**Minimum: VS Code 1.93+ and GitHub Copilot.** Copilot uses the GitHub account VS Code is already signed into, so there is nothing extra to install and it is enabled by default. Copilot's free tier is enough to try Ensemble; sustained use will run into its limits and need a paid Copilot plan.

That is the whole requirement. Everything below is optional.

### Optional: vendor CLI providers

Ensemble can also drive vendor CLIs that authenticate against your existing subscription, so you can use a different model for each workflow step. Every CLI provider is **off by default** — enable the ones you want under **Ensemble: Configure AI Models**. None of them is required.

| Provider | Install | Account |
|---|---|---|
| **Gemini CLI** | `npm i -g @google/gemini-cli`, then run `gemini` once | Google account; free tier available |
| **Claude Code** | `npm i -g @anthropic-ai/claude-code`, then run `claude` once | Claude Pro or Max subscription |
| **Codex CLI** | `npm i -g @openai/codex`, then `codex login` | ChatGPT Plus or Pro subscription |
| **Antigravity** | Install the Antigravity CLI, then run `agy` once | Google account |
| **Kiro CLI** | Install from [kiro.dev/cli](https://kiro.dev/cli/) | Kiro login **and** a `KIRO_API_KEY` environment variable — `kiro-cli login` alone is not sufficient for headless runs |
| **OpenCode Zen / Go** | `npm i -g opencode-ai`, then run `opencode` and use `/connect` | Zen and Go share an OpenCode account/API key, but are separate services: Zen needs its own billing and Go needs an active Go subscription |

OpenCode appears as two separate provider rows in Ensemble: **OpenCode Zen** for `opencode/...` models and **OpenCode Go** for `opencode-go/...` models. They use the same `opencode` CLI and can use the same OpenCode key, but enabling or connecting one does not grant access to the other. Choose the tier explicitly; a Zen/Go backup is only used when you explicitly select it as a backup model.

> **Note on Antigravity:** it runs with `--dangerously-skip-permissions` in **every** mode, including plan and review — so it can create, change, or delete any file in your workspace without asking, even on a run you'd expect to be read-only. The other providers restrict their read-only stages (Claude `--permission-mode plan`, Codex `--sandbox read-only`, Kiro `--trust-tools fs_read,grep,glob`, opencode `--agent plan`); Antigravity's headless CLI offers no equivalent, and without the flag its runs fail having done nothing. Commit or back up before using it, or pick another provider.

AI actions consume real quota or money, and implementation runs modify workspace files.

## Quick start

1. Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=j2kenton.vs-code-ai-helper).
2. Open a workspace folder. Ensemble stores task metadata in `.ensemble` by default, or you can run **Ensemble: Select Meta Resources Folder** to choose a different workspace folder.
3. Run **Ensemble: Start New Task**, describe the work in `task.md`, and use **Generate Plan with AI** or write the plan yourself.
4. Review and promote the plan, generate the implementation checklist, implement, and run the implementation reviews.

Configure models per workflow step under **Ensemble: Configure AI Models**.

## Safety and disclaimer

This extension is provided as-is with no warranty. Read [`DISCLAIMER.md`](DISCLAIMER.md) in full before use. AI runs send eligible open-editor contents to the selected third-party provider and may create, overwrite, or delete workspace files. Always commit or back up first, supervise every run, and review generated changes. See [`SECURITY.md`](SECURITY.md) for vulnerability reporting.

## Development

```bash
pnpm install
pnpm run compile
pnpm run test:unit
```

Press `F5` to launch an Extension Development Host. Run `pnpm run lint` for linting and `pnpm run package` to build a VSIX.

## License

MIT — see [LICENSE](LICENSE).
