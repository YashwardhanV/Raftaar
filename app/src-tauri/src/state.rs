//! Paths, user config and session-file reading. Must agree with hook/raftaar-hook.mjs.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf, time::{Duration, SystemTime}};

const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

pub fn base_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("RAFTAAR_HOME") {
        return PathBuf::from(p);
    }
    let name = if cfg!(target_os = "linux") { "raftaar" } else { "Raftaar" };
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join(name)
}

pub fn sessions_dir() -> PathBuf {
    base_dir().join("sessions")
}

fn config_path() -> PathBuf {
    let name = if cfg!(target_os = "linux") { "raftaar" } else { "Raftaar" };
    dirs::config_dir().unwrap_or_else(base_dir).join(name).join("config.json")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub always_on_top: bool,
    pub compact: bool,
    pub notifications: bool,
    pub stall_minutes: u64,
    pub long_running_minutes: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self { x: None, y: None, always_on_top: true, compact: false, notifications: false, stall_minutes: 5, long_running_minutes: 3 }
    }
}

impl Config {
    pub fn load() -> Self {
        fs::read_to_string(config_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self) {
        let path = config_path();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let tmp = path.with_extension("json.tmp");
            if fs::write(&tmp, text).is_ok() {
                let _ = fs::rename(&tmp, &path);
            }
        }
    }
}

fn is_stale(meta: &fs::Metadata) -> bool {
    meta.modified().ok().and_then(|m| SystemTime::now().duration_since(m).ok()).map_or(false, |age| age > MAX_AGE)
}

/// Delete session files untouched for over 24 hours (crashed or killed sessions never send SessionEnd).
pub fn cleanup_stale() {
    let Ok(entries) = fs::read_dir(sessions_dir()) else { return };
    for e in entries.flatten() {
        if e.metadata().map_or(false, |m| is_stale(&m)) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Read every live session file, dropping internal "_" keys the UI does not need.
pub fn read_sessions() -> Vec<Value> {
    let Ok(entries) = fs::read_dir(sessions_dir()) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.path().extension().map_or(false, |x| x == "json"))
        .filter(|e| e.metadata().map_or(false, |m| !is_stale(&m)))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|mut v| {
            if let Some(obj) = v.as_object_mut() {
                obj.retain(|k, _| !k.starts_with('_'));
            }
            v
        })
        .collect()
}
