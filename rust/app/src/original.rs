//! The original Node server behind the front door: started on a free port of its own, and sent
//! every request (and WebSocket upgrade) that no ported unit answers yet. Removed by the lift.

use std::ffi::OsString;
use std::io::Write;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
/// How the original is started. The environment passes through (`ACCOMPANIMENT_DATA_DIR`, ...).
const RUN: &[&str] = &["node", "server.js"];
const FALLBACK_LOG: &str = "RUST_ANYTHING_FALLBACK_LOG";
const DATA_DIR: &str = "ACCOMPANIMENT_DATA_DIR";
/// The recording's data dir (`rust/app-cases/rust-anything.json`), used only under
/// `rust-anything app replay` (which sets `RUST_ANYTHING_FALLBACK_LOG`) when no data dir is set,
/// so a replay can never start the original on the user's real `~/.accompaniment`.
const REPLAY_DATA_DIR: &str = "rust/app-fixtures/data";
/// How long the original gets to clean up after SIGTERM (its own limit is 10 s, see WO-013).
const STOP_GRACE: Duration = Duration::from_secs(12);

fn resolve(word: &str, port: u16) -> OsString {
    let word = word.replace("{port}", &port.to_string());
    if word.starts_with('-') {
        return word.into();
    }
    let path = Path::new(ROOT).join(&word);
    let looks_like_path = word.contains('/') || word.contains('\\') || path.is_file();
    if looks_like_path && path.exists() {
        return std::path::absolute(&path).unwrap_or(path).into_os_string();
    }
    word.into()
}

fn log() -> Option<std::fs::File> {
    let path = std::env::var_os(FALLBACK_LOG)?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

/// Tells `rust-anything app replay` this build counts its fallbacks, even when it makes none.
pub fn report_fallbacks() {
    let _ = log();
}

/// The original server, started on a free port of its own.
#[derive(Clone)]
pub struct Original {
    port: u16,
    client: Client<HttpConnector, Body>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Original {
    /// `public_port`: the front door's port, which the original reports to clients.
    pub async fn start(public_port: u16) -> Self {
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .expect("a free port");
        let (program, rest) = RUN.split_first().expect("the original's command");
        let mut command = Command::new(resolve(program, port));
        command
            .args(rest.iter().map(|w| resolve(w, port)))
            .args(std::env::args_os().skip(1))
            .env("PORT", port.to_string())
            // Only the front door listens on the network; the original is internal.
            .env("HOST", "127.0.0.1")
            .env("ACCOMPANIMENT_PUBLIC_PORT", public_port.to_string())
            .env_remove(FALLBACK_LOG)
            .stdin(Stdio::null());
        if std::env::var_os(FALLBACK_LOG).is_some() && std::env::var_os(DATA_DIR).is_none() {
            command.env(DATA_DIR, REPLAY_DATA_DIR);
        }
        let mut child = command.spawn().expect("starting the original");
        let deadline = Instant::now() + Duration::from_secs(60);
        while tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            if let Ok(Some(status)) = child.try_wait() {
                panic!("the original exited ({status}) before listening on port {port}");
            }
            assert!(
                Instant::now() < deadline,
                "the original did not listen on port {port}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Original {
            port,
            client: Client::builder(TokioExecutor::new()).build_http(),
            child: Arc::new(Mutex::new(Some(child))),
        }
    }

    /// SIGTERM, so the original saves its state and releases the audio device; SIGKILL only if
    /// it has not exited within `STOP_GRACE`.
    pub fn stop(&self) {
        let Ok(mut slot) = self.child.lock() else {
            return;
        };
        let Some(mut child) = slot.take() else {
            return;
        };
        #[cfg(unix)]
        {
            use nix::sys::signal::{Signal, kill};
            use nix::unistd::Pid;
            if let Ok(pid) = i32::try_from(child.id()) {
                let _ = kill(Pid::from_raw(pid), Signal::SIGTERM);
            }
            let deadline = Instant::now() + STOP_GRACE;
            while Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(header::UPGRADE)
        && headers
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| {
                v.split(',')
                    .any(|t| t.trim().eq_ignore_ascii_case("upgrade"))
            })
}

fn bad_gateway(e: impl std::fmt::Display) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        format!("front door: the original did not answer: {e}"),
    )
        .into_response()
}

/// Sends the request to the original and passes its answer through, unchanged: the path as sent
/// (no dot-segment clean-up), streamed bodies, and WebSocket upgrades piped both ways. Each call
/// is one fallback.
pub async fn proxy(State(original): State<Original>, mut req: Request) -> Response {
    let target = req
        .uri()
        .path_and_query()
        .map_or("/", |p| p.as_str())
        .to_string();
    if let Some(mut file) = log() {
        let _ = writeln!(file, "{} {target}", req.method());
    }
    let Ok(uri) = format!("http://127.0.0.1:{}{target}", original.port).parse::<Uri>() else {
        return (StatusCode::BAD_REQUEST, "front door: bad request target").into_response();
    };
    let upgrade = is_upgrade(req.headers());
    let client_side = upgrade.then(|| hyper::upgrade::on(&mut req));

    let (mut parts, body) = req.into_parts();
    parts.uri = uri;
    parts.headers.remove(header::HOST);
    let outgoing = Request::from_parts(parts, if upgrade { Body::empty() } else { body });

    let mut answer = match original.client.request(outgoing).await {
        Ok(answer) => answer,
        Err(e) => return bad_gateway(e),
    };

    if let Some(client_side) = client_side
        && answer.status() == StatusCode::SWITCHING_PROTOCOLS
    {
        let server_side = hyper::upgrade::on(&mut answer);
        tokio::spawn(async move {
            if let (Ok(client), Ok(server)) = (client_side.await, server_side.await) {
                let _ = tokio::io::copy_bidirectional(
                    &mut TokioIo::new(client),
                    &mut TokioIo::new(server),
                )
                .await;
            }
        });
        let (parts, _) = answer.into_parts();
        return Response::from_parts(parts, Body::empty());
    }

    let (mut parts, body) = answer.into_parts();
    parts.headers.remove(header::TRANSFER_ENCODING);
    parts.headers.remove(header::CONNECTION);
    Response::from_parts(parts, Body::new(body))
}

/// Ctrl-C or SIGTERM: stop taking requests and finish the open ones.
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("a SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
