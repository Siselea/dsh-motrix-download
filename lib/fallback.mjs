/**
 * Minimal direct HTTP(S) downloader used when Motrix is unavailable.
 * It exists so a download request still succeeds without the desktop app;
 * it intentionally implements no resume, torrent, or multi-connection logic.
 */

import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { URL } from 'node:url'

const MAX_REDIRECTS = 5

function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || 'download'
}

function filenameFromDisposition(header) {
  if (typeof header !== 'string' || !header) return ''
  const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (utf8 && utf8[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''))
    } catch {
      return utf8[1].trim().replace(/^"|"$/g, '')
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  return plain && plain[1] ? plain[1].trim() : ''
}

function filenameFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    const base = decodeURIComponent(path.posix.basename(parsed.pathname))
    return base && base !== '/' ? base : ''
  } catch {
    return ''
  }
}

async function nextAvailablePath(saveDir, filename) {
  const target = path.join(saveDir, filename)
  try {
    await stat(target)
  } catch {
    return target
  }
  const ext = path.extname(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(saveDir, `${stem} (${i})${ext}`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  return path.join(saveDir, `${stem}-${Date.now()}${ext}`)
}

function requestStream(url, headers, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`无效 URL：${url}`))
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`直连下载仅支持 http/https：${url}`))
      return
    }
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.request(
      parsed,
      {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: '*/*',
          ...(headers && typeof headers === 'object' ? headers : {}),
        },
      },
      (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            reject(new Error('重定向次数过多'))
            return
          }
          const next = new URL(res.headers.location, url).toString()
          resolve(requestStream(next, headers, redirectsLeft - 1))
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          reject(new Error(`HTTP ${status} ${res.statusMessage || ''}`.trim()))
          return
        }
        resolve({ res, finalUrl: url })
      },
    )
    req.setTimeout(60_000, () => req.destroy(new Error('连接超时（60 秒无响应）')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * Download `url` into `saveDir` and return the absolute path.
 * @returns {Promise<{partPath: string, finalUrl: string, contentType: string, requestedName: string}>}
 */
export async function directDownload(url, { saveDir, filename, headers, signal } = {}) {
  if (signal && signal.aborted) throw new Error('下载已取消')
  const dir = path.resolve(saveDir || process.cwd())
  await mkdir(dir, { recursive: true })

  const { res, finalUrl } = await requestStream(url, headers, MAX_REDIRECTS)
  if (signal && signal.aborted) {
    res.destroy()
    throw new Error('下载已取消')
  }

  const contentType = String(res.headers['content-type'] || '')
  const suggested =
    (filename && sanitizeFilename(filename)) ||
    (filenameFromDisposition(res.headers['content-disposition']) || filenameFromUrl(finalUrl) || 'download')
  const target = await nextAvailablePath(dir, sanitizeFilename(suggested))
  const partPath = `${target}.part`
  const expected = Number(res.headers['content-length'])

  await new Promise((resolve, reject) => {
    const out = createWriteStream(partPath)
    let bytes = 0
    const onAbort = () => {
      res.destroy()
      out.destroy()
      reject(new Error('下载已取消'))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    res.on('data', (chunk) => {
      bytes += chunk.length
    })
    res.on('error', (error) => {
      out.destroy()
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    out.on('error', (error) => {
      res.destroy()
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    out.on('finish', () => {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (Number.isFinite(expected) && expected > 0 && bytes !== expected) {
        reject(new Error(`下载不完整：收到 ${bytes} / ${expected} 字节`))
        return
      }
      resolve()
    })
    res.pipe(out)
  }).catch(async (error) => {
    await rm(partPath, { force: true }).catch(() => {})
    throw error
  })

  await rename(partPath, target)
  const info = await stat(target)
  return { path: target, bytes: info.size, contentType, finalUrl, saveDir: dir }
}
