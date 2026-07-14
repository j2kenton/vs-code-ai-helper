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

## Quick start

1. Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=j2kenton.vs-code-ai-helper).
2. Run **Ensemble: Select Meta Resources Folder** and choose a workspace folder such as `.helper/plans`.
3. Run **Ensemble: Start New Task**, describe the work in `task.md`, and use **Generate Plan with AI** or write the plan yourself.
4. Review and promote the plan, generate the implementation checklist, implement, and run the implementation reviews.

AI providers may include GitHub Copilot and supported vendor CLIs (Claude, Codex, Gemini, Antigravity, and Kiro). Configure models per workflow step; provider availability depends on your subscriptions and local setup. AI actions consume real quota or money and may modify files.

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
