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
| **Scout** | Claude Sonnet 5 | `atlas-scout` | Read-only recon that fuels tickets: repo maps, grep answers, infra digests, env discovery. The planner never reads the repo itself — its cache-read cost per turn exceeds an entire scout run. |
| **Verifier** | Claude Haiku | `atlas-verifier` | Acceptance batteries (typecheck/build/tests/probes/diff-scope) and long waits (CI watch, release smoke tests). Returns `VERDICT: PASS/FAIL`; the planner reads verdicts instead of re-running checks. |

The models above are the shipped defaults. The **authoritative** source is each agent's frontmatter
(`model:`) plus `.atlas/config.json` for the Codex/agy/local models — the `/atlas` prose no longer names
models. The wrapper agents themselves run on Haiku; the table's model is the CLI-driven one they forward
the ticket to.

## Why standalone (not a plugin)

Claude Code always namespaces plugin commands (`/plugin:command`). To get a bare `/atlas`, this ships as
standalone user config in `~/.claude/`, not as a marketplace plugin.

## Install

Clone the repo and run the installer:

```bash
git clone https://github.com/ondrejromancov/atlas.git
cd atlas
./install.sh
```

`install.sh` **symlinks** the command, the agents, and the `scripts/` directory into `~/.claude`. It
backs up any existing regular files to `*.bak.<timestamp>` and is idempotent (re-running it is a no-op
once the links are in place). Because the links point back at the clone, **the repo is the live
install**: editing a repo file — or the dashboard editing an agent's frontmatter through the symlink —
takes effect immediately, with no re-install and none of the copy-drift the old `cp` flow suffered.

Repo layout mirrors the install destination:

```
commands/atlas.md               → ~/.claude/commands/atlas.md              # the /atlas orchestrator command
agents/atlas-gpt-worker.md      → ~/.claude/agents/atlas-gpt-worker.md     # workhorse → codex exec (GPT-5.5)
agents/atlas-claude-worker.md   → ~/.claude/agents/atlas-claude-worker.md  # UI worker → Opus 4.8
agents/atlas-gemini-worker.md   → ~/.claude/agents/atlas-gemini-worker.md  # explorer → agy (Gemini 3.1 Pro)
agents/atlas-local-worker.md    → ~/.claude/agents/atlas-local-worker.md   # private hand → codex --oss (LM Studio)
agents/atlas-scout.md           → ~/.claude/agents/atlas-scout.md          # recon → Sonnet 5, read-only
agents/atlas-verifier.md        → ~/.claude/agents/atlas-verifier.md       # acceptance checks → Haiku
scripts/                        → ~/.claude/atlas/scripts                  # run-codex.sh / run-agy.sh wrappers
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

The **Projects** overview lists every sibling repo with an Atlas config — trace count, last run, total
billed, total saved, and whether its config matches your **base template**
(`~/.claude/atlas/config.json`). Click a project to edit its config and browse its traces; "Save as
base template" captures the current config as the template, and "Apply template" (per project or to
all) keeps repo configs in sync. `/atlas` bootstraps new repos from the template when one exists.

The config editor edits the selected repo's `.atlas/config.json` (planner, default worker, overrides)
and the pinned `model:` lines of the installed `~/.claude/agents/atlas-*.md` files. Model dropdowns are
populated live from `agy models` and `lms ls` where those CLIs can enumerate; curated lists elsewhere.
The `claude` override carries no model of its own, so its row shows the pinned agent-file model
**read-only** — matching reality instead of offering an editable field that never took effect. Zero
dependencies, localhost only.

The **Traces** section shows, per Atlas run, a per-model activity timeline and a token/cost breakdown.
Claude usage comes from the repo's Claude Code transcripts; the other models come from their own CLIs'
local logs, matched to the run's time window:

- **Codex** — `~/.codex/sessions/` rollouts (per-turn tokens incl. cache, attributed by repo cwd)
- **Gemini** — `~/.gemini/antigravity-cli/history.jsonl` (per-turn activity, attributed by workspace)
- **Local** — `~/.lmstudio/server-logs/` (per-request prompt tokens; time-window attribution only)

The savings line is an **estimate**: it prices Codex's actual token mix at Fable 5 rates — roughly what
that work would have cost had the planner done it itself. Two caveats are stated inline: it assumes the
planner would have spent the same token count, and it ignores that Codex's marginal cost under a ChatGPT
subscription is effectively $0.

## Config (`.atlas/config.json`)

```json
{
  "planner": "claude-fable-5",
  "defaultWorker": { "type": "codex", "model": "gpt-5.5", "effort": "xhigh" },
  "overrides": [
    {
      "when": "visual UI — how things look and feel: layout, styling, CSS/Tailwind, design polish, component appearance, animation implementation, accessibility. Frontend logic, state, and data wiring stay with the default worker.",
      "worker": "claude"
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
  judgment, top to bottom. The `codex`/`gemini`/`local` workers carry a `model` string passed to their
  CLI; the `claude` override has **no** `model` field — its model is pinned in the agent frontmatter, and
  an old config that still carries the field is tolerated (the field is ignored).

## Delegation-first rules (v3 — from a 5-session token autopsy)

Mined from ~$1,300 of real sessions: the planner typed 50–60% of its output as code in non-Atlas
sessions, and its per-turn cache reads (~$0.30–0.50) made every self-run grep cost more than a whole
Haiku worker session. Atlas sessions cost 5–10× less. Hence:

- **Delegation-first**: anything beyond a one-line fix is a ticket; an approved plan/task list IS the
  ticket board — dispatch it, don't execute item 1 yourself. (Also installed as a default posture in
  the user-level CLAUDE.md so non-/atlas sessions don't regress to solo.)
- **Scouts, not self-reads**: tickets are fueled by parallel `atlas-scout` digests (Sonnet 5 — recon quality matters, and it is still ~15x cheaper than planner turns; only the mechanical verifier stays on Haiku).
- **Deterministic wave dispatch**: a wave of 2+ independent tickets is driven by Claude Code's **Workflow**
  tool (`agentType` per worker, `parallel()`/`pipeline()`, optional `{ isolation: 'worktree' }`), so
  concurrency and refill are runtime-enforced rather than prompt-enforced. The prose rolling-queue rules
  (batch spawns in one message, refill from the ready-queue, never end the turn with tickets pending)
  remain the fallback when the Workflow tool is unavailable (observed: avg 1.6 concurrent workers when 6
  were possible, plus user-nudge stalls).
- **Triviality fast-path**: a genuinely trivial single-file change (≤~10 lines, no design decision) skips
  scouts and the verifier — one 3-line ticket, one worker, confirm via the diff.
- **Worktree isolation for overlap**: tickets that can't be made file-disjoint each get their own git
  worktree instead of serializing on the shared directory (automatic under Workflow, or an explicit
  `git worktree add … -b atlas/<slug>` recipe when dispatched via Task).
- **Verify once, cheaply**: workers self-verify at the right layer (browser for UI); `atlas-verifier`
  runs the acceptance battery and CI watches; the planner reads verdicts (observed: double-paid
  verification every wave).
- **Report contract**: workers start their final message with `SUCCESS:`/`FAILED:` — anything else is
  treated as failure (observed: silent Gemini stall, summary-only teammate notifications).
- **Fast taste loops**: batch N divergent variants in one ticket and keep the worker warm via
  SendMessage, instead of cold-starting a worker per micro-tweak.

## Field-tested reliability rules (v1.1)

Baked in after real-world runs. Workers no longer hand-compose CLI flags — they write the ticket to a
file, run `scripts/run-codex.sh` / `scripts/run-agy.sh`, interpret the exit code (0 ok, 3 = dud, 2 = CLI
missing, 1 = failed), verify the diff, and report the printed `FILES CHANGED` list and log path. So the
first two rules below are now **guaranteed by the scripts** rather than per prompt; they stay as rationale:

- **`codex exec` / `agy` always run with `< /dev/null`** — without it they can hang indefinitely at
  "Reading additional input from stdin…" in non-interactive shells (hit twice, ~10+ min lost each time).
- **`--skip-git-repo-check`** on codex — avoids a guaranteed first-run failure in non-git directories.
- **Trust the diff, not the status** — the orchestrator verifies delivery with `git status`/`git diff`;
  worker reports are advisory (one got lost in transit, one hung worker claimed progress).
- **Parallel disjoint tickets** — multi-part tasks are split into tickets with explicit file-ownership
  lists and dispatched concurrently; Codex→Claude fallback if a ticket delivers nothing twice.
- **Cheap wrappers** — CLI-forwarding workers run on Haiku; the planner stays out of implementation.

## Known limitations

- **The planner (Fable 5) is your session model** — recommended, not forced (config/tools can't set the
  main session's model).
- No cross-model review or verify/fix loop yet (that's the sous-chef `/serve` upgrade path).
