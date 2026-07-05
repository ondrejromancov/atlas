# Atlas — multi-model orchestration for Claude Code

A standalone `/atlas` command that turns your session into an **orchestrator**: it plans a task, then
delegates the implementation to the right worker model. Each model does what it's best at — and the
expensive planner is used as seldom as possible.

## Model roles

| Role | Model | Agent | Used for |
|---|---|---|---|
| **Planner** (the brain) | Fable 5 (your session) | — | Routing, tickets, reporting. Never writes code; minimal repo reading. |
| **Workhorse** | GPT-5.5 via Codex CLI | `atlas-gpt-worker` | All implementation by default: backend, infra, scripts, frontend *logic*. Efficient code, weak visuals. |
| **UI hand** | Claude Opus 4.8 | `atlas-claude-worker` | Visual UI only: layout, styling, design polish, animation implementation, accessibility. |
| **Explorer** | Gemini 3.1 Pro via agy CLI | `atlas-gemini-worker` | Occasional throwaway HTML explorations in `.atlas/explorations/` — divergent concepts, style directions, animation experiments. Winning direction is then implemented by the UI hand / workhorse. |
| **Private hand** | Local model (e.g. Gemma 4) via LM Studio, driven by `codex exec --oss` | `atlas-local-worker` | Opt-in only: offline/private work where code must stay on-machine, or quota-free execution. Receives narrow single-function/single-file **subtasks**, never full tickets. |

## Why standalone (not a plugin)

Claude Code always namespaces plugin commands (`/plugin:command`). To get a bare `/atlas`, this ships as
standalone user config in `~/.claude/`, not as a marketplace plugin.

## Install

Copy the files into your Claude Code user config:

```bash
git clone https://github.com/ondrejromancov/atlas.git
cd atlas
cp commands/atlas.md ~/.claude/commands/
cp agents/atlas-*.md ~/.claude/agents/
```

Repo layout mirrors the install destination:

```
commands/atlas.md               → ~/.claude/commands/atlas.md              # the /atlas orchestrator command
agents/atlas-gpt-worker.md      → ~/.claude/agents/atlas-gpt-worker.md     # workhorse → codex exec (GPT-5.5)
agents/atlas-claude-worker.md   → ~/.claude/agents/atlas-claude-worker.md  # UI worker → Opus 4.8
agents/atlas-gemini-worker.md   → ~/.claude/agents/atlas-gemini-worker.md  # explorer → agy (Gemini 3.1 Pro)
agents/atlas-local-worker.md    → ~/.claude/agents/atlas-local-worker.md   # private hand → codex --oss (LM Studio)
dashboard.mjs                   # config dashboard (run from anywhere, no install)
<repo>/.atlas/config.json       # per-repo routing config (auto-created on first /atlas run)
```

Worker CLIs:

- **Codex** (required for the workhorse): `npm i -g @openai/codex` (or `brew install codex`), then
  `codex login`. Requires a ChatGPT subscription.
- **agy** (optional, only for explorations): install the agy CLI and check `agy models` lists
  "Gemini 3.1 Pro".
- **LM Studio** (optional, only for the local worker): download a model (e.g.
  `google/gemma-4-26b-a4b-qat`), and make sure the `lms` CLI works. The worker starts the server and
  loads the model itself — with a 32k context window, since LM Studio's default is too small for
  Codex's prompts. (Ollama also works via `--local-provider ollama`, but Codex requires Ollama ≥ 0.13.4.)

## Usage

1. Set your session model to Fable 5: `/model` → Fable 5 (optional but intended).
2. In any repo, run:
   ```
   /atlas add an endpoint that returns the current user            # → GPT-5.5 workhorse
   /atlas polish the settings page — spacing, dark mode, motion    # → Opus 4.8 UI worker
   /atlas show me 3 wild directions for the onboarding screen      # → Gemini explorations
   /atlas locally, without cloud: add a slugify helper + tests     # → local Gemma 4 via LM Studio
   ```

On first run in a repo, Atlas creates `.atlas/config.json`. Edit it directly — or use the dashboard.

## Dashboard

See and adjust which model is used for what:

```bash
node dashboard.mjs [path-to-repo]     # defaults to the current directory
# → http://127.0.0.1:4777
```

It edits the repo's `.atlas/config.json` (planner, default worker, overrides) and the pinned `model:`
lines of the installed `~/.claude/agents/atlas-*.md` files. Zero dependencies, localhost only.

## Config (`.atlas/config.json`)

```json
{
  "planner": "claude-fable-5",
  "defaultWorker": { "type": "codex", "model": "gpt-5.5", "effort": "xhigh" },
  "overrides": [
    {
      "when": "visual UI — how things look and feel: layout, styling, CSS/Tailwind, design polish, component appearance, animation implementation, accessibility. Frontend logic, state, and data wiring stay with the default worker.",
      "worker": "claude",
      "model": "claude-opus-4-8"
    },
    {
      "when": "creative UI exploration — divergent concepts, style directions, animation experiments before committing. Output is throwaway HTML in .atlas/explorations/, never app code.",
      "worker": "gemini",
      "model": "Gemini 3.1 Pro (High)"
    },
    {
      "when": "the user explicitly asks for a local / offline / private model, wants code kept on-machine, or wants to spare cloud quota. Local work is dispatched as narrow single-function/single-file subtasks, never full tickets",
      "worker": "local",
      "model": "google/gemma-4-26b-a4b-qat"
    }
  ]
}
```

- `defaultWorker` — used for anything that doesn't match an override. Its `model`/`effort` are passed to
  `codex exec` at runtime, so you can change them here freely.
- `overrides[]` — each `{ when, worker, model }`; the orchestrator matches your task against `when` by
  judgment, top to bottom.

## Field-tested reliability rules (v1.1)

Baked in after real-world runs:

- **`codex exec` / `agy` always run with `< /dev/null`** — without it they can hang indefinitely at
  "Reading additional input from stdin…" in non-interactive shells (hit twice, ~10+ min lost each time).
- **`--skip-git-repo-check`** on codex — avoids a guaranteed first-run failure in non-git directories.
- **Trust the diff, not the status** — the orchestrator verifies delivery with `git status`/`git diff`;
  worker reports are advisory (one got lost in transit, one hung worker claimed progress).
- **Parallel disjoint tickets** — multi-part tasks are split into tickets with explicit file-ownership
  lists and dispatched concurrently; Codex→Claude fallback if a ticket delivers nothing twice.
- **Cheap wrappers** — CLI-forwarding workers run on Haiku; the planner stays out of implementation.

## Known limitations

- **Worker models are pinned in the agent files' frontmatter.** Claude Code fixes a subagent's model in
  its definition, so the `model` field of a `claude` override is documentation — change the pinned model
  via the dashboard or by editing the agent file.
- **The planner (Fable 5) is your session model** — recommended, not forced (config/tools can't set the
  main session's model).
- No cross-model review or verify/fix loop yet (that's the sous-chef `/serve` upgrade path).
