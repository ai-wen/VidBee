//! Minimal loopback HTTP server that receives native GUI requests from the
//! sidecar core (dialogs, shell, clipboard, notifications, window controls)
//! and executes them against the Tauri runtime.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

use serde_json::{json, Value as Json};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::CoreChannels;

pub fn start(app: AppHandle, port: u16, token: String) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[vidbee] native bridge bind failed on port {port}: {error}");
            return;
        }
    };
    eprintln!("[vidbee] native bridge listening on 127.0.0.1:{port}");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app = app.clone();
                let token = token.clone();
                thread::spawn(move || {
                    let _ = handle_connection(stream, &app, &token);
                });
            }
            Err(error) => eprintln!("[vidbee] native bridge accept failed: {error}"),
        }
    }
}

fn handle_connection(mut stream: TcpStream, app: &AppHandle, token: &str) -> std::io::Result<()> {
    let request = read_request(&mut stream)?;
    if request.token != token {
        write_response(&mut stream, 401, &json!({"ok": false, "error": "unauthorized"}))?;
        return Ok(());
    }

    let payload = request.body.clone();
    let outcome = dispatch(app, &request.op, payload);
    let (status, body) = match outcome {
        Ok(value) => (200, json!({"ok": true, "data": value})),
        Err(message) => (200, json!({"ok": false, "error": message})),
    };
    write_response(&mut stream, status, &body)
}

struct NativeRequest {
    op: String,
    token: String,
    body: Json,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<NativeRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end;
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "connection closed before header end",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = find_header_end(&buffer) {
            header_end = position;
            break;
        }
        if buffer.len() > 64 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "header too large",
            ));
        }
    }

    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let _method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();

    let mut content_length = 0usize;
    let mut token = String::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "content-length" {
            content_length = value.parse().unwrap_or(0);
        } else if name == "x-vidbee-token" {
            token = value.to_string();
        }
    }

    let op = path
        .trim_start_matches("/native/")
        .split('?')
        .next()
        .unwrap_or_default()
        .to_string();

    let mut body_bytes = buffer[header_end + 4..].to_vec();
    while body_bytes.len() < content_length {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        body_bytes.extend_from_slice(&chunk[..read]);
    }
    body_bytes.truncate(content_length);
    let body: Json = serde_json::from_slice(&body_bytes).unwrap_or(Json::Object(
        serde_json::Map::new(),
    ));

    Ok(NativeRequest { op, token, body })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn write_response(stream: &mut TcpStream, status: u16, body: &Json) -> std::io::Result<()> {
    let payload = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_text(status),
        payload.len(),
        payload
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    }
}

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// Operation dispatch
// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

fn dispatch(app: &AppHandle, op: &str, body: Json) -> Result<Json, String> {
    match op {
        "dialog.showOpenDialog" => dialog_open(app, &body),
        "dialog.showSaveDialog" => dialog_save(app, &body),
        "dialog.showMessageBox" => dialog_message(app, &body),
        "shell.openExternal" => shell_open_external(app, &body),
        "shell.openPath" => shell_open_path(app, &body),
        "shell.showItemInFolder" => shell_show_item_in_folder(app, &body),
        "clipboard.writeText" => clipboard_write_text(app, &body),
        "clipboard.readText" => clipboard_read_text(app),
        "notification.show" => notification_show(app, &body),
        "window.minimize" => window_op(app, "minimize"),
        "window.maximize" => window_op(app, "maximize"),
        "window.unmaximize" => window_op(app, "unmaximize"),
        "window.restore" => window_op(app, "restore"),
        "window.close" => window_op(app, "close"),
        "window.hide" => window_op(app, "hide"),
        "window.show" => window_op(app, "show"),
        "window.focus" => window_op(app, "focus"),
        "window.isMaximized" => window_bool(app, "isMaximized"),
        "window.isMinimized" => window_bool(app, "isMinimized"),
        "window.isVisible" => window_bool(app, "isVisible"),
        "app.quit" => {
            let channels = app.state::<CoreChannels>();
            channels.request_shutdown();
            app.exit(0);
            Ok(Json::Null)
        }
        _ => Err(format!("unsupported native op: {op}")),
    }
}

fn str_field(body: &Json, key: &str) -> Option<String> {
    body.get(key).and_then(|value| value.as_str()).map(String::from)
}

fn collect_extensions(body: &Json) -> (Option<String>, Vec<String>) {
    let mut name: Option<String> = None;
    let mut extensions: Vec<String> = Vec::new();
    if let Some(filters) = body.get("filters").and_then(|value| value.as_array()) {
        for filter in filters {
            if name.is_none() {
                name = filter
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(String::from);
            }
            if let Some(items) = filter.get("extensions").and_then(|value| value.as_array()) {
                for item in items {
                    if let Some(extension) = item.as_str() {
                        let cleaned = extension.trim_start_matches('*').trim_start_matches('.');
                        if !cleaned.is_empty() {
                            extensions.push(cleaned.to_string());
                        }
                    }
                }
            }
        }
    }
    (name, extensions)
}

fn properties(body: &Json) -> Vec<String> {
    body.get("properties")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn dialog_open(app: &AppHandle, body: &Json) -> Result<Json, String> {
    let props = properties(body);
    let multi = props.iter().any(|item| item == "multiSelections");
    let directory = props.iter().any(|item| item == "openDirectory");
    let (filter_name, extensions) = collect_extensions(body);
    let start_dir = str_field(body, "defaultPath").map(std::path::PathBuf::from);

    let builder = app.dialog().file();
    let builder = match start_dir {
        Some(dir) => builder.set_directory(dir),
        None => builder,
    };
    let builder = match (&filter_name, extensions.as_slice()) {
        (Some(name), list) if !list.is_empty() => {
            let refs: Vec<&str> = list.iter().map(String::as_str).collect();
            builder.add_filter(name, &refs)
        }
        _ => builder,
    };

    let picked = if directory {
        if multi {
            builder.blocking_pick_folders()
        } else {
            builder.blocking_pick_folder().map(|path| vec![path])
        }
    } else if multi {
        builder.blocking_pick_files()
    } else {
        builder.blocking_pick_file().map(|path| vec![path])
    };

    let paths: Vec<String> = picked
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string())
        .collect();
    let canceled = paths.is_empty();
    let file_path = paths.first().cloned();
    Ok(json!({"canceled": canceled, "filePaths": paths, "filePath": file_path}))
}

fn dialog_save(app: &AppHandle, body: &Json) -> Result<Json, String> {
    let (filter_name, extensions) = collect_extensions(body);
    let start_dir = str_field(body, "defaultPath").map(std::path::PathBuf::from);

    let builder = app.dialog().file();
    let builder = match start_dir {
        Some(dir) => builder.set_directory(dir),
        None => builder,
    };
    let builder = match (&filter_name, extensions.as_slice()) {
        (Some(name), list) if !list.is_empty() => {
            let refs: Vec<&str> = list.iter().map(String::as_str).collect();
            builder.add_filter(name, &refs)
        }
        _ => builder,
    };

    let picked = builder.blocking_save_file();
    let file_path = picked.map(|path| path.to_string());
    Ok(json!({
        "canceled": file_path.is_none(),
        "filePath": file_path
    }))
}

fn dialog_message(app: &AppHandle, body: &Json) -> Result<Json, String> {
    let title = str_field(body, "title").unwrap_or_else(|| "VidBee".to_string());
    let message = str_field(body, "message").unwrap_or_default();

    // The dialog plugin's message dialog does not report the picked button;
    // show it and mirror the Electron default so confirm-style flows continue.
    app.dialog()
        .message(message)
        .title(title)
        .blocking_show();

    Ok(json!({
        "response": body.get("defaultId").and_then(|v| v.as_u64()).unwrap_or(0),
        "checkboxChecked": false
    }))
}

fn shell_open_external(app: &AppHandle, body: &Json) -> Result<Json, String> {
    let url = str_field(body, "url").ok_or("missing url")?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(Json::Null)
}

fn shell_open_path(app: &AppHandle, body: &Json) -> Result<Json, String> {
    let path = str_field(body, "path").ok_or("missing path")?;
    match app.opener().open_path(path, None::<&str>) {
        Ok(()) => Ok(json!({"message": ""})),
        Err(error) => Ok(json!({"message": error.to_string()})),
    }
}

fn shell_show_item_in_folder(app: &AppHandle, body: &Json) -> Result<Json, String> {
    let path = str_field(body, "path").ok_or("missing path")?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())?;
    Ok(Json::Null)
}

fn clipboard_write_text(app: &AppHandle, body: &Json) -> Result<Json, String> {
    let text = str_field(body, "text").ok_or("missing text")?;
    app.clipboard().write_text(text).map_err(|e| e.to_string())?;
    Ok(Json::Null)
}

fn clipboard_read_text(app: &AppHandle) -> Result<Json, String> {
    let text = app
        .clipboard()
        .read_text()
        .map_err(|error| error.to_string())?;
    Ok(json!(text))
}

fn notification_show(app: &AppHandle, body: &Json) -> Result<Json, String> {
    let title = str_field(body, "title").unwrap_or_else(|| "VidBee".to_string());
    let content = str_field(body, "body").unwrap_or_default();
    app.notification()
        .builder()
        .title(title)
        .body(content)
        .show()
        .map_err(|error| error.to_string())?;
    Ok(Json::Null)
}

fn window_op(app: &AppHandle, action: &str) -> Result<Json, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main window unavailable".to_string());
    };
    match action {
        "minimize" => window.minimize(),
        "maximize" => window.maximize(),
        "unmaximize" => window.unmaximize(),
        "restore" => window.unminimize(),
        "close" => window.close(),
        "hide" => window.hide(),
        "show" => window.show(),
        "focus" => window.set_focus(),
        _ => return Err(format!("unsupported window op: {action}")),
    }
    .map_err(|error| error.to_string())?;
    Ok(Json::Null)
}

fn window_bool(app: &AppHandle, action: &str) -> Result<Json, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(json!(false));
    };
    let value = match action {
        "isMaximized" => window.is_maximized(),
        "isMinimized" => window.is_minimized(),
        "isVisible" => window.is_visible(),
        _ => return Err(format!("unsupported window probe: {action}")),
    }
    .map_err(|error| error.to_string())?;
    Ok(json!(value))
}
