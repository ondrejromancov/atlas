# Atlas — multi-model orchestration for Claude Code

A standalone `/atlas` command that turns your session into an **orchestrator**: it plans a task, then
delegates the implementation to the right worker model.

- **Planner / orchestrator** → your main session (intended: **Fable 5**, `claude-fable-5`)
- **Default worker** → **GPT-5.5** via the Codex CLI (`atlas-gpt-worker`)
- **Override worker** → **Claude Opus 4.8** (`atlas-claude-worker`) for frontend/UI, by routing rule

## Why standalone (not a plugin)

Claude Code always namespaces plugin commands (`/plugin:command`). To get a bare `/atlas`, this ships as
standalone user config in `~/.claude/`, not as a marketplace plugin.

## Install

Copy the files into your Claude Code user config:

```bash
git clone https://github.com/ondrejromancov/atlas.git
cd atlas
cp commands/atlas.md ~/.claude/commands/
cp agents/atlas-gpt-worker.md agents/atlas-claude-worker.md ~/.claude/agents/
```

Repo layout mirrors the install destination:

```
commands/atlas.md              → ~/.claude/commands/atlas.md            # the /atlas orchestrator command
agents/atlas-gpt-worker.md     → ~/.claude/agents/atlas-gpt-worker.md   # default worker → codex exec (GPT-5.5)
agents/atlas-claude-worker.md  → ~/.claude/agents/atlas-claude-worker.md# override worker → Opus 4.8 (frontend)
<repo>/.atlas/config.json      # per-repo routing config (auto-created on first /atlas run)
```

## Usage

1. Set your session model to Fable 5: `/model` → Fable 5 (optional but intended).
2. Install & authenticate the Codex CLI (for the GPT worker):
   `npm i -g @openai/codex` (or `brew install codex`), then `codex login`. Requires a ChatGPT subscription.
3. In any repo, run:
   ```
   /atlas add an endpoint that returns the current user      # → GPT-5.5 worker
   /atlas build a responsive settings page with a dark-mode toggle   # → Opus 4.8 worker
   ```

On first run in a repo, Atlas creates `.atlas/config.json`. Edit it to change routing.

## Config (`.atlas/config.json`)

```json
{
  "planner": "claude-fable-5",
  "defaultWorker": { "type": "codex", "model": "gpt-5.5", "effort": "xhigh" },
  "overrides": [
    {
      "when": "frontend / UI code — React, Vue, Svelte, TSX/JSX, HTML, CSS, Tailwind, styling, components, client-side interactivity, accessibility",
      "worker": "claude",
      "model": "claude-opus-4-8"
    }
  ]
}
```

- `defaultWorker` — used for anything that doesn't match an override. Its `model`/`effort` are passed to
  `codex exec` at runtime, so you can change them here freely.
- `overrides[]` — each `{ when, worker, model }`; the orchestrator matches your task against `when` by
  judgment. Add more overrides (e.g. one routing infra/Terraform to a specific worker).

## Known limitations (v1, "routing core only")

- **Claude worker model is pinned in `agents/atlas-claude-worker.md` frontmatter**
  (`claude-opus-4-8`). Claude Code fixes a subagent's model in its definition, so the `model` field in an
  override that routes to `claude` is documentation — to actually change the Claude worker's model, edit
  that one line in the agent file.
- **The planner (Fable 5) is your session model** — recommended, not forced (config/tools can't set the
  main session's model).
- No cross-model review or verify/fix loop yet (that's the sous-chef `/serve` upgrade path).
