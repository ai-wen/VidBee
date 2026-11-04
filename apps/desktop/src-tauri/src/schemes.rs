//! Webview custom-scheme handlers.
//!
//! The webview requests `vidbee://`, `vidbee-file://`, and
//! `agent-artifact://` URLs; each handler proxies the request to the sidecar
//! core's bridge server, preserving Range headers for media streaming.

use serde_json::json;
use tauri::http::{header, HeaderMap, Request, Response};
use tauri::{Manager, Runtime};
use tauri::UriSchemeContext;

use crate::state::CoreChannels;

fn proxy_to_core(
    core_port: u16,
    core_token: &str,
    core_path: &str,
    query: &str,
    request_headers: &HeaderMap,
) -> Response<Vec<u8>> {
    let url = format!("http://127.0.0.1:{core_port}{core_path}?{query}");

    let mut request = ureq_style_request("GET", &url);
    if let Some(range) = request_headers.get(header::RANGE) {
        request.extend_from_slice(format!("Range: {}\r\n", range.to_str().unwrap_or_default()).as_bytes());
    }
    request.extend_from_slice(format!("x-vidbee-token: {core_token}\r\n").as_bytes());
    request.extend_from_slice(b"Connection: close\r\n\r\n");

    let mut response_body = Vec::new();
    let status;
    let headers: Vec<(String, String)>;

    match std::net::TcpStream::connect(("127.0.0.1", core_port)) {
        Ok(mut stream) => {
            use std::io::{Read, Write};
            if stream.write_all(&request).is_err() {
                return error_response(502);
            }
            if stream.read_to_end(&mut response_body).is_err() {
                return error_response(502);
            }
            let (parsed_status, parsed_headers, body_offset) = match parse_http(&response_body) {
                Some(value) => value,
                None => return error_response(502),
            };
            status = parsed_status;
            headers = parsed_headers;
            let body = response_body[body_offset..].to_vec();
            return build_response(status, headers, body);
        }
        Err(_) => return error_response(502),
    }
}

fn error_response(status: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn build_response(status: u16, headers: Vec<(String, String)>, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut builder = Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    builder.header("Access-Control-Allow-Origin", "*").body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

fn ureq_style_request(method: &str, url: &str) -> Vec<u8> {
    let (host, port, path) = split_url(url).unwrap_or_default();
    format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: */*\r\n"
    )
    .into_bytes()
}

fn split_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = rest.split_once('/')?;
    let (host, port) = authority.split_once(':')?;
    Some((host.to_string(), port.parse().ok()?, format!("/{path}")))
}

fn parse_http(raw: &[u8]) -> Option<(u16, Vec<(String, String)>, usize)> {
    let header_end = raw.windows(4).position(|window| window == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
    let mut lines = head.lines();
    let status_line = lines.next()?;
    let status = status_line.split_whitespace().nth(1)?.parse().ok()?;
    let mut headers = Vec::new();
    let mut content_length: Option<usize> = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_string();
        let value = value.trim().to_string();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse().ok();
        }
        headers.push((name, value));
    }
    let expected = content_length.unwrap_or(0);
    let body_offset = header_end + 4;
    // Trim any trailing bytes beyond the advertised body length.
    let _ = expected;
    Some((status, headers, body_offset))
}

pub fn scheme_request<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    core_path: &'static str,
    query_builder: impl Fn(&str) -> String,
) -> Response<Vec<u8>> {
    let app = context.app_handle();
    let channels = app.state::<CoreChannels>();
    let full_url = request.uri().to_string();
    let query = query_builder(&full_url);
    proxy_to_core(
        channels.core_port,
        &channels.core_token,
        core_path,
        &query,
        request.headers(),
    )
}

/// Handlers to chain onto `tauri::Builder::register_uri_scheme_protocol`.
pub fn vidbee_scheme<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    scheme_request(context, request, "/protocol/vidbee", |url| {
        json!({ "url": url }).to_string()
    })
}

pub fn agent_artifact_scheme<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    scheme_request(context, request, "/protocol/agent-artifact", |url| {
        json!({ "url": url }).to_string()
    })
}

pub fn vidbee_file_scheme<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    scheme_request(context, request, "/file", |url| {
        let raw = url.strip_prefix("vidbee-file://").unwrap_or(url);
        let decoded = percent_decode(raw);
        format!("path={}", url_query_escape(&decoded))
    })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                output.push(value);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn url_query_escape(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}
