/**
 * Motrix MDXP bridge client.
 *
 * Motrix 2.x runs a local JSON-RPC bridge for its
 * browser extension. The bridge listens on 127.0.0.1:<port> (ports
 * 16802-16806, first free one wins) and speaks the Motrix Download eXchange
 * Protocol (MDXP) over plain HTTP:
 *
 *   POST http://127.0.0.1:<port>/mdxp
 *   Authorization: Bearer <localToken>
 *   {"jsonrpc":"2.0","id":"1","method":"download/add","params":{...}}
 *
 * `<port>` and `localToken` are written by the app to
 * %APPDATA%\Motrix\bridge\endpoint.json on every start, so both are read from
 * there instead of hard-coded. Tasks added this way are first-class Motrix
 * tasks (visible in the app, persisted, pausable) which is why this path is
 * preferred over talking to the embedded aria2 RPC directly: the app adopts
 * and re-owns raw aria2 tasks, making their gids unstable.
 */

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export const DEFAULT_BRIDGE_PORT = 16802
export const DEFAULT_LAUNCH_WAIT_MS = 25_000
export const TERMINAL_STATUSES = new Set(['completed', 'error'])

const STATUS_TEXT = {
  queued: '排队中',
  fetching_metadata: '获取元数据',
  downloading: '下载中',
  paused: '已暂停',
  seeding: '做种中',
  finalizing: '收尾中',
  completed: '已完成',
  error: '出错',
  removed: '已移除',
}

export function statusText(status) {
  return STATUS_TEXT[status] || status || '未知'
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status)
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function motrixStateDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Motrix')
}

export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '未知'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`
}

export class BridgeUnavailableError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'BridgeUnavailableError'
    this.transport = true
    if (code) this.code = code
  }
}

export class BridgeAuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeAuthError'
    this.unauthorized = true
  }
}

export class MdxpError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MdxpError'
    this.rpcCode = code
  }
}

function appDirFromAria2(aria2Path) {
  let dir = path.resolve(aria2Path)
  for (let i = 0; i < 5; i += 1) dir = path.dirname(dir)
  return dir
}

export async function readBridgeEndpoint(stateDir = motrixStateDir()) {
  try {
    const raw = JSON.parse(await readFile(path.join(stateDir, 'bridge', 'endpoint.json'), 'utf8'))
    const port = Number(raw && raw.port)
    const localToken = raw && typeof raw.localToken === 'string' ? raw.localToken : ''
    if (!Number.isInteger(port) || port <= 0 || port >= 65536 || !localToken) return null
    return {
      port,
      localToken,
      generation: typeof raw.generation === 'string' ? raw.generation : '',
      pid: Number(raw.pid) || 0,
    }
  } catch {
    return null
  }
}

/**
 * Read the Motrix settings that matter for downloads: the default save
 * directory and the installed executable (derived from the aria2 engine path
 * recorded in aria2-owner.json).
 */
export async function readMotrixState() {
  const stateDir = motrixStateDir()
  const state = {
    stateDir,
    downloadDir: path.join(os.homedir(), 'Downloads'),
    exePath: null,
    appDir: null,
  }

  try {
    const settings = JSON.parse(await readFile(path.join(stateDir, 'settings.json'), 'utf8'))
    if (settings && settings.app && typeof settings.app.defaultSaveDir === 'string' && settings.app.defaultSaveDir) {
      state.downloadDir = settings.app.defaultSaveDir
    }
  } catch {
    /* settings absent: keep defaults */
  }

  try {
    const owner = JSON.parse(await readFile(path.join(stateDir, 'aria2-owner.json'), 'utf8'))
    if (owner && typeof owner.binaryPath === 'string') {
      state.appDir = appDirFromAria2(owner.binaryPath)
      const exe = path.join(state.appDir, 'Motrix.exe')
      if (existsSync(exe)) state.exePath = exe
    }
  } catch {
    /* owner file absent: fall through to candidates */
  }

  if (!state.exePath) {
    const localAppData = process.env.LOCALAPPDATA || ''
    const candidates = [
      state.appDir ? path.join(state.appDir, 'Motrix.exe') : null,
      process.env.DSH_MOTRIX_EXE || null,
      localAppData ? path.join(localAppData, 'Programs', 'Motrix', 'Motrix.exe') : null,
      'C:\\Program Files\\Motrix\\Motrix.exe',
      'C:\\Program Files (x86)\\Motrix\\Motrix.exe',
    ].filter(Boolean)
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) {
          state.exePath = candidate
          state.appDir = path.dirname(candidate)
          break
        }
      } catch {
        /* unreadable candidate: ignore */
      }
    }
  }

  return state
}

let requestSeq = 0

/** One MDXP JSON-RPC call over the bridge HTTP endpoint. */
export function bridgeCall(endpoint, method, params = {}, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!endpoint) {
      reject(new BridgeUnavailableError('Motrix 桥接服务未运行'))
      return
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: String(++requestSeq), method, params })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        path: '/mdxp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${endpoint.localToken}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          if (settled) return
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode === 401 || res.statusCode === 403) {
            fail(new BridgeAuthError(`Motrix 桥接口令被拒绝（HTTP ${res.statusCode}）`))
            return
          }
          let payload
          try {
            payload = JSON.parse(text)
          } catch {
            fail(new Error(`Motrix 桥接返回了非 JSON 响应（HTTP ${res.statusCode}）`))
            return
          }
          if (payload && payload.error) {
            const error = payload.error
            fail(new MdxpError(error.code, typeof error.message === 'string' ? error.message : JSON.stringify(error)))
            return
          }
          settled = true
          resolve(payload ? payload.result : undefined)
        })
        res.on('error', fail)
      },
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy()
      fail(new BridgeUnavailableError(`连接 Motrix 桥接超时（127.0.0.1:${endpoint.port}）`, 'ETIMEDOUT'))
    })
    req.on('error', (error) => {
      if (error instanceof BridgeUnavailableError) fail(error)
      else fail(new BridgeUnavailableError(`无法连接 Motrix 桥接（127.0.0.1:${endpoint.port}）：${error.message}`, error.code))
    })
    req.end(body)
  })
}

/** Health probe: returns { ok, stats } or { ok: false, error }. */
export async function probeBridge(endpoint) {
  if (!endpoint) return { ok: false, error: 'Motrix 桥接服务未运行' }
  try {
    const stats = await bridgeCall(endpoint, 'stats/get', {}, { timeoutMs: 1500 })
    return { ok: true, stats }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), unauthorized: Boolean(error && error.unauthorized) }
  }
}

function spawnMotrix(exePath) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', reject)
      child.unref()
      resolve()
    } catch (error) {
      reject(error)
    }
  })
}

let launchPromise = null

/**
 * Ensure the bridge is reachable, launching Motrix once when it is not.
 * The endpoint file is re-read while waiting because the app rewrites the
 * port/token on every start.
 */
export async function ensureBridge(state, { autoLaunch = true, launchWaitMs = DEFAULT_LAUNCH_WAIT_MS } = {}) {
  let endpoint = await readBridgeEndpoint(state.stateDir)
  let probe = endpoint ? await probeBridge(endpoint) : { ok: false }
  if (probe.ok) return { ok: true, endpoint, stats: probe.stats }

  if (!autoLaunch) {
    return { ok: false, error: probe.unauthorized ? 'Motrix 桥接口令被拒绝' : 'Motrix 桥接服务未运行（Motrix 未启动）' }
  }
  if (!state.exePath || !existsSync(state.exePath)) {
    return { ok: false, error: '未找到 Motrix 可执行文件（尝试过 U:\\Motrix 等常见安装位置）' }
  }

  if (!launchPromise) {
    launchPromise = spawnMotrix(state.exePath)
      .catch(() => {})
      .then(() => {
        launchPromise = null
      })
  }

  const deadline = Date.now() + launchWaitMs
  while (Date.now() < deadline) {
    await delay(500)
    const nextEndpoint = await readBridgeEndpoint(state.stateDir)
    if (!nextEndpoint) continue
    probe = await probeBridge(nextEndpoint)
    if (probe.ok) return { ok: true, endpoint: nextEndpoint, stats: probe.stats, launched: true }
  }
  return { ok: false, error: `已尝试启动 Motrix，但 ${Math.round(launchWaitMs / 1000)} 秒内桥接服务未就绪`, launched: true }
}

function idempotencyKey() {
  return `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function projectTask(raw) {
  const task = raw && typeof raw === 'object' ? raw : {}
  return {
    taskId: String(task.id || ''),
    type: String(task.type || ''),
    name: String(task.name || ''),
    status: String(task.status || 'queued'),
    progress: Number(task.progress) || 0,
    bytesDone: Number(task.bytesDone) || 0,
    bytesTotal: Number.isFinite(task.bytesTotal) ? Number(task.bytesTotal) : null,
    speedBps: Number(task.speedBps) || 0,
    etaSec: Number.isFinite(task.etaSec) ? Number(task.etaSec) : null,
    saveDir: String(task.saveDir || ''),
    finalPath: typeof task.finalPath === 'string' ? task.finalPath : '',
    error: typeof task.error === 'string' && task.error ? task.error : '',
    errorCode: task.errorCode ? String(task.errorCode) : '',
    createdAt: Number(task.createdAt) || 0,
    finishedAt: Number.isFinite(task.finishedAt) ? Number(task.finishedAt) : null,
    infoHash: typeof task.infoHash === 'string' ? task.infoHash : '',
  }
}

function toHeaderList(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined
  const list = []
  for (const [name, value] of Object.entries(headers)) {
    if (!name || value === undefined || value === null || value === '') continue
    list.push({ name, value: typeof value === 'string' ? value : JSON.stringify(value) })
  }
  return list.length > 0 ? list : undefined
}

/** Submit a download. `spec` is { kind: 'url', url, filename?, headers? } | { kind: 'magnet', url } | { kind: 'torrent', base64, displayName? }. */
export async function addDownload(endpoint, { saveDir, spec }) {
  const params = { saveDir }
  if (spec.kind === 'url') {
    params.kind = 'url'
    params.uris = [spec.url]
    if (spec.filename) params.filename = spec.filename
    const headers = toHeaderList(spec.headers)
    if (headers) params.headers = headers
  } else if (spec.kind === 'magnet') {
    params.kind = 'magnet'
    params.uri = spec.url
  } else if (spec.kind === 'torrent') {
    params.kind = 'torrent'
    params.base64 = spec.base64
    if (spec.displayName) params.displayName = spec.displayName
  } else {
    throw new Error(`不支持的下载类型：${spec.kind}`)
  }
  params.idempotencyKey = idempotencyKey()
  const task = await bridgeCall(endpoint, 'download/add', params, { timeoutMs: 15_000 })
  return projectTask(task)
}

export async function getTask(endpoint, taskId) {
  const result = await bridgeCall(endpoint, 'task/get', { taskId })
  const task = result && result.task
  return task ? projectTask(task) : null
}

export async function listTasks(endpoint, { limit = 10, status } = {}) {
  const params = { limit }
  if (status) params.status = status
  const result = await bridgeCall(endpoint, 'task/list', params)
  const tasks = Array.isArray(result && result.tasks) ? result.tasks.map(projectTask) : []
  return { tasks, total: Number(result && result.total) || tasks.length }
}

export async function getStats(endpoint) {
  const stats = await bridgeCall(endpoint, 'stats/get', {})
  return {
    downloadSpeed: Number(stats && stats.totalDownloadSpeed) || 0,
    uploadSpeed: Number(stats && stats.totalUploadSpeed) || 0,
    activeTasks: Number(stats && stats.activeTasks) || 0,
    waitingTasks: Number(stats && stats.waitingTasks) || 0,
    stoppedTasks: Number(stats && stats.stoppedTasks) || 0,
  }
}

export async function pauseTask(endpoint, taskId) {
  return bridgeCall(endpoint, 'task/pause', { taskId })
}

export async function resumeTask(endpoint, taskId) {
  return bridgeCall(endpoint, 'task/resume', { taskId })
}

export async function removeTask(endpoint, taskId, { deleteFiles = false } = {}) {
  return bridgeCall(endpoint, 'task/remove', { taskId, deleteFiles })
}

/** Poll task/get until the task finishes or the wait budget runs out. */
export async function waitForTask(endpoint, taskId, { timeoutMs = 0, pollMs = 500 } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    const task = await getTask(endpoint, taskId)
    if (!task) return { task: null, timedOut: false }
    if (isTerminalStatus(task.status)) return { task, timedOut: false }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { task, timedOut: true }
    await delay(Math.min(pollMs, remaining))
  }
}
