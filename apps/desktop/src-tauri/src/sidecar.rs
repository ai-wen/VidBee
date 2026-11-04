//! Sidecar core process management: spawns the Node core with bridge ports and
//! waits for readiness before the window loads the renderer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::state::CoreChannels;

pub struct CoreProcess {
    child: Child,
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn node_exe_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// The desktop app directory (contains dist-core, resources) in dev mode.
fn app_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("VIDBEE_APP_DIR") {
        return PathBuf::from(dir);
    }
    // Dev: cargo runs from apps/desktop/src-tauri.
    let cwd = std::env::current_dir().unwrap_or_default();
    if cwd.join("dist-core").exists() {
        return cwd;
    }
    if let Some(parent) = cwd.parent() {
        if parent.join("dist-core").exists() {
            return parent.to_path_buf();
        }
    }
    cwd
}

fn resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

/// Directory that sits next to the running executable (portable layout).
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn find_core_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("VIDBEE_CORE_PATH") {
        return Ok(PathBuf::from(path));
    }
    let relative = Path::new("dist-core").join("main").join("core.js");
    let candidates = [
        resource_dir(app).map(|dir| dir.join(&relative)),
        exe_dir().map(|dir| dir.join(&relative)),
        Some(app_dir().join(&relative)),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "sidecar core bundle missing: {} (run `pnpm run build:core`)",
        app_dir().join(&relative).display()
    ))
}

fn find_node_binary(app: &AppHandle) -> String {
    if let Ok(path) = std::env::var("VIDBEE_NODE_PATH") {
        return path;
    }
    let file = node_exe_name();
    let candidates = [
        resource_dir(app).map(|dir| dir.join("node").join(file)),
        exe_dir().map(|dir| dir.join("node").join(file)),
        Some(app_dir().join("resources").join("node").join(file)),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    file.to_string()
}

/// Resources directory that contains `ffmpeg/` for the bundled-binary lookup.
fn find_resources_dir(app: &AppHandle) -> Option<String> {
    if let Ok(dir) = std::env::var("VIDBEE_RESOURCES_DIR") {
        return Some(dir);
    }
    let candidates = [
        resource_dir(app).map(|dir| dir.join("ffmpeg")),
        exe_dir().map(|dir| dir.join("ffmpeg")),
        Some(app_dir().join("resources").join("ffmpeg")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return candidate
                .parent()
                .map(|dir| dir.to_string_lossy().into_owned());
        }
    }
    None
}

fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    format!("{:x}{:x}", nanos, std::process::id())
}

/// Reserve an ephemeral port by binding and releasing it.
pub fn reserve_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    listener.local_addr().ok().map(|address| address.port())
}

pub fn spawn(
    app: &AppHandle,
    core_port: u16,
    core_token: &str,
    native_port: u16,
    native_token: &str,
) -> Result<CoreProcess, String> {
    let core_script = find_core_script(app)?;

    let mut envs = HashMap::new();
    envs.insert("VIDBEE_CORE_PORT", core_port.to_string());
    envs.insert("VIDBEE_CORE_TOKEN", core_token.to_string());
    envs.insert("VIDBEE_NATIVE_PORT", native_port.to_string());
    envs.insert("VIDBEE_NATIVE_TOKEN", native_token.to_string());
    if let Some(resources) = find_resources_dir(app) {
        envs.insert("VIDBEE_RESOURCES_DIR", resources);
    }

    let node = find_node_binary(app);
    // Dev: run with the app directory as cwd so relative paths resolve; in a
    // packaged app the core script location itself provides the base.
    let cwd = if core_script.starts_with(app_dir()) {
        app_dir()
    } else {
        core_script
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(app_dir)
    };

    let child = Command::new(node)
        .arg(&core_script)
        .current_dir(cwd)
        .envs(envs)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to spawn node sidecar ({}): {error}", node))?;

    Ok(CoreProcess { child })
}

/// Wait until the core bridge answers /health.
pub fn wait_for_core(channels: &CoreChannels, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if channels.health() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}
