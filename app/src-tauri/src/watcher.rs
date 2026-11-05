//! Watches the sessions folder and pushes the full session list to the UI.
//! Event-driven (no polling); bursts of hook writes are coalesced.

use crate::state;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{sync::mpsc, thread, time::Duration};
use tauri::{AppHandle, Emitter};

pub fn start(app: AppHandle) -> notify::Result<RecommendedWatcher> {
    let dir = state::sessions_dir();
    let _ = std::fs::create_dir_all(&dir);
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;

    thread::spawn(move || {
        while rx.recv().is_ok() {
            // Coalesce: a single hook run renames a temp file (2+ fs events).
            while rx.recv_timeout(Duration::from_millis(40)).is_ok() {}
            let _ = app.emit("sessions", state::read_sessions());
        }
    });
    Ok(watcher)
}
