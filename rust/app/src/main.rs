mod original;
mod units;

use std::net::{IpAddr, SocketAddr};
use std::process::ExitCode;

use axum::serve::ListenerExt;
use original::shutdown_signal;

#[tokio::main]
async fn main() -> ExitCode {
    original::report_fallbacks();
    // ADR-015: with ACCOMPANIMENT_CORE=rust the Rust core serves everything and Node is not
    // started; otherwise the front door proxies to the original as before.
    if std::env::var("ACCOMPANIMENT_CORE").as_deref() == Ok("rust") {
        return accompaniment::server::run().await;
    }
    // Same defaults as server.js: PORT or 3333, HOST or every interface.
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3333);
    let host: IpAddr = std::env::var("HOST")
        .ok()
        .and_then(|h| h.parse().ok())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));
    // Bind before starting the original, so a port conflict leaves nothing running behind.
    let listener = match tokio::net::TcpListener::bind(SocketAddr::new(host, port)).await {
        Ok(listener) => listener,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // The same message as server.js.
            eprintln!("Failed to start server: port {port} is already in use.");
            eprintln!(
                "Stop it, or set a different port via the PORT environment variable / app config."
            );
            return ExitCode::from(1);
        }
        Err(e) => {
            eprintln!("Failed to start server: {e}");
            return ExitCode::from(1);
        }
    };
    let public_port = listener.local_addr().map_or(port, |a| a.port());
    let listener = listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    let original = original::Original::start(public_port).await;
    let app = units::router().with_state(original.clone());
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    original.stop();
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Server error: {e}");
            ExitCode::from(1)
        }
    }
}
