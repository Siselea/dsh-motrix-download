# dsh-motrix-download

![CI](https://github.com/Siselea/dsh-motrix-download/actions/workflows/check.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)

**A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that routes model download requests to the local [Motrix](https://github.com/agalwood/Motrix) (aria2) app, and falls back to a built-in direct HTTP download when Motrix is unavailable.**

[简体中文](README.md) | English

Downloads created by this plugin are real Motrix tasks: they show up in the app, can be paused/resumed/removed, and obey Motrix queue and speed limits — instead of bypassing the app and talking to aria2 directly.

## Features

- **Motrix first**: the `download` tool sends URLs, magnet links and `.torrent` files to Motrix by default.
- **Automatic fallback**: if Motrix is not running or its bridge is unavailable, `http/https` downloads fall back to a built-in direct downloader.
- **Zero configuration**: bridge port, bearer token, default save directory and installation path are auto-discovered; the rotating token is re-read on every call.
- **Auto launch**: when the bridge is unreachable, the plugin starts `Motrix.exe` and waits up to 25 seconds.
- **Explicit destination**: `save_dir` is required, so the model always states where the file goes (and asks the user when unspecified).
- **No runtime dependencies**: Node built-ins only.

## Requirements

- **Windows** (Motrix is discovered through `%APPDATA%\Motrix`; macOS/Linux are untested).
- **Motrix 2.x** with its browser bridge enabled (`app.browserBridgeEnabled`, on by default).
- **DeepSeek Harness** — this is a Host plugin installed as a bundle.

## Install

```bash
git clone https://github.com/Siselea/dsh-motrix-download.git
```

Then install it into your Harness profile (replace `<abs>` with the cloned absolute path):

```text
plugin_manager action=install_bundle target=<abs>/dsh-motrix-download
```

The plugin appears in Plugin Manager (title/description from `locale/en.json` and `locale/zh.json`, icon from `icon.svg`) and its three tools are active immediately.

> Local packages are installed with a `link:` dependency. After editing the source, toggle the plugin off/on in Plugin Manager (or restart Harness) to reload the module.

## Quick start

```js
// Save a web image to D:\ (save_dir is required)
download({ url: "https://www.example.com/logo.png", save_dir: "D:\\", filename: "logo.png", wait_seconds: 60 })

// Magnet link (Motrix only)
download({ url: "magnet:?xt=urn:btih:...", save_dir: "D:\\Downloads" })

// Poll progress; wait_seconds > 0 waits for completion and returns finalPath
download_status({ task_id: "01a18d9a-...", wait_seconds: 120 })

// pause / resume / cancel (keeps files) / purge (deletes files)
download_control({ task_id: "01a18d9a-...", action: "pause" })
```

## Tools

| Tool | Purpose |
| --- | --- |
| `download` | Submit a download: URL / magnet / local `.torrent`. Prefers Motrix, falls back to direct download |
| `download_status` | Inspect a task by `task_id` (optionally wait), or list the queue and global speed |
| `download_control` | `pause` / `resume` / `cancel` (keep files) / `purge` (delete files) |

### `download` parameters

| Parameter | Description |
| --- | --- |
| `url` (required) | `http/https/ftp/ftps/sftp` URL, `magnet:?` link, or local `.torrent` path |
| `save_dir` (required) | Destination directory (absolute, or relative to the workspace) |
| `filename` | Output filename for single-file HTTP downloads (ignored for magnet/torrent) |
| `headers` | Extra HTTP headers, e.g. `{"Referer":"https://example.com"}` |
| `engine` | `auto` (default), `motrix` (Motrix only), `direct` (skip Motrix) |
| `wait_seconds` | Seconds to wait for completion (0 = return immediately) |

Key result fields: `backend` (motrix/http), `taskId`, `status`, `progress`, `bytesDone`/`bytesTotal`, `finalPath`, `message`.

## How it works

1. Reads the default save directory from `%APPDATA%\Motrix\settings.json` and the installation path from `aria2-owner.json`.
2. Reads the live bridge port (first free of 16802–16806) and `localToken` from `%APPDATA%\Motrix\bridge\endpoint.json` on every call.
3. If the bridge is unreachable, launches `Motrix.exe` and retries.
4. Talks to Motrix over its **MDXP** bridge (`POST http://127.0.0.1:<port>/mdxp`, `Authorization: Bearer <localToken>`): `download/add`, `task/get`, `task/list`, `task/pause|resume|remove`, `stats/get`.
5. If Motrix is unavailable, `http/https` URLs fall back to a direct downloader (redirects, `Content-Disposition` filenames, `.part` temp files; no resume).

### Why MDXP instead of the aria2 RPC

Motrix adopts raw aria2 tasks: a task added via aria2's 16800 RPC is re-owned by the app within about a second, the original gid is destroyed (`GID ... is not found`), and the bridge does not expose the gid↔UUID mapping. So raw aria2 RPC is fire-and-forget; task handles, status and control require MDXP. See [docs/mdxp-notes.md](docs/mdxp-notes.md).

## System prompt

The plugin registers a short global prompt section (`motrix-download`, order 5900) so that "prefer the `download` tool" also applies to prose requests, and requires `save_dir` on every download. If registration fails it only warns and the tools keep working.

## Configuration

No config file; everything is auto-discovered. Optional environment variable:

| Variable | Effect |
| --- | --- |
| `DSH_MOTRIX_EXE` | Explicit path to `Motrix.exe` when auto-discovery fails |

## Development and tests

Offline checks (no Motrix needed; also used by CI):

```bash
node scripts/check.mjs
```

End-to-end smoke test (requires a running Motrix; downloads a real file and cleans up):

```bash
node smoke.mjs
```

## Known limitations

- Requires Motrix's browser bridge to be enabled.
- Magnet links and torrent files can only be downloaded by Motrix; no fake fallback.
- The direct fallback supports `http/https` only (no FTP, magnet, torrent or resume).
- `purge` deletes downloaded files, matching Motrix's "remove task and files".
- Completion is detected by polling `task/get` every 500 ms (the HTTP bridge is request/response only).
- Not tested on macOS/Linux.

## License

[MIT](LICENSE)
