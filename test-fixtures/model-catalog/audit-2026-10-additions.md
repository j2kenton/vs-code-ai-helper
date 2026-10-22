# Model additions checked October 21, 2026

- Codex: `gpt-6.1-sol`, labelled `GPT-6.1-Sol`, with low, medium,
  high, xhigh, max and ultra effort, normal and Fast (priority) tiers.
  Evidence: this Codex session's available-model catalog explicitly lists
  those efforts and the priority tier. The exact ID is also published at
  https://developers.openai.com/api/docs/models/gpt-6.1-sol .
- Antigravity CLI: `Gemini 4 Argon (Low)`, `(Medium)` and `(High)`,
  following the existing CLI's display-string selection pattern.
  https://www.antigravity.google/docs/models/ lists Argon for the CLI and
  Low/Medium/High thinking levels. Access depends on the Google plan.
  No separate Fast or thinking-disabled Argon variant is evidenced.
- OpenCode Console / Zen: `opencode/gpt-6.1-sol` and
  `opencode/gemini-4-argon`. The official endpoint table confirms both IDs:
  https://opencode.ai/v2/docs/console/models/ .
- OpenCode Go: `opencode-go/gemini-4-argon-contributor`, preserving the
  Contributor distinction and omitting a Free label. The exact ID appears
  at https://opencode.ai/v2/docs/console/go/ .

OpenCode additions seed base selections only. Empty seed variant objects mean
provider defaults, not disabled thinking. Provider-specific variants remain
available through the existing live `model.list` discovery. A live local
capture was unavailable: the installed Windows OpenCode wrapper failed under
WSL with `UtilBindVsockAnyPort: socket failed`.

Gemini CLI is left unchanged: API availability alone does not establish
support in its Google-account path. The upstream feature request
https://github.com/google-gemini/gemini-cli/issues/29689 still requests Argon
registration and model-picker support. Copilot continues to discover its
models from the host. Other providers' catalogs do not supply confirmed IDs
for these additions, so their seeds remain unchanged. Existing models and
default selections are preserved.

- Gemini 3.8 Flash: added to the Antigravity CLI seed as its display labels
  at Low, Medium and High thinking; Google documents the model for the CLI
  and those thinking levels. Its Fast option is a separate Antigravity
  control, not a model ID suffix. The OpenCode Console seed uses
  `opencode/gemini-3.8-flash` with Low/Medium/High variants, matching Google's
  API capability page, which explicitly says `minimal` is unsupported.
  Sources: https://www.antigravity.google/docs/models/ ;
  https://opencode.ai/v2/docs/console/models/ ;
  https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash .
