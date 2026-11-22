//! The Express app: middleware order and every route of `src/backend/routes/*.js`.
//!
//! Matching copies Express 5 (rust/research/http-websocket.md §1.2): case-insensitive, one
//! trailing slash optional, `:param` = one non-empty segment run through `decodeURIComponent`, no
//! 405 (a method mismatch falls through to later routes, finally the 404 page), HEAD answered by
//! GET routes. Routes are tried in the original's registration order.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{Request, State, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::http::{self, Parsed};
use super::hub::field;
use super::upload::{self, Rules, UploadError};
use super::{Shared, net, op};
use crate::core::jsv::{self, Obj};
use crate::core::{bundle, id_validation, nodefs as nfs};
use crate::js;

const SUPPORTED_FORMATS: [&str; 6] = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];
const MAX_BUNDLE_BYTES: u64 = 20 * 1024 * 1024 * 1024;

/// Every request: WebSocket upgrades on any path (ws shares the HTTP server and never reaches
/// Express), then the Express app, then CORS headers on the way out.
pub async fn entry(
    State(sh): State<Arc<Shared>>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
    req: Request,
) -> Response {
    if let Ok(up) = upgrade {
        return super::ws::upgrade(sh, up);
    }
    let req_headers = req.headers().clone();
    if req.method() == Method::OPTIONS {
        return http::cors_preflight(&req_headers);
    }
    let is_head = req.method() == Method::HEAD;
    let mut res = app(&sh, req).await;
    http::add_cors(&req_headers, &mut res);
    if is_head {
        *res.body_mut() = Body::empty();
    }
    res
}

/// What a route gets.
struct Ctx {
    sh: Arc<Shared>,
    method: Method,
    headers: HeaderMap,
    query: Map<String, Value>,
    /// `req.body` after body-parser and server.js's `req.body ??= {}`.
    body: Value,
    /// The request body when body-parser left it (multipart). In a mutex so `&Ctx` is `Send`;
    /// shared with `app`, which drains what no route read.
    stream: Arc<std::sync::Mutex<Option<Body>>>,
}

async fn app(sh: &Arc<Shared>, req: Request) -> Response {
    let (parts, body_stream) = req.into_parts();
    let raw_path = parts.uri.path().to_string();
    let method = parts.method.clone();
    let headers = parts.headers.clone();

    // body-parser (json, urlencoded), then `req.body ??= {}`.
    let (body, stream) = if http::wants_body_parser(&headers) {
        let bytes = match axum::body::to_bytes(body_stream, http::JSON_LIMIT).await {
            Ok(b) => b,
            Err(_) => return http::status_page(413),
        };
        match http::parse_body(&headers, &bytes) {
            Parsed::Body(v) => (v, None),
            Parsed::Untouched => (json!({}), None),
            Parsed::Error(status) => return http::status_page(status),
        }
    } else {
        (json!({}), Some(body_stream))
    };

    // express.static(src/frontend): GET and HEAD, falling through on anything it can't serve.
    let get_like = method == Method::GET || method == Method::HEAD;
    if get_like && let Some(r) = http::serve_static(&sh.frontend, &raw_path, &headers).await {
        return r;
    }

    let mut segs: Vec<&str> = raw_path.split('/').skip(1).collect();
    // `strict: false`: one trailing slash is optional.
    if segs.len() > 1 && segs.last() == Some(&"") {
        segs.pop();
    }
    if segs == [""] {
        segs.clear();
    }

    let leftover = Arc::new(std::sync::Mutex::new(stream));
    let ctx = Ctx {
        sh: sh.clone(),
        method: method.clone(),
        headers,
        query: http::parse_query(parts.uri.query()),
        body,
        stream: leftover.clone(),
    };
    let res = route_app(ctx, get_like, &segs, &method, &raw_path).await;
    // Node discards a request body nobody read; hyper would reset the connection while the
    // client still sends (an upload answered early: a bad id, a missing file).
    let unread = leftover.lock().ok().and_then(|mut s| s.take());
    if let Some(body) = unread {
        upload::drain(body).await;
    }
    res
}

async fn route_app(
    ctx: Ctx,
    get_like: bool,
    segs: &[&str],
    method: &Method,
    raw_path: &str,
) -> Response {
    let segs = segs.to_vec();
    let raw_path = raw_path.to_string();
    let method = method.clone();

    // `GET /` (index.html) and `GET /remote` (the remote control page).
    if get_like && segs.is_empty() {
        return send_page(&ctx, &["index.html"]).await;
    }
    if get_like && segs.len() == 1 && segs[0].eq_ignore_ascii_case("remote") {
        return send_page(&ctx, &["remote_control", "remote.html"]).await;
    }

    if segs.len() >= 2 && segs[0].eq_ignore_ascii_case("api") {
        let area = segs[1].to_ascii_lowercase();
        let rest: Vec<&str> = segs[2..].to_vec();
        let r = match area.as_str() {
            "config" => config_routes(ctx, &rest).await,
            "cues" => cue_routes(ctx, &rest).await,
            "audio" => audio_routes(ctx, &rest).await,
            "workspaces" => workspace_routes(ctx, &rest).await,
            "projects" => project_routes(ctx, &rest).await,
            "remote" => remote_routes(ctx, &rest).await,
            _ => None,
        };
        return r.unwrap_or_else(|| http::not_found(&method, &raw_path));
    }
    http::not_found(&method, &raw_path)
}

async fn send_page(ctx: &Ctx, rel: &[&str]) -> Response {
    let mut p = ctx.sh.frontend.clone();
    for r in rel {
        p.push(r);
    }
    match tokio::fs::metadata(&p).await {
        Ok(m) => match http::send_file(&p, &m, &ctx.headers).await {
            Some(r) => r,
            None => http::status_page(500),
        },
        Err(_) => http::status_page(404),
    }
}

// --- Matching -----------------------------------------------------------------------------

/// A pattern segment: a literal word, or `:param`.
enum Seg {
    Lit(&'static str),
    Param,
}

/// Matches `rest` against a pattern; `Some(Ok(params))`, `Some(Err(()))` when a param can't be
/// decoded (Express answers 400), `None` when it doesn't match.
fn matches(rest: &[&str], pat: &[Seg]) -> Option<Result<Vec<String>, ()>> {
    if rest.len() != pat.len() {
        return None;
    }
    let mut params = Vec::new();
    for (s, p) in rest.iter().zip(pat) {
        match p {
            Seg::Lit(w) => {
                if !s.eq_ignore_ascii_case(w) {
                    return None;
                }
            }
            Seg::Param => {
                if s.is_empty() {
                    return None;
                }
                match http::decode_component(s) {
                    Some(d) => params.push(d),
                    None => return Some(Err(())),
                }
            }
        }
    }
    Some(Ok(params))
}

fn method_is(ctx: &Ctx, m: &Method) -> bool {
    ctx.method == *m || (*m == Method::GET && ctx.method == Method::HEAD)
}

/// The result of trying the routes of one router: a response, or `None` (no route matched).
type Routed = Option<Response>;

macro_rules! route {
    ($ctx:ident, $rest:ident, $method:expr, [$($seg:expr),*], |$params:ident| $body:expr) => {
        if method_is(&$ctx, &$method) {
            match matches($rest, &[$($seg),*]) {
                Some(Ok($params)) => {
                    #[allow(unused_variables)]
                    let $params = $params;
                    return Some($body);
                }
                Some(Err(())) => return Some(http::status_page(400)),
                None => {}
            }
        }
    };
}

use Seg::{Lit, Param};

/// `requireUuid('id')`.
fn require_uuid(id: &str) -> Option<Response> {
    (!id_validation::is_uuid(id)).then(|| http::fail(400, "Invalid id: must be a UUID"))
}

fn body_get(ctx: &Ctx, key: &str) -> Value {
    match &ctx.body {
        Value::Object(o) => o.get(key).cloned().unwrap_or_else(js::undefined),
        _ => js::undefined(),
    }
}

/// A function of the original that threw: the route's catch answers 500.
fn thrown(v: &Value) -> Option<String> {
    v.get("$error").map(jsv::to_js_string)
}

fn ok_merge(fields: Vec<(&str, Value)>) -> Value {
    let mut o = Obj::new();
    o.insert("success".into(), json!(true));
    for (k, v) in fields {
        o.insert(k.into(), v);
    }
    Value::Object(o)
}

fn not_found_status(error: &Value) -> u16 {
    if error.as_str() == Some("Cue not found") {
        404
    } else {
        400
    }
}

fn fail_v(status: u16, error: Value) -> Response {
    let mut o = Obj::new();
    o.insert("success".into(), json!(false));
    o.insert("error".into(), error);
    http::json(status, &Value::Object(o))
}

// --- /api/config ----------------------------------------------------------------------------

async fn config_routes(ctx: Ctx, rest: &[&str]) -> Routed {
    route!(ctx, rest, Method::GET, [], |p| {
        op(&ctx.sh, |c| {
            http::json(
                200,
                &json!({ "success": true, "config": Value::Object(c.config.get_config()) }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::PUT, [], |p| {
        let updates = ctx.body.clone();
        op(&ctx.sh, move |c| {
            let current = c.config.get_config();
            let mut merged = current.clone();
            jsv::spread(&mut merged, &updates);
            let errors = crate::core::config::AppConfigManager::validate_config(&merged);
            if !errors.is_empty() {
                return http::json(
                    400,
                    &json!({ "success": false, "error": "Invalid configuration", "details": errors }),
                );
            }
            let result = c.config.update_config(&updates);
            if jsv::truthy_opt(result.get("success")) {
                let next = field(&result, "config");
                propagate_config(c, &Value::Object(current), next.clone());
                http::json(200, &json!({ "success": true, "config": next }))
            } else {
                fail_v(500, field(&result, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Lit("reset")], |p| {
        op(&ctx.sh, |c| {
            let prev = Value::Object(c.config.get_config());
            let config = Value::Object(c.config.reset_to_defaults());
            propagate_config(c, &prev, config.clone());
            http::json(200, &json!({ "success": true, "config": config }))
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("network")], |p| {
        op(&ctx.sh, |c| {
            let port = c.config.get_listening_port();
            http::json(
                200,
                &json!({ "success": true, "interfaces": net::interfaces(&port) }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("path")], |p| {
        op(&ctx.sh, |c| {
            http::json(
                200,
                &json!({ "success": true, "path": c.config.config_path }),
            )
        })
        .await
    });
    None
}

/// `propagateConfig`: the cue manager gets the new config (reopening the engine if an audio
/// setting changed) and every page is told.
fn propagate_config(c: &mut super::Core, prev: &Value, next: Value) {
    c.cm.apply_config(prev, next.clone());
    c.cm.ws
        .broadcast(json!({ "type": "config-updated", "payload": { "config": next } }));
}

// --- /api/cues ------------------------------------------------------------------------------

async fn cue_routes(ctx: Ctx, rest: &[&str]) -> Routed {
    route!(ctx, rest, Method::GET, [], |p| {
        op(&ctx.sh, |c| {
            http::json(200, &json!({ "success": true, "cues": c.cm.get_cues() }))
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Lit("stop-all")], |p| {
        let behavior = body_get(&ctx, "behavior");
        op(&ctx.sh, move |c| stop_all_response(c, &behavior)).await
    });
    route!(ctx, rest, Method::POST, [Lit("reorder")], |p| {
        let ids = body_get(&ctx, "cueIds");
        op(&ctx.sh, move |c| {
            let r = c.cm.reorder_cues(&ids);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            http::json(
                if jsv::truthy_opt(r.get("success")) {
                    200
                } else {
                    400
                },
                &r,
            )
        })
        .await
    });
    route!(
        ctx,
        rest,
        Method::GET,
        [Lit("status"), Lit("playback")],
        |p| {
            op(&ctx.sh, |c| {
                http::json(
                    200,
                    &json!({ "success": true, "status": c.cm.get_playback_status() }),
                )
            })
            .await
        }
    );
    route!(ctx, rest, Method::GET, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| match c.cm.get_cue(&id) {
            Some(cue) => http::json(200, &json!({ "success": true, "cue": cue })),
            None => http::fail(404, "Cue not found"),
        })
        .await
    });
    route!(ctx, rest, Method::POST, [], |p| {
        let data = ctx.body.clone();
        op(&ctx.sh, move |c| {
            let r = c.cm.create_cue(&data);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(201, &ok_merge(vec![("cue", field(&r, "cue"))]))
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::PUT, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        let updates = ctx.body.clone();
        op(&ctx.sh, move |c| {
            let r = c.cm.update_cue(&id, &updates);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(200, &ok_merge(vec![("cue", field(&r, "cue"))]))
            } else {
                let e = field(&r, "error");
                fail_v(not_found_status(&e), e)
            }
        })
        .await
    });
    route!(ctx, rest, Method::DELETE, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.delete_cue(&id);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(200, &json!({ "success": true }))
            } else {
                let e = field(&r, "error");
                fail_v(not_found_status(&e), e)
            }
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Param, Lit("trigger")], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        let options = ctx.body.clone();
        op(&ctx.sh, move |c| trigger_response(c, &id, &options, true)).await
    });
    route!(ctx, rest, Method::POST, [Param, Lit("stop")], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        let fade = body_get(&ctx, "fadeOut");
        op(&ctx.sh, move |c| stop_response(c, &id, &fade, true)).await
    });
    route!(ctx, rest, Method::POST, [Param, Lit("toggle-pause")], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.toggle_pause_cue(&id);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                let status = field(&r, "status");
                http::json(
                    200,
                    &json!({
                        "success": true,
                        "status": status,
                        "message": format!("Cue {}", js_str(&status)),
                    }),
                )
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(
        ctx,
        rest,
        Method::POST,
        [Param, Lit("playlist"), Lit("jump")],
        |p| {
            let id = p[0].clone();
            if let Some(r) = require_uuid(&id) {
                return Some(r);
            }
            let index = body_get(&ctx, "index");
            op(&ctx.sh, move |c| {
                let r = c.cm.jump_to_playlist_item(&id, &index);
                if let Some(e) = thrown(&r) {
                    return http::fail(500, &e);
                }
                if jsv::truthy_opt(r.get("success")) {
                    http::json(200, &r)
                } else {
                    http::json(not_found_status(&field(&r, "error")), &r)
                }
            })
            .await
        }
    );
    route!(
        ctx,
        rest,
        Method::POST,
        [Param, Lit("playlist"), Lit("navigate")],
        |p| {
            let id = p[0].clone();
            if let Some(r) = require_uuid(&id) {
                return Some(r);
            }
            let direction = body_get(&ctx, "direction");
            op(&ctx.sh, move |c| {
                navigate_response(c, &id, &direction, true)
            })
            .await
        }
    );
    None
}

/// `String(value)` for a template literal (`undefined` reads "undefined").
fn js_str(v: &Value) -> String {
    if js::is_undefined(v) {
        "undefined".into()
    } else {
        jsv::to_js_string(v)
    }
}

fn stop_all_response(c: &mut super::Core, behavior: &Value) -> Response {
    let b = (!js::is_undefined(behavior)).then_some(behavior);
    let r = c.cm.stop_all_cues(b);
    if let Some(e) = thrown(&r) {
        return http::fail(500, &e);
    }
    if jsv::truthy_opt(r.get("success")) {
        let n = r
            .get("results")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        http::json(
            200,
            &json!({ "success": true, "stoppedCount": n, "message": format!("Stopped {n} cues") }),
        )
    } else {
        fail_v(400, field(&r, "error"))
    }
}

fn trigger_response(c: &mut super::Core, id: &str, options: &Value, uuid_route: bool) -> Response {
    let r = c.cm.trigger_cue(id, options);
    if let Some(e) = thrown(&r) {
        return http::fail(500, &e);
    }
    if jsv::truthy_opt(r.get("success")) {
        // `result.status ?? cueManager.getCue(id)?.status`
        let status = match r
            .get("status")
            .filter(|s| !s.is_null() && !js::is_undefined(s))
        {
            Some(s) => s.clone(),
            None => {
                c.cm.get_cue(id)
                    .map_or_else(js::undefined, |cue| field(&cue, "status"))
            }
        };
        http::json(
            200,
            &json!({ "success": true, "message": "Cue triggered successfully", "status": status }),
        )
    } else {
        let e = field(&r, "error");
        fail_v(
            if uuid_route {
                not_found_status(&e)
            } else {
                400
            },
            e,
        )
    }
}

fn stop_response(c: &mut super::Core, id: &str, fade: &Value, uuid_route: bool) -> Response {
    let r = c.cm.stop_cue(id, jsv::truthy(fade));
    if let Some(e) = thrown(&r) {
        return http::fail(500, &e);
    }
    if jsv::truthy_opt(r.get("success")) {
        http::json(
            200,
            &json!({ "success": true, "message": "Cue stopped successfully" }),
        )
    } else {
        let e = field(&r, "error");
        fail_v(
            if uuid_route {
                not_found_status(&e)
            } else {
                400
            },
            e,
        )
    }
}

fn navigate_response(
    c: &mut super::Core,
    id: &str,
    direction: &Value,
    uuid_route: bool,
) -> Response {
    let d = direction.as_str();
    if !matches!(d, Some("next" | "previous")) {
        return http::fail(400, "Direction must be \"next\" or \"previous\"");
    }
    let r = c.cm.navigate_playlist(id, direction);
    if let Some(e) = thrown(&r) {
        return http::fail(500, &e);
    }
    if jsv::truthy_opt(r.get("success")) {
        http::json(
            200,
            &json!({
                "success": true,
                "newIndex": field(&r, "newIndex"),
                "message": format!("Playlist navigated {}", d.unwrap_or("")),
            }),
        )
    } else {
        let e = field(&r, "error");
        fail_v(
            if uuid_route {
                not_found_status(&e)
            } else {
                400
            },
            e,
        )
    }
}

// --- /api/audio -----------------------------------------------------------------------------

fn file_status(error: &Value) -> u16 {
    if error.as_str() == Some("Audio file not found") {
        404
    } else {
        400
    }
}

async fn audio_routes(ctx: Ctx, rest: &[&str]) -> Routed {
    route!(ctx, rest, Method::GET, [], |p| {
        let (limit, offset) = http::pagination(&ctx.query);
        op(&ctx.sh, move |c| {
            let all = c.cm.afm.get_all_audio_files();
            let total = all.len();
            let slice: Vec<Value> = if limit > 0.0 {
                all.into_iter()
                    .skip(offset as usize)
                    .take(limit as usize)
                    .map(Value::Object)
                    .collect()
            } else {
                all.into_iter().map(Value::Object).collect()
            };
            http::json(
                200,
                &json!({
                    "success": true,
                    "audioFiles": slice,
                    "total": total,
                    "limit": if limit > 0.0 { jsv::num(limit) } else { Value::Null },
                    "offset": jsv::num(offset),
                }),
            )
        })
        .await
    });
    route!(
        ctx,
        rest,
        Method::GET,
        [Lit("stats"), Lit("overview")],
        |p| {
            op(&ctx.sh, |c| {
                let stats = c.cm.afm.get_audio_file_stats();
                http::json(200, &json!({ "success": true, "stats": stats }))
            })
            .await
        }
    );
    route!(ctx, rest, Method::GET, [Lit("output-devices")], |p| {
        // The engine lists RtAudio's devices; the interim engine has none (B4).
        http::json(200, &json!({ "success": true, "devices": [] }))
    });
    route!(ctx, rest, Method::GET, [Lit("search"), Param], |p| {
        let q = p[0].clone();
        op(&ctx.sh, move |c| {
            let results: Vec<Value> =
                c.cm.afm
                    .search_audio_files(&json!(q))
                    .into_iter()
                    .map(Value::Object)
                    .collect();
            http::json(
                200,
                &json!({ "success": true, "results": results, "query": q }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("serve"), Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        serve_audio(&ctx, id).await
    });
    route!(ctx, rest, Method::POST, [Lit("upload")], |p| {
        upload_audio(&ctx).await
    });
    route!(ctx, rest, Method::POST, [Param, Lit("replace")], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        replace_audio(&ctx, id).await
    });
    route!(ctx, rest, Method::POST, [Lit("import")], |p| {
        let file_path = body_get(&ctx, "filePath");
        if !jsv::truthy(&file_path) {
            return Some(http::fail(400, "File path is required"));
        }
        let options = json!({
            "name": body_get(&ctx, "name"),
            "subdirectory": body_get(&ctx, "subdirectory"),
            "tags": body_get(&ctx, "tags"),
        });
        op(&ctx.sh, move |c| {
            let fp = jsv::to_js_string(&file_path);
            let r = c.cm.afm.import_audio_file(&fp, &options);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(200, &ok_merge(vec![("audioFile", field(&r, "audioFile"))]))
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Lit("validate")], |p| {
        let file_path = body_get(&ctx, "filePath");
        if !jsv::truthy(&file_path) {
            return Some(http::fail(400, "File path is required"));
        }
        op(&ctx.sh, move |c| {
            let v = c.cm.afm.validate_audio_file(&jsv::to_js_string(&file_path));
            http::json(200, &json!({ "success": true, "validation": v }))
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            match c.cm.afm.load_audio_file_metadata(&json!(id)) {
                Some(f) => http::json(
                    200,
                    &json!({ "success": true, "audioFile": Value::Object(f) }),
                ),
                None => http::fail(404, "Audio file not found"),
            }
        })
        .await
    });
    route!(ctx, rest, Method::PUT, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        let updates = ctx.body.clone();
        op(&ctx.sh, move |c| {
            let r = c.cm.afm.update_audio_file_metadata(&json!(id), &updates);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(200, &ok_merge(vec![("audioFile", field(&r, "audioFile"))]))
            } else {
                let e = field(&r, "error");
                fail_v(file_status(&e), e)
            }
        })
        .await
    });
    route!(ctx, rest, Method::DELETE, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.afm.delete_audio_file(&json!(id));
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(200, &json!({ "success": true }))
            } else {
                let e = field(&r, "error");
                fail_v(file_status(&e), e)
            }
        })
        .await
    });
    None
}

fn mime_of(path: &str) -> &'static str {
    match nfs::extname(path).to_lowercase().as_str() {
        ".mp3" => "audio/mpeg",
        ".wav" => "audio/wav",
        ".m4a" => "audio/mp4",
        ".aac" => "audio/aac",
        ".ogg" => "audio/ogg",
        ".flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

/// `GET /api/audio/serve/:id` (`audio.js:175-264`): the file, with its exact-string ETag and
/// single-range support.
async fn serve_audio(ctx: &Ctx, id: String) -> Response {
    let record = op(&ctx.sh, move |c| {
        c.cm.afm.load_audio_file_metadata(&json!(id))
    })
    .await;
    let Some(record) = record else {
        return http::fail(404, "Audio file not found");
    };
    let path = record
        .get("path")
        .map(jsv::to_js_string)
        .unwrap_or_default();
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        return http::fail(404, "Audio file not found on disk");
    };
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .map(|t| jsv::system_time_ms(t).floor())
        .unwrap_or(0.0);
    let etag = format!("\"{size:x}-{:x}\"", mtime_ms as i64);
    let header_str = |k: header::HeaderName| {
        ctx.headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let base = |status: u16| {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
        r.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        if let Ok(v) = HeaderValue::from_str(&etag) {
            r.headers_mut().insert(header::ETAG, v);
        }
        r
    };
    if header_str(header::IF_NONE_MATCH).as_deref() == Some(etag.as_str()) {
        return base(304);
    }
    let unsatisfiable = |error: &str| {
        let mut r = http::fail(416, error);
        r.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        if let Ok(v) = HeaderValue::from_str(&etag) {
            r.headers_mut().insert(header::ETAG, v);
        }
        // The audio type was set before the range check; `res.json` keeps it and adds a charset.
        if let Ok(v) = HeaderValue::from_str(&format!("{}; charset=utf-8", mime_of(&path))) {
            r.headers_mut().insert(header::CONTENT_TYPE, v);
        }
        if let Ok(v) = HeaderValue::from_str(&format!("bytes */{size}")) {
            r.headers_mut().insert(header::CONTENT_RANGE, v);
        }
        r.headers_mut()
            .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        r
    };
    let (status, start, end) = match header_str(header::RANGE) {
        Some(range) => {
            // `/^bytes=(\d*)-(\d*)$/`
            let parsed = range.strip_prefix("bytes=").and_then(|r| {
                let (a, b) = r.split_once('-')?;
                (a.bytes().all(|c| c.is_ascii_digit()) && b.bytes().all(|c| c.is_ascii_digit()))
                    .then(|| (a.to_string(), b.to_string()))
            });
            let Some((a, b)) = parsed.filter(|(a, b)| !(a.is_empty() && b.is_empty())) else {
                return unsatisfiable("Invalid Range header");
            };
            let num = |s: &str| s.parse::<f64>().unwrap_or(f64::INFINITY);
            let fsize = size as f64;
            let (start, end) = if a.is_empty() {
                ((fsize - num(&b)).max(0.0), fsize - 1.0)
            } else {
                let start = num(&a);
                (start, if b.is_empty() { fsize - 1.0 } else { num(&b) })
            };
            if start > end || start >= fsize {
                return unsatisfiable("Range not satisfiable");
            }
            (206, start as u64, end.min(fsize - 1.0) as u64)
        }
        None => (200, 0, size.saturating_sub(1)),
    };
    let Ok(mut file) = tokio::fs::File::open(&path).await else {
        return http::fail(500, "Failed to read audio file");
    };
    let len = if size == 0 { 0 } else { end - start + 1 };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return http::fail(500, "Failed to read audio file");
    }
    let stream = tokio_util::io::ReaderStream::new(file.take(len));
    let mut r = base(status);
    *r.body_mut() = Body::from_stream(stream);
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(mime_of(&path)),
    );
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if status == 206
        && let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{size}"))
    {
        h.insert(header::CONTENT_RANGE, v);
    }
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    r
}

/// `getMaxUploadBytes(req)`: `maxAudioFileSize || 100 MiB`, read per request.
async fn max_upload_bytes(sh: &Arc<Shared>) -> (u64, Value) {
    op(sh, |c| {
        let cfg = c.config.get_config();
        let v = jsv::or(cfg.get("maxAudioFileSize"), json!(100 * 1024 * 1024));
        let n = jsv::to_number(&v);
        let bytes = if n.is_finite() && n >= 0.0 {
            n as u64
        } else {
            u64::MAX
        };
        (bytes, v)
    })
    .await
}

/// `handleMulterError`.
fn multer_error(e: UploadError, max: &Value) -> Response {
    match e {
        UploadError::TooLarge => http::fail(
            413,
            &format!(
                "File too large. Maximum size is {} bytes",
                jsv::to_js_string(max)
            ),
        ),
        UploadError::Other(m) => http::fail(400, &m),
    }
}

/// `parseTags(req.body.tags)`.
fn parse_tags(raw: Option<&Value>) -> Result<Value, String> {
    let Some(raw) = raw.filter(|v| jsv::truthy(v)) else {
        return Ok(json!([]));
    };
    if raw.is_array() {
        return Ok(raw.clone());
    }
    match jsv::parse_str(&jsv::to_js_string(raw)) {
        Ok(v @ Value::Array(_)) => Ok(v),
        Ok(_) => Ok(json!([])),
        Err(_) => Err("Invalid tags: must be a JSON array".into()),
    }
}

fn take_stream(ctx: &Ctx) -> Option<Body> {
    ctx.stream.lock().ok().and_then(|mut s| s.take())
}

async fn receive_audio(ctx: &Ctx) -> Result<upload::Received, Box<Response>> {
    let (max, max_v) = max_upload_bytes(&ctx.sh).await;
    let Some(body) = take_stream(ctx) else {
        return Ok(upload::Received {
            file: None,
            fields: Map::new(),
        });
    };
    let rules = Rules {
        field: "audioFile",
        upload_dir: nfs::join2(&ctx.sh.pm.temp_dir, "uploads"),
        max_bytes: max,
        allowed: Some(&SUPPORTED_FORMATS),
        fixed_ext: None,
    };
    upload::receive(&ctx.headers, body, &rules)
        .await
        .map_err(|e| Box::new(multer_error(e, &max_v)))
}

async fn upload_audio(ctx: &Ctx) -> Response {
    let received = match receive_audio(ctx).await {
        Ok(r) => r,
        Err(r) => return *r,
    };
    let Some(file) = received.file else {
        return http::fail(400, "No file uploaded");
    };
    let tags = match parse_tags(received.fields.get("tags")) {
        Ok(t) => t,
        Err(e) => {
            let _ = tokio::fs::remove_file(&file.path).await;
            return http::fail(400, &e);
        }
    };
    let name = received
        .fields
        .get("name")
        .filter(|v| jsv::truthy(v))
        .cloned()
        .unwrap_or_else(js::undefined);
    op(&ctx.sh, move |c| {
        let r = c.cm.afm.add_file(
            &file.path,
            Some(&file.original_name),
            &json!({ "name": name, "tags": tags }),
        );
        if let Some(e) = thrown(&r) {
            let _ = nfs::remove(&file.path);
            return http::fail(500, &e);
        }
        if jsv::truthy_opt(r.get("success")) {
            http::json(
                200,
                &ok_merge(vec![
                    ("audioFile", field(&r, "audioFile")),
                    ("reused", field(&r, "reused")),
                    ("renamed", field(&r, "renamed")),
                ]),
            )
        } else {
            let _ = nfs::remove(&file.path);
            fail_v(400, field(&r, "error"))
        }
    })
    .await
}

async fn replace_audio(ctx: &Ctx, id: String) -> Response {
    let received = match receive_audio(ctx).await {
        Ok(r) => r,
        Err(r) => return *r,
    };
    let Some(file) = received.file else {
        return http::fail(400, "No file uploaded");
    };
    op(&ctx.sh, move |c| {
        let r =
            c.cm.afm
                .replace_file(&json!(id), &file.path, Some(&file.original_name));
        if let Some(e) = thrown(&r) {
            let _ = nfs::remove(&file.path);
            return http::fail(500, &e);
        }
        if !jsv::truthy_opt(r.get("success")) {
            let e = field(&r, "error");
            return fail_v(file_status(&e), e);
        }
        let af = field(&r, "audioFile");
        let refs = c.cm.handle_audio_file_replaced(&af, &field(&r, "previous"));
        if let Some(e) = thrown(&refs) {
            let _ = nfs::remove(&file.path);
            return http::fail(500, &e);
        }
        http::json(
            200,
            &ok_merge(vec![
                ("audioFile", af),
                ("cuesUpdated", field(&refs, "cuesUpdated")),
                ("projectsUpdated", field(&refs, "projectsUpdated")),
            ]),
        )
    })
    .await
}

// --- /api/workspaces ------------------------------------------------------------------------

async fn workspace_routes(ctx: Ctx, rest: &[&str]) -> Routed {
    route!(ctx, rest, Method::GET, [], |p| {
        let include = ctx.query.get("includeCues").and_then(Value::as_str) == Some("true");
        let (limit, offset) = http::pagination(&ctx.query);
        op(&ctx.sh, move |c| {
            let all = c.cm.cdm.get_all_workspaces(include);
            let total = all.len();
            let slice: Vec<Value> = if limit > 0.0 {
                all.into_iter()
                    .skip(offset as usize)
                    .take(limit as usize)
                    .collect()
            } else {
                all
            };
            http::json(
                200,
                &json!({
                    "success": true,
                    "workspaces": slice,
                    "total": total,
                    "limit": if limit > 0.0 { jsv::num(limit) } else { Value::Null },
                    "offset": jsv::num(offset),
                }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("current")], |p| {
        op(&ctx.sh, |c| {
            http::json(
                200,
                &json!({ "success": true, "workspace": c.cm.get_current_workspace() }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::POST, [], |p| {
        let name = body_get(&ctx, "name");
        op(&ctx.sh, move |c| {
            let r = c.cm.new_project(&name);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if !jsv::truthy_opt(r.get("success")) {
                return fail_v(400, field(&r, "error"));
            }
            http::json(
                201,
                &json!({ "success": true, "workspace": c.cm.get_current_workspace() }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Param, Lit("load")], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.open_project(&json!(id));
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(
                    200,
                    &json!({
                        "success": true,
                        "workspace": field(&r, "workspace"),
                        "message": "Workspace loaded successfully",
                    }),
                )
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Lit("save")], |p| {
        let name = body_get(&ctx, "name");
        let description = body_get(&ctx, "description");
        op(&ctx.sh, move |c| {
            // `saveWorkspace(name, description)`: a missing one is `undefined` → its default `null`.
            let n = (!js::is_undefined(&name)).then_some(&name);
            let d = (!js::is_undefined(&description)).then_some(&description);
            let r = c.cm.cdm.save_workspace(n, d);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(
                    200,
                    &json!({
                        "success": true,
                        "workspace": field(&r, "workspace"),
                        "message": "Workspace saved successfully",
                    }),
                )
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::PUT, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        let updates = ctx.body.clone();
        op(&ctx.sh, move |c| {
            match c.cm.cdm.update_workspace_by_id(&json!(id), &updates) {
                Err(e) => http::fail(500, &e),
                Ok(r) => {
                    if jsv::truthy_opt(r.get("success")) {
                        http::json(
                            200,
                            &json!({
                                "success": true,
                                "workspace": field(&r, "workspace"),
                                "message": "Workspace updated successfully",
                            }),
                        )
                    } else {
                        let e = field(&r, "error");
                        let status = if e.as_str() == Some("Workspace not found") {
                            404
                        } else {
                            400
                        };
                        fail_v(status, e)
                    }
                }
            }
        })
        .await
    });
    route!(ctx, rest, Method::DELETE, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.cdm.delete_workspace(&json!(id));
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(
                    200,
                    &json!({ "success": true, "message": "Workspace deleted successfully" }),
                )
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Param, Lit("export")], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        // `const { includeAudioFiles = false } = req.body`
        let include = match body_get(&ctx, "includeAudioFiles") {
            v if js::is_undefined(&v) => json!(false),
            v => v,
        };
        op(&ctx.sh, move |c| {
            let timestamp = jsv::iso_now().replace([':', '.'], "-");
            let export_path = nfs::join2(
                &c.pm.cues_dir,
                &format!("workspace_export_{id}_{timestamp}.json"),
            );
            let r =
                c.cm.cdm
                    .export_workspace(&json!(id), &export_path, &include, Some(&mut c.cm.afm));
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(
                    200,
                    &json!({
                        "success": true,
                        "exportPath": field(&r, "exportPath"),
                        "message": "Workspace exported successfully",
                    }),
                )
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Lit("import")], |p| {
        let import_path = body_get(&ctx, "importPath");
        if !jsv::truthy(&import_path) {
            return Some(http::fail(400, "Import path is required"));
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.cdm.import_workspace(&jsv::to_js_string(&import_path));
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(
                    200,
                    &json!({
                        "success": true,
                        "workspace": field(&r, "workspace"),
                        "message": "Workspace imported successfully",
                    }),
                )
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.cdm.read_workspace(&json!(id));
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(
                    200,
                    &json!({ "success": true, "workspace": field(&r, "workspace") }),
                )
            } else {
                fail_v(404, field(&r, "error"))
            }
        })
        .await
    });
    None
}

// --- /api/projects --------------------------------------------------------------------------

/// "My Show: Act 1" -> a safe-ish ASCII fallback plus the real name (RFC 5987).
fn content_disposition(name: &Value) -> String {
    let raw = if jsv::truthy(name) {
        jsv::to_js_string(name)
    } else {
        "Project".into()
    };
    let replaced: String = raw
        .chars()
        .map(|c| {
            if (c as u32) < 0x20 || c == '\u{7f}' || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = replaced.trim_matches(jsv::is_js_space);
    let base = if trimmed.is_empty() {
        "Project"
    } else {
        trimmed
    };
    // `replace(/[^\x20-\x7e]/g, '_')` works on UTF-16 units: an astral character is two.
    let ascii: String = base
        .chars()
        .flat_map(|c| {
            if (' '..='~').contains(&c) {
                vec![c]
            } else {
                vec!['_'; c.len_utf16()]
            }
        })
        .collect();
    let encoded: String =
        percent_encoding::utf8_percent_encode(&format!("{base}.zip"), &ENCODE_URI_COMPONENT)
            .to_string();
    format!("attachment; filename=\"{ascii}.zip\"; filename*=UTF-8''{encoded}")
}

/// What `encodeURIComponent` leaves alone: `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
const ENCODE_URI_COMPONENT: percent_encoding::AsciiSet = percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn not_found_re(error: &Value) -> bool {
    jsv::to_js_string(error)
        .to_lowercase()
        .contains("not found")
}

async fn project_routes(ctx: Ctx, rest: &[&str]) -> Routed {
    route!(ctx, rest, Method::GET, [], |p| {
        op(&ctx.sh, |c| {
            let r = c.cm.list_projects();
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            http::json(200, &json!({ "success": true, "projects": r }))
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("current")], |p| {
        op(&ctx.sh, |c| {
            let project = c.cm.get_current_project();
            if !jsv::truthy(&project) {
                return http::fail(404, "No project is open");
            }
            http::json(200, &json!({ "success": true, "project": project }))
        })
        .await
    });
    route!(ctx, rest, Method::PUT, [Lit("current")], |p| {
        let name = body_get(&ctx, "name");
        op(&ctx.sh, move |c| {
            let r = c.cm.rename_project(&name);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            http::json(
                if jsv::truthy_opt(r.get("success")) {
                    200
                } else {
                    400
                },
                &r,
            )
        })
        .await
    });
    route!(ctx, rest, Method::POST, [], |p| {
        let name = body_get(&ctx, "name");
        op(&ctx.sh, move |c| {
            let r = c.cm.new_project(&name);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if !jsv::truthy_opt(r.get("success")) {
                return http::json(400, &r);
            }
            http::json(
                201,
                &json!({ "success": true, "project": c.cm.get_current_project() }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Lit("import")], |p| {
        import_bundle(&ctx).await
    });
    route!(ctx, rest, Method::GET, [Param, Lit("bundle")], |p| {
        download_bundle(&ctx, p[0].clone()).await
    });
    route!(ctx, rest, Method::POST, [Param, Lit("open")], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.open_project(&json!(id));
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if !jsv::truthy_opt(r.get("success")) {
                let status = if not_found_re(&field(&r, "error")) {
                    404
                } else {
                    400
                };
                return http::json(status, &r);
            }
            http::json(
                200,
                &json!({ "success": true, "project": c.cm.get_current_project() }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::DELETE, [Param], |p| {
        let id = p[0].clone();
        if let Some(r) = require_uuid(&id) {
            return Some(r);
        }
        op(&ctx.sh, move |c| {
            let r = c.cm.delete_project(&json!(id));
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if !jsv::truthy_opt(r.get("success")) {
                let status = if not_found_re(&field(&r, "error")) {
                    404
                } else {
                    409
                };
                return http::json(status, &r);
            }
            http::json(200, &json!({ "success": true }))
        })
        .await
    });
    None
}

/// `POST /api/projects/import` (`projects.js:78-121`): temp files removed before answering.
async fn import_bundle(ctx: &Ctx) -> Response {
    let upload_dir = nfs::join2(&ctx.sh.pm.temp_dir, "uploads");
    let received = match take_stream(ctx) {
        None => Ok(upload::Received {
            file: None,
            fields: Map::new(),
        }),
        Some(body) => {
            let rules = Rules {
                field: "bundle",
                upload_dir,
                max_bytes: MAX_BUNDLE_BYTES,
                allowed: None,
                fixed_ext: Some(".zip"),
            };
            upload::receive(&ctx.headers, body, &rules).await
        }
    };
    let received = match received {
        Ok(r) => r,
        Err(UploadError::TooLarge) => return http::fail(413, "File too large"),
        Err(UploadError::Other(m)) => return http::fail(400, &m),
    };
    let extract_dir = nfs::join(&[&ctx.sh.pm.temp_dir, "imports", &jsv::random_uuid()]);
    let file = received.file;
    op(&ctx.sh, move |c| {
        let (status, body) = match &file {
            None => (
                400,
                json!({ "success": false, "error": "No bundle uploaded" }),
            ),
            Some(f) => match bundle::read_bundle(&f.path, &extract_dir) {
                Err(e) => (400, json!({ "success": false, "error": e })),
                Ok(b) => {
                    let audio: Vec<(String, String)> = b
                        .get("audio")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .map(|x| {
                                    (
                                        x.get("path").map(jsv::to_js_string).unwrap_or_default(),
                                        x.get("name").map(jsv::to_js_string).unwrap_or_default(),
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let r = c.cm.import_project(&field(&b, "project"), &audio);
                    if let Some(e) = thrown(&r) {
                        (500, json!({ "success": false, "error": e }))
                    } else if jsv::truthy_opt(r.get("success")) {
                        (
                            201,
                            json!({
                                "success": true,
                                "project": field(&r, "project"),
                                "audio": field(&r, "audio"),
                                "missingAudio": field(&b, "missingAudio"),
                            }),
                        )
                    } else {
                        (400, r)
                    }
                }
            },
        };
        if let Some(f) = &file {
            let _ = nfs::remove(&f.path);
        }
        let _ = nfs::remove(&extract_dir);
        http::json(status, &body)
    })
    .await
}

/// `GET /api/projects/:id/bundle`: the zip is written to a temp file (the core's writer needs to
/// seek) and streamed from there; the file is removed once sent.
async fn download_bundle(ctx: &Ctx, id: String) -> Response {
    let tmp = nfs::join(&[
        &ctx.sh.pm.temp_dir,
        "exports",
        &format!("{}.zip", jsv::random_uuid()),
    ]);
    let tmp2 = tmp.clone();
    let made = op(&ctx.sh, move |c| {
        c.cm.flush_persist_workspace();
        let id = if id == "current" {
            c.cm.get_current_workspace().get("id").cloned()
        } else {
            Some(json!(id))
        };
        let read = match id {
            Some(id) if jsv::truthy(&id) => c.cm.cdm.read_workspace(&id),
            _ => json!({ "success": false, "error": "No project is open" }),
        };
        if !jsv::truthy_opt(read.get("success")) {
            let error = jsv::or(read.get("error"), json!("Project not found"));
            return Err(Box::new(http::json(
                404,
                &json!({ "success": false, "error": error }),
            )));
        }
        let ws = read
            .get("workspace")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let name = field(&Value::Object(ws.clone()), "name");
        let project = c.cm.cdm.with_hidden_cues(&ws);
        let _ = nfs::ensure_dir(&nfs::dirname(&tmp2));
        let afm = &mut c.cm.afm;
        let mut resolve = |r: &Obj| -> Option<Obj> {
            if let Some(id) = r.get("audioFileId").filter(|v| jsv::truthy(v))
                && let Some(f) = afm.load_audio_file_metadata(id)
            {
                return Some(f);
            }
            r.get("relativePath")
                .filter(|v| jsv::truthy(v))
                .and_then(Value::as_str)
                .and_then(|p| afm.get_audio_file_by_path(p))
        };
        match bundle::write_bundle(&project, &tmp2, &mut resolve) {
            Ok(_) => Ok(name),
            Err(e) => {
                let _ = nfs::remove(&tmp2);
                Err(Box::new(http::fail(500, &e.to_string())))
            }
        }
    })
    .await;
    let name = match made {
        Ok(n) => n,
        Err(r) => return *r,
    };
    let Ok(file) = tokio::fs::File::open(&tmp).await else {
        return http::fail(500, "Failed to read the bundle");
    };
    // Unix lets the open file outlive its name; the bytes are still streamed.
    #[cfg(unix)]
    let _ = std::fs::remove_file(&tmp);
    let stream = tokio_util::io::ReaderStream::new(file);
    #[cfg(not(unix))]
    let stream = {
        use futures_util::StreamExt;
        let tmp = tmp.clone();
        stream.chain(futures_util::stream::once(async move {
            let _ = tokio::fs::remove_file(&tmp).await;
            Ok::<_, std::io::Error>(axum::body::Bytes::new())
        }))
    };
    let mut r = Response::new(Body::from_stream(stream));
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    if let Ok(v) = HeaderValue::from_str(&content_disposition(&name)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    r
}

// --- /api/remote ----------------------------------------------------------------------------

fn or_default(cue: &Value, key: &str, default: Value) -> Value {
    jsv::or(cue.get(key), default)
}

async fn remote_routes(ctx: Ctx, rest: &[&str]) -> Routed {
    route!(ctx, rest, Method::GET, [Lit("cues")], |p| {
        op(&ctx.sh, |c| {
            let cues: Vec<Value> = c
                .cm
                .get_cues()
                .iter()
                .map(|cue| {
                    let volume = match cue.get("volume") {
                        Some(v @ Value::Number(_)) => v.clone(),
                        _ => json!(1.0),
                    };
                    json!({
                        "id": field(cue, "id"),
                        "name": field(cue, "name"),
                        "type": field(cue, "type"),
                        "status": or_default(cue, "status", json!("stopped")),
                        "currentTime": or_default(cue, "currentTime", json!(0)),
                        "totalTime": or_default(cue, "totalTime", json!(0)),
                        "volume": volume,
                        "fadeInTime": or_default(cue, "fadeInTime", json!(0)),
                        "fadeOutTime": or_default(cue, "fadeOutTime", json!(0)),
                        "loop": or_default(cue, "loop", json!(false)),
                        "retriggerBehavior": or_default(cue, "retriggerBehavior", json!("restart")),
                        "currentPlaylistIndex": or_default(cue, "currentPlaylistIndex", json!(0)),
                        "playlistItems": or_default(cue, "playlistItems", json!([])),
                        "shufflePlaylist": or_default(cue, "shufflePlaylist", json!(false)),
                        "repeatOnePlaylistItem": or_default(cue, "repeatOnePlaylistItem", json!(false)),
                        "playlistPlayMode": or_default(cue, "playlistPlayMode", json!("continue")),
                    })
                })
                .collect();
            http::json(200, &json!({ "success": true, "cues": cues }))
        })
        .await
    });
    route!(
        ctx,
        rest,
        Method::POST,
        [Lit("cues"), Param, Lit("trigger")],
        |p| {
            let id = p[0].clone();
            // `{ source: 'remote_http', ...req.body }`
            let mut options = Obj::new();
            options.insert("source".into(), json!("remote_http"));
            jsv::spread(&mut options, &ctx.body);
            let options = Value::Object(options);
            op(&ctx.sh, move |c| trigger_response(c, &id, &options, false)).await
        }
    );
    route!(
        ctx,
        rest,
        Method::POST,
        [Lit("cues"), Param, Lit("stop")],
        |p| {
            let id = p[0].clone();
            let fade = body_get(&ctx, "fadeOut");
            op(&ctx.sh, move |c| stop_response(c, &id, &fade, false)).await
        }
    );
    route!(
        ctx,
        rest,
        Method::POST,
        [Lit("cues"), Lit("stop-all")],
        |p| {
            let behavior = body_get(&ctx, "behavior");
            op(&ctx.sh, move |c| stop_all_response(c, &behavior)).await
        }
    );
    route!(
        ctx,
        rest,
        Method::POST,
        [Lit("cues"), Param, Lit("playlist"), Lit("navigate")],
        |p| {
            let id = p[0].clone();
            let direction = body_get(&ctx, "direction");
            op(&ctx.sh, move |c| {
                navigate_response(c, &id, &direction, false)
            })
            .await
        }
    );
    route!(ctx, rest, Method::GET, [Lit("master-volume")], |p| {
        op(&ctx.sh, |c| {
            http::json(
                200,
                &json!({ "success": true, "volume": jsv::num(c.cm.get_master_volume()) }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Lit("master-volume")], |p| {
        let volume = body_get(&ctx, "volume");
        op(&ctx.sh, move |c| {
            let r = c.cm.set_master_volume(&volume);
            if let Some(e) = thrown(&r) {
                return http::fail(500, &e);
            }
            if jsv::truthy_opt(r.get("success")) {
                http::json(
                    200,
                    &json!({ "success": true, "volume": field(&r, "volume") }),
                )
            } else {
                fail_v(400, field(&r, "error"))
            }
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("crossfade")], |p| {
        op(&ctx.sh, |c| {
            http::json(
                200,
                &json!({ "success": true, "enabled": c.cm.get_crossfade_mode() }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::POST, [Lit("crossfade")], |p| {
        let enabled = body_get(&ctx, "enabled");
        if !enabled.is_boolean() {
            return Some(http::fail(400, "enabled must be true or false"));
        }
        op(&ctx.sh, move |c| {
            http::json(200, &c.cm.set_crossfade_mode(&enabled))
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("status")], |p| {
        op(&ctx.sh, |c| {
            http::json(
                200,
                &json!({ "success": true, "status": c.cm.get_playback_status() }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("info")], |p| {
        op(&ctx.sh, |c| {
            let config = c.config.get_config();
            let port = c.config.get_listening_port();
            http::json(
                200,
                &json!({
                    "success": true,
                    "info": {
                        "name": "acCompaniment",
                        "version": "0.3.0",
                        "httpPort": port,
                        "websocketPort": port,
                        "networkInterfaces": net::interfaces(&port),
                        "features": {
                            "httpRemote": true,
                            "websocket": config.get("websocketEnabled").cloned().unwrap_or_else(js::undefined),
                            "audioFormats": config.get("supportedAudioFormats").cloned().unwrap_or_else(js::undefined),
                        }
                    }
                }),
            )
        })
        .await
    });
    route!(ctx, rest, Method::GET, [Lit("health")], |p| {
        let clients = ctx.sh.hub.len();
        op(&ctx.sh, move |c| {
            let status = c.cm.get_playback_status();
            let timestamp = jsv::iso_now();
            http::json(
                200,
                &json!({
                    "status": "ok",
                    "timestamp": timestamp,
                    "success": true,
                    "health": {
                        "status": "healthy",
                        "timestamp": timestamp,
                        "playback": {
                            "totalPlaying": field(&status, "totalPlaying"),
                            "playingCues": field(&status, "playingCues"),
                        },
                        "websocket": { "connectedClients": clients },
                    }
                }),
            )
        })
        .await
    });
    None
}
