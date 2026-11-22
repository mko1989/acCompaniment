//! The Rust server (B2, rust/DECISIONS.md ADR-015): `server.js`, the routes, the WebSocket
//! protocol and the static UI, on the core in `crate::core`. Served when `ACCOMPANIMENT_CORE=rust`;
//! otherwise the front door still proxies to Node.
//!
//! The core is synchronous, so it sits behind one lock (replacing Node's per-cue `_serialized`
//! queues and the save queue), and every operation runs on a blocking thread. After each
//! operation the engine's events are handled, a just-opened project is remembered in the config
//! (server.js's project-opened listener) and the broadcasts go out. A task drives the clock's
//! timers (the debounced save, the 100 ms playback-time broadcast).

pub mod engine;
pub mod http;
pub mod hub;
pub mod net;
pub mod routes;
pub mod upload;
pub mod ws;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::Router;
use axum::serve::ListenerExt;
use serde_json::{Value, json};

use crate::core::audio_files::AudioFileManager;
use crate::core::clock::Clock;
use crate::core::config::AppConfigManager;
use crate::core::cue_engine::CueManager;
use crate::core::cues::CueDataManager;
use crate::core::jsv;
use crate::core::library;
use crate::core::nodefs as nfs;
use crate::core::paths::PathManager;

use hub::{Hub, Out, Outbox, QueueBroadcaster};

const DATA_DIR: &str = "ACCOMPANIMENT_DATA_DIR";
const FALLBACK_LOG: &str = "RUST_ANYTHING_FALLBACK_LOG";
/// The recording's data dir, used under `rust-anything app replay` when none is set (as the
/// front door does for the original, `original.rs`).
const REPLAY_DATA_DIR: &str = "rust/app-fixtures/data";

/// The managers, as `app.locals.managers`.
pub struct Core {
    pub pm: PathManager,
    pub config: AppConfigManager,
    pub cm: CueManager,
    outbox: Outbox,
}

pub struct Shared {
    core: Mutex<Core>,
    pub hub: Hub,
    pub pm: PathManager,
    pub frontend: PathBuf,
    shutting_down: AtomicBool,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl Core {
    /// What follows every operation: engine callbacks, the project-opened listener, broadcasts.
    fn settle(&mut self, hub: &Hub) {
        loop {
            self.cm.pump_engine_events();
            if let Some(id) = self.cm.opened_project.take() {
                let r = self
                    .config
                    .update_config(&json!({ "lastOpenedProjectId": id }));
                if jsv::truthy_opt(r.get("success")) {
                    self.cm.set_config(Value::Object(self.config.get_config()));
                }
            }
            let outs: Vec<Out> = self
                .outbox
                .lock()
                .map(|mut o| std::mem::take(&mut *o))
                .unwrap_or_default();
            if outs.is_empty() && self.cm.opened_project.is_none() {
                break;
            }
            for out in outs {
                match out {
                    Out::Message(m) => hub.send_all(&m),
                    Out::Cues(cues) => {
                        let cues = hub::resolve_cue_file_paths(&mut self.cm.afm, &cues);
                        hub.send_all(
                            &json!({ "type": "cues-updated", "payload": { "cues": cues } }),
                        );
                    }
                }
            }
        }
    }
}

/// Runs one operation on the core, on a blocking thread, then settles it.
pub async fn op<R: Send + 'static>(
    sh: &Arc<Shared>,
    f: impl FnOnce(&mut Core) -> R + Send + 'static,
) -> R {
    let sh = sh.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let mut core = sh.lock();
        let r = f(&mut core);
        core.settle(&sh.hub);
        r
    })
    .await;
    match joined {
        Ok(r) => r,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

fn frontend_dir() -> PathBuf {
    std::env::var_os("ACCOMPANIMENT_FRONTEND_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/frontend"))
        })
}

fn data_dir() -> String {
    if let Some(d) = std::env::var_os(DATA_DIR) {
        return d.to_string_lossy().into_owned();
    }
    if std::env::var_os(FALLBACK_LOG).is_some() {
        return REPLAY_DATA_DIR.to_string();
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_default();
    nfs::join2(&home, ".accompaniment")
}

/// `initialize()` of server.js: the managers, the config, the library migration, the open
/// project. Returns the core and the port from config when `PORT` is unset.
fn initialize() -> Result<(Core, Option<u16>), String> {
    let data = data_dir();
    nfs::ensure_dir(&data).map_err(|e| e.to_string())?;
    let pm = PathManager::new(&data);
    let mut config = AppConfigManager::new(&pm);
    let afm = AudioFileManager::new(&pm);
    let cdm = CueDataManager::new(&pm);
    let outbox: Outbox = Arc::default();
    let mut cm = CueManager::new(
        afm,
        cdm,
        Box::new(QueueBroadcaster {
            outbox: outbox.clone(),
        }),
        Box::new(engine::NoOutputEngine::new()),
        &pm.pcm_cache_dir,
        Clock::real(),
    );
    config.load_config();
    let cfg = config.get_config();
    if let Some(max) = cfg.get("maxAudioFileSize").filter(|v| jsv::truthy(v)) {
        cm.afm.set_max_file_size(max);
    }
    cm.set_config(Value::Object(cfg.clone()));
    if let Some(rate) = cfg.get("audioSampleRate").filter(|v| jsv::truthy(v)) {
        cm.afm.set_pcm_sample_rate(rate);
    }
    let config_port = if std::env::var_os("PORT").is_none() {
        cfg.get("httpRemotePort")
            .filter(|v| jsv::truthy(v))
            .and_then(Value::as_f64)
            .filter(|p| (1.0..=65535.0).contains(p))
            .map(|p| p as u16)
    } else {
        None
    };
    let metadata = cm.afm.metadata_dir();
    let dirs = library::MigrateDirs {
        audio_dir: &pm.audio_dir,
        metadata_dir: &metadata,
        workspaces_dir: &cm.cdm.workspaces_dir.clone(),
        backups_dir: &cm.cdm.backups_dir.clone(),
        pcm_cache_dir: Some(&pm.pcm_cache_dir),
    };
    library::migrate_library(&dirs).map_err(|e| e.to_string())?;
    cm.afm.invalidate_metadata_index();
    cm.initialize()?;
    Ok((
        Core {
            pm,
            config,
            cm,
            outbox,
        },
        config_port,
    ))
}

/// The server, when `ACCOMPANIMENT_CORE=rust`.
pub async fn run() -> ExitCode {
    let (mut core, config_port) = match tokio::task::spawn_blocking(initialize).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            eprintln!("Failed to start server: {e}");
            return ExitCode::from(1);
        }
        Err(e) => {
            eprintln!("Failed to start server: {e}");
            return ExitCode::from(1);
        }
    };
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .or(config_port)
        .unwrap_or(3333);
    let host: IpAddr = std::env::var("HOST")
        .ok()
        .and_then(|h| h.parse().ok())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));
    let listener = match tokio::net::TcpListener::bind(SocketAddr::new(host, port)).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("Failed to start server: port {port} is already in use.");
            eprintln!(
                "Another instance of acCompaniment (or something else) is likely already running. Stop it, or set a different port via the PORT environment variable / app config."
            );
            return ExitCode::from(1);
        }
        Err(e) => {
            eprintln!("Failed to start server: {e}");
            return ExitCode::from(1);
        }
    };
    let actual = listener.local_addr().map_or(port, |a| a.port());
    core.config.set_listening_port(actual);
    let pm = core.pm.clone();
    let shared = Arc::new(Shared {
        core: Mutex::new(core),
        hub: Hub::default(),
        pm,
        frontend: frontend_dir(),
        shutting_down: AtomicBool::new(false),
    });
    println!("HTTP Server running at http://{host}:{actual}");
    println!("WebSocket Server running at ws://{host}:{actual}");
    println!("Browser UI: http://localhost:{actual}");

    // The clock's timers: the debounced save and the 100 ms playback-time broadcast.
    let timers = shared.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(10));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if timers.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            op(&timers, |c| c.cm.run_due_timers()).await;
        }
    });

    let app: Router = Router::<Arc<Shared>>::new()
        .fallback(routes::entry)
        .with_state(shared.clone());
    let listener = listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    let stopping = shared.clone();
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            stop(&stopping).await;
        })
        .await;
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Server error: {e}");
            ExitCode::from(1)
        }
    }
}

/// `stop()`: clean up the cue manager (stop playback, flush the save), then close the WebSocket
/// clients so nothing holds the server open (WO-013). A 10 s backstop, as server.js has.
async fn stop(sh: &Arc<Shared>) {
    println!("Stopping server...");
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(10)).await;
        eprintln!("Server shutdown timeout - forcing exit");
        std::process::exit(1);
    });
    sh.shutting_down.store(true, Ordering::SeqCst);
    op(sh, |c| c.cm.cleanup()).await;
    sh.hub.close_all();
    println!("Server stopped");
}

/// SIGINT or SIGTERM; a second one during shutdown ends the process at once (server.js's
/// `forceExit`).
async fn shutdown_signal() {
    wait_signal().await;
    tokio::spawn(async {
        wait_signal().await;
        eprintln!("Shutdown already in progress, forcing exit...");
        std::process::exit(1);
    });
}

async fn wait_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut term), Ok(mut int)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            let _ = tokio::signal::ctrl_c().await;
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
