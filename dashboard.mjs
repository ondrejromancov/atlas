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

// ---------------------------------------------------------------------------
// Traces — per-run model activity, tokens, and estimated cost, mined from the
// Claude Code session transcripts for this repo's project directory.

// $/MTok (platform.claude.com pricing, 2026-07). Cache read = 0.1× input rate,
// cache write = 1.25× input rate (5m TTL).
const PRICES = [
  { match: 'fable', in: 10, out: 50 },
  { match: 'opus', in: 5, out: 25 },
  { match: 'sonnet', in: 3, out: 15 },
  { match: 'haiku', in: 1, out: 5 },
];

const LANES = [
  { key: 'fable', label: 'Fable 5 (planner)' },
  { key: 'codex', label: 'Codex (GPT-5.5)' },
  { key: 'opus', label: 'Claude Opus' },
  { key: 'sonnet', label: 'Claude Sonnet' },
  { key: 'haiku', label: 'Haiku (wrappers)' },
  { key: 'gemini', label: 'Gemini (agy)' },
  { key: 'local', label: 'Local (LM Studio)' },
];

// --- external CLI logs: authoritative usage for the non-Claude models -------

// Codex rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — per-turn
// token_count events with timestamps; session_meta carries the cwd.
function collectCodexEvents(startMs, endMs, events) {
  const base = path.join(os.homedir(), '.codex', 'sessions');
  const pad = Math.max(endMs - startMs, 120_000) * 0 + 120_000;
  const seen = new Set();
  for (let t = startMs - 86_400_000; t <= endMs + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    const dir = path.join(base, String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    if (seen.has(dir)) continue;
    seen.add(dir);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let txt;
      try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      if (!txt.includes('"cwd":"' + repoRoot + '"')) continue;
      for (const line of txt.split('\n')) {
        if (!line.includes('"token_count"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const ts = Date.parse(o.timestamp ?? '');
        if (!Number.isFinite(ts) || ts < startMs - pad || ts > endMs + pad) continue;
        const u = o.payload?.info?.last_token_usage;
        if (!u) continue;
        events.push({
          ts, lane: 'codex',
          cxIn: Math.max((u.input_tokens || 0) - (u.cached_input_tokens || 0), 0),
          cxCached: u.cached_input_tokens || 0,
          cxOut: u.output_tokens || 0,
        });
      }
    }
  }
}

// agy history: ~/.gemini/antigravity-cli/history.jsonl — one line per turn
// with workspace + ms timestamp. No token counts; activity markers only.
function collectGeminiEvents(startMs, endMs, events) {
  let txt;
  try {
    txt = fs.readFileSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'history.jsonl'), 'utf8');
  } catch { return; }
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.workspace !== repoRoot) continue;
    const ts = o.timestamp;
    if (!Number.isFinite(ts) || ts < startMs - 120_000 || ts > endMs + 120_000) continue;
    events.push({ ts, lane: 'gemini', marker: true });
  }
}

// LM Studio server logs: ~/.lmstudio/server-logs/YYYY-MM/YYYY-MM-DD.N.log —
// per-request lines with local-time timestamps + prompt token counts. Not
// workspace-attributed; any local inference inside the window is shown.
function collectLocalEvents(startMs, endMs, events) {
  const base = path.join(os.homedir(), '.lmstudio', 'server-logs');
  const seen = new Set();
  for (let t = startMs; t <= endMs + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const mdir = path.join(base, day.slice(0, 7));
    let files = [];
    try { files = fs.readdirSync(mdir); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith(day) || seen.has(f)) continue;
      seen.add(f);
      let txt;
      try { txt = fs.readFileSync(path.join(mdir, f), 'utf8'); } catch { continue; }
      for (const line of txt.split('\n')) {
        const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\].*?cached_tokens=(\d+) uncached_tokens=(\d+)/);
        if (!m) continue;
        const ts = Date.parse(m[1].replace(' ', 'T'));
        if (!Number.isFinite(ts) || ts < startMs - 120_000 || ts > endMs + 120_000) continue;
        events.push({ ts, lane: 'local', lcTok: Number(m[2]) + Number(m[3]) });
      }
    }
  }
}

function laneForModel(model) {
  for (const key of ['fable', 'opus', 'sonnet', 'haiku']) {
    if (model.includes(key)) return key;
  }
  return null;
}

function parseTranscriptText(txt, events, fileKey = 'main') {
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const isAssistant = line.includes('"assistant"');
    const hasCodex = line.includes('tokens used');
    if (!isAssistant && !hasCodex) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp ?? '');
    if (!Number.isFinite(ts)) continue;
    const usage = obj.message?.usage;
    if (obj.type === 'assistant' && usage && obj.message?.model) {
      const lane = laneForModel(obj.message.model);
      if (lane) {
        events.push({
          ts,
          lane,
          in: usage.input_tokens || 0,
          out: usage.output_tokens || 0,
          cr: usage.cache_read_input_tokens || 0,
          cw: usage.cache_creation_input_tokens || 0,
        });
      }
    }
    if (hasCodex) {
      // codex exec logs cumulative "tokens used: N" lines; the run's total is
      // the max per transcript file (buildTrace takes max per fileKey).
      const m = line.match(/tokens used[^0-9]{0,24}([\d,]{3,})/i);
      if (m) {
        const n = Number(m[1].replace(/,/g, ''));
        if (n >= 1000) events.push({ ts, lane: 'codex', codexTokens: n, fileKey });
      }
    }
  }
}

function firstUserLabel(txt) {
  for (const line of txt.split('\n')) {
    if (!line.includes('"user"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type !== 'user') continue;
      const c = o.message?.content;
      const s = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text ?? '') : '';
      const clean = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!clean || clean.startsWith('Caveat:')) continue;
      if (clean.startsWith('/') && clean.length < 40) continue;
      return clean.slice(0, 90);
    } catch {}
  }
  return '';
}

function buildTrace(id, label, events) {
  let start = Infinity;
  let end = -Infinity;
  for (const e of events) {
    if (e.ts < start) start = e.ts;
    if (e.ts > end) end = e.ts;
  }
  const dur = Math.max(end - start, 1);
  const byLane = {};
  for (const e of events) {
    const l = (byLane[e.lane] ??= {
      ts: [], in: 0, out: 0, cr: 0, cw: 0, codexByFile: {},
      cxIn: 0, cxCached: 0, cxOut: 0, cx: false, lcTok: 0, markers: 0,
    });
    l.ts.push(e.ts);
    if (e.codexTokens) {
      // scrape fallback: max cumulative "tokens used" figure per worker file
      l.codexByFile[e.fileKey] = Math.max(l.codexByFile[e.fileKey] ?? 0, e.codexTokens);
    } else if (e.cxIn !== undefined) {
      l.cx = true;
      l.cxIn += e.cxIn;
      l.cxCached += e.cxCached;
      l.cxOut += e.cxOut;
    } else if (e.marker) {
      l.markers++;
    } else if (e.lcTok !== undefined) {
      l.lcTok += e.lcTok;
      l.markers++;
    } else {
      l.in += e.in;
      l.out += e.out;
      l.cr += e.cr;
      l.cw += e.cw;
    }
  }
  const gap = Math.max(30_000, dur * 0.015);
  const lanes = [];
  for (const { key } of LANES) {
    const l = byLane[key];
    if (!l) continue;
    l.ts.sort((a, b) => a - b);
    const segments = [];
    for (const t of l.ts) {
      const last = segments[segments.length - 1];
      if (last && t - last.t1 <= gap) {
        last.t1 = t;
        last.n++;
      } else {
        segments.push({ t0: t, t1: t, n: 1 });
      }
    }
    const codex = Object.values(l.codexByFile).reduce((a, b) => a + b, 0);
    const price = PRICES.find((p) => key.includes(p.match)) ?? null;
    const cost = price
      ? (l.in * price.in + l.out * price.out + l.cr * price.in * 0.1 + l.cw * price.in * 1.25) / 1e6
      : 0;
    lanes.push({
      key,
      segments: segments.map((s) => ({
        start: (s.t0 - start) / dur,
        end: (s.t1 - start) / dur,
        t0: s.t0,
        t1: s.t1,
        n: s.n,
      })),
      tokens: {
        in: l.in, out: l.out, cacheRead: l.cr, cacheWrite: l.cw, codex,
        cx: l.cx, cxIn: l.cxIn, cxCached: l.cxCached, cxOut: l.cxOut,
        lcTok: l.lcTok, markers: l.markers,
      },
      cost,
    });
  }
  // Savings: exact Fable-equivalent when Codex rollout breakdowns exist,
  // otherwise a rate-range estimate from the scraped total.
  const cx = lanes.find((l) => l.key === 'codex')?.tokens;
  let savings;
  if (cx?.cx) {
    savings = {
      mode: 'exact',
      codexIn: cx.cxIn + cx.cxCached,
      codexOut: cx.cxOut,
      est: (cx.cxIn * 10 + cx.cxCached * 1 + cx.cxOut * 50) / 1e6,
    };
  } else {
    const total = cx?.codex ?? 0;
    savings = { mode: 'range', codexTokens: total, low: (total * 10) / 1e6, high: (total * 50) / 1e6 };
  }
  const lc = lanes.find((l) => l.key === 'local')?.tokens.lcTok ?? 0;
  return {
    id,
    label,
    start,
    end,
    lanes,
    totalCost: lanes.reduce((a, l) => a + l.cost, 0),
    savings,
    localTokens: lc,
  };
}

let tracesCache = { at: 0, value: null };
function getTraces() {
  if (tracesCache.value && Date.now() - tracesCache.at < 60_000) return tracesCache.value;
  const projDir = path.join(os.homedir(), '.claude', 'projects', repoRoot.replace(/[/.]/g, '-'));
  const traces = [];
  let files = [];
  try {
    files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
  } catch {}
  for (const f of files) {
    let txt;
    try {
      txt = fs.readFileSync(path.join(projDir, f), 'utf8');
    } catch {
      continue;
    }
    // Only sessions that actually DISPATCHED an atlas worker — not ones that
    // merely mention the workers (e.g. sessions spent building/analyzing atlas).
    if (!/(subagent_type|customAgentType)"?\s*:\s*"atlas-(gpt|claude|gemini|local)-worker/.test(txt)) continue;
    const events = [];
    parseTranscriptText(txt, events, 'main');
    const subDir = path.join(projDir, f.replace(/\.jsonl$/, ''), 'subagents');
    try {
      for (const sf of fs.readdirSync(subDir)) {
        if (!sf.endsWith('.jsonl')) continue;
        try {
          parseTranscriptText(fs.readFileSync(path.join(subDir, sf), 'utf8'), events, sf);
        } catch {}
      }
    } catch {}
    if (!events.length) continue;
    let s = Infinity;
    let e = -Infinity;
    for (const ev of events) {
      if (ev.ts < s) s = ev.ts;
      if (ev.ts > e) e = ev.ts;
    }
    collectCodexEvents(s, e, events);
    collectGeminiEvents(s, e, events);
    collectLocalEvents(s, e, events);
    traces.push(buildTrace(f.replace(/\.jsonl$/, ''), firstUserLabel(txt), events));
  }
  traces.sort((a, b) => b.start - a.start);
  tracesCache = { at: Date.now(), value: traces };
  return traces;
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
  .agent .name { flex: 0 0 175px; font-family: ui-monospace, monospace; font-size: 13px; }
  .agent .brain { flex: 1.2; font-size: 13px; color: var(--muted); }
  .agent .brain b { color: var(--ink); font-weight: 600; }
  .agent .wlabel { flex: none; font-size: 11px; color: var(--muted); text-transform: uppercase;
    letter-spacing: .05em; }
  .agent input { flex: 0 1 170px; }
  .missing { color: var(--danger); font-size: 13px; }
  .hint { text-transform: none; letter-spacing: 0; font-weight: normal; opacity: .8; }
  /* Trace viz — validated categorical slots (dataviz reference palette) */
  :root { --viz-grid: #e1e0d9; --viz-axis: #c3c2b7; --viz-muted: #898781;
    --s-fable: #2a78d6; --s-codex: #1baf7a; --s-opus: #eda100; --s-sonnet: #008300; --s-haiku: #4a3aa7;
    --s-gemini: #e34948; --s-local: #e87ba4; }
  @media (prefers-color-scheme: dark) { :root { --viz-grid: #2c2c2a; --viz-axis: #383835;
    --s-fable: #3987e5; --s-codex: #199e70; --s-opus: #c98500; --s-sonnet: #008300; --s-haiku: #9085e9;
    --s-gemini: #e66767; --s-local: #d55181; } }
  .lane { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 10px; margin: 8px 0; }
  .lane .lname { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .lane .swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .lane .track { position: relative; height: 14px; border-bottom: 1px solid var(--viz-grid); }
  .lane .seg { position: absolute; top: 2px; height: 10px; border-radius: 4px; min-width: 3px; cursor: default; }
  .axis { display: grid; grid-template-columns: 150px 1fr; gap: 10px; }
  .axis .ticks { display: flex; justify-content: space-between; font-size: 11px; color: var(--viz-muted);
    border-top: 1px solid var(--viz-axis); padding-top: 3px; font-variant-numeric: tabular-nums; }
  #trace-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
  #trace-table th { text-align: right; font-weight: 500; color: var(--muted); font-size: 11px;
    text-transform: uppercase; letter-spacing: .05em; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  #trace-table th:first-child, #trace-table td:first-child { text-align: left; }
  #trace-table td { padding: 5px 8px; text-align: right; font-variant-numeric: tabular-nums;
    border-bottom: 1px solid var(--viz-grid); }
  #trace-table tr:last-child td { border-bottom: none; font-weight: 600; }
  #tip { position: fixed; z-index: 10; background: var(--card); border: 1px solid var(--line);
    border-radius: 7px; padding: 6px 10px; font-size: 12px; pointer-events: none;
    box-shadow: 0 2px 10px rgba(0,0,0,.15); }
  #savings { margin-top: 10px; }
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

  <h2>Worker agents <span class="role">who actually writes the code</span></h2>
  <p class="sub">Three of the four workers are thin wrappers: a small Claude subagent whose only job is
  to shell out to another CLI — the real work happens in that CLI's model (shown per row). The wrapper
  model just forwards the ticket, so cheap (haiku) is correct. Only the claude worker implements
  directly with its pinned model.</p>
  <div class="card" id="agents"></div>

  <h2>Traces <span class="role">per-run model activity, tokens &amp; est. cost</span></h2>
  <div class="card" id="traces-card">
    <label>Atlas session</label>
    <select id="trace-select"></select>
    <div id="swimlane" style="margin-top:14px"></div>
    <div class="axis"><span></span><div class="ticks" id="trace-ticks"></div></div>
    <table id="trace-table"></table>
    <p class="sub" id="savings"></p>
  </div>

  <div class="bar">
    <button class="primary" id="save">Save config</button>
    <span id="status"></span>
  </div>
  <div id="datalists"></div>
  <div id="tip" hidden></div>
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

function workerBrain(name) {
  // What actually implements the ticket, resolved from the routing config.
  const c = state.config;
  if (name === 'atlas-gpt-worker')
    return \`runs <b>\${esc(c.defaultWorker.model)}</b> via Codex CLI\`;
  if (name === 'atlas-claude-worker')
    return 'implements directly with the pinned model →';
  if (name === 'atlas-gemini-worker') {
    const o = c.overrides.find((x) => x.worker === 'gemini');
    return \`runs <b>\${esc(o?.model ?? 'Gemini 3.1 Pro')}</b> via agy CLI\`;
  }
  if (name === 'atlas-local-worker') {
    const o = c.overrides.find((x) => x.worker === 'local');
    return \`runs <b>\${esc(o?.model ?? 'local model')}</b> via LM Studio\`;
  }
  return '';
}

function renderAgents(agents) {
  $('agents').innerHTML = agents.map((a) => a.exists ? \`
    <div class="agent" data-name="\${a.name}" style="margin:8px 0">
      <span class="name">\${a.name}</span>
      <span class="brain">\${workerBrain(a.name)}</span>
      <span class="wlabel">\${a.name === 'atlas-claude-worker' ? 'model' : 'wrapper'}</span>
      <input class="ag-model" list="dl-claude" value="\${esc(a.model ?? '')}">
      <button class="ag-save">Save</button>
    </div>\` : \`
    <div class="agent" style="margin:8px 0">
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

// ---- Traces ----
let traceData;

const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const fmtUsd = (n) => '$' + n.toFixed(n >= 10 ? 0 : 2);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function laneLabel(key) { return traceData.lanes.find((l) => l.key === key)?.label ?? key; }

function renderTrace(trace) {
  $('swimlane').innerHTML = trace.lanes.map((lane) => \`
    <div class="lane">
      <span class="lname"><span class="swatch" style="background:var(--s-\${lane.key})"></span>\${esc(laneLabel(lane.key))}</span>
      <div class="track">\${lane.segments.map((s, i) => \`
        <div class="seg" data-lane="\${lane.key}" data-i="\${i}"
          style="left:\${(s.start * 100).toFixed(2)}%;width:\${Math.max((s.end - s.start) * 100, 0.4).toFixed(2)}%;background:var(--s-\${lane.key})"></div>\`).join('')}
      </div>
    </div>\`).join('');
  $('trace-ticks').innerHTML = \`<span>\${fmtTime(trace.start)}</span>\` +
    \`<span>\${Math.round((trace.end - trace.start) / 60000)} min</span>\` +
    \`<span>\${fmtTime(trace.end)}</span>\`;

  const cells = (l) => {
    const t = l.tokens;
    if (l.key === 'codex') {
      return t.cx
        ? [fmtTok(t.cxIn), fmtTok(t.cxOut), fmtTok(t.cxCached), '$0 (subscription)']
        : [t.codex ? fmtTok(t.codex) + ' total' : '—', '—', '—', '$0 (subscription)'];
    }
    if (l.key === 'gemini') return [\`\${t.markers} turn\${t.markers === 1 ? '' : 's'}\`, '—', '—', '$0 (plan)'];
    if (l.key === 'local') return [t.lcTok ? fmtTok(t.lcTok) + ' prompt' : \`\${t.markers} req\`, '—', '—', '$0 (local)'];
    return [fmtTok(t.in + t.cacheRead + t.cacheWrite), fmtTok(t.out), fmtTok(t.cacheRead), fmtUsd(l.cost)];
  };
  const rows = trace.lanes.map((l) => \`
    <tr>
      <td><span class="swatch" style="display:inline-block;background:var(--s-\${l.key});margin-right:6px;width:8px;height:8px;border-radius:2px"></span>\${esc(laneLabel(l.key))}</td>
      \${cells(l).map((c) => \`<td>\${c}</td>\`).join('')}
    </tr>\`).join('');
  $('trace-table').innerHTML = \`
    <tr><th>Model</th><th>Input tok</th><th>Output tok</th><th>Cache read</th><th>Est. cost</th></tr>
    \${rows}
    <tr><td>Total billed (Claude)</td><td></td><td></td><td></td><td>\${fmtUsd(trace.totalCost)}</td></tr>\`;

  const s = trace.savings;
  let msg;
  if (s.mode === 'exact' && (s.codexIn || s.codexOut)) {
    msg = \`Codex ran \${fmtTok(s.codexIn)} in / \${fmtTok(s.codexOut)} out tokens at $0 — ≈ \${fmtUsd(s.est)} at Fable 5 rates.\`;
  } else if (s.mode === 'range' && s.codexTokens > 0) {
    msg = \`Codex handled \${fmtTok(s.codexTokens)} tokens at $0 — roughly \${fmtUsd(s.low)}–\${fmtUsd(s.high)} on Fable 5 (rate-range estimate).\`;
  } else {
    msg = 'No Codex usage found in this trace.';
  }
  if (trace.localTokens > 0) msg += \` Local model processed \${fmtTok(trace.localTokens)} prompt tokens offline.\`;
  $('savings').textContent = msg;

  document.querySelectorAll('.seg').forEach((el) =>
    el.addEventListener('mousemove', (e) => {
      const lane = trace.lanes.find((l) => l.key === el.dataset.lane);
      const seg = lane.segments[Number(el.dataset.i)];
      const tip = $('tip');
      tip.innerHTML = \`<b>\${esc(laneLabel(lane.key))}</b><br>\${fmtTime(seg.t0)}–\${fmtTime(seg.t1)} · \${seg.n} event\${seg.n > 1 ? 's' : ''}\`;
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 180) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    }));
  document.querySelectorAll('.seg').forEach((el) =>
    el.addEventListener('mouseleave', () => { $('tip').hidden = true; }));
}

async function loadTraces() {
  traceData = await (await fetch('/api/traces')).json();
  const sel = $('trace-select');
  if (!traceData.traces.length) {
    $('traces-card').innerHTML = '<p class="sub">No Atlas sessions found for this repo yet — run /atlas here first.</p>';
    return;
  }
  sel.innerHTML = traceData.traces.map((t, i) =>
    \`<option value="\${i}">\${new Date(t.start).toLocaleString()} — \${esc(t.label || t.id.slice(0, 8))}</option>\`).join('');
  sel.addEventListener('change', () => renderTrace(traceData.traces[Number(sel.value)]));
  renderTrace(traceData.traces[0]);
}
loadTraces();

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
    if (req.method === 'GET' && req.url === '/api/traces') {
      return json(res, 200, { lanes: LANES, traces: getTraces() });
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
