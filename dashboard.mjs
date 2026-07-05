#!/usr/bin/env node
// Atlas dashboard — view and edit which model is used for what.
//
//   node dashboard.mjs [path-to-repo]     (defaults to the current directory)
//
// Edits <repo>/.atlas/config.json (routing) and the `model:` line of the
// ~/.claude/agents/atlas-*-worker.md files (pinned wrapper/worker models).
// Zero dependencies; binds to 127.0.0.1 only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const configPath = path.join(repoRoot, '.atlas', 'config.json');
const agentsDir = path.join(os.homedir(), '.claude', 'agents');
const PORT = Number(process.env.ATLAS_DASHBOARD_PORT ?? 4777);

const AGENT_NAMES = ['atlas-gpt-worker', 'atlas-claude-worker', 'atlas-gemini-worker', 'atlas-local-worker'];
const WORKER_TYPES = ['codex', 'claude', 'gemini', 'local'];

const DEFAULT_CONFIG = {
  planner: 'claude-fable-5',
  defaultWorker: { type: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
  overrides: [
    {
      when: 'visual UI — how things look and feel: layout, styling, CSS/Tailwind, design polish, component appearance, animation implementation, accessibility. Frontend logic, state, and data wiring stay with the default worker.',
      worker: 'claude',
      model: 'claude-opus-4-8',
    },
    {
      when: "creative UI exploration — the user wants divergent concepts, style directions, animation experiments, or 'show me what's possible' before committing. Output is throwaway HTML in .atlas/explorations/, never app code.",
      worker: 'gemini',
      model: 'Gemini 3.1 Pro (High)',
    },
  ],
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function validateConfig(c) {
  if (typeof c !== 'object' || c === null) return 'config must be an object';
  if (typeof c.planner !== 'string' || !c.planner.trim()) return 'planner must be a non-empty string';
  const d = c.defaultWorker;
  if (typeof d !== 'object' || d === null) return 'defaultWorker must be an object';
  if (!WORKER_TYPES.includes(d.type)) return `defaultWorker.type must be one of ${WORKER_TYPES.join(', ')}`;
  if (typeof d.model !== 'string' || !d.model.trim()) return 'defaultWorker.model must be a non-empty string';
  if (!Array.isArray(c.overrides)) return 'overrides must be an array';
  for (const [i, o] of c.overrides.entries()) {
    if (typeof o?.when !== 'string' || !o.when.trim()) return `overrides[${i}].when must be a non-empty string`;
    if (!WORKER_TYPES.includes(o?.worker)) return `overrides[${i}].worker must be one of ${WORKER_TYPES.join(', ')}`;
    if (typeof o?.model !== 'string' || !o.model.trim()) return `overrides[${i}].model must be a non-empty string`;
  }
  return null;
}

// Model/effort options. Live where the CLI can enumerate them (agy, lms);
// curated fallbacks where it can't (codex has no model-list command, and
// Claude Code model aliases aren't enumerable from a CLI).
let optionsCache = { at: 0, value: null };
function getOptions() {
  if (optionsCache.value && Date.now() - optionsCache.at < 60_000) return optionsCache.value;
  const run = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000 });
    } catch {
      return '';
    }
  };
  const agy = run('agy', ['models']).split('\n').map((s) => s.trim()).filter(Boolean);
  let lmstudio = [];
  try {
    lmstudio = JSON.parse(run('lms', ['ls', '--json']) || '[]')
      .filter((m) => m.type === 'llm')
      .map((m) => m.modelKey)
      .filter(Boolean);
  } catch {}
  const value = {
    codex: { models: ['gpt-5.5'], efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], live: false },
    claude: { models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'opus', 'sonnet', 'haiku'], live: false },
    gemini: { models: agy, live: agy.length > 0 },
    local: { models: lmstudio, live: lmstudio.length > 0 },
  };
  optionsCache = { at: Date.now(), value };
  return value;
}

function readAgents() {
  return AGENT_NAMES.map((name) => {
    const file = path.join(agentsDir, `${name}.md`);
    let exists = false;
    let model = null;
    try {
      const txt = fs.readFileSync(file, 'utf8');
      exists = true;
      model = txt.match(/^model:\s*(.+)$/m)?.[1]?.trim() ?? null;
    } catch {}
    return { name, file, exists, model };
  });
}

function setAgentModel(name, model) {
  if (!AGENT_NAMES.includes(name)) throw new Error('unknown agent');
  if (typeof model !== 'string' || !model.trim() || /[\r\n]/.test(model)) throw new Error('invalid model');
  const file = path.join(agentsDir, `${name}.md`);
  const txt = fs.readFileSync(file, 'utf8');
  if (!/^model:\s*.+$/m.test(txt)) throw new Error(`no model: line in ${file}`);
  fs.writeFileSync(file, txt.replace(/^model:\s*.+$/m, `model: ${model.trim()}`));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas dashboard</title>
<style>
  :root { color-scheme: light dark;
    --bg: #f6f6f4; --card: #ffffff; --ink: #1a1a1a; --muted: #6b6b66; --line: #e3e3de;
    --accent: #0b6e4f; --accent-ink: #ffffff; --danger: #a33; }
  @media (prefers-color-scheme: dark) { :root {
    --bg: #14141a; --card: #1d1d25; --ink: #ececf1; --muted: #9a9aa6; --line: #2c2c36;
    --accent: #34a37f; --accent-ink: #0c0c10; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
    margin: 36px 0 12px; }
  .sub { color: var(--muted); margin: 0 0 8px; font-size: 13px; }
  .sub code { font-size: 12px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; margin-bottom: 12px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
  input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--line);
    border-radius: 7px; background: var(--bg); color: var(--ink); font: inherit; }
  textarea { min-height: 64px; resize: vertical; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 140px; }
  button { padding: 8px 16px; border: 1px solid var(--line); border-radius: 7px;
    background: var(--card); color: var(--ink); font: inherit; cursor: pointer; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  button.ghost { color: var(--danger); }
  button:hover { filter: brightness(1.05); }
  .role { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px;
    border: 1px solid var(--line); color: var(--muted); margin-left: 6px; }
  .bar { position: sticky; bottom: 0; background: var(--bg); padding: 14px 0;
    display: flex; gap: 10px; align-items: center; border-top: 1px solid var(--line); }
  #status { font-size: 13px; color: var(--muted); }
  #status.err { color: var(--danger); }
  .agent { display: flex; gap: 10px; align-items: center; }
  .agent .name { flex: 1.2; font-family: ui-monospace, monospace; font-size: 13px; }
  .agent input { flex: 1; }
  .missing { color: var(--danger); font-size: 13px; }
  .hint { text-transform: none; letter-spacing: 0; font-weight: normal; opacity: .8; }
</style>
</head>
<body>
<main>
  <h1>Atlas dashboard</h1>
  <p class="sub" id="paths"></p>

  <h2>Planner</h2>
  <div class="card">
    <p class="sub">The brain. Plans, routes, and writes tickets — used as seldom as possible. This is
    your Claude Code session model (informational; set it with <code>/model</code>).</p>
    <label>Model</label>
    <input id="planner">
  </div>

  <h2>Default worker <span class="role">the workhorse — all code unless an override matches</span></h2>
  <div class="card">
    <div class="row">
      <div><label>Type</label><select id="dw-type"></select></div>
      <div><label>Model</label><input id="dw-model"></div>
      <div><label>Effort</label><input id="dw-effort" placeholder="e.g. xhigh"></div>
    </div>
  </div>

  <h2>Overrides <span class="role">matched top-to-bottom by the orchestrator's judgment</span></h2>
  <div id="overrides"></div>
  <button id="add-override">+ Add override</button>

  <h2>Worker agents <span class="role">pinned models in ~/.claude/agents</span></h2>
  <p class="sub">Claude Code fixes each subagent's model in its definition file — the wrapper model for
  CLI workers (gpt/gemini), the implementing model for the claude worker.</p>
  <div class="card" id="agents"></div>

  <div class="bar">
    <button class="primary" id="save">Save config</button>
    <span id="status"></span>
  </div>
  <div id="datalists"></div>
</main>
<script>
const WORKER_TYPES = ${JSON.stringify(WORKER_TYPES)};
let state;

const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function setStatus(msg, isErr) {
  $('status').textContent = msg;
  $('status').className = isErr ? 'err' : '';
}

function modelHint(type) {
  const o = state?.options?.[type];
  if (!o) return '';
  return o.live ? \`live from \${type === 'local' ? 'lms ls' : 'agy models'}\` : 'curated — CLI has no list command';
}

function renderOverrides(overrides) {
  $('overrides').innerHTML = overrides.map((o, i) => \`
    <div class="card" data-i="\${i}">
      <label>When (natural language — the orchestrator matches by judgment)</label>
      <textarea class="ov-when">\${esc(o.when)}</textarea>
      <div class="row">
        <div><label>Worker</label>
          <select class="ov-worker">\${WORKER_TYPES.map((t) =>
            \`<option \${t === o.worker ? 'selected' : ''}>\${t}</option>\`).join('')}</select></div>
        <div><label>Model <span class="hint">(\${modelHint(o.worker)})</span></label>
          <input class="ov-model" list="dl-\${o.worker}" value="\${esc(o.model)}"></div>
        <div style="flex:0;align-self:flex-end"><button class="ghost ov-remove">Remove</button></div>
      </div>
    </div>\`).join('');
  document.querySelectorAll('.ov-remove').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      const i = Number(e.target.closest('[data-i]').dataset.i);
      collectOverrides().then((list) => { list.splice(i, 1); renderOverrides(list); });
    }));
  document.querySelectorAll('.ov-worker').forEach((sel) =>
    sel.addEventListener('change', (e) => {
      const card = e.target.closest('[data-i]');
      card.querySelector('.ov-model').setAttribute('list', 'dl-' + e.target.value);
      card.querySelector('.hint').textContent = '(' + modelHint(e.target.value) + ')';
    }));
}

async function collectOverrides() {
  return [...document.querySelectorAll('#overrides [data-i]')].map((card) => ({
    when: card.querySelector('.ov-when').value,
    worker: card.querySelector('.ov-worker').value,
    model: card.querySelector('.ov-model').value,
  }));
}

function renderAgents(agents) {
  $('agents').innerHTML = agents.map((a) => a.exists ? \`
    <div class="agent" data-name="\${a.name}" style="margin:6px 0">
      <span class="name">\${a.name}</span>
      <input class="ag-model" list="dl-claude" value="\${esc(a.model ?? '')}">
      <button class="ag-save">Save</button>
    </div>\` : \`
    <div class="agent" style="margin:6px 0">
      <span class="name">\${a.name}</span>
      <span class="missing">not installed (\${esc(a.file)})</span>
    </div>\`).join('');
  document.querySelectorAll('.ag-save').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-name]');
      const res = await fetch('/api/agent-model', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: row.dataset.name, model: row.querySelector('.ag-model').value }),
      });
      const body = await res.json();
      setStatus(res.ok ? \`Saved \${row.dataset.name}\` : body.error, !res.ok);
    }));
}

async function load() {
  state = await (await fetch('/api/state')).json();
  $('paths').innerHTML = \`Repo: <code>\${esc(state.repoRoot)}</code> · Config: <code>\${esc(state.configPath)}</code>\` +
    (state.configExists ? '' : ' <b>(will be created on save)</b>');
  $('datalists').innerHTML = Object.entries(state.options).map(([type, o]) =>
    \`<datalist id="dl-\${type}">\${o.models.map((m) => \`<option value="\${esc(m)}">\`).join('')}</datalist>\`
  ).join('') + \`<datalist id="dl-effort">\${state.options.codex.efforts.map((e) =>
    \`<option value="\${e}">\`).join('')}</datalist>\`;
  const c = state.config;
  $('planner').value = c.planner;
  $('dw-type').innerHTML = WORKER_TYPES.map((t) =>
    \`<option \${t === c.defaultWorker.type ? 'selected' : ''}>\${t}</option>\`).join('');
  $('dw-model').value = c.defaultWorker.model;
  $('dw-model').setAttribute('list', 'dl-' + c.defaultWorker.type);
  $('dw-type').addEventListener('change', () =>
    $('dw-model').setAttribute('list', 'dl-' + $('dw-type').value));
  $('dw-effort').value = c.defaultWorker.effort ?? '';
  $('dw-effort').setAttribute('list', 'dl-effort');
  renderOverrides(c.overrides);
  renderAgents(state.agents);
}

$('add-override').addEventListener('click', async () => {
  const list = await collectOverrides();
  list.push({ when: '', worker: 'claude', model: '' });
  renderOverrides(list);
});

$('save').addEventListener('click', async () => {
  const config = {
    planner: $('planner').value,
    defaultWorker: { type: $('dw-type').value, model: $('dw-model').value },
    overrides: await collectOverrides(),
  };
  if ($('dw-effort').value.trim()) config.defaultWorker.effort = $('dw-effort').value.trim();
  const res = await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const body = await res.json();
  setStatus(res.ok ? 'Config saved' : body.error, !res.ok);
  if (res.ok) load();
});

load();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && req.url === '/api/state') {
      const config = readConfig();
      return json(res, 200, {
        repoRoot,
        configPath,
        configExists: config !== null,
        config: config ?? DEFAULT_CONFIG,
        agents: readAgents(),
        options: getOptions(),
      });
    }
    if (req.method === 'POST' && req.url === '/api/config') {
      const config = JSON.parse(await readBody(req));
      const err = validateConfig(config);
      if (err) return json(res, 400, { error: err });
      writeConfig(config);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/agent-model') {
      const { name, model } = JSON.parse(await readBody(req));
      setAgentModel(name, model);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Atlas dashboard → http://127.0.0.1:${PORT}`);
  console.log(`  repo:   ${repoRoot}`);
  console.log(`  config: ${configPath}${fs.existsSync(configPath) ? '' : ' (not created yet)'}`);
});
