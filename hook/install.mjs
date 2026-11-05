#!/usr/bin/env node
// Usage: node hook/install.mjs install [--claude-md] | uninstall | status
// Merges Raftaar's hook entries into ~/.claude/settings.json (backing it up
// first), keeps every existing hook, never duplicates, and creates no startup
// entries of any kind.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'raftaar-hook.mjs');
const MARK = 'raftaar-hook.mjs';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const WITH_MATCHER = new Set(['PreToolUse', 'PostToolUse']);

// Kept deliberately short: CLAUDE.md is re-read every turn, so every word here
// is paid for again and again. One update per finished task, no in_progress
// calls (the hook infers the current task from the next pending one).
export const CLAUDE_MD = `<!-- raftaar:start -->
## Progress tracking
At the start of each phase, create one task per deliverable (aim for 4-8, not micro-steps). Mark a task completed right after finishing it; skip in_progress updates and TaskList calls. Add newly discovered work as a new task.
<!-- raftaar:end -->`;

const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARK);

export function addHooks(settings, hookPath = HOOK) {
  const command = `node "${hookPath.replace(/\\/g, '/')}"`;
  settings.hooks ??= {};
  for (const ev of EVENTS) {
    const groups = (settings.hooks[ev] ??= []);
    if (groups.some((g) => (g.hooks || []).some(isOurs))) continue;
    const group = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (WITH_MATCHER.has(ev)) group.matcher = '*';
    groups.push(group);
  }
  return settings;
}

export function removeHooks(settings) {
  if (!settings.hooks) return settings;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = (settings.hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (groups.length) settings.hooks[ev] = groups;
    else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

const stripSnippet = (text) => text.replace(/\n*<!-- raftaar:start -->[\s\S]*?<!-- raftaar:end -->\n*/g, '\n').replace(/^\n+/, '');

function main(argv) {
  const [cmd = 'status', ...flags] = argv;
  const dir = claudeDir();
  const file = path.join(dir, 'settings.json');
  const mdFile = path.join(dir, 'CLAUDE.md');
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  const write = (obj) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  };

  if (cmd === 'install') {
    const settings = read();
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.raftaar-backup`);
    write(addHooks(settings));
    console.log(`Raftaar hooks installed in ${file}`);
    if (flags.includes('--claude-md')) {
      const old = fs.existsSync(mdFile) ? stripSnippet(fs.readFileSync(mdFile, 'utf8')) : '';
      fs.writeFileSync(mdFile, (old.trimEnd() ? old.trimEnd() + '\n\n' : '') + CLAUDE_MD + '\n');
      console.log(`Progress snippet added to ${mdFile}`);
    }
    console.log('Launch the widget yourself when you want it. Nothing starts automatically.');
  } else if (cmd === 'uninstall') {
    if (fs.existsSync(file)) write(removeHooks(read()));
    if (fs.existsSync(mdFile)) {
      const text = fs.readFileSync(mdFile, 'utf8');
      if (text.includes('raftaar:start')) fs.writeFileSync(mdFile, stripSnippet(text));
    }
    console.log('Raftaar hooks and snippet removed.');
  } else if (cmd === 'status') {
    const s = read();
    const on = EVENTS.filter((ev) => (s.hooks?.[ev] || []).some((g) => (g.hooks || []).some(isOurs)));
    console.log(on.length ? `Installed for: ${on.join(', ')}` : 'Not installed.');
  } else {
    console.log('Usage: node hook/install.mjs install [--claude-md] | uninstall | status');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
