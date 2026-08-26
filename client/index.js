#!/usr/bin/env node
'use strict'

// DeepSeek Harness TUI — a zero-dependency terminal client for the tui-bridge.
//
//   node client/index.js                         interactive TUI
//   node client/index.js --list                  list sessions and exit
//   node client/index.js --once "hello"          one-shot message, print reply
//   node client/index.js --session <id> --once "hi"   resume + one-shot
//   node client/index.js --dump <file>           run interactive, write each
//                                                rendered frame (plain text) to <file>

const http = require('node:http')
const readline = require('node:readline')

// ---------------------------------------------------------------- config ---
const ARGV = process.argv.slice(2)
function opt(name, fallback) {
  const i = ARGV.indexOf('--' + name)
  return i >= 0 && ARGV[i + 1] !== undefined && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : fallback
}
function has(name) { return ARGV.includes('--' + name) }

const BASE = opt('url', process.env.DSH_WEB_URL || 'http://127.0.0.1:43120')
const CWD = opt('cwd', process.cwd())
const PRESET = opt('preset', 'standard')
const SESSION = opt('session', '')
const ONCE = opt('once', '')
const DUMP = opt('dump', '')
const LIST = has('list')

const WIDTH = () => (process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 100)
const HEIGHT = () => (process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 30)

// ---------------------------------------------------------------- http -----
function post(op, extra) {
  return new Promise((resolve, reject) => {
    const payload = Object.assign({ op }, extra || {})
    const body = JSON.stringify(payload)
    const req = http.request(BASE + '/tui/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('bad response: ' + data.slice(0, 200))) }
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(new Error('command timeout')) })
    req.end(body)
  })
}

function connectSSE(onEvent) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + '/tui/events', { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('SSE status ' + res.statusCode)); return }
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            try { onEvent(JSON.parse(payload)) } catch (e) { /* ignore malformed */ }
          }
        }
      })
      res.on('error', (e) => { /* keep going; caller observes */ })
      resolve()
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- state ----
const state = {
  sessionId: SESSION,
  preset: PRESET,
  cwd: CWD,
  connected: false,
  status: 'idle',
  items: [],          // committed history: { kind: 'user'|'assistant'|'reasoning'|'tool'|'error'|'system', text, callId?, status? }
  live: { reasoning: '', text: '' },
  input: '',
  replaying: false
}

function pushItem(kind, text, extra) {
  const item = Object.assign({ kind, text: String(text == null ? '' : text) }, extra || {})
  state.items.push(item)
  return item
}

function commitLive() {
  if (state.live.reasoning) pushItem('reasoning', state.live.reasoning)
  if (state.live.text) pushItem('assistant', state.live.text)
  state.live.reasoning = ''
  state.live.text = ''
}

function textBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
}

// ---------------------------------------------------------------- events ---
function handleEvent(ev) {
  if (ev.type === 'hello') { state.connected = true; return }
  if (ev.type === 'agent_status') {
    if (ev.sessionId === state.sessionId) state.status = ev.status
    return
  }
  if (ev.type === 'agent_error') {
    if (ev.sessionId === state.sessionId) pushItem('error', 'agent error: ' + ev.error)
    return
  }
  if (ev.type !== 'session_event' || ev.sessionId !== state.sessionId) return

  const e = ev.event
  const d = e.data

  switch (e.type) {
    case 'user/message': {
      // skip plugin-injected messages (runtime-context snapshot, system-reminder)
      const src = d && d.source
      if (src && src.kind !== 'user') break
      if (state.replaying) { const t = textBlocks(d && d.content); if (t) pushItem('user', t) }
      else { commitLive(); const t = textBlocks(d && d.content); if (t) pushItem('user', t) }
      break
    }
    case 'assistant/chunk': {
      if (state.replaying) break
      const c = d && d.chunk
      if (!c) break
      if (c.type === 'text-delta') state.live.text += (c.text || '')
      else if (c.type === 'reasoning-delta') state.live.reasoning += (c.text || '')
      break
    }
    case 'assistant/message': {
      if (state.replaying) {
        const m = d && d.message
        if (m && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === 'reasoning' && b.text) pushItem('reasoning', b.text)
            else if (b.type === 'text' && b.text) pushItem('assistant', b.text)
          }
        }
      } else if (!state.live.text && !state.live.reasoning) {
        const m = d && d.message
        if (m && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b.type === 'reasoning' && b.text) state.live.reasoning += b.text
            else if (b.type === 'text' && b.text) state.live.text += b.text
          }
        }
        commitLive()
      }
      break
    }
    case 'tool/call': {
      pushItem('tool', d.name, { callId: d.callId, status: 'running' })
      break
    }
    case 'tool/result': {
      const callId = d && d.message && d.message.source && d.message.source.callId
      const item = state.items.findLast((x) => x.kind === 'tool' && x.callId === callId)
      if (item) item.status = 'done'
      break
    }
    case 'turn/end': {
      commitLive()
      break
    }
    case 'session/title': {
      // titles are not rendered inline; ignored
      break
    }
    default:
      break
  }
}

function afterEvent() {
  if (DUMP) dumpFrame()
}

// ---------------------------------------------------------------- render ---
function wrap(text, width) {
  if (width <= 0) return []
  const out = []
  for (const raw of String(text).split('\n')) {
    if (raw.length <= width) { out.push(raw); continue }
    let rest = raw
    while (rest.length > width) { out.push(rest.slice(0, width)); rest = rest.slice(width) }
    out.push(rest)
  }
  return out
}

function frameRows() {
  const width = WIDTH()
  const height = HEIGHT()
  const rows = []

  const bar = (c) => c.repeat(width)
  const title = ` DeepSeek Harness TUI  ·  ${state.sessionId || '(no session)'}  ·  ${state.connected ? 'connected' : 'connecting'}  ·  ${state.status} `

  rows.push('┌' + title + '─'.repeat(Math.max(0, width - title.length - 2)) + '┐')
  rows.push('│ preset: ' + state.preset + '  cwd: ' + state.cwd + ' '.repeat(Math.max(0, width - (12 + state.preset.length + state.cwd.length) - 1)) + '│')
  rows.push('├' + bar('─') + '┤')

  // body
  const bodyHeight = Math.max(3, height - 6)
  const lines = []
  function pushBlock(prefix, text) {
    const indent = ' '.repeat(prefix.length)
    const wrapWidth = Math.max(1, width - 2 - prefix.length)
    const wrapped = wrap(text, wrapWidth)
    for (let i = 0; i < wrapped.length; i++) lines.push((i === 0 ? prefix : indent) + wrapped[i])
    lines.push('')
  }
  for (const item of state.items) {
    if (item.kind === 'tool') {
      const mark = item.status === 'done' ? '✔' : '…'
      lines.push(`${mark} ${item.text}  [${item.status}]`)
      lines.push('')
      continue
    }
    const prefix = item.kind === 'user' ? 'you   › ' : item.kind === 'reasoning' ? 'agent › (reasoning) ' : item.kind === 'error' ? '✗ ' : 'agent › '
    pushBlock(prefix, item.text)
  }
  // live streaming
  if (state.live.reasoning) pushBlock('agent › (reasoning) ', state.live.reasoning)
  if (state.live.text) pushBlock('agent › ', state.live.text)

  // take the tail of lines that fit
  const visible = lines.slice(-bodyHeight)
  for (const ln of visible) rows.push('│ ' + (ln.length > width - 2 ? ln.slice(0, width - 2) : ln + ' '.repeat(Math.max(0, width - 2 - ln.length))) + ' │')
  while (rows.length < 3 + bodyHeight) rows.push('│' + ' '.repeat(width - 2) + '│')

  rows.push('├' + bar('─') + '┤')
  const prompt = '❯ ' + state.input
  const shown = prompt.length > width - 4 ? prompt.slice(-(width - 4)) : prompt
  rows.push('│ ' + shown + ' '.repeat(Math.max(0, width - 4 - shown.length)) + ' │')
  rows.push('└' + bar('─') + '┘')
  return rows
}

function paint() {
  const rows = frameRows()
  const width = WIDTH()
  const prompt = '❯ ' + state.input
  const shown = prompt.length > width - 4 ? prompt.slice(-(width - 4)) : prompt
  // hide cursor, home, draw
  let out = '\x1b[?25l\x1b[H'
  out += rows.join('\r\n') + '\r\n'
  // Position the cursor at the end of the visible input on the prompt row:
  //   row   = rows.length - 1 (ANSI is 1-based; prompt is the 2nd-to-last row)
  //   col   = 3 + shown.length ('│ ' is 2 chars, so shown starts at col 3)
  out += '\x1b[' + (rows.length - 1) + ';' + (3 + shown.length) + 'H'
  out += '\x1b[?25h'
  process.stdout.write(out)
}

function dumpFrame() {
  if (!DUMP) return
  const fs = require('node:fs')
  try { fs.writeFileSync(DUMP, frameRows().join('\n') + '\n') } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- modes ----
function printLine() { process.stdout.write('\n') }

async function listMode() {
  const res = await post('list_sessions')
  if (res.error) { console.error('list failed: ' + res.error); process.exit(1) }
  const sessions = res.sessions || []
  console.log('sessions (' + sessions.length + '):')
  for (const s of sessions) {
    const title = s.title ? s.title : '(untitled)'
    const flag = s.tuiOwned ? '●' : ' '
    console.log(`${flag} ${s.id}  ${title}  ${s.cwd || ''}`)
  }
}

async function ensureSession() {
  if (state.sessionId) {
    const r = await post('resume', { sessionId: state.sessionId, preset: PRESET })
    if (r.error) throw new Error('resume failed: ' + r.error)
    return state.sessionId
  }
  const r = await post('create_session', { cwd: CWD, preset: PRESET })
  if (r.error) throw new Error('create failed: ' + r.error)
  state.sessionId = r.sessionId
  return r.sessionId
}

async function loadHistory(sid) {
  const r = await post('read_session', { sessionId: sid })
  if (r.error || !r.events) return
  state.replaying = true
  for (const ev of r.events) {
    // normalize a raw persisted event into the same shape handleEvent expects
    handleEvent({ type: 'session_event', sessionId: sid, event: { type: ev.type, seq: ev.seq, time: ev.time, data: ev.data } })
  }
  state.replaying = false
}

// one-shot: stream the reply to stdout and exit on turn/end
async function onceMode() {
  const sid = await ensureSession()
  await loadHistory(sid)

  let sawRunning = false
  let finished = false
  await connectSSE((ev) => {
    handleEvent(ev)
    afterEvent()
    if (ev.sessionId !== sid) return
    if (ev.type === 'agent_status') {
      if (ev.status === 'running') sawRunning = true
    }
    if (ev.type === 'session_event') {
      const t = ev.event && ev.event.type
      if (t === 'assistant/chunk') {
        const c = ev.event.data && ev.event.data.chunk
        if (c && c.type === 'text-delta' && c.text) process.stdout.write(c.text)
      } else if (t === 'turn/end') {
        if (!finished) { finished = true; printLine() }
      }
    }
  })

  const send = await post('send', { sessionId: sid, text: ONCE })
  if (send.error) { console.error('send failed: ' + send.error); process.exit(1) }

  // wait for turn/end (or timeout)
  const deadline = Date.now() + 180000
  while (!finished && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  printLine()
  afterEvent()
  process.exit(finished ? 0 : 1)
}

// ---------------------------------------------------------------- interactive
function startInteractive() {
  if (!process.stdin.isTTY) {
    console.error('stdin is not a TTY. Use --list or --once for non-interactive use.')
    process.exit(2)
  }
  process.stdin.setRawMode(true)
  readline.emitKeypressEvents(process.stdin)
  process.stdin.resume()

  process.stdin.on('keypress', (str, key) => {
    if (!key) return
    if (key.ctrl && key.name === 'c') { shutdown(); return }
    if (key.ctrl && key.name === 'l') { paint(); return }
    if (key.ctrl && key.name === 'u') { state.input = ''; paint(); return }
    if (key.name === 'return') {
      const text = state.input.trim()
      state.input = ''
      paint()
      if (text && state.sessionId) {
        post('send', { sessionId: state.sessionId, text }).catch((e) => {
          pushItem('error', 'send failed: ' + e.message)
          paint()
        })
      }
      return
    }
    if (key.name === 'backspace') { state.input = state.input.slice(0, -1); paint(); return }
    if (key.name === 'escape') { return }
    if (str && str.length === 1 && !key.ctrl && !key.meta) {
      state.input += str
      paint()
    }
  })

  process.stdout.on('resize', () => paint())
}

function shutdown() {
  try { process.stdout.write('\x1b[?25h\x1b[?1049l\x1b[0m\n') } catch (e) {}
  process.exit(0)
}

// ---------------------------------------------------------------- main -----
async function main() {
  if (LIST) { await listMode(); return }
  if (ONCE) { await onceMode(); return }

  // interactive
  process.stdout.write('\x1b[?1049h') // alternate screen
  paint()
  ;(async () => {
    try {
      await connectSSE((ev) => { handleEvent(ev); afterEvent(); paint() })
      const sid = await ensureSession()
      await loadHistory(sid)
      await post('subscribe', { sessionId: sid })
      state.connected = true
      paint()
    } catch (e) {
      pushItem('error', 'startup failed: ' + e.message)
      paint()
    }
  })()
  startInteractive()
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => { console.error('fatal: ' + e.message); process.exit(1) })
