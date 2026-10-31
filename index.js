/**
 * dsh-motrix-download — route model download requests to the local Motrix
 * desktop app through its MDXP bridge, with a built-in direct HTTP fallback.
 *
 * Model-facing surface:
 *   - download          submit a URL / magnet / .torrent download
 *   - download_status   inspect or wait for Motrix tasks
 *   - download_control  pause / resume / cancel / delete a task
 *
 * A short system-prompt section makes "prefer Motrix" explicit for download
 * requests that arrive as ordinary conversation rather than a tool choice.
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'

import {
  addDownload,
  BridgeAuthError,
  BridgeUnavailableError,
  delay,
  ensureBridge,
  formatBytes,
  getStats,
  getTask,
  isTerminalStatus,
  listTasks,
  pauseTask,
  readMotrixState,
  removeTask,
  resumeTask,
  statusText,
  waitForTask,
} from './lib/motrix.mjs'
import { directDownload } from './lib/fallback.mjs'

export const name = 'dsh-motrix-download'
export const inject = ['tools']

const PROMPT_SECTION = {
  name: 'motrix-download',
  order: 5900,
  text: [
    '下载任务：需要把网络资源（HTTP/HTTPS 链接、磁力链接、.torrent 种子文件）保存到本地时，优先调用 download 工具——它会把任务交给本机 Motrix（aria2）下载，Motrix 不可用时自动回退为内置直连下载。',
    '调用 download 时必须指定 save_dir（下载到哪个目录）。用户没有说明保存位置时，先问清楚再下载，不要自行猜测目录。',
    '除非用户明确要求或 download 工具不可用，不要用 curl/wget 等命令代替下载。',
  ].join('\n'),
}

const URL_SCHEMES = /^(https?|ftps?|sftp):\/\//i

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function textBlock(text) {
  return [{ type: 'text', text }]
}

function sessionCwd(exec) {
  const header = exec && exec.agent && exec.agent.session && exec.agent.session.header
  return (header && header.cwd) || process.cwd()
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function describeError(error) {
  if (!error) return '未知错误'
  return typeof error.message === 'string' && error.message ? error.message : String(error)
}

function progressPercent(task) {
  const ratio = task && Number.isFinite(task.progress) ? task.progress : 0
  return Math.round(ratio * 100)
}

function formatDuration(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 60) return `${Math.round(n)} 秒`
  const minutes = Math.floor(n / 60)
  const rest = Math.round(n % 60)
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function describeTask(task) {
  const parts = [statusText(task.status), `${progressPercent(task)}%`]
  if (task.bytesTotal !== null && task.bytesTotal > 0) {
    parts.push(`${formatBytes(task.bytesDone)} / ${formatBytes(task.bytesTotal)}`)
  } else if (task.bytesDone > 0) {
    parts.push(formatBytes(task.bytesDone))
  }
  if (task.speedBps > 0) parts.push(`${formatBytes(task.speedBps)}/s`)
  if (task.etaSec) parts.push(`剩余 ${formatDuration(task.etaSec)}`)
  return parts.join(' · ')
}

/** Parse the user's target into the MDXP download spec. */
function normalizeTarget(raw, cwd) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('url 不能为空')
  if (/^magnet:/i.test(text)) {
    if (!/^magnet:\?/i.test(text)) throw new Error('磁力链接格式无效（应以 magnet:? 开头）')
    return { kind: 'magnet', url: text }
  }
  if (URL_SCHEMES.test(text)) return { kind: 'url', url: text }

  const absPath = path.resolve(cwd, text)
  if (existsSync(absPath)) {
    if (!/\.torrent$/i.test(absPath)) throw new Error(`本地文件不是 .torrent 种子：${absPath}`)
    return { kind: 'torrentFile', path: absPath }
  }

  if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(text)) return { kind: 'url', url: `https://${text}` }
  throw new Error(`无法识别的下载地址：${text}（支持 http/https/ftp/ftps/sftp、magnet:、本地 .torrent 文件路径）`)
}

function resolveSaveDir(saveDirArg, cwd) {
  if (typeof saveDirArg !== 'string' || !saveDirArg.trim()) {
    throw new Error('缺少 save_dir：请指定下载保存到哪个目录（如 C:\\Users\\<用户>\\Downloads），不确定时先询问用户')
  }
  return path.resolve(cwd, saveDirArg.trim())
}

function buildMotrixMessage(task, { timedOut, saveDir }) {
  const pct = progressPercent(task)
  if (task.status === 'completed') {
    return `已下载完成：${task.finalPath || task.name}（${formatBytes(task.bytesTotal || task.bytesDone)}）`
  }
  if (timedOut) {
    return `已提交到 Motrix，等待期间未完成（当前${statusText(task.status)}，${pct}%）；任务仍在 Motrix 中继续，可用 download_status 查询进度`
  }
  const where = task.finalPath
    ? `；保存路径：${task.finalPath}`
    : task.saveDir || saveDir
      ? `；保存目录：${task.saveDir || saveDir}`
      : ''
  return `已提交到 Motrix（${describeTask(task)}）${where}`
}

async function finishTask(endpoint, task, { waitSeconds, saveDir, launched }) {
  let current = task
  let timedOut = false

  if (waitSeconds > 0 && !isTerminalStatus(current.status)) {
    const result = await waitForTask(endpoint, current.taskId, { timeoutMs: waitSeconds * 1000 })
    if (result.task) current = result.task
    else {
      return {
        ok: false,
        backend: 'motrix',
        taskId: current.taskId,
        error: '任务在等待期间被移除（可能已在 Motrix 中删除）',
      }
    }
    timedOut = result.timedOut
  }

  const payload = {
    backend: 'motrix',
    taskId: current.taskId,
    type: current.type,
    status: current.status,
    name: current.name,
    progress: current.progress,
    bytesDone: current.bytesDone,
    bytesTotal: current.bytesTotal,
    speedBps: current.speedBps,
    etaSec: current.etaSec,
    saveDir: current.saveDir || saveDir,
    finalPath: current.finalPath,
    timedOut,
    launched: Boolean(launched),
  }

  if (current.status === 'error') {
    return {
      ok: false,
      ...payload,
      error: `Motrix 下载出错${current.errorCode ? `（${current.errorCode}）` : ''}：${current.error || '未知原因'}`,
    }
  }

  return {
    ok: true,
    ...payload,
    message: buildMotrixMessage(current, { timedOut, saveDir }),
    note: launched ? 'Motrix 之前未运行，已自动启动' : '',
  }
}

/* ------------------------------------------------------------------ *
 * 工具 1：download
 * ------------------------------------------------------------------ */

const downloadTool = {
  name: 'download',
  description:
    '下载网络资源到本地：优先交给本机 Motrix（aria2）下载（任务会出现在 Motrix 中，可暂停/恢复），Motrix 不可用时自动回退为内置直连下载。支持 HTTP/HTTPS/FTP 链接、magnet 磁力链接、本地 .torrent 种子文件。必须指定 save_dir（下载到哪个目录）；用户未说明保存位置时，先询问用户再下载。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: {
        type: 'string',
        description: '下载地址：http/https/ftp/ftps/sftp 链接、magnet:? 磁力链接，或本地 .torrent 种子文件路径',
      },
      save_dir: {
        type: 'string',
        description: '必填：下载到哪个目录（绝对路径，或相对当前工作区的路径），如 C:\\Users\\<用户>\\Downloads 或 .',
      },
      filename: {
        type: 'string',
        description: '另存文件名（仅对单文件的 HTTP/HTTPS 下载有效；磁力/种子忽略此参数）',
      },
      headers: {
        type: 'object',
        description: '额外的 HTTP 请求头（键值均为字符串），如 {"Referer":"https://example.com"}（仅 HTTP/HTTPS 下载有效）',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'motrix', 'direct'],
        default: 'auto',
        description:
          '下载引擎：auto=优先 Motrix、失败回退直连（默认）；motrix=只用 Motrix（磁力/种子必须用此项）；direct=跳过 Motrix 直接下载（仅 http/https）',
      },
      wait_seconds: {
        type: 'integer',
        default: 0,
        description: '最多等待任务完成的秒数（0-3600）；0 表示提交后立即返回任务信息',
      },
    },
    required: ['url', 'save_dir'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean', description: '是否成功' },
        backend: { type: 'string', description: 'motrix 或 http' },
        taskId: { type: 'string', description: 'Motrix 任务 id' },
        status: {
          type: 'string',
          description: 'Motrix 任务状态：queued/fetching_metadata/downloading/paused/seeding/finalizing/completed/error',
        },
        name: { type: 'string' },
        progress: { type: 'number', description: '完成比例 0-1' },
        bytesDone: { type: 'integer' },
        speedBps: { type: 'integer' },
        saveDir: { type: 'string' },
        finalPath: { type: 'string', description: '完成后的文件绝对路径' },
        path: { type: 'string', description: '直连下载完成后的绝对路径' },
        bytes: { type: 'integer' },
        timedOut: { type: 'boolean' },
        message: { type: 'string' },
        note: { type: 'string' },
        error: { type: 'string' },
      },
    },
    render: renderDownload,
  },
  async execute(args, exec) {
    const cwd = sessionCwd(exec)
    const engine = args.engine === 'motrix' || args.engine === 'direct' ? args.engine : 'auto'
    const waitSeconds = clampInt(args.wait_seconds, 0, 0, 3600)
    const headers =
      args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers) ? args.headers : undefined

    let target
    let saveDir
    try {
      target = normalizeTarget(args.url, cwd)
      saveDir = resolveSaveDir(args.save_dir, cwd)
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }

    const state = await readMotrixState()
    await mkdir(saveDir, { recursive: true }).catch(() => {})

    const isTorrent = target.kind === 'torrentFile' || target.kind === 'torrent'
    const isMagnet = target.kind === 'magnet'
    const isHttpUrl = target.kind === 'url' && /^https?:/i.test(target.url)
    let motrixError = ''

    if (engine !== 'direct') {
      const bridge = await ensureBridge(state, { autoLaunch: true })
      if (bridge.ok) {
        try {
          let spec
          if (isTorrent) {
            const base64 = (await readFile(target.path)).toString('base64')
            spec = { kind: 'torrent', base64, displayName: path.basename(target.path, path.extname(target.path)) }
          } else if (isMagnet) {
            spec = { kind: 'magnet', url: target.url }
          } else {
            spec = { kind: 'url', url: target.url, filename: args.filename, headers }
          }
          const task = await addDownload(bridge.endpoint, { saveDir, spec })
          return await finishTask(bridge.endpoint, task, {
            waitSeconds,
            saveDir,
            launched: Boolean(bridge.launched),
          })
        } catch (error) {
          if (error instanceof BridgeUnavailableError || error instanceof BridgeAuthError) {
            motrixError = describeError(error)
          } else {
            // The bridge answered: this is an authoritative Motrix rejection
            // (invalid URL, unavailable directory, duplicate id, ...).
            return { ok: false, backend: 'motrix', error: `Motrix 拒绝了下载任务：${describeError(error)}` }
          }
        }
      } else {
        motrixError = describeError(bridge)
      }
    }

    if (engine === 'motrix') {
      return { ok: false, backend: 'motrix', error: motrixError || 'Motrix 不可用，且指定了只用 Motrix' }
    }

    if (!isHttpUrl) {
      const kindText = isMagnet ? '磁力链接' : isTorrent ? '种子文件' : '该下载地址'
      return {
        ok: false,
        backend: 'motrix',
        error: `${kindText}需要 Motrix 才能下载，而 ${motrixError || 'Motrix 当前不可用'}`,
      }
    }

    const note = motrixError ? `Motrix 不可用（${motrixError}），已回退为直连下载` : ''
    try {
      const file = await directDownload(target.url, { saveDir, filename: args.filename, headers })
      return {
        ok: true,
        backend: 'http',
        path: file.path,
        bytes: file.bytes,
        saveDir: file.saveDir,
        contentType: file.contentType,
        finalUrl: file.finalUrl,
        note,
        message: `已直连下载：${file.path}（${formatBytes(file.bytes)}）`,
      }
    } catch (error) {
      return { ok: false, backend: 'http', error: `直连下载失败：${describeError(error)}`, note }
    }
  },
}

function renderDownload(_args, value) {
  if (!value || value.ok !== true) {
    const lines = [`❌ 下载失败：${(value && value.error) || '未知错误'}`]
    if (value && value.note) lines.push(value.note)
    if (value && value.taskId) lines.push(`任务 id：${value.taskId}`)
    return textBlock(lines.join('\n'))
  }

  if (value.backend === 'http') {
    const lines = ['⬇️ 直连下载完成（Motrix 未参与）', `文件：${value.path}`, `大小：${formatBytes(value.bytes)}`]
    if (value.note) lines.push(`说明：${value.note}`)
    return textBlock(lines.join('\n'))
  }

  const lines = [
    `⬇️ 已交给 Motrix 下载（任务 id ${value.taskId}）`,
    `文件：${value.name}`,
    `状态：${statusText(value.status)} · ${progressPercent(value)}%`,
  ]
  if (value.bytesTotal > 0) lines.push(`进度：${formatBytes(value.bytesDone)} / ${formatBytes(value.bytesTotal)}`)
  if (value.finalPath) lines.push(`保存路径：${value.finalPath}`)
  else if (value.saveDir) lines.push(`保存目录：${value.saveDir}`)
  if (value.status === 'downloading' && value.speedBps > 0) lines.push(`速度：${formatBytes(value.speedBps)}/s`)
  if (value.timedOut) lines.push('⏳ 等待超时：任务仍在 Motrix 中继续，可用 download_status 查看进度')
  if (value.launched) lines.push('ℹ️ Motrix 之前未运行，已自动启动')
  return textBlock(lines.join('\n'))
}

/* ------------------------------------------------------------------ *
 * 工具 2：download_status
 * ------------------------------------------------------------------ */

const downloadStatusTool = {
  name: 'download_status',
  description:
    '查询 Motrix 下载任务：传入 task_id 时返回该任务详情（可等待完成），不传时列出当前下载中、排队中和最近结束的任务及全局速度。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task_id: { type: 'string', description: '任务 id（download 工具返回的 taskId 或 id）；省略则列出任务列表' },
      wait_seconds: {
        type: 'integer',
        default: 0,
        description: '传入 task_id 时最多等待完成的秒数（0-3600）；0 表示只查询一次',
      },
      limit: {
        type: 'integer',
        default: 10,
        description: '列表模式下最多返回的任务条数（1-50）',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        backend: { type: 'string' },
        task: { type: 'object', additionalProperties: true },
        tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        stats: { type: 'object', additionalProperties: true },
        message: { type: 'string' },
        error: { type: 'string' },
      },
    },
    render: renderStatus,
  },
  async execute(args) {
    const state = await readMotrixState()
    const bridge = await ensureBridge(state, { autoLaunch: false })
    if (!bridge.ok) {
      return {
        ok: false,
        error: `Motrix 不可用：${describeError(bridge)}。可先调用 download 让它自动启动后重试。`,
      }
    }

    const waitSeconds = clampInt(args.wait_seconds, 0, 0, 3600)
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''

    if (taskId) {
      let task
      try {
        task = await getTask(bridge.endpoint, taskId)
      } catch (error) {
        return { ok: false, error: `查询任务 ${taskId} 失败：${describeError(error)}` }
      }
      if (!task) return { ok: false, error: `任务 ${taskId} 不存在（可能已被删除）` }

      let timedOut = false
      if (waitSeconds > 0 && !isTerminalStatus(task.status)) {
        const result = await waitForTask(bridge.endpoint, taskId, { timeoutMs: waitSeconds * 1000 })
        if (result.task) task = result.task
        timedOut = result.timedOut
      }
      return {
        ok: true,
        backend: 'motrix',
        task,
        summary: describeTask(task),
        timedOut,
        message:
          task.status === 'completed'
            ? `任务已完成：${task.finalPath || task.name}（${formatBytes(task.bytesTotal || task.bytesDone)}）`
            : `任务${statusText(task.status)}：${describeTask(task)}`,
      }
    }

    const limit = clampInt(args.limit, 10, 1, 50)
    try {
      const [listed, stats] = await Promise.all([listTasks(bridge.endpoint, { limit }), getStats(bridge.endpoint)])
      return {
        ok: true,
        backend: 'motrix',
        tasks: listed.tasks,
        total: listed.total,
        stats,
        message: listed.tasks.length > 0 ? `共 ${listed.tasks.length} 个任务` : 'Motrix 当前没有任务',
      }
    } catch (error) {
      return { ok: false, error: `查询任务列表失败：${describeError(error)}` }
    }
  },
}

function renderStatus(_args, value) {
  if (!value || value.ok !== true) return textBlock(`❌ 查询失败：${(value && value.error) || '未知错误'}`)

  if (value.task) {
    const task = value.task
    const lines = [`📥 ${task.name}`, `状态：${describeTask(task)}`, `任务 id：${task.taskId}`]
    if (task.finalPath) lines.push(`文件：${task.finalPath}`)
    else if (task.saveDir) lines.push(`保存目录：${task.saveDir}`)
    if (task.error) lines.push(`错误：${task.errorCode ? `${task.errorCode} ` : ''}${task.error}`)
    if (value.timedOut) lines.push('⏳ 等待超时：任务仍在继续')
    return textBlock(lines.join('\n'))
  }

  const tasks = Array.isArray(value.tasks) ? value.tasks : []
  if (tasks.length === 0) return textBlock('Motrix 当前没有任务')
  const lines = []
  const stats = value.stats || {}
  lines.push(
    `全局：下载 ${formatBytes(stats.downloadSpeed)}/s · 活动 ${stats.activeTasks || 0} · 等待 ${stats.waitingTasks || 0} · 已结束 ${stats.stoppedTasks || 0}`,
  )
  lines.push('')
  tasks.forEach((task, index) => {
    lines.push(`${index + 1}. [${statusText(task.status)} ${progressPercent(task)}%] ${task.name}`)
    lines.push(`   任务 id：${task.taskId}`)
    if (task.finalPath) lines.push(`   文件：${task.finalPath}`)
    else if (task.saveDir) lines.push(`   保存目录：${task.saveDir}`)
    if (task.error) lines.push(`   错误：${task.errorCode ? `${task.errorCode} ` : ''}${task.error}`)
  })
  return textBlock(lines.join('\n'))
}

/* ------------------------------------------------------------------ *
 * 工具 3：download_control
 * ------------------------------------------------------------------ */

const CONTROLS = {
  pause: { label: '暂停', run: (endpoint, taskId) => pauseTask(endpoint, taskId) },
  resume: { label: '继续', run: (endpoint, taskId) => resumeTask(endpoint, taskId) },
  cancel: { label: '取消', run: (endpoint, taskId) => removeTask(endpoint, taskId, { deleteFiles: false }) },
  purge: { label: '删除', run: (endpoint, taskId) => removeTask(endpoint, taskId, { deleteFiles: true }) },
}

const downloadControlTool = {
  name: 'download_control',
  description:
    '控制 Motrix 下载任务：暂停、继续、取消（停止并从 Motrix 移除任务，保留已下载文件）或彻底删除（移除任务并删除已下载文件，谨慎使用）。task_id 来自 download 或 download_status。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task_id: { type: 'string', description: '任务 id' },
      action: {
        type: 'string',
        enum: ['pause', 'resume', 'cancel', 'purge'],
        description: 'pause=暂停；resume=继续；cancel=取消并移除任务但保留文件；purge=删除任务及文件',
      },
    },
    required: ['task_id', 'action'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        taskId: { type: 'string' },
        action: { type: 'string' },
        status: { type: 'string' },
        message: { type: 'string' },
        error: { type: 'string' },
      },
    },
    render: (args, value) =>
      value && value.ok
        ? textBlock(
            `✅ 已${(CONTROLS[args && args.action] || {}).label || args.action}任务 ${value.taskId}${value.status ? `（${statusText(value.status)}）` : ''}`,
          )
        : textBlock(`❌ 操作失败：${(value && value.error) || '未知错误'}`),
  },
  async execute(args) {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
    const action = typeof args.action === 'string' ? args.action : ''
    const control = CONTROLS[action]
    if (!taskId) return { ok: false, error: 'task_id 不能为空' }
    if (!control) return { ok: false, error: `action 必须是 ${Object.keys(CONTROLS).join('/')} 之一` }

    const state = await readMotrixState()
    const bridge = await ensureBridge(state, { autoLaunch: false })
    if (!bridge.ok) return { ok: false, error: `Motrix 不可用：${describeError(bridge)}` }

    try {
      await control.run(bridge.endpoint, taskId)
    } catch (error) {
      return { ok: false, taskId, action, error: describeError(error) }
    }

    let status = ''
    try {
      const task = await getTask(bridge.endpoint, taskId)
      status = task ? task.status : 'removed'
    } catch {
      status = action === 'pause' || action === 'resume' ? '' : 'removed'
    }
    return { ok: true, taskId, action, status, message: `已${control.label}任务 ${taskId}` }
  },
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/** Own a registration with ctx.effect so plugin unload / HMR reload disposes it. */
function ownEffect(ctx, register) {
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => register())
    return
  }
  register()
}

export function apply(ctx) {
  ownEffect(ctx, () => ctx.tools.register(downloadTool))
  ownEffect(ctx, () => ctx.tools.register(downloadStatusTool))
  ownEffect(ctx, () => ctx.tools.register(downloadControlTool))

  // Make "prefer Motrix" explicit in the system prompt as well: a user may ask
  // for a download in prose without naming a tool. Registration failures must
  // never break the tools, so the section is best-effort.
  try {
    const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      ownEffect(ctx, () => systemPrompt.section(PROMPT_SECTION))
    }
  } catch (error) {
    console.warn(`[motrix-download] 系统提示词片段注册失败：${describeError(error)}`)
  }
}
