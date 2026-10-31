# Motrix MDXP bridge — implementation notes

These notes summarize what this plugin relies on. They were verified against
Motrix 2.x on Windows. Motrix's bridge is meant for its browser extension;
this plugin reuses the same JSON-RPC surface to create first-class Motrix
tasks.

## Endpoint and authentication

On every start Motrix writes its live bridge coordinates to:

```text
%APPDATA%\Motrix\bridge\endpoint.json
{ "port": 16802, "pid": 1234, "writtenAt": 1793375616419,
  "localToken": "<rotating token>", "generation": "<uuid>" }
```

- Ports **16802–16806** are tried in order; the first free one wins, so never
  hard-code the port.
- `localToken` **rotates on restart** — always re-read the file; a stale token
  produces `401 Unauthorized`.
- Requests are plain HTTP JSON-RPC 2.0:

```http
POST http://127.0.0.1:<port>/mdxp
Authorization: Bearer <localToken>
Content-Type: application/json

{"jsonrpc":"2.0","id":"1","method":"download/add","params":{...}}
```

- Server-sent events are available at `GET /mdxp/events` (`$/stats`,
  `$/task/progress`, …). This plugin does not use them and polls instead.

## Methods available on this surface

| Method | Purpose |
| --- | --- |
| `download/add` | Create a task from URL / magnet / `.torrent` |
| `task/list` | List tasks (`status?`, `limit?`, `offset?`) |
| `task/get` | One task by `taskId` (`{ task: MdxpTask \| null }`) |
| `task/pause` · `task/resume` | Pause / resume |
| `task/remove` | Remove (`{taskId, deleteFiles?}`) |
| `task/reveal` | Reveal output in the file manager |
| `stats/get` | Aggregate speeds and task counts |
| `engine/status` | Engine health |

Some methods documented elsewhere (for example `download/directories`,
`system/ping`, `motrix/initialize`) are not available on this HTTP surface in
the tested build and answer with a JSON-RPC error (`-32005`).

## `download/add`

Strict schema — unknown keys are rejected with `-32602`.

```jsonc
// kind: "url"
{ "kind": "url", "saveDir": "D:\\Downloads",
  "uris": ["https://example.com/file.zip"], "filename": "file.zip",
  "headers": [{ "name": "Referer", "value": "https://example.com" }],
  "connections": 16, "proxy": "http://127.0.0.1:7890",
  "idempotencyKey": "optional-8-to-128-chars" }

// kind: "magnet"
{ "kind": "magnet", "saveDir": "D:\\Downloads",
  "uri": "magnet:?xt=urn:btih:...", "selectedFiles": [0, 1] }

// kind: "torrent"
{ "kind": "torrent", "saveDir": "D:\\Downloads",
  "base64": "<base64 .torrent bytes>", "displayName": "ubuntu" }
```

- Allowed URL schemes: `http`, `https`, `ftp`, `ftps`, `sftp`.
- `saveDir` must already exist; a missing directory is accepted at add time and
  fails later with `DL_FILE_WRITE_ERROR`.
- `idempotencyKey` is a real deduplication key: replaying the same key returns
  the original task.
- The result is the created task snapshot (`MdxpTask`), so no extra `task/get`
  round-trip is needed to render it.

## Task object

```jsonc
{
  "id": "01a18d9a-1d41-73a6-ad7f-b1e24e3b627b", // stable Motrix UUID
  "type": "http",            // http | ftp | bt | magnet | metalink
  "name": "file.zip",
  "status": "downloading",   // queued | fetching_metadata | downloading |
                             // paused | seeding | finalizing | completed | error
  "progress": 0.42,          // 0..1
  "bytesDone": 6617,
  "bytesTotal": 15728640,    // null while unknown
  "speedBps": 1048576,
  "etaSec": 15,              // null while unknown
  "saveDir": "D:\\Downloads",
  "finalPath": null,         // absolute path once completed
  "error": null,             // human-readable message on error
  "errorCode": null,         // DL_* code on error, e.g. DL_NOT_FOUND
  "createdAt": 1793376337266,
  "finishedAt": null,
  "infoHash": null           // torrents only
}
```

## Why not the embedded aria2 RPC

Motrix embeds aria2 and exposes its own JSON-RPC on `127.0.0.1:16800`
(`aria2.getVersion`, `aria2.addUri`, …), with the secret in
`settings.json → engine.rpcSecret`. It works, but Motrix **adopts** raw aria2
tasks within about a second (`adoptTask`, `adopted:<gid>`): the original gid is
destroyed (`GID ... is not found`), and the gid↔UUID mapping is not exposed.
That makes raw aria2 useful only as fire-and-forget; anything that needs a task
handle (status, pause, resume, remove, final path) must use the MDXP bridge.
