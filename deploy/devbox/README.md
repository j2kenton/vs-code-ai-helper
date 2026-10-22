# Dev box runner setup

## Grant Ensemble access to Copilot in each runner profile

VS Code keeps language-model extension permissions in each user-data profile.
Grant this once in every profile that runs Ensemble, before sending real
Copilot work:

1. Open the runner window for the profile on the virtual display.
2. Trigger any Ensemble action that requests a Copilot language model.
3. In the VS Code prompt, choose **Allow** for Ensemble's access to GitHub
   Copilot language models.

Runner 1 uses the default profile at `~/.config/Code`. Runner 2 and later use
`~/.config/Code-runner-N`; explicitly grant access in `Code-runner-2`,
`Code-runner-3` and `Code-runner-4` as well. Signing into Copilot in one profile
does not grant this permission in another profile.

For a headless runner screenshot, capture the root window from the same
environment where Xvfb is running:

```sh
DISPLAY=:99 import -window root shot.png
```
