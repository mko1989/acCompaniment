//! acCompaniment's tray app (ADR-008, ADR-022): runs the server binary (`accompaniment`) as a
//! child process, shows its state in the tray, and opens the browser UI. No window of its own
//! (ADR-022 note, 2026-11-24): settings, the port included, are in the browser UI. The process
//! supervision, ported from the Electron launcher, is in `supervisor.rs`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod supervisor;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, RunEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use supervisor::{Notice, Options, Status, Supervisor};

const TRAY_ID: &str = "main";
const VERSION: &str = env!("CARGO_PKG_VERSION");

struct App {
    supervisor: Supervisor,
}

/// The server binary: `ACCOMPANIMENT_SERVER_BIN`; the bundled sidecar next to this executable
/// (`accompaniment-server`: a sidecar called `accompaniment` would be this very executable,
/// `acCompaniment`, on a case-insensitive file system); in a development build, the repo's
/// release build. Never this executable itself.
fn server_binary() -> PathBuf {
    if let Some(p) = std::env::var_os("ACCOMPANIMENT_SERVER_BIN").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let me = std::env::current_exe().ok();
    let same_file = |p: &Path| {
        me.as_deref()
            .and_then(|m| m.canonicalize().ok())
            .is_some_and(|m| p.canonicalize().is_ok_and(|q| q == m))
    };
    if let Some(dir) = me.as_deref().and_then(Path::parent) {
        let sidecar = dir.join(format!("accompaniment-server{exe}"));
        if sidecar.is_file() && !same_file(&sidecar) {
            return sidecar;
        }
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../app/target/release")
        .join(format!("accompaniment{exe}"))
}

/// The browser UI and ffmpeg shipped in the bundle's resources, when they are there; without
/// them the server falls back to its own defaults (the repo's `src/frontend`, `vendor/ffmpeg`).
fn bundled_env(app: &AppHandle) -> Vec<(String, String)> {
    let mut env = Vec::new();
    let Ok(res) = app.path().resource_dir() else {
        return env;
    };
    let frontend = res.join("frontend");
    if frontend.join("index.html").is_file() {
        env.push((
            "ACCOMPANIMENT_FRONTEND_DIR".into(),
            frontend.display().to_string(),
        ));
    }
    let ffmpeg = res.join("ffmpeg").join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    });
    if ffmpeg.is_file() {
        env.push(("FFMPEG_PATH".into(), ffmpeg.display().to_string()));
    }
    env
}

fn browser_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

fn status_label(s: &Status) -> &'static str {
    if s.running {
        "Server Running"
    } else if s.starting {
        "Server Starting…"
    } else {
        "Server Stopped"
    }
}

fn build_menu(app: &AppHandle, s: &Status) -> tauri::Result<Menu<Wry>> {
    let sep = || PredefinedMenuItem::separator(app);
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "title", "acCompaniment", false, None::<&str>)?,
            &sep()?,
            &MenuItem::with_id(app, "status", status_label(s), false, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "port",
                format!("Port: {}", s.port),
                false,
                None::<&str>,
            )?,
            &sep()?,
            &MenuItem::with_id(app, "browser", "Open Browser UI", s.running, None::<&str>)?,
            &MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?,
            &sep()?,
            &MenuItem::with_id(app, "logs", "Show Logs", true, None::<&str>)?,
            &MenuItem::with_id(app, "datadir", "Open Data Directory", true, None::<&str>)?,
            &sep()?,
            &MenuItem::with_id(app, "about", "About", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )
}

fn update_tray(app: &AppHandle, s: Status) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id(TRAY_ID), build_menu(&handle, &s)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

fn show_error(app: &AppHandle, title: &str, message: impl Into<String>) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

fn open_browser(app: &AppHandle) -> Result<(), String> {
    let status = app.state::<Arc<App>>().supervisor.status();
    if !status.running {
        return Err("The server is not running.".into());
    }
    app.opener()
        .open_url(browser_url(status.port), None::<&str>)
        .map_err(|e| e.to_string())
}

fn open_data_dir(app: &AppHandle) -> Result<(), String> {
    let dir = app.state::<Arc<App>>().supervisor.data_dir().to_path_buf();
    if !dir.is_dir() {
        return Err(format!("Data directory not found: {}", dir.display()));
    }
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

fn show_logs(app: &AppHandle) -> Result<(), String> {
    let data_dir = app.state::<Arc<App>>().supervisor.data_dir().to_path_buf();
    let log = supervisor::log_path(&data_dir);
    if !log.exists() {
        supervisor::append_log(
            &data_dir,
            &format!(
                "acCompaniment server log - created {}\n",
                supervisor::iso_now()
            ),
        );
    }
    app.opener()
        .reveal_item_in_dir(&log)
        .map_err(|e| e.to_string())
}

/// Restarts the server, on the port now in the config: the browser UI's settings save it there
/// (`httpRemotePort`), and a running server can't move to another port by itself.
fn restart_server(app: &AppHandle) {
    let sup = &app.state::<Arc<App>>().supervisor;
    let port = config::configured_port(sup.data_dir()).unwrap_or(sup.status().port);
    sup.set_port(port);
}

fn show_about(app: &AppHandle) {
    app.dialog()
        .message(format!(
            "acCompaniment Soundboard\n\nVersion: {VERSION}\n\nA professional soundboard application for live performance and broadcasting."
        ))
        .title("About acCompaniment")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

fn on_menu(app: &AppHandle, id: &str) {
    let result = match id {
        "browser" => open_browser(app).map_err(|e| ("Server Not Running", e)),
        "restart" => {
            restart_server(app);
            Ok(())
        }
        "logs" => show_logs(app).map_err(|e| ("Could Not Open Logs", e)),
        "datadir" => open_data_dir(app).map_err(|e| ("Directory Not Found", e)),
        "about" => {
            show_about(app);
            Ok(())
        }
        "quit" => {
            app.exit(0);
            Ok(())
        }
        _ => Ok(()),
    };
    if let Err((title, message)) = result {
        show_error(app, title, message);
    }
}

fn build_tray(app: &AppHandle, status: Status) -> tauri::Result<TrayIcon> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("acCompaniment Soundboard")
        .menu(&build_menu(app, &status)?)
        // The menu on either button, everywhere: the tray has no window to open.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let opts = Options {
                data_dir: config::data_dir(),
                server_bin: server_binary(),
                extra_env: bundled_env(&handle),
            };
            let on_change = {
                let handle = handle.clone();
                move |s: Status| update_tray(&handle, s)
            };
            let on_notice = {
                let handle = handle.clone();
                move |n: Notice| {
                    let _ = handle
                        .notification()
                        .builder()
                        .title(n.title())
                        .body(n.body())
                        .show();
                }
            };
            let supervisor = Supervisor::new(opts, on_change, on_notice);
            let status = supervisor.status();
            let state = Arc::new(App { supervisor });
            app.manage(state.clone());
            build_tray(&handle, status)?;

            // SIGTERM / SIGINT / SIGHUP (a logout, `kill`, a process manager) go through the same
            // quit path, so the server is never left behind holding the port.
            let on_signal = handle.clone();
            let _ = ctrlc::set_handler(move || on_signal.exit(0));

            state.supervisor.start();
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("acCompaniment tray: could not start: {e}");
            std::process::exit(1);
        });

    app.run(|app, event| match event {
        // The tray runs without windows; only Quit (or a signal) ends it.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(state) = app.try_state::<Arc<App>>() {
                state.supervisor.shutdown();
            }
        }
        _ => {}
    });
}
