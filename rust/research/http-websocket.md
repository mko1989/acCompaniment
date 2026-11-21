# Research: HTTP + WebSocket front door (Express 5 / ws → axum)

Scope: what the Node server answers on the wire, and how to make an axum server answer the same
(ADR-004 Companion wire compatibility, ADR-005 same routes/status/JSON values, error text free).
Spotify (`routes/spotify.js`, `src/backend/spotify/`) is ignored (ADR-003).

Versions read (installed, `node_modules/*/package.json`): express 5.2.1, router 2.2.0,
path-to-regexp 8.4.2, body-parser 2.3.0, serve-static 2.2.0, send 1.2.0, finalhandler 2.1.0,
cors 2.8.6, multer 2.4.0 (busboy 1.6.0), ws 8.22.0. Rust crates read from their published crate
source (crates.io download = the docs.rs "source" view, `https://docs.rs/crate/<name>/<ver>/source/<path>`):
axum 0.8.9, axum-core 0.5.6, tower-http 0.7.1, tungstenite/tokio-tungstenite 0.29.0 (what axum
0.8.9 depends on), multer 3.1.0, mime_guess 2.0.5, serde_json 1.0.154.
Line numbers are against the working tree of 2026-11-21 with the Spotify removal (ADR-003)
applied; re-verify before quoting. Claims marked **(probed)** were also checked by running a minimal Express app with the exact
`server.js` middleware stack (scratch script, not committed).

## 1. The original

### 1.1 Middleware stack (`server.js:55-109`)
In order, for every non-upgrade request:
1. `cors({origin:true, credentials:true})` (`server.js:57`).
2. `express.json({limit:'50mb'})`, `express.urlencoded({extended:true, limit:'50mb'})` (`server.js:63-64`).
3. `req.body ??= {}` shim (`server.js:74-79`), because body-parser 2 leaves `req.body` undefined
   when the request has no body or a non-matching type (`body-parser/lib/read.js:46-63`).
4. `express.static(src/frontend)` with defaults (`server.js:82`).
5. `GET /` → `sendFile(index.html)` (`server.js:85`, unreachable in practice: static serves `/` first);
   `GET /remote` → `sendFile(remote_control/remote.html)` (`server.js:91`).
6. Routers mounted at `/api/config|cues|audio|workspaces|projects|remote` (`server.js:103-108`).
7. Nothing else: unmatched → finalhandler 404, thrown/`next(err)` → finalhandler error page.

The WebSocket server shares the HTTP server (`server.js:34`, `new WebSocket.Server({server})`, no
`path`, no `verifyClient`) - upgrades never pass through Express (no CORS, no body parsing).

### 1.2 Express 5 behaviors the routes rely on
| Behavior | Original | Source |
|---|---|---|
| Route match is case-insensitive, trailing slash optional | `caseSensitive`/`strict` default off; path-to-regexp gets `trailing: !strict` | `express/lib/application.js:75-76`, `router/lib/layer.js:87-90`; probed: `POST /API/Cues/Stop-All/` → 200 |
| `:id` param | one non-empty segment, `decodeURIComponent`-decoded; bad `%` → 400 HTML "Failed to decode param" | `router/lib/layer.js:219-229`; probed |
| Method mismatch | no 405: falls through to later routes, finally 404 | probed: `GET /api/cues/stop-all` → `GET /:id` → 400 `Invalid id: must be a UUID` |
| HEAD | answered by GET routes (body dropped) | `router/lib/route.js:64,111`; probed |
| Unmatched | 404 `text/html; charset=utf-8`, body `<pre>Cannot GET /path</pre>`, plus `Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options: nosniff` | `finalhandler/index.js:106-107,244-275`; probed |
| Errors reaching finalhandler | HTML page; body is `err.stack` unless `NODE_ENV=production` (never set at runtime: `electron-launcher/main.js:345-356`) | `finalhandler/index.js:157-170` |
| Async handler rejection → 500 | Express 5 forwards rejected promises to finalhandler (HTML 500) - but every route here wraps its body in try/catch and answers `500 {success:false,error}` itself | probed `POST` throwing handler → 500 HTML |
| `res.json` | `Content-Type: application/json; charset=utf-8`; weak ETag `W/"len-sha1"`; `304` if `If-None-Match` matches on GET/HEAD; `undefined` members dropped; `NaN`/`Infinity` → `null` | `express/lib/application.js:95`, `express/lib/response.js:168-202`; probed |
| `X-Powered-By: Express` | on every response | `express/lib/application.js:94,160` |
| Query parser | `simple` (node `querystring`): repeated key → array | `express/lib/application.js:97` |

Body parsing (`body-parser` 2.3.0):
- JSON only for `Content-Type: application/json` (type-is; `+json` types are *not* parsed - they
  fall through to the shim and become `{}`). `text/plain` etc. → `{}` (probed).
- No body (`Content-Length: 0`, no `Transfer-Encoding`) → skipped → `{}` (`read.js:51`). Empty
  chunked body → `{}` (`json.js:77-80`).
- `strict`: top level must start with `{` or `[`, else 400 (`json.js:84-86`; probed `"str"` → 400 HTML).
  Malformed JSON → 400 HTML (probed). Whitespace-only body → 400 (firstchar fails).
- Charset other than `utf-*` → 415; `Content-Encoding` gzip/deflate/br inflated, other → 415
  (`read.js:68-75,185-230`). Over 50 MB → 413 HTML.
- urlencoded `extended`: `qs` with depth 32, parameterLimit 1000 (→ 413), `a[b]=1` → `{a:{b:'1'}}`
  (`urlencoded.js:63-111`; probed). No client sends urlencoded.

### 1.3 CORS (`cors` 2.8.6, `cors/lib/index.js`)
- Non-OPTIONS: `Access-Control-Allow-Origin: <request Origin>` (reflected; omitted when the request
  has no `Origin` - falsy values are skipped, `:36-71,144-155`), `Vary: Origin`,
  `Access-Control-Allow-Credentials: true` (always, `:84-91`). No expose-headers.
- **Every** `OPTIONS` (preflight or not, any path) is answered by cors itself: `204`,
  `Content-Length: 0`, ACAO (reflected), ACAC `true`, `Access-Control-Allow-Methods:
  GET,HEAD,PUT,PATCH,POST,DELETE`, `Access-Control-Allow-Headers: <Access-Control-Request-Headers>`
  when sent, `Vary: Origin, Access-Control-Request-Headers`; no Max-Age (`:10-12,94-115,159-182`;
  probed both with and without preflight headers).

### 1.4 Static files (`express.static`, serve-static 2.2.0 / send 1.2.0)
- GET/HEAD only; other methods fall through (`serve-static/index.js:72-77`) → 404 HTML.
- `index.html` for `/`; directory without slash → `301 Location: /dir/` (`serve-static/index.js:182-200`;
  probed `/ui` → 301 → `/ui/` → 404 since only `/` has an index.html).
- Dotfiles `ignore` → 404 (`send/index.js:114-116,458-470`); `..` in path → 403 (`send/index.js:431-446`).
- Headers: `Accept-Ranges: bytes`, `Cache-Control: public, max-age=0`, `Last-Modified`,
  weak `ETag: W/"<size hex>-<mtime ms hex>"` (`send/index.js:741-766`, `etag/index.js:70-130`);
  `Content-Type` from mime-types 3.0.1 *with charset* for text (`text/javascript; charset=utf-8`,
  `text/html; charset=utf-8`, `text/css; charset=utf-8`, `image/vnd.microsoft.icon` for .ico)
  (`send/index.js:715-725`; probed). Range → 206/416; If-None-Match/If-Modified-Since → 304;
  If-Match/If-Unmodified-Since → 412 (`send/index.js:514-560`).
- `src/frontend` holds .js/.css/.html/.ico/.png/.svg only; dirs `ui audio styles assets vendor remote_control`.

### 1.5 Routes
All JSON bodies are `{success:boolean, ...}`; errors are `{success:false, error:string}` (+`details`
where noted). "uuid" = `requireUuid('id')` (`utils/idValidation.js:1,14-23`: RFC-4122 v1-5 regex,
case-insensitive) → `400 {success:false,error:"Invalid id: must be a UUID"}` before any body use.
Every handler catches → `500 {success:false,error:e.message}` unless noted.

`/api/config` (`routes/config.js`)
| Method path | Line | Body / query | Success | Errors |
|---|---|---|---|---|
| GET / | 15 | | 200 `{config}` | |
| PUT / | 34 | partial config | 200 `{config}`; broadcasts `config-updated` (`:11`) | 400 `{error,details}` invalid; 500 save failed |
| POST /reset | 74 | | 200 `{config}`; broadcast | |
| GET /network | 95 | | 200 `{interfaces}` | |
| GET /path | 114 | | 200 `{path}` | |

`/api/cues` (`routes/cues.js`; `notFoundStatus`: `"Cue not found"`→404 else 400, `:5-7`)
| Method path | Line | Body | Success | Errors |
|---|---|---|---|---|
| GET / | 10 | | `{cues}` | |
| POST /stop-all | 29 | `{behavior?}` | `{stoppedCount,message}` | 400 |
| POST /reorder | 58 | `{cueIds}` | manager result | 400 manager result |
| GET /status/playback | 74 | | `{status}` | |
| GET /:id uuid | 93 | | `{cue}` | 404 |
| POST / | 119 | cue | **201** `{cue}` | 400 |
| PUT /:id uuid | 147 | updates | `{cue}` | 404/400 |
| DELETE /:id uuid | 175 | | `{success}` | 404/400 |
| POST /:id/trigger uuid | 198 | options | `{message,status}` | 404/400 |
| POST /:id/stop uuid | 229 | `{fadeOut?}` | `{message}` | 404/400 |
| POST /:id/toggle-pause uuid | 257 | | `{status,message}` | 400 (never 404) |
| POST /:id/playlist/jump uuid | 285 | `{index}` | manager result | 404/400 manager result (no console log) |
| POST /:id/playlist/navigate uuid | 296 | `{direction}` next/previous | `{newIndex,message}` | 400 bad direction; 404/400 |

`/api/audio` (`routes/audio.js`)
| Method path | Line | Notes | Success | Errors |
|---|---|---|---|---|
| GET / | 108 | `?limit` (clamped 0..500, 0=all) `&offset` (`:99-103`) | `{audioFiles,total,limit\|null,offset}` | |
| GET /stats/overview | 132 | | `{stats}` | |
| GET /output-devices | 145 | | `{devices}` | |
| GET /search/:query | 158 | decoded param, `req.query` passed but unused | `{results,query}` | |
| GET /serve/:id uuid | 175 | streams file, see below | 200/206/304 | 404 JSON (2 messages), 416 JSON + `Content-Range: bytes */N` |
| POST /upload | 266 | multipart `audioFile` + `name?`, `tags?` (JSON array string or repeated field, `:88-97`) | `{audioFile,reused,renamed}` | 400 no file / bad tags / unsupported / multer; 413; 400 manager error |
| POST /:id/replace uuid | 312 | multipart `audioFile` | `{audioFile,cuesUpdated,projectsUpdated}` | 404 "Audio file not found"; 400 |
| POST /import | 337 | `{filePath,name?,subdirectory?,tags?}` | `{audioFile}` | 400 |
| POST /validate | 359 | `{filePath}` | `{validation}` | 400 |
| GET, PUT, DELETE /:id uuid | 379/395/412 | | `{audioFile}` / `{audioFile}` / `{success}` | 404 "Audio file not found" else 400 |

`/serve/:id` details (`audio.js:184-255`): `Cache-Control: no-cache`; strong
`ETag: "<size hex>-<floor(mtimeMs) hex>"`; `If-None-Match` compared by **exact string** → `304`
with empty body; `Content-Type` from its own table (mp3/wav/m4a/aac/ogg/flac else
`application/octet-stream`, no charset); `Accept-Ranges: bytes`; Range regex `^bytes=(\d*)-(\d*)$`
(single range only; multi-range → 416), suffix ranges, end clamped to size-1; 206 with
`Content-Range`/`Content-Length`. Read error mid-stream → socket destroyed.

`/api/workspaces` (`routes/workspaces.js`)
| Method path | Line | Body | Success | Errors |
|---|---|---|---|---|
| GET / | 7 | `?includeCues=true&limit&offset` | `{workspaces,total,limit\|null,offset}` | |
| GET /current | 36 | | `{workspace}` (may be null) | |
| POST / | 55 | `{name}` | **201** `{workspace}` | 400 |
| POST /:id/load uuid | 82 | | `{workspace,message}` | 400 |
| POST /save | 109 | `{name,description}` | `{workspace,message}` | 400 |
| PUT /:id uuid | 138 | updates | `{workspace,message}` | 404 "Workspace not found" else 400 |
| DELETE /:id uuid | 167 | | `{message}` | 400 |
| POST /:id/export uuid | 193 | `{includeAudioFiles?}` | `{exportPath,message}` | 400 |
| POST /import | 228 | `{importPath}` | `{workspace,message}` | 400 |
| GET /:id uuid | 264 | | `{workspace}` | 404 |

`/api/projects` (`routes/projects.js`)
| Method path | Line | Notes | Success | Errors |
|---|---|---|---|---|
| GET / | 38 | | `{projects}` | |
| GET /current | 47 | not try/caught | `{project}` | 404 "No project is open" |
| PUT /current | 55 | `{name}` | 200 manager result | 400 manager result |
| POST / | 66 | `{name?}` | **201** `{project}` | 400 manager result |
| POST /import | 78 | multipart `bundle` | **201** `{project,audio,missingAudio}`; temp files removed *before* answering (`:89-119`) | 400 no file/bad zip/manager; 413 `err.message` |
| GET /:id/bundle | 123 | **no uuid check**; `current` or id | `application/zip` stream, `Content-Disposition` (`:32-36`, RFC 5987 `filename*`) | 404; mid-stream error → destroy |
| POST /:id/open uuid | 148 | | `{project}` | 404 if `/not found/i` else 400 |
| DELETE /:id uuid | 162 | | `{success}` | 404 if `/not found/i` else **409** |

`/api/remote` (`routes/remote.js`; **no uuid checks**; all manager failures → 400, never 404)
| Method path | Line | Notes |
|---|---|---|
| GET /cues | 7 | reduced cue objects with defaults (`:13-31`) |
| POST /cues/:id/trigger | 47 | options = `{source:'remote_http', ...body}` → `{message,status}` |
| POST /cues/:id/stop | 81 | `{fadeOut?}` |
| POST /cues/stop-all | 109 | `{behavior?}` → `{stoppedCount,message}` |
| POST /cues/:id/playlist/navigate | 138 | 400 bad direction |
| GET, POST /master-volume | 175/185 | `{volume}` |
| GET, POST /crossfade | 204/214 | POST requires boolean `enabled` else 400; returns manager result |
| GET /status | 229 | `{status}` |
| GET /info | 248 | `{info:{name,version:'0.3.0',httpPort,websocketPort,networkInterfaces,features}}` |
| GET /health | 279 | `{status:'ok',timestamp,success,health:{...}}` - polled by `electron-launcher/main.js:13` |

Method-mismatch outcomes (Express fall-through, §1.2): a single static segment under a router that
has a `/:id` route for that method answers the uuid 400 - e.g. `GET /api/cues/stop-all`,
`GET /api/audio/upload`, `DELETE /api/projects/current`, `PUT /api/workspaces/current`; anything
else answers 404 HTML - e.g. `POST /api/workspaces/current`, `PUT /api/config/network`,
`POST /api/cues/status/playback`, `GET /api/remote/cues/stop-all`.

### 1.6 Uploads (multer 2.4.0)
`createUpload` (`audio.js:33-59`): disk storage in `<tempDir>/uploads` (created per request),
filename `randomUUID() + lowercased ext(originalname)`; `limits.fileSize =
config.maxAudioFileSize || 100 MiB` read per request (`:25-28`); `fileFilter` allows
`.mp3 .wav .m4a .aac .ogg .flac` by lowercased extension (`:9,50-57`). `.single('audioFile')`.
Errors (`:68-86`): `LIMIT_FILE_SIZE` → 413 `File too large. Maximum size is N bytes`; everything
else (unsupported format, `Unexpected field` for another file field or a 2nd file,
field-value > 1 MB busboy default, etc.) → 400 `{error: err.message}`. Non-multipart request →
multer skips → 400 `No file uploaded`. Original name: busboy decodes header params as latin1;
`originalNameOf` re-decodes to UTF-8 unless that yields U+FFFD (`:63-66`). Text fields become
`req.body` (repeated name → array). Partial file removed by multer on error; route removes the
temp file on its own failures (`:286,298,303,331`).
Bundle (`projects.js:19-29`): same storage, filename `<uuid>.zip`, no filter, `fileSize` 20 GiB,
field `bundle`; 413 if over, else 400, both with `err.message`.

### 1.7 WebSocket protocol (`websocketManager.js`, ws 8.22.0)
Server options: defaults - any path accepted (`ws/lib/websocket-server.js:85,225-229`), any
Origin, `perMessageDeflate: false`, `maxPayload: 100 MiB`, `autoPong: true`, first offered
subprotocol echoed (`:71-78,404-406`). No server pings, no heartbeat, no idle timeout. Clients
connect to `ws://host:port` (`renderer.js:35-39`, `remote.html:212`, companion `client.js:94-108`).

On connect (`:28-49,66-124`, client added to the broadcast set *before* this async sequence runs):
1. `cues-updated {cues}` (file paths resolved to `/api/audio/serve/<id>`, `:736-793`)
2. one `cue_status {cueId,status,currentTime,totalTime}` per cue in playing/paused/cued_next
3. `crossfade-mode-updated {enabled}` 4. `master-volume-updated {volume}`
5. `config-updated {config}` 6. `workspace-updated {workspace}` (only if one is open)

Client → server, parsing (`:126-248`): `JSON.parse(buf.toString())` (text or binary frames).
Parse failure, or JSON `null` (property access throws) → `{type:'error',payload:{error:'Invalid
message format'}}`. If `requestId` is present and not null (any JSON value, incl. `0`/`""`) →
invoke path; otherwise event path by `type`; unknown type → no reply.

Event messages (reply goes to sender only; handlers return silently when `payload.cueId` is
missing, but throw → `{type:'error',payload:{error:'Failed to <verb>'}}` when `payload` itself is
missing/null, `:437-664`):
| In | Reply | Line |
|---|---|---|
| `trigger_cue {cueId}` | `cue_triggered {cueId,success,error?}` | 143,437 |
| `toggle_cue {cueId,retriggerBehavior?,fromCompanion?}` | `cue_toggled {cueId,success,status,error?}` | 147,464 |
| `play_cue {cueId}` | `cue_played {cueId,success,error?}` | 151,495 |
| `stop_cue {cueId,fadeOut}` | `cue_stopped {...}` | 155,522 |
| `stop_all_cues {behavior?}` (payload optional) | `all_cues_stopped {success,error?}` | 159,546 |
| `set_crossfade_mode {enabled}` | none (broadcast only) | 163 |
| `playlist_navigate {cueId,direction}` | `playlist_navigated {cueId,direction,success,error?}` | 167,569 |
| `playlist_jump {cueId,index}` | `playlist_jumped {cueId,...result}` (no-op w/o cueId) | 173 |
| `toggle_pause_cue {cueId}` | `cue_pause_toggled {cueId,...result}` | 180 |
| `set_master_volume {volume}` | `master_volume_set <result>` (`Number(undefined)`=NaN → manager error) | 187 |
| `update_cue {cueId,updates}` / `delete_cue {cueId}` / `create_cue <cue>` | `cue_updated` / `cue_deleted` / `cue_created {success,cue,error?}` | 194-204 |
| `ping` | `{type:'pong'}` | 206 |
| `cue-status-update`, `cue-duration-update` | none (log only) | 210,229 |
| `playback-time-update <p>` | **broadcast** to all incl. sender | 218 |

Invoke messages (`:250-435`): reply `{type:'<type>_response', requestId, payload}` or
`{type:'<type>_response', requestId, error}`; types `get-app-config`, `save-app-config`
(→ `{success}` + `config-updated` broadcast), `save-reordered-cues`, `get-crossfade-mode`,
`set-crossfade-mode`, `get-cues`, `add-or-update-cue` (unknown id = create, `:310-326`),
`generate-uuid` (payload is a bare string), `get-media-duration`, `get-http-remote-info`,
`delete-cue` (payload string or `{cueId}`); unknown → error `Unknown invoke message type: X`.
Frontend `invoke` matches on `requestId`, 10 s timeout (`renderer.js:191-245`).

Server broadcasts (to every OPEN client, serialized once, `:676-699`): `cues-updated`, `cue_update
{cueId,updates}` (`cueManager.js:329`), `cue_status {cueId,status,...extra}` (many sites, e.g.
`cueManager.js:548,604,853`), `config-updated`, `workspace-updated` (`cueManager.js:1265,1302`),
`playback-time-update` (every 100 ms per playing cue, `cueManager.js:104-157`),
`audio-engine-error` (`cueManager.js:76`), `crossfade-mode-updated` (`cueManager.js:967`),
`master-volume-updated` (`cueManager.js:1426`). `playback_time` (`websocketManager.js:718`) is dead code.
Companion consumes `cues-updated`, `cue_status`, `playback-time-update`, `workspace-updated`,
`crossfade-mode-updated`, `master-volume-updated` and sends only event messages
(`client.js:176-215`).

Concurrency: the `message` handler is an un-awaited async function, so one client's messages run
**concurrently** and replies can arrive out of order (`:36-38`); per-cue ordering comes from
`cueManager._serialized` (`cueManager.js:461-463,652-653`).

### 1.8 Shutdown
SIGINT/SIGTERM → `cueManager.cleanup()` → `server.close()` → exit 0, with a 10 s SIGKILL backstop
(`server.js:250-280,333-361`). `server.close()` does not finish while a WebSocket client is
connected (probed: still open after 3 s) - so with a browser open, shutdown ends via the 10 s
SIGKILL. `test/shutdown.test.js:75` covers only the no-client case.

## 2. Rust replacements (axum 0.8.9 stack)

Routing (axum `src/routing/path_router.rs:58-65`, matchit 0.8.4 pinned in axum's Cargo.toml):
captures are `{id}`, wildcards `{*rest}`; `:id` panics at startup. Matching is case-sensitive
and exact on trailing slash (`/api/cues/` ≠ `/api/cues`). Static segments beat captures, so
`/stats/overview` vs `/{id}` ordering needs no care - but a method mismatch on a matched path is
`405` with `Allow` (`src/routing/method_routing.rs:754`), unless `Router::method_not_allowed_fallback`
(`src/routing/mod.rs:374`) is set. `get` also serves HEAD with the body stripped
(`method_routing.rs:55-56,1157-1158`). Path params are percent-decoded; invalid UTF-8 → 400
`text/plain` "Invalid URL: ..." (`src/extract/path/mod.rs:426-445`).
Trailing slash: tower-http `NormalizePath::trim_trailing_slash` must wrap the Router *outside*
(layers added with `Router::layer` run after routing); it rewrites to `"/" + trim_matches('/')`,
i.e. also collapses a leading `//` (`tower-http src/normalize_path.rs:146-151`).

Extractor rejections (`axum src/extract/rejection.rs:11-89`, `src/json.rs:106-200`):
`Json<T>`: missing/other content type → **415**; syntax error → 400; type mismatch → **422**; all
`text/plain`. It accepts `application/*+json` too (`json.rs:138-154`). `Bytes`/`Json`/`Form` are
capped at **2 MiB** by default (`axum-core src/ext_traits/request.rs:319-326`) → 413;
`DefaultBodyLimit::max(n)` / `::disable()` per route. `Json` responses carry
`content-type: application/json` with no charset (`json.rs:216`). `Query<T>` → 400 on failure.

Multipart (`axum src/extract/multipart.rs`, feature `multipart`, built on multer 3.1.0): the whole
body goes through `with_limited_body()` → 2 MiB default (`:58,78`); multer errors map to 400 /
413 / 500 (`:261-294`); bad boundary → 400 text (`:350-351`). No per-file size limit or file
filter: count bytes while streaming `Field::chunk()` to disk yourself. `Field::file_name()` is the
raw header bytes run through `str::from_utf8` - so a browser's UTF-8 filename arrives correct
without the latin1 dance, a non-UTF-8 one becomes `None`, and `filename*` is not read
(`multer src/constants.rs:38-77`).

CORS (`tower-http src/cors/mod.rs`): `CorsLayer::very_permissive()` = credentials + mirrored
origin/method/headers (`:150-157`). Preflight is any `OPTIONS` (`:715`), answered with an empty
`Response::new` = **200**, not 204 (`:805-814`). `AllowMethods::mirror_request()` echoes only the
requested method (`allow_methods.rs:79-89`), unlike cors' fixed list; credentials + wildcard
methods/headers panics (`:819-830`). `Vary` is computed and added to preflight and normal
responses alike (`:459-480,710`). ACAO is omitted without an `Origin` (`allow_origin.rs:118-138`).

ServeDir (`tower-http src/services/fs/serve_dir/`): index.html on directories (default on),
directory without slash → **307** (`future.rs:102-103`); GET/HEAD only, else **405 `Allow:
GET,HEAD`** unless `call_fallback_on_method_not_allowed(true)` (`future.rs:173-177`, `mod.rs:357`);
Range + 416, `Accept-Ranges`, `Last-Modified`, **strong** `ETag: "<secs hex>.<nanos>-<size hex>"`
(`headers.rs:16-27`), If-None-Match weak compare → 304; no `Cache-Control`; dotfiles served; `..`
→ treated as not found (`mod.rs:608-647`); Content-Type from mime_guess `first_raw` **without
charset** (`open_file.rs:124`; mime_guess `src/mime_types.rs`: js `text/javascript`, html
`text/html`, css `text/css`, ico `image/x-icon`).

WebSocket (`axum src/extract/ws.rs`, feature `ws`, tokio-tungstenite 0.29): no permessage-deflate
support at all (matches ws' default off). Defaults `max_message_size` 64 MiB, `max_frame_size`
16 MiB (`tungstenite src/protocol/mod.rs:99-103`) vs ws 100 MiB - set both with
`WebSocketUpgrade::max_message_size/max_frame_size` (`ws.rs:195-203`). Pings are answered
automatically as long as the socket is being read (`tungstenite protocol/mod.rs:284-291,552-554`).
Subprotocol only if configured via `.protocols()` (`ws.rs:242`). Upgrade rejections: non-GET 405,
missing headers 400, no upgrade state 426, plain text (`ws.rs:950-1001`). `WebSocketUpgrade` has
no `Option` extractor in 0.8.9; take `Result<WebSocketUpgrade, WebSocketUpgradeRejection>` to
serve HTTP and WS on the same route. The upgraded connection runs in a detached `tokio::spawn`
(`ws.rs:359`).

Graceful shutdown: `axum::serve(..).with_graceful_shutdown(signal)` stops accepting and waits for
in-flight HTTP connections (`src/serve/mod.rs:151,276-278,389-409`); upgraded WebSocket tasks are
not tracked (see above), so they must be told to close (a `CancellationToken`/watch channel).

## 3. Semantic traps and how to match the original

1. **Case / trailing slash.** Don't use `NormalizePath` globally: with ServeDir, `/ui/` would be
   trimmed to `/ui` and redirected back to `/ui/` forever. Write a small pre-routing rewrite
   (wrapping the Router) that, for paths whose first segment is `api` (any case) or that equal
   `/remote/`, strips one trailing slash and lowercases the *literal* segments (route words), not
   the captured ones (`search/:query` is user text). Leave static paths untouched (filesystem
   decides, as in Node).
2. **405 vs fall-through.** Set `method_not_allowed_fallback` to emulate Express: if the path is
   `/api/<area>/<one segment>` and `<area>` has a `/{id}` route for this method (cues: GET PUT
   DELETE; audio: GET PUT DELETE; workspaces: GET PUT DELETE; projects: DELETE) → `400
   {success:false,error:"Invalid id: must be a UUID"}` (a literal word is never a UUID); else the
   404 page. Table in §1.5. Also: `remote/cues/{id}/*` and `projects/{id}/bundle` must *not* validate.
3. **404 / error pages.** Fallback returns 404 `text/html; charset=utf-8` with the finalhandler
   document and `Cannot <METHOD> <path>` plus the CSP and nosniff headers (deterministic, cheap to
   copy). 400/413/415 parse-error pages contain a Node stack trace in the original; emit the
   production form (status text) and have the recorder compare status + content type only.
4. **Body parsing.** Never use `axum::Json` for request bodies. Use one extractor `ExpressBody`
   = `Bytes` (with `DefaultBodyLimit::max(50 MiB)`) → `serde_json::Value`: content type exactly
   `application/json` (case-insensitive, params allowed) → empty → `{}`; first non-whitespace
   char not `{`/`[` → 400; parse error → 400; charset not `utf-*` → 415; strip a UTF-8 BOM
   (iconv-lite does); urlencoded → flat object (nested `qs` keys are an accepted deviation);
   anything else, no body, or `+json` → `{}`. Handlers then read fields like JS does
   (`body.get("fadeOut")`, missing = undefined). Optionally `RequestDecompressionLayer` for
   gzip/deflate/br.
5. **JSON output.** Use `serde_json::Value` (feature `preserve_order`) or structs with
   `#[serde(skip_serializing_if = "Option::is_none")]` for every field the JS fills with a
   possibly-`undefined` value (`error: result.error`, `status`, WS `cue_triggered.error`, ...) -
   `undefined` is dropped but `null` is kept. Integers that JS prints as `1` serialize as `1.0`
   from an `f64` (ryu); keep integer-valued numbers as `i64`/`serde_json::Number` from the input,
   and check the recorder's normalizer treats `1` and `1.0` as equal. NaN/∞ → `null` in both
   (`serde_json src/ser.rs:169-180`). Set `content-type: application/json; charset=utf-8`.
6. **Weak ETag + 304 on JSON GETs.** Express adds `W/"..."` to every JSON response and answers
   304 on a matching `If-None-Match`. Browsers can revalidate with it. Either reproduce (hash the
   body, any stable tag) or drop it; dropping only costs bandwidth. Recommend dropping, documented.
7. **`/api/audio/serve/:id`.** Hand-write it (do not use ServeFile): exact-string If-None-Match,
   the `"size-mtimeMs"` strong tag (`test/media-library.test.js:214-230` asserts 304 and that the
   tag changes on Replace), `Cache-Control: no-cache`, the single-range regex, 416 JSON bodies.
   Stream with `tokio_util::io::ReaderStream` over a `take()`n file.
8. **Static files.** `ServeDir::new(frontend).call_fallback_on_method_not_allowed(true)
   .fallback(not_found_page)` as the Router fallback service, plus a response map that: sets
   `Cache-Control: public, max-age=0` if absent; rewrites Content-Type to the mime-types values
   (append `; charset=utf-8` for text/javascript, text/html, text/css, application/json; .ico →
   `image/vnd.microsoft.icon`); and a request filter that 404s any segment starting with `.`
   (`.DS_Store` exists in dev checkouts). Accept: 307 instead of 301 for `/ui`-style dirs, 404
   instead of 403 for `..`, strong instead of weak ETag (opaque, still revalidates). `GET /remote`
   → serve `remote_control/remote.html` with the same headers.
9. **CORS.** Write a ~30-line middleware instead of `CorsLayer`: copy §1.3 exactly (any OPTIONS →
   204, `Content-Length: 0`, fixed method list, mirrored request headers, `Vary` values as cors
   sends them, ACAC always). `CorsLayer` gives 200 and different `Allow-Methods`/`Vary`. It must
   be the outermost layer so it also covers 404s and the upload routes.
10. **Uploads.** `DefaultBodyLimit::disable()` on `/api/audio/upload`, `/api/audio/{id}/replace`,
    `/api/projects/import`. Validate the uuid before touching the body. Stream parts: text fields
    into a map (repeated → array); first file part named `audioFile`/`bundle` → check extension
    (audio) before writing, write `<tempDir>/uploads/<uuid><ext>`, count bytes against the limit
    read from config *per request*; a second file or other file field → 400 "Unexpected field";
    over the limit → delete partial file, 413 with the JSON body. Before answering early, drain
    (or at least keep reading) the rest of the request body: closing the socket while the client
    still sends can make fetch/undici report a network error instead of the 413 that
    `test/audio-files.test.js:151` asserts - verify with that test. Non-multipart → 400 "No file
    uploaded". Apply the U+FFFD rule only if a latin1 path is ever taken; with multer-rs the name
    is already UTF-8, and a `None` name (non-UTF-8 bytes) should be treated as a file anyway by
    re-reading `Content-Disposition` raw bytes.
11. **Query strings.** Parse with `form_urlencoded` and take the first value of a repeated key
    (`parseInt(['5','6'])` = 5); `includeCues` must equal the string `true` exactly; `limit`
    parsing must mimic `parseInt` (leading digits, `"12abc"` → 12, junk → 0).
12. **WebSocket on any path.** `ws` upgrades every path. Route WS through the Router fallback and
    `/`: a handler taking `Result<WebSocketUpgrade, _>` upgrades when `Ok`, otherwise defers to
    static/404. Don't check Origin. Set `max_message_size`/`max_frame_size` to 100 MiB.
13. **WS message handling.** Accept Text and Binary (`from_utf8_lossy`, as `Buffer.toString`).
    Reproduce the exact error/silence matrix of §1.7 (missing payload → `error` message, payload
    without cueId → silence, `requestId: 0` → invoke, `ping` with requestId → unknown invoke).
    Echo `requestId` as the original JSON value. Spawn each message's handling as its own task (as
    Node runs them concurrently): processing one client's messages sequentially would make a
    Companion press wait behind a slow first-play decode.
14. **Broadcast fan-out.** One serialized `Utf8Bytes`/`Arc<str>` per broadcast, per-client
    unbounded (or large) `mpsc` + writer task. Avoid `tokio::sync::broadcast`: a lagging receiver
    silently loses messages (`RecvError::Lagged`), which ws never does. Register the client before
    sending initial data, and send the six initial messages in order through the same queue.
15. **Shutdown.** Track WS tasks with a cancellation token: on signal, close sockets, then let
    `with_graceful_shutdown` drain HTTP. This exits faster than the original (no 10 s SIGKILL with
    a browser open) - a behavior improvement, not wire-visible. Keep the exit code 0.
16. **Headers nobody needs.** `X-Powered-By: Express`, `Keep-Alive: timeout=5`, Node's 300 s
    `requestTimeout` (a 20 GB bundle import over 5 min fails in Node, not in hyper): don't copy;
    list them as accepted differences for the recorder.
17. **Projects bundle download.** Stream the zip as the body; on a mid-stream error return an
    error from the body stream so hyper aborts the connection (matches `res.destroy`). Headers set
    before streaming; `Content-Disposition` builder copied verbatim (`projects.js:32-36`).
18. **`/remote` and `/` route vs static order.** Node checks static first; Rust puts routes first.
    Only `/` (same index.html) and `/remote` (no such file) collide, so the order is unobservable.

## 4. Recommended crate set

```toml
axum        = { version = "0.8.9", features = ["ws", "multipart"] }   # defaults keep http1, json, query, tokio
tokio       = { version = "1.54", features = ["rt-multi-thread", "macros", "net", "fs", "io-util", "signal", "sync", "time"] }
tower       = { version = "0.5.3", features = ["util"] }
tower-http  = { version = "0.7.1", features = ["fs", "set-header", "decompression-gzip", "decompression-deflate", "decompression-br"] }
tokio-util  = { version = "0.7.20", features = ["io"] }                # ReaderStream for /serve and bundles
futures-util = "0.3.34"                                               # StreamExt/SinkExt on WebSocket
serde       = { version = "1", features = ["derive"] }
serde_json  = { version = "1.0.154", features = ["preserve_order"] }
form_urlencoded = "1"                                                 # query + urlencoded bodies
uuid        = { version = "1.29", features = ["v4"] }
httpdate    = "1"
```
Not recommended: tower-http `cors` (200 preflight, different headers - write the middleware) and
`normalize-path` (redirect loop with ServeDir - write the rewrite). tower-http 0.7.1 sits on
http 1 / tower 0.5 like axum 0.8.9 (axum itself only pulls tower-http 0.6.8 for internal features).
Test with `tower::ServiceExt::oneshot` against the Router for routing/CORS/404 tables, and run the
existing `test/*.test.js` + Playwright suites against the binary (MAP.md "Proof").
