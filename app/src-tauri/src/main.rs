// No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;
mod tray;
mod watcher;

use serde_json::Value;
use state::Config;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::{thread, time::Duration};
use tauri::{AppHandle, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent};

const SNAP_PX: i32 = 20;

struct AppState {
    config: Mutex<Config>,
    move_gen: Arc<AtomicU64>,
}

#[tauri::command]
fn get_sessions() -> Vec<Value> {
    state::read_sessions()
}

#[tauri::command]
fn get_config(st: State<AppState>) -> Config {
    st.config.lock().unwrap().clone()
}

/// UI-owned settings. Position is owned by the Rust side and kept as is.
#[tauri::command]
fn save_config(st: State<AppState>, cfg: Config) {
    let mut c = st.config.lock().unwrap();
    *c = Config { x: c.x, y: c.y, ..cfg };
    c.save();
}

/// The close (X) button and the menu's Quit: end the whole process.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// After the window stops moving: snap to nearby monitor edges, then remember the position.
fn settle_after_move(window: WebviewWindow) {
    let gen = window.state::<AppState>().move_gen.clone();
    let mine = gen.fetch_add(1, Ordering::SeqCst) + 1;
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(400));
        if gen.load(Ordering::SeqCst) != mine {
            return; // still being dragged
        }
        let (Ok(pos), Ok(size), Ok(Some(mon))) = (window.outer_position(), window.outer_size(), window.current_monitor()) else { return };
        let (mx, my) = (mon.position().x, mon.position().y);
        let (mw, mh) = (mon.size().width as i32, mon.size().height as i32);
        let (w, h) = (size.width as i32, size.height as i32);
        let snap = |v: i32, lo: i32, hi: i32| {
            if (v - lo).abs() <= SNAP_PX { lo } else if (hi - v).abs() <= SNAP_PX { hi } else { v }
        };
        let x = snap(pos.x, mx, mx + mw - w);
        let y = snap(pos.y, my, my + mh - h);
        if (x, y) != (pos.x, pos.y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        let st = window.state::<AppState>();
        let mut c = st.config.lock().unwrap();
        c.x = Some(x);
        c.y = Some(y);
        c.save();
    });
}

fn restore_position(window: &WebviewWindow, cfg: &Config) {
    let (Some(x), Some(y)) = (cfg.x, cfg.y) else { return };
    // Only restore if the spot is still on a connected monitor.
    let on_screen = window.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        x >= p.x - SNAP_PX && y >= p.y - SNAP_PX && x < p.x + s.width as i32 && y < p.y + s.height as i32
    });
    if on_screen {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

fn main() {
    state::cleanup_stale();
    let config = Config::load();

    tauri::Builder::default()
        // Must be first: a second launch focuses the existing window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::focus_main(app)))
        .plugin(tauri_plugin_notification::init())
        .manage(AppState { config: Mutex::new(config.clone()), move_gen: Arc::new(AtomicU64::new(0)) })
        .invoke_handler(tauri::generate_handler![get_sessions, get_config, save_config, quit])
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            restore_position(&window, &config);
            let _ = window.set_always_on_top(config.always_on_top);
            let _ = window.show();

            tray::create(app.handle())?;
            let watcher = watcher::start(app.handle().clone()).map_err(|e| e.to_string())?;
            app.manage(Mutex::new(watcher)); // keep the watcher alive for the app's lifetime

            let w = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Moved(_) => settle_after_move(w.clone()),
                // Close always means exit, never hide to tray.
                WindowEvent::CloseRequested { .. } => w.app_handle().exit(0),
                _ => {}
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Raftaar");
}
