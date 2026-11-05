#!/usr/bin/env node
// Raftaar hook. Claude Code runs this on lifecycle events; it reads the event
// JSON from stdin and updates one state file per session.
//
// Hard rules: never print to stdout (stdout from some hooks is injected into
// Claude's context and would cost tokens), always exit 0, finish fast, never
// launch anything. Errors go to <base>/hook-errors.log.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export function baseDir(env = process.env) {
  if (env.RAFTAAR_HOME) return env.RAFTAAR_HOME;
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Raftaar');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Raftaar');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'raftaar');
}

const PHASE_RE = /phase\s*(\d+)/i;
const TASK_PHASE_RE = /^\s*\[phase\s*(\d+)\]/i;
const now = () => new Date().toISOString();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson(file) {
  for (let i = 0; i < 4; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      sleepSync(10); // locked or half-written: retry briefly
    }
  }
  return null;
}

function writeAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i === 4) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      sleepSync(15); // Windows: target briefly held open by the watcher
    }
  }
}

export function newState(ev) {
  return {
    sessionId: ev.session_id,
    project: ev.cwd ? path.basename(ev.cwd) : null,
    cwd: ev.cwd || null,
    state: 'idle',
    phase: { number: null, total: null },
    tasks: { total: 0, completed: 0, current: null },
    scope: { baselineTotal: null, added: 0 },
    runningTool: null,
    message: null,
    lastActivity: now(),
    updatedAt: now(),
    // Internal bookkeeping (the widget ignores keys starting with "_").
    _tasks: {},     // id -> { subject, activeForm, status }
    _hidden: [],    // ids finished in an earlier phase, excluded from counts
    _locked: false, // scope baseline is provisional until Claude starts working
  };
}

// Optional raftaar.json in the project root: { totalPhases } or { planFile }.
export function readTotalPhases(cwd) {
  if (!cwd) return null;
  const cfg = readJson(path.join(cwd, 'raftaar.json'));
  if (!cfg) return null;
  if (Number.isInteger(cfg.totalPhases)) return cfg.totalPhases;
  if (typeof cfg.planFile === 'string') {
    try {
      const text = fs.readFileSync(path.resolve(cwd, cfg.planFile), 'utf8');
      const n = (text.match(/^##\s+phase\b/gim) || []).length;
      return n || null;
    } catch {}
  }
  return null;
}

function visibleTasks(s) {
  const hidden = new Set(s._hidden);
  return Object.entries(s._tasks).filter(([id]) => !hidden.has(id)).map(([, t]) => t);
}

function setPhase(s, n) {
  if (n == null || n === s.phase.number) return;
  s.phase.number = n;
  // New phase: tasks finished earlier no longer count; reset scope baseline.
  s._hidden = Object.entries(s._tasks).filter(([, t]) => t.status === 'completed').map(([id]) => id);
  s.scope = { baselineTotal: null, added: 0 };
  s._locked = false;
}

export function recompute(s) {
  const list = visibleTasks(s);
  const total = list.length;
  const completed = list.filter((t) => t.status === 'completed').length;
  // "current" prefers the in-progress task; falls back to the next pending one,
  // so Claude does not have to spend a tool call marking tasks in_progress.
  const active = list.find((t) => t.status === 'in_progress') || list.find((t) => t.status !== 'completed');
  s.tasks = { total, completed, current: active ? active.activeForm || active.subject : null };

  // TaskCreate arrives one task at a time, so the baseline follows the total
  // until the first task changes status or a non-task tool runs.
  if (total === 0) {
    s.scope = { baselineTotal: null, added: 0 };
    s._locked = false;
  } else if (s.scope.baselineTotal == null || !s._locked) {
    s.scope = { baselineTotal: total, added: 0 };
  } else {
    s.scope.added = Math.max(0, total - s.scope.baselineTotal);
  }

  // Fallback phase source: "[Phase 2] ..." prefix on a task.
  if (s.phase.number == null) {
    for (const t of list) {
      const m = TASK_PHASE_RE.exec(t.subject || '');
      if (m) { s.phase.number = Number(m[1]); break; }
    }
  }
}

// Apply a task/todo tool result to the task map. Supports both the full-list
// TodoWrite style and incremental TaskCreate/TaskUpdate (Claude Code 2.1+).
export function applyTaskTool(s, ev) {
  const name = ev.tool_name || '';
  const input = ev.tool_input || {};
  const resp = ev.tool_response || {};

  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    const prev = new Set(visibleTasks(s).map((t) => t.subject));
    const next = {};
    input.todos.forEach((t, i) => {
      next[`todo-${i}`] = { subject: t.content, activeForm: t.activeForm || null, status: t.status };
    });
    const nextList = Object.values(next);
    const overlap = nextList.some((t) => prev.has(t.subject));
    const tagged = nextList.map((t) => TASK_PHASE_RE.exec(t.subject || '')).find(Boolean);
    const newPhase = tagged && Number(tagged[1]) !== s.phase.number;
    if (tagged) s.phase.number = Number(tagged[1]);
    s._tasks = next;
    s._hidden = [];
    // Full-list writes carry the whole plan at once, so the first list is the baseline.
    if (newPhase || (prev.size && nextList.length && !overlap)) s.scope = { baselineTotal: null, added: 0 };
    s._locked = s.scope.baselineTotal != null;
    return true;
  }

  if (name === 'TaskCreate') {
    const id = String((resp.task && resp.task.id) ?? resp.taskId ?? resp.id ?? `anon-${Object.keys(s._tasks).length + 1}`);
    s._tasks[id] = {
      subject: input.subject || (resp.task && resp.task.subject) || '',
      activeForm: input.activeForm || null,
      status: input.status || 'pending',
    };
    return true;
  }

  if (name === 'TaskUpdate') {
    const id = String(input.taskId ?? resp.taskId ?? '');
    if (!id) return false;
    if (input.status === 'deleted') {
      delete s._tasks[id];
      s._hidden = s._hidden.filter((h) => h !== id);
      return true;
    }
    const t = s._tasks[id] || (s._tasks[id] = { subject: '', activeForm: null, status: 'pending' });
    if (input.subject) t.subject = input.subject;
    if (input.activeForm) t.activeForm = input.activeForm;
    if (input.status) t.status = input.status;
    else if (resp.statusChange && resp.statusChange.to) t.status = resp.statusChange.to;
    if (input.status) s._locked = true;
    return true;
  }
  return false;
}

function classifyNotification(ev) {
  const type = ev.notification_type || '';
  const msg = ev.message || '';
  if (type === 'permission_prompt' || (!type && /permission/i.test(msg))) return 'needs_permission';
  if (type === 'idle_prompt' || type === 'elicitation_dialog' || (!type && /waiting|idle|input/i.test(msg))) return 'waiting_input';
  return null;
}

// Pure state transition. Returns the new state, or null to delete the file.
export function reduce(prev, ev) {
  const event = ev.hook_event_name;
  if (event === 'SessionEnd') return null;
  const s = prev || newState(ev);
  const t = now();
  s.updatedAt = t;
  if (ev.cwd) { s.cwd = ev.cwd; s.project = path.basename(ev.cwd); }

  switch (event) {
    case 'SessionStart':
      s.state = 'idle';
      s.runningTool = null;
      s.message = null;
      s.phase.total = readTotalPhases(s.cwd);
      break;
    case 'UserPromptSubmit': {
      s.state = 'working';
      s.message = null;
      s.lastActivity = t;
      const m = PHASE_RE.exec(ev.prompt || '');
      if (m) setPhase(s, Number(m[1]));
      s.phase.total = readTotalPhases(s.cwd);
      break;
    }
    case 'PreToolUse':
      s.lastActivity = t;
      s.runningTool = { name: ev.tool_name || 'tool', since: t };
      if (s.state !== 'needs_permission') s.state = 'working';
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      s.lastActivity = t;
      s.runningTool = null;
      s.state = 'working';
      s.message = null;
      if (!applyTaskTool(s, ev) && !/^(Task|Todo)/.test(ev.tool_name || '') && s.scope.baselineTotal != null) s._locked = true;
      break;
    case 'Notification': {
      const st = classifyNotification(ev);
      if (st) {
        s.state = st;
        s.message = ev.message || null;
        s.lastActivity = t;
      }
      break;
    }
    case 'Stop':
      s.runningTool = null;
      s.lastActivity = t;
      s.message = null;
      s.state = 'waiting_input';
      break;
    default:
      return s;
  }
  recompute(s);
  if (event === 'Stop' && s.tasks.total > 0 && s.tasks.completed === s.tasks.total) s.state = 'phase_done';
  return s;
}

function logError(dir, err) {
  try {
    const file = path.join(dir, 'hook-errors.log');
    try { if (fs.statSync(file).size > 256 * 1024) fs.truncateSync(file, 0); } catch {}
    fs.appendFileSync(file, `${now()} ${err && err.stack ? err.stack : err}\n`);
  } catch {}
}

export function handle(raw, dir = baseDir()) {
  const ev = JSON.parse(raw);
  if (!ev || typeof ev.session_id !== 'string' || !/^[\w.-]+$/.test(ev.session_id)) return;
  const sessions = path.join(dir, 'sessions');
  const file = path.join(sessions, `${ev.session_id}.json`);
  const next = reduce(readJson(file), ev);
  if (next === null) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }
  fs.mkdirSync(sessions, { recursive: true });
  writeAtomic(file, next);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = baseDir();
  setTimeout(() => process.exit(0), 1500).unref(); // never hang Claude Code
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try { handle(raw, dir); } catch (e) { logError(dir, e); }
    process.exit(0);
  });
  process.stdin.on('error', (e) => { logError(dir, e); process.exit(0); });
}
