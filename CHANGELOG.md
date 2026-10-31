# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-31

### Added

- `download` tool: submits HTTP/HTTPS/FTP URLs, magnet links and `.torrent`
  files to the local Motrix app through its MDXP bridge, with an automatic
  fallback to a built-in direct HTTP(S) downloader when Motrix is unavailable.
- `download_status` tool: inspect a task by id (optionally waiting for
  completion) or list the Motrix queue with global speed and counters.
- `download_control` tool: pause, resume, cancel (keep files) or purge
  (delete files and record) a Motrix task.
- Auto-discovery of the Motrix bridge port/token from
  `%APPDATA%\Motrix\bridge\endpoint.json`, the default download directory from
  `settings.json`, and the executable path from `aria2-owner.json`; the token
  is re-read on every call because it rotates on restart.
- Automatic Motrix launch when the bridge is unreachable (bounded wait).
- Required `save_dir` on `download`, so the model always states the
  destination (and asks the user when unspecified).
- A system-prompt section (`motrix-download`, order 5900) that makes
  "prefer Motrix for downloads" explicit.
- `docs/mdxp-notes.md`: protocol notes for the Motrix MDXP bridge.
- `scripts/check.mjs` offline contract check and a GitHub Actions workflow.
- `smoke.mjs` end-to-end self-check (requires a running Motrix).
- MIT license.

### Notes

- Windows only in practice; macOS/Linux support is untested.
- The direct fallback supports `http/https` only and does not resume.
