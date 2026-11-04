//! VidBee Tauri shell.
//!
//! The shell owns the window, the sidecar Node core process, the native bridge
//! (core -> shell GUI calls), and the custom-scheme proxies. All application
//! logic lives in the sidecar core (see apps/desktop/src-core).

mod native_bridge;
mod schemes;
mod sidecar;
mod state;

use std::time::Duration;

use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri_plugin_single_instance::init as single_instance;

use state::CoreChannels;

fn platform_string() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        _ => "linux",
    }
}

fn initialization_script(port: u16, token: &str) -> String {
    let versions = serde_json::json!({
        "node": std::env::var("VIDBEE_NODE_VERSION").unwrap_or_default(),
        "chrome": "",
        "electron": ""
    });
    format!(
        "window.__VIDBEE_TAURI__ = {{}}; window.__VIDBEE_TAURI__.port = {port}; window.__VIDBEE_TAURI__.token = {}; window.__VIDBEE_TAURI__.platform = {}; window.__VIDBEE_TAURI__.versions = {};",
        serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(platform_string()).unwrap_or_else(|_| "\"\"".to_string()),
        versions
    )
}

pub fn run() {
    let core_port = sidecar::reserve_port().expect("failed to reserve core port");
    let native_port = sidecar::reserve_port().expect("failed to reserve native port");
    let core_token = sidecar::random_token();
    let native_token = sidecar::random_token();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(single_instance(|app, argv, _cwd| {
            // Second launch: focus the window and forward deep links.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            for argument in argv.iter().skip(1) {
                if argument.starts_with("vidbee://") {
                    if let Some(channels) = app.try_state::<CoreChannels>() {
                        channels.send_deep_link(argument);
                    }
                }
            }
        }))
        .register_uri_scheme_protocol("vidbee", schemes::vidbee_scheme)
        .register_uri_scheme_protocol("agent-artifact", schemes::agent_artifact_scheme)
        .register_uri_scheme_protocol("vidbee-file", schemes::vidbee_file_scheme)
        .setup(move |app| {
            let channels = CoreChannels {
                core_port,
                core_token: core_token.clone(),
            };
            app.manage(channels);

            // Spawn the sidecar core first so it is ready when the UI mounts.
            let core = sidecar::spawn(
                app.handle(),
                core_port,
                &core_token,
                native_port,
                &native_token,
            );
            match core {
                Ok(child) => {
                    app.manage(child);
                }
                Err(error) => {
                    eprintln!("[vidbee] sidecar core failed to start: {error}");
                }
            }

            // Native bridge for core -> shell GUI operations.
            {
                let handle = app.handle().clone();
                let token = native_token.clone();
                std::thread::spawn(move || {
                    native_bridge::start(handle, native_port, token);
                });
            }

            // Build the main window (frameless; the renderer draws the title bar).
            let script = initialization_script(core_port, &core_token);
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("VidBee")
                .inner_size(1200.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .decorations(false)
                .initialization_script(&script)
                .build()?;
            let _ = window.hide();

            // Wait for the core, then reveal the window.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let channels = handle.state::<CoreChannels>();
                let ready = sidecar::wait_for_core(&channels, Duration::from_secs(60));
                if !ready {
                    eprintln!("[vidbee] sidecar core did not become ready in 60s");
                }
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Let the core flush state before the process exits.
                if let Some(channels) = window.app_handle().try_state::<CoreChannels>() {
                    channels.request_shutdown();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
