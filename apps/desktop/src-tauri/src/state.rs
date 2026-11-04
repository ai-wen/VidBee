//! Shared application state: bridge coordinates for the sidecar core.

use serde_json::json;

pub struct CoreChannels {
    pub core_port: u16,
    pub core_token: String,
}

impl CoreChannels {
    /// Ask the sidecar core to run its shutdown hooks and exit.
    /// Blocking on purpose: callers run on the native bridge worker threads.
    pub fn request_shutdown(&self) {
        let url = format!("http://127.0.0.1:{}/shutdown", self.core_port);
        let _ = http_request("POST", &url, &self.core_token, Some("{}".to_string()));
    }

    /// Push a deep link into the core for delivery to the renderer.
    pub fn send_deep_link(&self, url: &str) {
        let payload = json!({ "url": url }).to_string();
        let _ = http_request(
            "POST",
            &format!("http://127.0.0.1:{}/deeplink", self.core_port),
            &self.core_token,
            Some(payload),
        );
    }

    /// Query core readiness.
    pub fn health(&self) -> bool {
        let url = format!("http://127.0.0.1:{}/health", self.core_port);
        http_request("GET", &url, &self.core_token, None).is_some()
    }
}

// Tiny HTTP helpers built on std to avoid pulling an HTTP client crate.

fn http_request(method: &str, url: &str, token: &str, body: Option<String>) -> Option<String> {
    use std::io::{Read, Write};

    let (host, port, path) = split_url(url)?;
    let mut stream = std::net::TcpStream::connect((host.as_str(), port)).ok()?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .ok()?;
    let body_bytes = body.unwrap_or_else(|| "{}".to_string());
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nx-vidbee-token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body_bytes}",
        body_bytes.len()
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    Some(String::from_utf8_lossy(&response).to_string())
}

fn split_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = rest.split_once('/')?;
    let (host, port) = authority.split_once(':')?;
    Some((host.to_string(), port.parse().ok()?, format!("/{path}")))
}
