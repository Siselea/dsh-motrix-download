/**
 * Standalone smoke test for the Motrix download plugin.
 *
 * Runs the plugin's `apply()` against a minimal fake context, then exercises the
 * real tool definitions end-to-end (no Harness required):
 *   1. Motrix bridge + task list (download_status without task_id)
 *   2. a real Motrix download that must complete and report finalPath
 *   3. task list after the download
 *   4. the direct-download fallback (engine=direct)
 *   5. invalid input rejection
 *
 * Usage:
 *   node smoke.mjs
 */

import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, stat } from 'node:fs/promises'

const { apply } = await import('./index.js')

const tools = new Map()
const sections = []
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  get(name) {
    if (name !== 'systemPrompt') return undefined
    return {
      section(section) {
        sections.push(section)
        return () => {}
      },
    }
  },
}

apply(ctx)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('registered tools :', [...tools.keys()].join(', '))
console.log('prompt sections  :', sections.map((s) => `${s.name}@${s.order}`).join(', '))
check('3 tools registered', tools.size === 3)
check('prompt section registered', sections.length === 1)
check(
  'tool schemas expose description',
  [...tools.values()].every((t) => typeof t.description === 'string' && t.description.length > 10),
)

const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-motrix-smoke-'))
const created = []

try {
  const download = tools.get('download')
  const status = tools.get('download_status')
  const control = tools.get('download_control')

  console.log('\n--- Motrix probe (status list) ---')
  const probe = await status.execute({ limit: 5 })
  console.log(JSON.stringify({ ok: probe.ok, total: probe.total, stats: probe.stats, error: probe.error }).slice(0, 400))
  check('Motrix bridge reachable', probe.ok === true, probe.ok ? '' : probe.error)

  const target = process.env.SMOKE_URL || 'https://www.example.com/'

  console.log('\n--- Motrix download (wait up to 120s) ---')
  const started = Date.now()
  const motrix = await download.execute({
    url: target,
    save_dir: tmp,
    filename: 'motrix-smoke.html',
    wait_seconds: 120,
  })
  console.log(JSON.stringify(motrix, null, 2).slice(0, 900))
  check('motrix backend used', motrix.backend === 'motrix', motrix.backend)
  check('motrix download completed', motrix.status === 'completed', `status=${motrix.status}`)
  check('motrix taskId returned', typeof motrix.taskId === 'string' && motrix.taskId.length > 0, motrix.taskId)
  if (motrix.status === 'completed') {
    check('motrix finalPath absolute', Boolean(motrix.finalPath) && path.isAbsolute(motrix.finalPath), motrix.finalPath)
    if (motrix.finalPath) {
      const info = await stat(motrix.finalPath)
      check('motrix file non-empty', info.size > 0, `${info.size} bytes in ${Date.now() - started}ms`)
      created.push(motrix.finalPath)
    }
    const got = await status.execute({ task_id: motrix.taskId })
    check('status by task_id', got.ok === true && got.task && got.task.status === 'completed', got.error || got.task?.status)
    const purge = await control.execute({ task_id: motrix.taskId, action: 'purge' })
    check('purge task', purge.ok === true, purge.error || `status=${purge.status}`)
    const gone = await status.execute({ task_id: motrix.taskId })
    check('purged task gone', gone.ok === false, gone.error)
  }

  console.log('\n--- task list ---')
  const list = await status.execute({ limit: 5 })
  console.log(JSON.stringify({ ok: list.ok, tasks: (list.tasks || []).length, stats: list.stats }).slice(0, 300))
  check('task list ok', list.ok === true)

  console.log('\n--- direct fallback (engine=direct) ---')
  const direct = await download.execute({
    url: target,
    save_dir: tmp,
    filename: 'direct-smoke.html',
    engine: 'direct',
  })
  console.log(JSON.stringify(direct).slice(0, 400))
  check('direct backend used', direct.backend === 'http', direct.backend)
  if (direct.ok && direct.path) {
    const info = await stat(direct.path)
    check('direct file non-empty', info.size > 0, `${info.size} bytes`)
    created.push(direct.path)
  }

  console.log('\n--- invalid input ---')
  const bad = await download.execute({ url: 'not a url', engine: 'direct' })
  console.log(JSON.stringify(bad).slice(0, 200))
  check('invalid url rejected', bad.ok === false, bad.error)

  const noDir = await download.execute({ url: target })
  console.log(JSON.stringify(noDir).slice(0, 200))
  check('missing save_dir rejected', noDir.ok === false && /save_dir/.test(noDir.error || ''), noDir.error)
} finally {
  for (const file of created) await rm(file, { force: true }).catch(() => {})
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((item) => item.name).join(', '))
    process.exitCode = 1
  }
}
