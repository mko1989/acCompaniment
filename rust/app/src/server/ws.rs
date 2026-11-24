//! `websocketManager.js`: connections, the initial messages, and every client message
//! (rust/research/http-websocket.md §1.7). Like ws: any path, any origin, no compression, 100 MiB
//! messages, pings answered; each message handled in its own task, as Node runs them concurrently.

use std::sync::Arc;

use axum::extract::WebSocketUpgrade;
use axum::extract::ws::{Message, WebSocket};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc::{self, UnboundedSender};

use super::hub::{ToClient, field, resolve_cue_file_paths};
use super::{Core, Shared, net, op};
use crate::core::jsv::{self, Obj};
use crate::js;

const MAX_MESSAGE: usize = 100 * 1024 * 1024;

pub fn upgrade(sh: Arc<Shared>, up: WebSocketUpgrade) -> Response {
    up.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| connection(sh, socket))
}

async fn connection(sh: Arc<Shared>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ToClient>();
    // Added to the broadcast set before the initial data, as the original does.
    let id = sh.hub.add(tx.clone());
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            match m {
                ToClient::Text(t) => {
                    if sink.send(Message::Text(t.as_ref().into())).await.is_err() {
                        break;
                    }
                }
                ToClient::Close => {
                    let _ = sink.close().await;
                    break;
                }
            }
        }
    });
    send_initial_data(&sh, &tx).await;
    while let Some(msg) = stream.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t.as_str().to_string(),
            Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let (sh, tx) = (sh.clone(), tx.clone());
        tokio::spawn(async move { handle_message(&sh, &tx, &text).await });
    }
    sh.hub.remove(id);
    drop(tx);
    let _ = writer.await;
}

fn send(tx: &UnboundedSender<ToClient>, message: &Value) {
    let _ = tx.send(ToClient::Text(Arc::from(jsv::stringify(message))));
}

/// `sendInitialData(ws)`.
async fn send_initial_data(sh: &Arc<Shared>, tx: &UnboundedSender<ToClient>) {
    let messages = op(sh, |c| {
        let mut out = Vec::new();
        let cues = c.cm.get_cues();
        let cues = resolve_cue_file_paths(&mut c.cm.afm, &cues);
        out.push(json!({ "type": "cues-updated", "payload": { "cues": cues } }));
        let status = c.cm.get_playback_status();
        if let Some(Value::Object(states)) = status.get("cueStates") {
            for (cue_id, state) in states {
                let s = state.get("status").and_then(Value::as_str).unwrap_or("");
                if !matches!(s, "playing" | "paused" | "cued_next") {
                    continue;
                }
                out.push(json!({
                    "type": "cue_status",
                    "payload": {
                        "cueId": cue_id,
                        "status": s,
                        "currentTime": jsv::or(state.get("currentTime"), json!(0)),
                        "totalTime": jsv::or(state.get("totalTime"), json!(0)),
                    }
                }));
            }
        }
        out.push(json!({
            "type": "crossfade-mode-updated",
            "payload": { "enabled": jsv::truthy_opt(status.get("crossfadeMode")) }
        }));
        out.push(json!({
            "type": "master-volume-updated",
            "payload": { "volume": field(&status, "masterVolume") }
        }));
        out.push(json!({
            "type": "config-updated",
            "payload": { "config": Value::Object(c.config.get_config()) }
        }));
        let ws = c.cm.get_current_workspace();
        if jsv::truthy(&ws) {
            out.push(json!({ "type": "workspace-updated", "payload": { "workspace": ws } }));
        }
        out
    })
    .await;
    for m in messages {
        send(tx, &m);
    }
}

fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object()?.get(key)
}

/// `payload.x` where reading a property of `undefined`/`null` throws in the original.
fn prop(payload: &Value, key: &str) -> Result<Value, ()> {
    if payload.is_null() || js::is_undefined(payload) {
        return Err(());
    }
    Ok(get(payload, key).cloned().unwrap_or_else(js::undefined))
}

fn error_reply(tx: &UnboundedSender<ToClient>, verb: &str) {
    send(
        tx,
        &json!({ "type": "error", "payload": { "error": format!("Failed to {verb}") } }),
    );
}

/// `handleMessage(ws, message)`.
async fn handle_message(sh: &Arc<Shared>, tx: &UnboundedSender<ToClient>, text: &str) {
    let Ok(data) = jsv::parse_str(text) else {
        send(
            tx,
            &json!({ "type": "error", "payload": { "error": "Invalid message format" } }),
        );
        return;
    };
    if data.is_null() {
        // `data.requestId` on null throws: caught as a bad message.
        send(
            tx,
            &json!({ "type": "error", "payload": { "error": "Invalid message format" } }),
        );
        return;
    }
    if get(&data, "requestId").is_some_and(|r| !r.is_null()) {
        handle_invoke(sh, tx, &data).await;
        return;
    }
    let payload = get(&data, "payload").cloned().unwrap_or_else(js::undefined);
    let ty = get(&data, "type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "trigger_cue" => {
            let Ok(cue_id) = prop(&payload, "cueId") else {
                return error_reply(tx, "trigger cue");
            };
            if !jsv::truthy(&cue_id) {
                return;
            }
            let id = jsv::to_js_string(&cue_id);
            let r = op(sh, move |c| {
                c.cm.trigger_cue(
                    &id,
                    &json!({ "source": "websocket", "clientId": js::undefined() }),
                )
            })
            .await;
            reply_result(tx, "cue_triggered", &cue_id, &r, &[]);
        }
        "toggle_cue" => {
            let Ok(cue_id) = prop(&payload, "cueId") else {
                return error_reply(tx, "toggle cue");
            };
            if !jsv::truthy(&cue_id) {
                return;
            }
            let mut options = Obj::new();
            options.insert(
                "retriggerBehavior".into(),
                field(&payload, "retriggerBehavior"),
            );
            options.insert(
                "fromCompanion".into(),
                jsv::or(get(&payload, "fromCompanion"), json!(false)),
            );
            options.insert("source".into(), json!("websocket"));
            options.insert("clientId".into(), js::undefined());
            let id = jsv::to_js_string(&cue_id);
            let r = op(sh, move |c| c.cm.toggle_cue(&id, &Value::Object(options))).await;
            reply_result(tx, "cue_toggled", &cue_id, &r, &["status"]);
        }
        "play_cue" => {
            let Ok(cue_id) = prop(&payload, "cueId") else {
                return error_reply(tx, "play cue");
            };
            if !jsv::truthy(&cue_id) {
                return;
            }
            let id = jsv::to_js_string(&cue_id);
            let r = op(sh, move |c| {
                c.cm.play_cue(
                    &id,
                    &json!({ "source": "websocket", "clientId": js::undefined() }),
                )
            })
            .await;
            reply_result(tx, "cue_played", &cue_id, &r, &[]);
        }
        "stop_cue" => {
            let Ok(cue_id) = prop(&payload, "cueId") else {
                return error_reply(tx, "stop cue");
            };
            if !jsv::truthy(&cue_id) {
                return;
            }
            let fade = jsv::truthy(&field(&payload, "fadeOut"));
            let id = jsv::to_js_string(&cue_id);
            let r = op(sh, move |c| c.cm.stop_cue(&id, fade)).await;
            reply_result(tx, "cue_stopped", &cue_id, &r, &[]);
        }
        "stop_all_cues" => {
            let behavior = get(&payload, "behavior").cloned();
            let r = op(sh, move |c| {
                let b = behavior.filter(|v| !js::is_undefined(v));
                c.cm.stop_all_cues(b.as_ref())
            })
            .await;
            let mut p = Obj::new();
            p.insert("success".into(), field(&r, "success"));
            p.insert("error".into(), field(&r, "error"));
            send(
                tx,
                &json!({ "type": "all_cues_stopped", "payload": Value::Object(p) }),
            );
        }
        "set_crossfade_mode" => {
            let enabled = jsv::truthy_opt(get(&payload, "enabled"));
            op(sh, move |c| c.cm.set_crossfade_mode(&json!(enabled))).await;
        }
        "playlist_navigate" => {
            let Ok(cue_id) = prop(&payload, "cueId") else {
                return error_reply(tx, "navigate playlist");
            };
            let direction = field(&payload, "direction");
            if !jsv::truthy(&cue_id) || !jsv::truthy(&direction) {
                return;
            }
            let id = jsv::to_js_string(&cue_id);
            let d = direction.clone();
            let r = op(sh, move |c| c.cm.navigate_playlist(&id, &d)).await;
            let mut p = Obj::new();
            p.insert("cueId".into(), cue_id);
            p.insert("direction".into(), direction);
            p.insert("success".into(), field(&r, "success"));
            p.insert("error".into(), field(&r, "error"));
            send(
                tx,
                &json!({ "type": "playlist_navigated", "payload": Value::Object(p) }),
            );
        }
        "playlist_jump" => {
            let cue_id = get(&payload, "cueId")
                .cloned()
                .unwrap_or_else(js::undefined);
            if !jsv::truthy(&cue_id) {
                return;
            }
            let index = field(&payload, "index");
            let id = jsv::to_js_string(&cue_id);
            let r = op(sh, move |c| c.cm.jump_to_playlist_item(&id, &index)).await;
            send_spread(tx, "playlist_jumped", &cue_id, &r);
        }
        "toggle_pause_cue" => {
            let cue_id = get(&payload, "cueId")
                .cloned()
                .unwrap_or_else(js::undefined);
            if !jsv::truthy(&cue_id) {
                return;
            }
            let id = jsv::to_js_string(&cue_id);
            let r = op(sh, move |c| c.cm.toggle_pause_cue(&id)).await;
            send_spread(tx, "cue_pause_toggled", &cue_id, &r);
        }
        "set_master_volume" => {
            let volume = jsv::to_number(&field(&payload, "volume"));
            let r = op(sh, move |c| c.cm.set_master_volume(&jsv::num(volume))).await;
            send(tx, &json!({ "type": "master_volume_set", "payload": r }));
        }
        "update_cue" => {
            let Ok(cue_id) = prop(&payload, "cueId") else {
                return error_reply(tx, "update cue");
            };
            let updates = field(&payload, "updates");
            if !jsv::truthy(&cue_id) || !jsv::truthy(&updates) {
                return;
            }
            let id = jsv::to_js_string(&cue_id);
            let r = op(sh, move |c| c.cm.update_cue(&id, &updates)).await;
            reply_result(tx, "cue_updated", &cue_id, &r, &[]);
        }
        "delete_cue" => {
            let Ok(cue_id) = prop(&payload, "cueId") else {
                return error_reply(tx, "delete cue");
            };
            if !jsv::truthy(&cue_id) {
                return;
            }
            let id = jsv::to_js_string(&cue_id);
            let r = op(sh, move |c| c.cm.delete_cue(&id)).await;
            reply_result(tx, "cue_deleted", &cue_id, &r, &[]);
        }
        "create_cue" => {
            if !jsv::truthy(&payload) {
                return;
            }
            let r = op(sh, move |c| c.cm.create_cue(&payload)).await;
            let mut p = Obj::new();
            p.insert("success".into(), field(&r, "success"));
            p.insert("cue".into(), field(&r, "cue"));
            p.insert("error".into(), field(&r, "error"));
            send(
                tx,
                &json!({ "type": "cue_created", "payload": Value::Object(p) }),
            );
        }
        "ping" => send(tx, &json!({ "type": "pong" })),
        "playback-time-update" if jsv::truthy(&payload) => {
            sh.hub
                .send_all(&json!({ "type": "playback-time-update", "payload": payload }));
        }
        _ => {}
    }
}

/// `{ type, payload: { cueId, success, [extra...], error } }`.
fn reply_result(
    tx: &UnboundedSender<ToClient>,
    ty: &str,
    cue_id: &Value,
    r: &Value,
    extra: &[&str],
) {
    if let Some(e) = r.get("$error") {
        // The handler's catch.
        let _ = e;
        let verb = match ty {
            "cue_triggered" => "trigger cue",
            "cue_toggled" => "toggle cue",
            "cue_played" => "play cue",
            "cue_stopped" => "stop cue",
            "cue_updated" => "update cue",
            "cue_deleted" => "delete cue",
            _ => "handle message",
        };
        return error_reply(tx, verb);
    }
    let mut p = Obj::new();
    p.insert("cueId".into(), cue_id.clone());
    p.insert("success".into(), field(r, "success"));
    for k in extra {
        p.insert((*k).into(), field(r, k));
    }
    p.insert("error".into(), field(r, "error"));
    send(tx, &json!({ "type": ty, "payload": Value::Object(p) }));
}

/// `{ type, payload: { cueId, ...result } }`.
fn send_spread(tx: &UnboundedSender<ToClient>, ty: &str, cue_id: &Value, r: &Value) {
    let mut p = Obj::new();
    p.insert("cueId".into(), cue_id.clone());
    jsv::spread(&mut p, r);
    send(tx, &json!({ "type": ty, "payload": Value::Object(p) }));
}

/// `handleInvokeMessage(ws, data)`: `{ type: '<type>_response', requestId, payload | error }`.
async fn handle_invoke(sh: &Arc<Shared>, tx: &UnboundedSender<ToClient>, data: &Value) {
    let ty_v = get(data, "type").cloned().unwrap_or_else(js::undefined);
    let ty = if js::is_undefined(&ty_v) {
        "undefined".to_string()
    } else {
        jsv::to_js_string(&ty_v)
    };
    let request_id = get(data, "requestId").cloned().unwrap_or(Value::Null);
    let payload = get(data, "payload").cloned().unwrap_or_else(js::undefined);
    let t = ty.clone();
    let outcome: Result<Value, String> = match ty.as_str() {
        "get-app-config" => Ok(op(sh, |c| Value::Object(c.config.get_config())).await),
        "save-app-config" => {
            if jsv::truthy(&payload) {
                Ok(op(sh, move |c| save_app_config(c, &payload)).await)
            } else {
                Err("AppConfigManager not available or invalid payload".into())
            }
        }
        "save-reordered-cues" => Ok(op(sh, move |c| c.cm.reorder_cues(&payload)).await),
        "get-crossfade-mode" => {
            Ok(op(sh, |c| json!({ "enabled": c.cm.get_crossfade_mode() })).await)
        }
        "set-crossfade-mode" => {
            let enabled = jsv::truthy_opt(get(&payload, "enabled"));
            Ok(op(sh, move |c| c.cm.set_crossfade_mode(&json!(enabled))).await)
        }
        "get-cues" => Ok(op(sh, |c| {
            let cues = c.cm.get_cues();
            Value::Array(resolve_cue_file_paths(&mut c.cm.afm, &cues))
        })
        .await),
        "add-or-update-cue" => {
            if jsv::truthy(&payload) {
                Ok(op(sh, move |c| {
                    let id = field(&payload, "id");
                    let existing = jsv::truthy(&id)
                        && id.as_str() != Some("new")
                        && c.cm.get_cue(&jsv::to_js_string(&id)).is_some();
                    let r = if existing {
                        c.cm.update_cue(&jsv::to_js_string(&id), &payload)
                    } else {
                        c.cm.create_cue(&payload)
                    };
                    let mut o = Obj::new();
                    o.insert("success".into(), field(&r, "success"));
                    o.insert("cue".into(), field(&r, "cue"));
                    Value::Object(o)
                })
                .await)
            } else {
                Err("CueManager not available or invalid payload".into())
            }
        }
        "generate-uuid" => Ok(json!(jsv::random_uuid())),
        "get-media-duration" => {
            let fp = get(&payload, "filePath").cloned();
            match fp.filter(jsv::truthy) {
                None => Err("AudioFileManager not available or invalid payload".into()),
                Some(Value::String(path)) => op(sh, move |c| media_duration(c, &path)).await,
                Some(_) => Err(
                    "Error getting duration: payload.filePath.startsWith is not a function".into(),
                ),
            }
        }
        "get-http-remote-info" => Ok(op(sh, |c| {
            let port = c.config.get_listening_port();
            let interfaces: Vec<Value> = net::interfaces(&port)
                .iter()
                .map(|i| {
                    json!({
                        "interface": field(i, "name"),
                        "url": format!("{}/remote", jsv::to_js_string(&field(i, "httpUrl"))),
                    })
                })
                .collect();
            json!({ "enabled": true, "port": port, "interfaces": interfaces })
        })
        .await),
        "delete-cue" => {
            let cue_id = match &payload {
                Value::String(s) => json!(s),
                p if jsv::truthy(p) => field(p, "cueId"),
                _ => js::undefined(),
            };
            if jsv::truthy(&cue_id) {
                let id = jsv::to_js_string(&cue_id);
                Ok(op(sh, move |c| {
                    let r = c.cm.delete_cue(&id);
                    let mut o = Obj::new();
                    o.insert("success".into(), field(&r, "success"));
                    o.insert("error".into(), field(&r, "error"));
                    Value::Object(o)
                })
                .await)
            } else {
                Err("Cue ID required for delete".into())
            }
        }
        _ => Err(format!("Unknown invoke message type: {t}")),
    };
    let outcome = match outcome {
        Ok(v) => match v.get("$error") {
            Some(e) => Err(jsv::to_js_string(e)),
            None => Ok(v),
        },
        Err(e) => Err(e),
    };
    let mut o = Obj::new();
    o.insert("type".into(), json!(format!("{ty}_response")));
    o.insert("requestId".into(), request_id);
    match outcome {
        Ok(p) => o.insert("payload".into(), p),
        Err(e) => o.insert("error".into(), json!(e)),
    };
    send(tx, &Value::Object(o));
}

/// `save-app-config`: `{ success }`, then the cue manager and every page get the new config.
fn save_app_config(c: &mut Core, payload: &Value) -> Value {
    let prev = Value::Object(c.config.get_config());
    let r = c.config.update_config(payload);
    let ok = jsv::truthy_opt(r.get("success"));
    if ok {
        let next = Value::Object(c.config.get_config());
        c.cm.apply_config(&prev, next.clone());
        c.cm.ws
            .broadcast(json!({ "type": "config-updated", "payload": { "config": next } }));
    }
    json!({ "success": field(&r, "success") })
}

/// `get-media-duration`.
fn media_duration(c: &mut Core, path: &str) -> Result<Value, String> {
    let mut file = c.cm.afm.get_audio_file_by_path(path);
    if file.is_none()
        && crate::core::nodefs::is_absolute(path)
        && let Some(rel) = c.pm.to_relative_path(path)
    {
        file = c.cm.afm.get_audio_file_by_path(&rel);
    }
    if let Some(f) = &file {
        let fv = Value::Object(f.clone());
        if let Some(d) = get(&fv, "metadata")
            .and_then(|m| get(m, "duration"))
            .filter(|d| jsv::truthy(d))
        {
            return Ok(d.clone());
        }
        if let Some(d) = f.get("duration").filter(|d| jsv::truthy(d)) {
            return Ok(d.clone());
        }
    }
    let v = c.cm.afm.validate_audio_file(path);
    match get(&v, "metadata").and_then(|m| get(m, "duration")) {
        Some(d) if jsv::truthy_opt(v.get("valid")) && jsv::truthy(d) => Ok(d.clone()),
        _ => Err("Could not determine duration".into()),
    }
}
