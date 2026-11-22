//! The WebSocket side of `websocketManager.js`: the connected clients, and the broadcasts the cue
//! engine makes.
//!
//! The engine broadcasts while the core is locked; those messages go into an outbox, and after
//! the operation the server resolves cue file paths (as `resolveCueFilePaths` does) and sends each
//! message once, serialized, to every open client, in order. Each client has its own unbounded
//! queue and writer task, so a slow client never loses a message (ws never drops one either).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use crate::core::audio_files::AudioFileManager;
use crate::core::cue_engine::Broadcaster;
use crate::core::jsv::{self, Obj};
use crate::js;

/// What a client's writer task is told to do.
pub enum ToClient {
    Text(Arc<str>),
    Close,
}

#[derive(Default)]
pub struct Hub {
    clients: Mutex<IndexMap<u64, UnboundedSender<ToClient>>>,
    next_id: AtomicU64,
}

impl Hub {
    pub fn add(&self, tx: UnboundedSender<ToClient>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut c) = self.clients.lock() {
            c.insert(id, tx);
        }
        id
    }

    pub fn remove(&self, id: u64) {
        if let Ok(mut c) = self.clients.lock() {
            c.shift_remove(&id);
        }
    }

    /// `getConnectedClientsCount()`.
    pub fn len(&self) -> usize {
        self.clients.lock().map_or(0, |c| c.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// `broadcast(message)`: serialized once, sent to every open client.
    pub fn send_all(&self, message: &Value) {
        let text: Arc<str> = Arc::from(jsv::stringify(message));
        if let Ok(c) = self.clients.lock() {
            for tx in c.values() {
                let _ = tx.send(ToClient::Text(text.clone()));
            }
        }
    }

    /// Shutdown (WO-013): every client is closed, so nothing keeps the server open.
    pub fn close_all(&self) {
        if let Ok(mut c) = self.clients.lock() {
            for tx in c.values() {
                let _ = tx.send(ToClient::Close);
            }
            c.clear();
        }
    }
}

/// One thing the engine broadcast during an operation.
pub enum Out {
    Message(Value),
    /// `broadcastCuesUpdate(cues)`: resolved before sending.
    Cues(Vec<Value>),
}

pub type Outbox = Arc<Mutex<Vec<Out>>>;

/// The `Broadcaster` the cue engine gets: it fills the outbox.
pub struct QueueBroadcaster {
    pub outbox: Outbox,
}

impl QueueBroadcaster {
    fn push(&self, out: Out) {
        if let Ok(mut o) = self.outbox.lock() {
            o.push(out);
        }
    }
}

impl Broadcaster for QueueBroadcaster {
    fn broadcast(&mut self, message: Value) {
        self.push(Out::Message(message));
    }
    fn broadcast_cues_update(&mut self, cues: Vec<Value>) {
        self.push(Out::Cues(cues));
    }
    fn broadcast_cue_update(&mut self, cue_id: &str, updates: &Value) {
        let mut payload = Obj::new();
        payload.insert("cueId".into(), json!(cue_id));
        payload.insert("updates".into(), updates.clone());
        self.push(Out::Message(
            json!({ "type": "cue_update", "payload": Value::Object(payload) }),
        ));
    }
    fn broadcast_cue_status(&mut self, cue_id: &str, status: &str, extra: Option<Obj>) {
        // `{ cueId, status, ...additionalData }`
        let mut payload = Obj::new();
        payload.insert("cueId".into(), json!(cue_id));
        payload.insert("status".into(), json!(status));
        if let Some(extra) = extra {
            jsv::spread(&mut payload, &Value::Object(extra));
        }
        self.push(Out::Message(
            json!({ "type": "cue_status", "payload": Value::Object(payload) }),
        ));
    }
    fn broadcast_workspace_update(&mut self, workspace: Value) {
        self.push(Out::Message(
            json!({ "type": "workspace-updated", "payload": { "workspace": workspace } }),
        ));
    }
}

/// `resolveCueFilePaths(cues)`: each cue (and playlist item) that names a library file but has no
/// `filePath` gets `/api/audio/serve/<id>`, and its `relativePath` if it had none.
pub fn resolve_cue_file_paths(afm: &mut AudioFileManager, cues: &[Value]) -> Vec<Value> {
    cues.iter()
        .map(|cue| {
            let mut resolved = cue.clone();
            let ty = cue.get("type").and_then(Value::as_str);
            if ty == Some("single_file")
                && let Value::Object(o) = &mut resolved
            {
                resolve_one(afm, o);
            }
            if ty == Some("playlist")
                && let Some(Value::Array(items)) = cue.get("playlistItems")
                && let Value::Object(o) = &mut resolved
            {
                let items: Vec<Value> = items
                    .iter()
                    .map(|item| {
                        let mut it = item.clone();
                        if let Value::Object(io) = &mut it {
                            resolve_one(afm, io);
                        }
                        it
                    })
                    .collect();
                o.insert("playlistItems".into(), Value::Array(items));
            }
            resolved
        })
        .collect()
}

fn resolve_one(afm: &mut AudioFileManager, o: &mut Obj) {
    if jsv::truthy_opt(o.get("filePath")) {
        return;
    }
    let id = o.get("audioFileId").cloned();
    let rel = o.get("relativePath").cloned();
    if !(jsv::truthy_opt(id.as_ref()) || jsv::truthy_opt(rel.as_ref())) {
        return;
    }
    let found = if jsv::truthy_opt(id.as_ref()) {
        id.as_ref().and_then(|id| afm.load_audio_file_metadata(id))
    } else {
        // A non-string path throws in the original; caught, the cue stays as it is.
        rel.as_ref()
            .and_then(Value::as_str)
            .and_then(|p| afm.get_audio_file_by_path(p))
    };
    if let Some(file) = found {
        let fid = file.get("id").map(jsv::to_js_string).unwrap_or_default();
        o.insert("filePath".into(), json!(format!("/api/audio/serve/{fid}")));
        if !jsv::truthy_opt(o.get("relativePath"))
            && let Some(r) = file.get("relativePath").filter(|r| jsv::truthy(r))
        {
            o.insert("relativePath".into(), r.clone());
        }
    }
}

/// The undefined marker, for JS fields that may be `undefined` (left out when serialized).
pub fn field(v: &Value, key: &str) -> Value {
    v.get(key).cloned().unwrap_or_else(js::undefined)
}
