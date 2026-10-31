# dsh-motrix-download

![CI](https://github.com/Siselea/dsh-motrix-download/actions/workflows/check.yml/badge.svg)
![Release](https://img.shields.io/github/v/release/Siselea/dsh-motrix-download)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)

**DeepSeek Harness 插件：模型请求下载时，优先交给本机 [Motrix](https://github.com/agalwood/Motrix)（aria2）下载；Motrix 不可用时自动回退为内置直连下载。**

[English](README.en.md) | 简体中文

下载任务会真实出现在 Motrix 应用中（可暂停/继续/删除、参与 Motrix 的队列与限速），而不是绕开应用直接塞给 aria2。

## 特性

- **优先 Motrix**：`download` 工具默认把 URL / magnet / `.torrent` 交给 Motrix；任务可在 Motrix 中查看和管理。
- **自动回退**：Motrix 未运行或桥接不可用时，http/https 链接自动改用内置直连下载，下载请求不会失败。
- **自动发现**：端口、token、默认下载目录、安装位置全部从 Motrix 配置自动读取，token 轮换无需配置。
- **自动启动**：桥接不可达时自动拉起 `Motrix.exe`（最多等 25 秒），成功后再提交任务。
- **目的地必填**：`save_dir` 为必填参数，模型必须先明确"下载到哪"；用户没说时模型会先询问。
- **零运行时依赖**：只使用 Node 内置模块，不需要 `npm install`。

## 环境要求

- **Windows**（插件通过 `%APPDATA%\Motrix` 发现 Motrix；macOS / Linux 未验证）。
- **Motrix 2.x**，且设置中的「浏览器桥接」（`app.browserBridgeEnabled`）保持开启——默认开启。
- **DeepSeek Harness**（Host 插件，通过 `plugin_manager` 安装为 bundle）。

## 安装

> 尚未发布到 npm；如需通过包名安装，可自行 `npm login && npm publish --access public`（包名 `dsh-motrix-download` 可用）。

方式一：clone 仓库

```bash
git clone https://github.com/Siselea/dsh-motrix-download.git
```

方式二：从 [Releases](https://github.com/Siselea/dsh-motrix-download/releases) 下载 `dsh-motrix-download-0.1.0.tgz` 并解压：

```bash
tar -xzf dsh-motrix-download-0.1.0.tgz
```

然后在 Harness 中安装为该 profile 的 bundle（把 `<abs>` 换成 clone 或解压出来的绝对路径）：

```text
plugin_manager action=install_bundle target=<abs>/dsh-motrix-download
```

安装后插件出现在 Plugin Manager 中（标题/描述来自 `locale/en.json` 与 `locale/zh.json`，图标为 `icon.svg`），三个工具立即生效。

> 本插件是用 `link:` 方式安装的本地包：之后修改源码，需要在 Plugin Manager 里把插件关闭再开启（或重启 Harness）来重载模块。

## 快速上手

```js
// 下载网页图片到 D 盘（save_dir 必填）
download({ url: "https://www.example.com/logo.png", save_dir: "D:\\", filename: "logo.png", wait_seconds: 60 })

// 磁力链接（只能由 Motrix 下载）
download({ url: "magnet:?xt=urn:btih:...", save_dir: "D:\\Downloads" })

// 查询进度；wait_seconds > 0 时等待完成并返回 finalPath
download_status({ task_id: "01a18d9a-...", wait_seconds: 120 })

// 暂停 / 继续 / 取消（保留文件）/ 删除（连文件删）
download_control({ task_id: "01a18d9a-...", action: "pause" })
```

典型返回（节选）：

```json
{
  "ok": true,
  "backend": "motrix",
  "taskId": "01a18d9a-1d41-73a6-ad7f-b1e24e3b627b",
  "status": "completed",
  "name": "baidu-logo.png",
  "bytesTotal": 6617,
  "finalPath": "D:\\baidu-logo.png",
  "message": "已下载完成：D:\\baidu-logo.png（6.5 KB）"
}
```

## 工具

| 工具 | 用途 |
| --- | --- |
| `download` | 提交下载：URL / magnet / 本地 `.torrent`。默认优先 Motrix，失败回退直连 |
| `download_status` | 查询任务：传 `task_id` 看详情并可等待完成；不传则列出任务队列与全局速度 |
| `download_control` | 控制任务：`pause` / `resume` / `cancel`（保留文件）/ `purge`（删除文件） |

### `download` 参数

| 参数 | 说明 |
| --- | --- |
| `url`（必填） | `http/https/ftp/ftps/sftp` 链接、`magnet:?` 磁力链接，或本地 `.torrent` 文件路径 |
| `save_dir`（必填） | 下载到哪个目录（绝对路径或相对工作区路径）。用户未指定时，模型应先询问再下载 |
| `filename` | 单文件 HTTP 下载的另存文件名（磁力/种子忽略） |
| `headers` | 额外 HTTP 请求头，如 `{"Referer":"https://example.com"}` |
| `engine` | `auto`（默认，优先 Motrix）、`motrix`（只用 Motrix）、`direct`（跳过 Motrix 直连） |
| `wait_seconds` | 最多等待完成的秒数（0 = 提交后立即返回；完成时返回 `finalPath`） |

返回值关键字段：`backend`（motrix/http）、`taskId`、`status`、`progress`、`bytesDone`/`bytesTotal`、`finalPath`、`message`。

## 工作原理

1. 从 `%APPDATA%\Motrix\settings.json` 读取默认下载目录，从 `%APPDATA%\Motrix\aria2-owner.json` 推导安装位置。
2. 从 `%APPDATA%\Motrix\bridge\endpoint.json` 读取当前桥接端口（16802–16806 中实际绑定的那个）与 `localToken`；两者每次调用前重读，token 重启轮换也不影响。
3. 桥接不可达时自动启动 `Motrix.exe`，等待桥接就绪后重试。
4. 通过 Motrix 的 **MDXP** 桥（`POST http://127.0.0.1:<port>/mdxp`，`Authorization: Bearer <localToken>`）调用 `download/add`、`task/get`、`task/list`、`task/pause|resume|remove`、`stats/get`。
5. 非 http/https 的地址在 Motrix 不可用时无法回退，返回明确错误；http/https 则回退到内置直连下载（跟随重定向、按 `Content-Disposition` 命名、`.part` 临时文件；不支持断点续传）。

### 为什么用 MDXP 桥而不是 aria2 RPC

Motrix 会"接管" aria2 队列：直接向内嵌 aria2 的 16800 RPC 提交任务后，应用会在约 1 秒内把任务收编（`adoptTask`），原 gid 随即失效（`tellStatus` → `GID ... is not found`），且桥不暴露 gid 与 Motrix 任务 UUID 的映射。因此裸 aria2 RPC 只能"发完不管"；要任务句柄、状态和控制能力，必须走 MDXP 桥。协议细节见 [docs/mdxp-notes.md](docs/mdxp-notes.md)。

## 系统提示词

插件注册一个简短的全局提示词片段（`motrix-download`，order 5900），让"下载优先用 `download` 工具"在普通对话请求中也生效，并要求每次下载都附带 `save_dir`（用户没说保存位置时先询问）。片段注册失败只告警，不影响工具可用性。

## 配置

没有配置文件，全部自动发现。可选的环境变量：

| 变量 | 作用 |
| --- | --- |
| `DSH_MOTRIX_EXE` | 指定 `Motrix.exe` 路径（自动发现失败时使用） |

## 开发与测试

离线检查（不需要 Motrix，CI 也跑这个）：

```bash
node scripts/check.mjs
```

端到端自检（需要本机 Motrix 正在运行，会真实下载并自动清理）：

```bash
node smoke.mjs
```

`smoke.mjs` 覆盖：工具注册、提示词片段、Motrix 桥连通、真实下载并校验 `finalPath`、任务查询、任务删除、直连回退、非法输入与缺少 `save_dir` 的拒绝。

## 已知限制

- 需要 Motrix 的**浏览器桥接**开启；关闭时 Motrix 不可用，只能直连下载。
- 磁力链接与种子文件必须由 Motrix 下载：桥接不可用时直接报错，不会伪造回退。
- 直连回退仅支持 http/https，不处理 FTP、磁力、种子，也不支持断点续传。
- `purge` 会删除已下载的文件（等价于 Motrix 中"删除任务并删除文件"）。
- 等待完成使用 500ms 轮询 `task/get`，不订阅 MDXP 通知（HTTP 桥只提供请求/响应）。
- 未在 macOS / Linux 上验证。

## 目录结构

```
dsh-motrix-download/
├── index.js              # 插件入口：三个工具 + 提示词片段
├── lib/motrix.mjs        # Motrix 状态发现、MDXP 桥客户端、启动与轮询
├── lib/fallback.mjs      # 直连 HTTP(S) 下载回退
├── cordis.patch.yml      # bundle patch（insert 一行）
├── package.json          # dsh.bundle.patch + locale/icon 导出
├── locale/{en,zh}.json   # Plugin Manager 标题/描述
├── icon.svg              # 图标
├── .github/workflows/    # CI（离线检查）与 Release（打 tag 自动发布）
├── docs/mdxp-notes.md    # MDXP 协议实测笔记
├── scripts/check.mjs     # 离线自检（CI）
├── smoke.mjs             # 端到端自检（需要 Motrix）
├── CHANGELOG.md          # 版本记录
└── LICENSE               # MIT
```

## 许可证

[MIT](LICENSE)
