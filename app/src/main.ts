import { Gauge } from './gauge';

type StateName = 'idle' | 'working' | 'needs_permission' | 'waiting_input' | 'long_running' | 'stalled' | 'phase_done';
interface Session {
  sessionId: string;
  project: string | null;
  state: StateName;
  phase: { number: number | null; total: number | null };
  tasks: { total: number; completed: number; current: string | null };
  scope: { baselineTotal: number | null; added: number };
  runningTool: { name: string; since: string } | null;
  message: string | null;
  lastActivity: string;
}
interface Config {
  x: number | null; y: number | null;
  alwaysOnTop: boolean; compact: boolean; notifications: boolean;
  stallMinutes: number; longRunningMinutes: number;
}

const inTauri = '__TAURI_INTERNALS__' in window;
const $ = (id: string) => document.getElementById(id)!;
const gauge = new Gauge($('gauge') as unknown as SVGSVGElement);

let sessions: Session[] = [];
let config: Config = { x: null, y: null, alwaysOnTop: true, compact: false, notifications: false, stallMinutes: 5, longRunningMinutes: 3 };
let pinned: string | null = null;
const lastState = new Map<string, StateName>();

const ago = (iso: string) => (Date.now() - Date.parse(iso)) / 60000;
const mins = (m: number) => `${Math.max(1, Math.floor(m))} min`;

// Stall and long-running are derived from timestamps here, so the hook never
// needs a timer or a background process.
function derive(s: Session): StateName {
  if (s.state !== 'working') return s.state;
  if (s.runningTool && ago(s.runningTool.since) >= config.longRunningMinutes) return 'long_running';
  if (!s.runningTool && ago(s.lastActivity) >= config.stallMinutes) return 'stalled';
  return 'working';
}

function label(s: Session, st: StateName): string {
  switch (st) {
    case 'idle': return 'Idle';
    case 'working': return s.tasks.current ? `Working: ${s.tasks.current}` : 'Working';
    case 'needs_permission': {
      const tool = s.message?.match(/use (\S+)/)?.[1] ?? s.runningTool?.name;
      return tool ? `Needs permission: ${tool}` : 'Needs permission';
    }
    case 'waiting_input': return 'Waiting for you';
    case 'long_running': return `Running ${s.runningTool?.name ?? 'tool'} for ${mins(ago(s.runningTool!.since))}`;
    case 'stalled': return `No activity for ${mins(ago(s.lastActivity))}`;
    case 'phase_done': return s.phase.number != null ? `Phase ${s.phase.number} complete` : 'All tasks complete';
  }
}

function pick(): Session | undefined {
  const byRecent = [...sessions].sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  return byRecent.find((s) => s.state === 'needs_permission')
    ?? byRecent.find((s) => s.sessionId === pinned)
    ?? byRecent[0];
}

function render() {
  if (pinned && !sessions.some((s) => s.sessionId === pinned)) pinned = null;
  const s = pick();
  const widget = $('widget');
  widget.classList.toggle('compact', config.compact);

  if (!s) {
    widget.dataset.state = 'idle';
    $('project').textContent = 'Raftaar';
    $('counts').textContent = 'No active session';
    $('badge').hidden = true;
    $('status').textContent = 'Idle';
    $('dots').replaceChildren();
    gauge.set(0);
    return;
  }

  const st = derive(s);
  widget.dataset.state = st;
  const { total, completed } = s.tasks;
  gauge.set(st === 'phase_done' ? 100 : total ? (completed / total) * 100 : 0);

  $('project').textContent = s.project ?? '';
  const parts: string[] = [];
  if (s.phase.number != null) parts.push(`Phase ${s.phase.number}${s.phase.total ? `/${s.phase.total}` : ''}`);
  parts.push(total ? `${completed}/${total} tasks` : 'No tasks yet');
  $('counts').textContent = parts.join(' · ');
  const badge = $('badge');
  badge.hidden = !s.scope.added;
  badge.textContent = `+${s.scope.added} task${s.scope.added === 1 ? '' : 's'}`;
  $('status').textContent = label(s, st);

  $('dots').replaceChildren(...(sessions.length > 1 ? sessions : []).map((x) => {
    const dot = document.createElement('button');
    dot.className = 'dot' + (x === s ? ' active' : '');
    dot.dataset.state = derive(x);
    dot.title = `${x.project ?? x.sessionId}: ${label(x, derive(x))}`;
    dot.onclick = () => { pinned = x.sessionId; render(); };
    return dot;
  }));
}

async function onSessions(next: Session[]) {
  for (const s of next) {
    if (s.state === 'needs_permission' && lastState.get(s.sessionId) !== 'needs_permission') void toast(s);
    lastState.set(s.sessionId, s.state);
  }
  sessions = next;
  render();
}

async function toast(s: Session) {
  if (!inTauri || !config.notifications) return;
  const n = await import('@tauri-apps/plugin-notification');
  let ok = await n.isPermissionGranted();
  if (!ok) ok = (await n.requestPermission()) === 'granted';
  if (ok) n.sendNotification({ title: `Raftaar · ${s.project ?? 'Claude Code'}`, body: s.message ?? 'Claude needs your permission' });
}

async function applyConfig(save: boolean) {
  render();
  if (!inTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.setAlwaysOnTop(config.alwaysOnTop);
  await win.setSize(config.compact ? new LogicalSize(140, 104) : new LogicalSize(220, 194));
  if (save) await invoke('save_config', { cfg: config });
}

async function showMenu(e: MouseEvent) {
  e.preventDefault();
  if (!inTauri) return;
  const { Menu, CheckMenuItem, MenuItem, PredefinedMenuItem } = await import('@tauri-apps/api/menu');
  const { invoke } = await import('@tauri-apps/api/core');
  const toggle = (text: string, key: 'alwaysOnTop' | 'compact' | 'notifications') =>
    CheckMenuItem.new({ text, checked: config[key], action: () => { config[key] = !config[key]; void applyConfig(true); } });
  const menu = await Menu.new({
    items: [
      await toggle('Always on top', 'alwaysOnTop'),
      await toggle('Compact mode', 'compact'),
      await toggle('Permission notifications', 'notifications'),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await MenuItem.new({ text: 'Quit', action: () => void invoke('quit') }),
    ],
  });
  await menu.popup();
}

async function init() {
  document.addEventListener('contextmenu', showMenu);
  setInterval(render, 1000); // only re-derives stall/long-running timers; no disk reads

  if (!inTauri) return demo();
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  $('close').onclick = () => void invoke('quit');
  config = await invoke<Config>('get_config');
  await applyConfig(false);
  await listen<Session[]>('sessions', (e) => void onSessions(e.payload));
  await onSessions(await invoke<Session[]>('get_sessions'));
}

// Browser preview (npm run dev, no Tauri): ?state=needs_permission&done=6&total=12&added=2&compact
function demo() {
  const q = new URLSearchParams(location.search);
  config.compact = q.has('compact');
  const now = new Date().toISOString();
  const mk = (id: string, project: string, state: StateName, done: number, total: number, added = 0): Session => ({
    sessionId: id, project, state,
    phase: { number: 2, total: 5 },
    tasks: { total, completed: done, current: 'Add login screen' },
    scope: { baselineTotal: total - added, added },
    runningTool: state === 'needs_permission' ? { name: 'Bash', since: now } : null,
    message: state === 'needs_permission' ? 'Claude needs your permission to use Bash' : null,
    lastActivity: now,
  });
  void onSessions([
    mk('a', 'pagdandi', (q.get('state') as StateName) || 'working', Number(q.get('done') ?? 6), Number(q.get('total') ?? 12), Number(q.get('added') ?? 2)),
    mk('b', 'raftaar', 'idle', 1, 4),
  ]);
}

void init();
