// Run: node --test hook/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reduce, handle } from './raftaar-hook.mjs';
import { addHooks, removeHooks } from './install.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const payload = (name) => JSON.parse(fs.readFileSync(path.join(here, '..', 'docs', 'payloads', `${name}.json`), 'utf8'));
const base = { session_id: 's1', cwd: '/x/demo' };
const ev = (hook_event_name, extra = {}) => ({ ...base, hook_event_name, ...extra });
const create = (id, subject) => ev('PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject }, tool_response: { task: { id, subject } } });
const update = (taskId, status) => ev('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId, status } });
const run = (events, s = null) => events.reduce((acc, e) => reduce(acc, e), s);

test('real captured payloads drive progress to phase_done', () => {
  const names = ['SessionStart', 'UserPromptSubmit', 'PostToolUse-TaskCreate', 'PostToolUse-TaskUpdate-completed', 'Stop'];
  let s = run(names.slice(0, 3).map(payload));
  assert.equal(s.tasks.total, 1);
  assert.equal(s.tasks.current, 'Creating a.txt');
  s = run(names.slice(3).map(payload), s);
  assert.equal(s.tasks.completed, 1);
  assert.equal(s.state, 'phase_done');
  assert.equal(s.phase.number, 1); // "Build phase 1 ..." in the real prompt
  assert.equal(reduce(s, payload('SessionEnd')), null);
});

test('incremental tasks, scope growth, needle moves back', () => {
  let s = run([ev('UserPromptSubmit', { prompt: 'build phase 2' }), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => create(String(i), `t${i}`))]);
  s = run([1, 2, 3, 4, 5, 6].map((i) => update(String(i), 'completed')), s);
  assert.deepEqual([s.tasks.completed, s.tasks.total, s.scope.added], [6, 10, 0]);
  s = run([create('11', 'x'), create('12', 'y')], s);
  assert.deepEqual([s.tasks.total, s.scope.baselineTotal, s.scope.added], [12, 10, 2]);
  s = run([ev('Stop')], s);
  assert.equal(s.state, 'waiting_input');
});

test('new phase hides finished tasks and resets the baseline', () => {
  let s = run([ev('UserPromptSubmit', { prompt: 'phase 1' }), create('1', 'a'), create('2', 'b'), update('1', 'completed'), update('2', 'completed')]);
  s = run([ev('UserPromptSubmit', { prompt: 'now do Phase 2' }), create('3', 'c')], s);
  assert.deepEqual([s.phase.number, s.tasks.total, s.tasks.completed, s.scope.baselineTotal], [2, 1, 0, 1]);
});

test('TodoWrite full-list style and full replacement', () => {
  const todo = (items) => ev('PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos: items } });
  let s = run([todo([{ content: '[Phase 3] a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }])]);
  assert.deepEqual([s.tasks.completed, s.tasks.total, s.tasks.current, s.phase.number], [1, 2, 'Doing b', 3]);
  s = run([todo([{ content: 'b', status: 'completed' }, { content: 'a', status: 'completed' }, { content: 'c', status: 'pending' }])], s);
  assert.equal(s.scope.added, 1);
  s = run([todo([{ content: 'z', status: 'pending' }])], s);
  assert.deepEqual([s.scope.baselineTotal, s.scope.added], [1, 0]);
});

test('notifications and permission flow', () => {
  let s = run([ev('PreToolUse', { tool_name: 'Bash' }), ev('Notification', { message: 'Claude needs your permission to use Bash' })]);
  assert.equal(s.state, 'needs_permission');
  assert.equal(s.runningTool.name, 'Bash');
  s = run([ev('PostToolUse', { tool_name: 'Bash' })], s);
  assert.equal(s.state, 'working');
  s = run([ev('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })], s);
  assert.equal(s.state, 'waiting_input');
  s = run([ev('Notification', { notification_type: 'auth_success', message: 'ok' })], s);
  assert.equal(s.state, 'waiting_input');
});

test('raftaar.json totalPhases and planFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raftaar-proj-'));
  fs.writeFileSync(path.join(dir, 'PHASES.md'), '# Plan\n## Phase 0\n## Phase 1\n## Phase 2\n');
  fs.writeFileSync(path.join(dir, 'raftaar.json'), '{"planFile":"PHASES.md"}');
  assert.equal(reduce(null, { session_id: 's', cwd: dir, hook_event_name: 'SessionStart' }).phase.total, 3);
  fs.writeFileSync(path.join(dir, 'raftaar.json'), '{"totalPhases":5}');
  assert.equal(reduce(null, { session_id: 's', cwd: dir, hook_event_name: 'SessionStart' }).phase.total, 5);
});

test('process: silent, exit 0 on garbage, fast, writes atomically', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'raftaar-home-'));
  const env = { ...process.env, RAFTAAR_HOME: home };
  const hook = path.join(here, 'raftaar-hook.mjs');
  const bad = spawnSync('node', [hook], { input: 'not json', env });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.length, 0);
  assert.ok(fs.readFileSync(path.join(home, 'hook-errors.log'), 'utf8').includes('JSON'));
  const t0 = Date.now();
  const ok = spawnSync('node', [hook], { input: JSON.stringify(payload('UserPromptSubmit')), env });
  const ms = Date.now() - t0;
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.length, 0);
  const files = fs.readdirSync(path.join(home, 'sessions'));
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
  assert.equal(files.length, 1);
  console.log(`  hook process time: ${ms} ms`);
  handle(JSON.stringify({ ...payload('SessionEnd') }), home);
  assert.equal(fs.readdirSync(path.join(home, 'sessions')).length, 0);
});

test('installer merges, never duplicates, and uninstalls cleanly', () => {
  const original = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  const once = addHooks(structuredClone(original), '/h/raftaar-hook.mjs');
  const twice = addHooks(structuredClone(once), '/h/raftaar-hook.mjs');
  assert.deepEqual(once, twice);
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.hooks.PreToolUse[0].matcher, '*');
  assert.deepEqual(removeHooks(twice), original);
  assert.deepEqual(removeHooks(addHooks({}, '/h/raftaar-hook.mjs')), {});
});

test('install CLI end to end with CLAUDE.md snippet', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'raftaar-claude-'));
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(cfg, 'CLAUDE.md'), '# Mine\n');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const cli = path.join(here, 'install.mjs');
  execFileSync('node', [cli, 'install', '--claude-md'], { env });
  execFileSync('node', [cli, 'install', '--claude-md'], { env });
  const md = fs.readFileSync(path.join(cfg, 'CLAUDE.md'), 'utf8');
  assert.equal(md.match(/raftaar:start/g).length, 1);
  assert.ok(fs.existsSync(path.join(cfg, 'settings.json.raftaar-backup')));
  execFileSync('node', [cli, 'uninstall'], { env });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')), { theme: 'dark' });
  assert.equal(fs.readFileSync(path.join(cfg, 'CLAUDE.md'), 'utf8').trim(), '# Mine');
});
