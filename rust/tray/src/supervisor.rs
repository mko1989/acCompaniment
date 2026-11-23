//! Runs the server binary as a child process and keeps it running, as the Electron launcher did
//! (ADR-022; its spec: rust/MAP.md "Wave C"): adopt a healthy server already on the port, spawn
//! one otherwise, wait for it to answer, restart it after a crash (3 tries, 2/4/6 s apart), and on
//! a port conflict kill a hung server of our own holding the port. The server's output goes to
//! `<dataDir>/logs/accompaniment-server.log`, rotated at 5 MB. No periodic health check: a crash
//! is noticed when the process exits.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::config;

pub const DEFAULT_PORT: u16 = 3333;
const MAX_RESTART_ATTEMPTS: u32 = 3;
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_POLL: Duration = Duration::from_millis(500);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// What the supervisor needs to know.
#[derive(Clone, Debug)]
pub struct Options {
    pub data_dir: PathBuf,
    /// The server binary. A process whose command line contains this path is ours.
    pub server_bin: PathBuf,
    /// More environment for the server (the bundled UI and ffmpeg).
    pub extra_env: Vec<(String, String)>,
}

/// Something the user should be told about (the launcher's two notifications).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Notice {
    TakingTooLong,
    GaveUp { crashes: u32 },
}

impl Notice {
    pub fn title(&self) -> &'static str {
        match self {
            Notice::TakingTooLong => "acCompaniment server is taking too long to start",
            Notice::GaveUp { .. } => "acCompaniment server stopped unexpectedly",
        }
    }
    pub fn body(&self) -> String {
        match self {
            Notice::TakingTooLong => "The audio server hasn't responded after a minute. Check the logs (tray menu -> Show Logs) - it may still finish starting, or it may need a manual restart.".into(),
            Notice::GaveUp { crashes } => format!("The audio server crashed {crashes} times and could not be restarted automatically. Check the logs (tray menu -> Show Logs) and restart the app."),
        }
    }
}

/// What the tray shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub running: bool,
    pub starting: bool,
    pub port: u16,
    /// We spawned the server (false: none, or one we adopted).
    pub own_child: bool,
}

type Callback<T> = Box<dyn Fn(T) + Send + Sync>;

pub struct Supervisor {
    inner: Arc<Inner>,
}

struct Inner {
    opts: Options,
    state: Mutex<State>,
    changed: Condvar,
    on_change: Callback<Status>,
    on_notice: Callback<Notice>,
}

#[derive(Default)]
struct State {
    port: u16,
    running: bool,
    starting: bool,
    child: Option<Child>,
    pid: Option<u32>,
    /// Bumped per spawn, so threads of an old child leave the state alone.
    generation: u64,
    deliberate_stop: bool,
    port_conflict: bool,
    restart_attempts: u32,
    started_logged: bool,
    shut_down: bool,
}

/// The result of one `GET /api/remote/health`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Health {
    Healthy,
    /// Nothing listening.
    Refused,
    /// Something listening that didn't answer 200 in time.
    Unhealthy,
}

/// Probes `http://127.0.0.1:<port>/api/remote/health`: only HTTP 200 is healthy.
pub fn probe_health(port: u16) -> Health {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => return Health::Refused,
        Err(_) => return Health::Unhealthy,
    };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
    let request = format!(
        "GET /api/remote/health HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return Health::Unhealthy;
    }
    let mut head = [0u8; 16];
    let mut got = 0;
    while got < head.len() {
        match stream.read(&mut head[got..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => got += n,
        }
    }
    let line = String::from_utf8_lossy(&head[..got]);
    if line.starts_with("HTTP/1.") && line.get(9..12) == Some("200") {
        Health::Healthy
    } else {
        Health::Unhealthy
    }
}

/// Now as ISO 8601 UTC with milliseconds, like JS `new Date().toISOString()`.
pub fn iso_now() -> String {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

pub fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("accompaniment-server.log")
}

/// Appends to the server log, rotating it to `.old` past 5 MB.
pub fn append_log(data_dir: &Path, text: &str) {
    let path = log_path(data_dir);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_ROTATE_BYTES) {
        let _ = std::fs::rename(&path, path.with_extension("log.old"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(text.as_bytes());
    }
}

fn say(message: &str) {
    eprintln!("acCompaniment tray: {message}");
}

impl Supervisor {
    pub fn new(
        opts: Options,
        on_change: impl Fn(Status) + Send + Sync + 'static,
        on_notice: impl Fn(Notice) + Send + Sync + 'static,
    ) -> Self {
        let port = config::configured_port(&opts.data_dir).unwrap_or(DEFAULT_PORT);
        Supervisor {
            inner: Arc::new(Inner {
                opts,
                state: Mutex::new(State {
                    port,
                    ..State::default()
                }),
                changed: Condvar::new(),
                on_change: Box::new(on_change),
                on_notice: Box::new(on_notice),
            }),
        }
    }

    pub fn status(&self) -> Status {
        self.inner.status()
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.opts.data_dir
    }

    /// Starts the server (or adopts one already answering on the port). Returns at once; the
    /// work happens on a thread.
    pub fn start(&self) {
        let inner = self.inner.clone();
        thread::spawn(move || inner.start());
    }

    /// Applies a new port: saved by the caller; restarts a running server on it.
    pub fn set_port(&self, port: u16) {
        let was_running = {
            let mut st = self.inner.lock();
            st.port = port;
            st.running || st.child.is_some()
        };
        self.inner.notify();
        if was_running {
            let inner = self.inner.clone();
            thread::spawn(move || {
                inner.stop();
                thread::sleep(Duration::from_secs(3));
                inner.lock().restart_attempts = 0;
                inner.start();
            });
        }
    }

    /// Stops our server and keeps it stopped (quitting): SIGTERM, then SIGKILL after 5 s; gives
    /// up waiting after 10 s. An adopted server is left running, as the launcher left it.
    pub fn shutdown(&self) {
        self.inner.lock().shut_down = true;
        self.inner.stop();
    }
}

impl Drop for Supervisor {
    /// The last resort: never leave our server behind.
    fn drop(&mut self) {
        let mut st = self.inner.lock();
        st.shut_down = true;
        if let Some(child) = st.child.as_mut() {
            let _ = child.kill();
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn status(&self) -> Status {
        let st = self.lock();
        Status {
            running: st.running,
            starting: st.starting,
            port: st.port,
            own_child: st.child.is_some(),
        }
    }

    fn notify(&self) {
        self.changed.notify_all();
        (self.on_change)(self.status());
    }

    fn start(self: &Arc<Self>) {
        let port = {
            let mut st = self.lock();
            if st.running || st.child.is_some() || st.shut_down {
                return;
            }
            if let Some(p) = config::configured_port(&self.opts.data_dir) {
                st.port = p;
            }
            st.port
        };
        if self.adopt_if_healthy(port) {
            return;
        }
        self.spawn(port);
    }

    /// Probes up to 3 times, 750 ms apart; "connection refused" ends it at once.
    fn adopt_if_healthy(&self, port: u16) -> bool {
        for attempt in 0..3 {
            match probe_health(port) {
                Health::Healthy => {
                    say(&format!(
                        "adopting the server already running on port {port}"
                    ));
                    {
                        let mut st = self.lock();
                        st.running = true;
                        st.starting = false;
                        st.restart_attempts = 0;
                    }
                    self.notify();
                    return true;
                }
                Health::Refused => return false,
                Health::Unhealthy if attempt < 2 => thread::sleep(Duration::from_millis(750)),
                Health::Unhealthy => {}
            }
        }
        false
    }

    fn spawn(self: &Arc<Self>, port: u16) {
        let data = &self.opts.data_dir;
        append_log(
            data,
            &format!(
                "\n--- acCompaniment server starting {} (port {port}) ---\n",
                iso_now()
            ),
        );
        let mut cmd = Command::new(&self.opts.server_bin);
        cmd.env("PORT", port.to_string())
            .env("ACCOMPANIMENT_DATA_DIR", data)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // HOST is left unset: the server listens on every interface, for the LAN and Companion.
        for (k, v) in &self.opts.extra_env {
            cmd.env(k, v);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let message = format!(
                    "Failed to start the server ({}): {e}",
                    self.opts.server_bin.display()
                );
                say(&message);
                append_log(data, &format!("{message}\n"));
                self.lock().starting = false;
                self.notify();
                return;
            }
        };
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let generation = {
            let mut st = self.lock();
            st.generation += 1;
            st.pid = Some(child.id());
            st.child = Some(child);
            st.starting = true;
            st.running = false;
            st.deliberate_stop = false;
            st.port_conflict = false;
            st.generation
        };
        self.notify();
        let mut readers = Vec::new();
        if let Some(out) = stdout {
            let me = self.clone();
            readers.push(thread::spawn(move || {
                me.read_output(out, false, generation)
            }));
        }
        if let Some(err) = stderr {
            let me = self.clone();
            readers.push(thread::spawn(move || me.read_output(err, true, generation)));
        }
        let me = self.clone();
        thread::spawn(move || me.wait_ready(port, generation));
        let me = self.clone();
        thread::spawn(move || me.wait_exit(generation, readers));
    }

    fn read_output(self: &Arc<Self>, pipe: impl Read, stderr: bool, generation: u64) {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let prefix = if stderr { "[stderr] " } else { "" };
            append_log(&self.opts.data_dir, &format!("{prefix}{line}\n"));
            let mut st = self.lock();
            if st.generation != generation {
                continue;
            }
            if line.contains("EADDRINUSE") || line.contains("is already in use") {
                st.port_conflict = true;
            }
            let failed = line.contains("Server stopped")
                || line.contains("Failed to start")
                || line.contains("Server startup failed");
            if failed && st.running {
                st.running = false;
                drop(st);
                self.notify();
            }
        }
    }

    /// Polls health every 500 ms for up to 60 s while our child lives.
    fn wait_ready(self: &Arc<Self>, port: u16, generation: u64) {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            {
                let st = self.lock();
                if st.generation != generation || st.child.is_none() {
                    return;
                }
            }
            if probe_health(port) == Health::Healthy {
                let first = {
                    let mut st = self.lock();
                    if st.generation != generation || st.child.is_none() {
                        return;
                    }
                    st.running = true;
                    st.starting = false;
                    st.restart_attempts = 0;
                    !std::mem::replace(&mut st.started_logged, true)
                };
                if first {
                    say("Server started successfully");
                }
                self.notify();
                return;
            }
            thread::sleep(READY_POLL);
        }
        let still_waiting = {
            let mut st = self.lock();
            let ours = st.generation == generation && st.child.is_some() && !st.running;
            if ours {
                st.starting = false;
            }
            ours
        };
        if still_waiting {
            self.notify();
            (self.on_notice)(Notice::TakingTooLong);
        }
    }

    /// Waits for the child to exit, then for its output to be read to the end (a port conflict
    /// is known from its last lines), then decides: done, adopt, or restart.
    fn wait_exit(self: &Arc<Self>, generation: u64, readers: Vec<thread::JoinHandle<()>>) {
        // Poll try_wait, so the child stays in the state (stop() needs it to signal).
        let code = loop {
            {
                let mut st = self.lock();
                if st.generation != generation {
                    return;
                }
                match st.child.as_mut().map(Child::try_wait) {
                    Some(Ok(Some(status))) => break status.code(),
                    Some(Ok(None)) => {}
                    Some(Err(_)) | None => break None,
                }
            }
            thread::sleep(Duration::from_millis(50));
        };
        for reader in readers {
            let _ = reader.join();
        }
        append_log(
            &self.opts.data_dir,
            &format!(
                "--- acCompaniment server exited (code {}) {} ---\n",
                code.map_or_else(|| "null".to_string(), |c| c.to_string()),
                iso_now()
            ),
        );
        let (deliberate, conflict, shut_down) = {
            let mut st = self.lock();
            st.child = None;
            st.pid = None;
            st.running = false;
            st.starting = false;
            (st.deliberate_stop, st.port_conflict, st.shut_down)
        };
        self.notify();
        if deliberate || shut_down {
            return;
        }
        if conflict {
            self.handle_port_conflict();
        } else {
            self.restart_after_crash();
        }
    }

    fn handle_port_conflict(self: &Arc<Self>) {
        let port = self.lock().port;
        if probe_health(port) == Health::Healthy {
            say(&format!(
                "adopting the server already running on port {port}"
            ));
            {
                let mut st = self.lock();
                st.running = true;
                st.restart_attempts = 0;
            }
            self.notify();
            return;
        }
        let may_retry = self.lock().restart_attempts < MAX_RESTART_ATTEMPTS;
        if may_retry && self.kill_own_orphans(port) {
            self.lock().restart_attempts += 1;
            self.start();
            return;
        }
        self.restart_after_crash();
    }

    fn restart_after_crash(self: &Arc<Self>) {
        let attempt = {
            let mut st = self.lock();
            if st.restart_attempts >= MAX_RESTART_ATTEMPTS {
                None
            } else {
                st.restart_attempts += 1;
                Some(st.restart_attempts)
            }
        };
        match attempt {
            Some(n) => {
                say(&format!(
                    "server exited unexpectedly; restarting (attempt {n}/{MAX_RESTART_ATTEMPTS})"
                ));
                thread::sleep(Duration::from_millis(2000 * u64::from(n)));
                if !self.lock().shut_down {
                    self.start();
                }
            }
            None => (self.on_notice)(Notice::GaveUp {
                crashes: MAX_RESTART_ATTEMPTS,
            }),
        }
    }

    /// Kills processes listening on the port whose command line contains our server binary's
    /// path (a hung server of ours). Others are left alone. Not on Windows.
    #[cfg(unix)]
    fn kill_own_orphans(&self, port: u16) -> bool {
        let me = std::process::id().to_string();
        let Ok(out) = Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
            .output()
        else {
            return false;
        };
        let ours = self.opts.server_bin.to_string_lossy().to_string();
        let mut killed = false;
        for pid in String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .filter(|p| *p != me)
        {
            let command = Command::new("ps")
                .args(["-o", "command=", "-p", pid])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default();
            if !command.contains(&ours) {
                continue;
            }
            if Command::new("kill")
                .args(["-KILL", pid])
                .status()
                .is_ok_and(|s| s.success())
            {
                append_log(
                    &self.opts.data_dir,
                    &format!(
                        "--- killed unresponsive orphaned server pid {pid} holding port {port} ---\n"
                    ),
                );
                killed = true;
            }
        }
        if killed {
            thread::sleep(Duration::from_millis(500));
        }
        killed
    }

    #[cfg(not(unix))]
    fn kill_own_orphans(&self, _port: u16) -> bool {
        false
    }

    fn stop(&self) {
        let pid = {
            let mut st = self.lock();
            st.starting = false;
            match st.pid {
                Some(pid) => {
                    st.deliberate_stop = true;
                    pid
                }
                None => {
                    // Nothing of ours; an adopted server keeps running.
                    if !st.shut_down {
                        st.running = false;
                    }
                    return;
                }
            }
        };
        self.notify();
        terminate(pid, false);
        let mut st = self.lock();
        let start = Instant::now();
        let mut killed = false;
        while st.pid == Some(pid) && start.elapsed() < Duration::from_secs(10) {
            if !killed && start.elapsed() >= Duration::from_secs(5) {
                if let Some(child) = st.child.as_mut() {
                    let _ = child.kill();
                }
                killed = true;
            }
            st = self
                .changed
                .wait_timeout(st, Duration::from_millis(100))
                .map(|(g, _)| g)
                .unwrap_or_else(|e| e.into_inner().0);
        }
    }
}

/// SIGTERM (or SIGKILL with `force`); on Windows `taskkill /T /F`, as the launcher did.
fn terminate(pid: u32, force: bool) {
    #[cfg(unix)]
    {
        let signal = if force { "-KILL" } else { "-TERM" };
        let _ = Command::new("kill")
            .args([signal, &pid.to_string()])
            .status();
    }
    #[cfg(windows)]
    {
        let _ = force;
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_now_looks_like_js_to_iso_string() {
        let s = iso_now();
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.ends_with('Z') && s.as_bytes()[10] == b'T', "{s}");
    }

    // --- Against the real server (ported from the Electron launcher's spec) ---

    /// The server under test: `ACCOMPANIMENT_SERVER_BIN`, or the repo's release build.
    fn server_bin() -> PathBuf {
        std::env::var_os("ACCOMPANIMENT_SERVER_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                // WO-035: with the platform's suffix (`.exe` on Windows).
                Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
                    "../app/target/release/accompaniment{}",
                    std::env::consts::EXE_SUFFIX
                ))
            })
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .unwrap()
    }

    struct Env {
        data_dir: PathBuf,
        port: u16,
        notices: Arc<Mutex<Vec<Notice>>>,
    }

    impl Env {
        /// A fresh data dir whose config says `port`.
        fn new(name: &str) -> Env {
            let bin = server_bin();
            assert!(
                bin.is_file(),
                "{} is missing: npm run build first",
                bin.display()
            );
            let data_dir = std::env::temp_dir()
                .join(format!("accompaniment-tray-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&data_dir);
            let port = free_port();
            let changes = serde_json::json!({ "httpRemotePort": port });
            config::merge_write(&data_dir, changes.as_object().unwrap().clone()).unwrap();
            Env {
                data_dir,
                port,
                notices: Arc::default(),
            }
        }

        fn supervisor(&self) -> Supervisor {
            let notices = self.notices.clone();
            Supervisor::new(
                Options {
                    data_dir: self.data_dir.clone(),
                    server_bin: server_bin(),
                    extra_env: vec![],
                },
                |_| {},
                move |n| notices.lock().unwrap().push(n),
            )
        }

        fn log(&self) -> String {
            std::fs::read_to_string(log_path(&self.data_dir)).unwrap_or_default()
        }

        /// Starts a server of our own on the port, outside any supervisor.
        fn spawn_server(&self) -> Child {
            Command::new(server_bin())
                .env("PORT", self.port.to_string())
                .env("ACCOMPANIMENT_DATA_DIR", &self.data_dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.data_dir);
        }
    }

    fn wait_for(what: &str, timeout: Duration, mut ok: impl FnMut() -> bool) {
        let start = Instant::now();
        while !ok() {
            assert!(start.elapsed() < timeout, "timed out waiting: {what}");
            thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn starts_its_server_on_the_configured_port_from_the_data_dir_and_stops_it_on_quit() {
        let env = Env::new("start");
        let sup = env.supervisor();
        assert_eq!(sup.status().port, env.port);
        sup.start();
        wait_for("running", Duration::from_secs(45), || sup.status().running);
        let status = sup.status();
        assert!(status.own_child && !status.starting, "{status:?}");
        assert_eq!(probe_health(env.port), Health::Healthy);
        // It uses the data dir it was given: the server keeps its config and log there.
        assert!(env.data_dir.join("config").is_dir());
        let log = env.log();
        assert!(
            log.contains("--- acCompaniment server starting ")
                && log.contains(&format!("(port {}) ---", env.port)),
            "{log}"
        );
        wait_for(
            "the server's own output in the log",
            Duration::from_secs(5),
            || {
                env.log()
                    .contains(&format!("Browser UI: http://localhost:{}", env.port))
            },
        );

        // No periodic health check, and its own probes are never logged.
        thread::sleep(Duration::from_secs(2));
        let log = env.log();
        assert!(!log.to_lowercase().contains("health"), "{log}");

        sup.shutdown();
        assert!(!sup.status().running);
        assert_eq!(probe_health(env.port), Health::Refused);
        assert!(
            env.log().contains("--- acCompaniment server exited (code"),
            "{}",
            env.log()
        );
        assert!(env.notices.lock().unwrap().is_empty());
    }

    #[test]
    fn restarts_a_crashed_server() {
        let env = Env::new("crash");
        let sup = env.supervisor();
        sup.start();
        wait_for("running", Duration::from_secs(45), || sup.status().running);
        let pid = sup.inner.lock().pid.unwrap();
        terminate(pid, true);
        wait_for("a new server", Duration::from_secs(45), || {
            let st = sup.inner.lock();
            st.running && st.pid.is_some_and(|p| p != pid)
        });
        // Killed: no exit code on Unix (a signal); on Windows `taskkill /F` exits it with 1.
        let killed = if cfg!(windows) {
            "exited (code 1)"
        } else {
            "exited (code null)"
        };
        assert!(env.log().contains(killed), "{}", env.log());
        sup.shutdown();
        assert_eq!(probe_health(env.port), Health::Refused);
    }

    #[test]
    fn adopts_a_server_already_running_on_its_port_and_leaves_it_running() {
        let env = Env::new("adopt");
        let mut existing = env.spawn_server();
        wait_for("the existing server", Duration::from_secs(30), || {
            probe_health(env.port) == Health::Healthy
        });
        let sup = env.supervisor();
        sup.start();
        wait_for("running", Duration::from_secs(10), || sup.status().running);
        assert!(!sup.status().own_child, "{:?}", sup.status());
        sup.shutdown();
        assert_eq!(probe_health(env.port), Health::Healthy);
        let _ = existing.kill();
        let _ = existing.wait();
    }

    /// A stand-in for a server of ours hung on its way out: it holds the port and never answers.
    /// Our binary's path on its command line is how the supervisor recognises it.
    #[cfg(unix)]
    #[test]
    fn kills_its_own_hung_orphan_holding_the_port_then_starts_a_fresh_server() {
        let env = Env::new("orphan");
        let script = format!(
            "import socket,time\ns=socket.socket()\ns.bind(('0.0.0.0',{}))\ns.listen(5)\ntime.sleep(300)",
            env.port
        );
        let mut hung = Command::new("python3")
            .args(["-c", &script])
            .arg(server_bin())
            .spawn()
            .unwrap();
        wait_for("the hung listener", Duration::from_secs(10), || {
            TcpStream::connect(("127.0.0.1", env.port)).is_ok()
        });
        let sup = env.supervisor();
        sup.start();
        let killed = {
            let start = Instant::now();
            loop {
                if let Some(status) = hung.try_wait().unwrap() {
                    break Some(status);
                }
                if start.elapsed() > Duration::from_secs(90) {
                    break None;
                }
                thread::sleep(Duration::from_millis(100));
            }
        };
        let _ = hung.kill();
        let status = killed.expect("the hung server was not killed");
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(9), "{status:?}");
        assert!(
            env.log()
                .contains("--- killed unresponsive orphaned server pid"),
            "{}",
            env.log()
        );
        wait_for("a fresh server", Duration::from_secs(60), || {
            sup.status().running
        });
        assert!(sup.status().own_child);
        sup.shutdown();
    }

    /// Something else on the port is left alone: after 3 tries the user is told.
    #[cfg(unix)]
    #[test]
    fn leaves_a_stranger_holding_the_port_alone() {
        let env = Env::new("stranger");
        let holder = std::net::TcpListener::bind(("0.0.0.0", env.port)).unwrap();
        let sup = env.supervisor();
        sup.start();
        wait_for("giving up", Duration::from_secs(120), || {
            !env.notices.lock().unwrap().is_empty()
        });
        assert_eq!(
            *env.notices.lock().unwrap(),
            vec![Notice::GaveUp { crashes: 3 }]
        );
        assert!(!env.log().contains("killed"), "{}", env.log());
        drop(holder);
        sup.shutdown();
    }

    #[test]
    fn notices_carry_the_launchers_wording() {
        assert_eq!(
            Notice::GaveUp { crashes: 3 }.body(),
            "The audio server crashed 3 times and could not be restarted automatically. Check the logs (tray menu -> Show Logs) and restart the app."
        );
    }
}
