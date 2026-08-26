// dsh-tui-bridge — Host plugin exposing the agent loop over SSE + POST.
// Mounted in the Host composition (desktop profile user layer).

export const name = 'tui-bridge'

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const agentRegistry = ctx.get('agents')
  const agentDefaultModel = ctx.get('agentDefaultModel')
  const agentPresets = ctx.get('agentPresets')
  const sessionQuery = ctx.get('sessionQuery')
  const sandboxPolicy = ctx.get('sandboxPolicy')

  if (webServer === undefined || agentRegistry === undefined || agentDefaultModel === undefined || agentPresets === undefined) {
    console.error('[tui-bridge] missing required service (webServer/agents/agentDefaultModel/agentPresets)')
    return
  }

  const sseClients = new Set()
  const handles = new Map()   // sessionId -> { agent, dispose }
  const watched = new Set()   // sessionIds whose events we forward

  function makeId(prefix) {
    return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }
  function broadcast(obj) {
    const frame = 'data: ' + JSON.stringify(obj) + '\n\n'
    for (const client of sseClients) {
      try { client.res.write(frame) } catch (err) { /* ignore */ }
    }
  }
  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  function errText(err) {
    return (err && err.message) ? String(err.message) : String(err)
  }
  function currentRoute() {
    const selection = agentDefaultModel.currentSelection()
    return { provider: selection && selection.provider, model: selection && selection.model }
  }
  function makeSetup(presetId) {
    return async (agentCtx) => {
      await agentPresets.mount(agentCtx, presetId)
    }
  }

  async function handleCommand(msg) {
    if (msg === null || typeof msg !== 'object') return { error: 'message must be a JSON object' }
    const op = msg.op

    if (op === 'ping') return { ok: true, time: Date.now() }

    if (op === 'list_sessions') {
      const records = sessionQuery !== undefined ? await sessionQuery.listSessions() : []
      const ids = records.map((r) => r.header.id)
      const titles = new Map()
      if (sessionQuery !== undefined && ids.length > 0) {
        try {
          const obs = await sessionQuery.readTitleSnapshots(ids)
          for (const o of obs) {
            if (!o || o.status !== 'fulfilled' || !o.value) continue
            const t = o.value.title
            const title = (t && typeof t.title === 'string') ? t.title : undefined
            if (title !== undefined) titles.set(o.sessionId, title)
          }
        } catch (err) { /* ignore */ }
      }
      return {
        sessions: records.map((r) => ({
          id: r.header.id,
          cwd: r.header.cwd,
          createdAt: r.header.createdAt,
          live: r.live,
          persisted: r.persisted,
          tuiOwned: handles.has(r.header.id),
          title: titles.get(r.header.id)
        }))
      }
    }

    if (op === 'read_session') {
      if (sessionQuery === undefined) return { error: 'sessionQuery unavailable' }
      const snap = await sessionQuery.readSession(msg.sessionId)
      return { session: snap.session, events: snap.events }
    }

    if (op === 'create_session') {
      const route = currentRoute()
      if (!route.provider || !route.model) return { error: 'no provider/model in current selection' }
      const cwd = (typeof msg.cwd === 'string' && msg.cwd !== '') ? msg.cwd : (sandboxPolicy ? sandboxPolicy.workspaceRoot : undefined)
      if (typeof cwd !== 'string' || cwd === '') return { error: 'no absolute cwd available' }
      const presetId = (typeof msg.preset === 'string' && msg.preset !== '') ? msg.preset : 'standard'
      const sessionId = makeId('session-tui-')
      const handle = await agentRegistry.create({
        sessionId: sessionId,
        meta: { cwd: cwd },
        agentOptions: { provider: route.provider, model: route.model },
        setup: makeSetup(presetId)
      })
      handles.set(sessionId, handle)
      watched.add(sessionId)
      return { ok: true, sessionId: sessionId, cwd: cwd, provider: route.provider, model: route.model, preset: presetId }
    }

    if (op === 'resume') {
      const id = msg.sessionId
      if (typeof id !== 'string' || id === '') return { error: 'missing sessionId' }
      if (handles.has(id)) return { ok: true, sessionId: id, resumed: false }
      const route = currentRoute()
      const presetId = (typeof msg.preset === 'string' && msg.preset !== '') ? msg.preset : 'standard'
      const handle = await agentRegistry.resume({
        resumeSessionId: id,
        agentOptions: { provider: route.provider, model: route.model },
        setup: makeSetup(presetId)
      })
      handles.set(id, handle)
      watched.add(id)
      return { ok: true, sessionId: id, resumed: true, preset: presetId }
    }

    if (op === 'send') {
      const handle = handles.get(msg.sessionId)
      if (handle === undefined) return { error: 'session not open: ' + msg.sessionId }
      const text = (msg.text === undefined || msg.text === null) ? '' : String(msg.text)
      if (text.trim() === '') return { error: 'empty text' }
      handle.agent.followup({
        role: 'user',
        content: [{ type: 'text', text: text }],
        source: { kind: 'user' },
        id: makeId('msg-')
      })
      return { ok: true }
    }

    if (op === 'interrupt') {
      const handle = handles.get(msg.sessionId)
      if (handle === undefined) return { error: 'session not open: ' + msg.sessionId }
      try { handle.agent.cancel(new Error('interrupted by TUI')) } catch (err) { /* ignore */ }
      return { ok: true }
    }

    if (op === 'subscribe') {
      if (typeof msg.sessionId === 'string' && msg.sessionId !== '') watched.add(msg.sessionId)
      return { ok: true }
    }

    if (op === 'unsubscribe') {
      if (typeof msg.sessionId === 'string') watched.delete(msg.sessionId)
      return { ok: true }
    }

    return { error: 'unknown op: ' + op }
  }

  ctx.on('session/event', (session, event) => {
    if (!watched.has(session.id)) return
    broadcast({
      type: 'session_event',
      sessionId: session.id,
      event: { type: event.type, seq: event.seq, time: event.time, data: event.data }
    })
  })

  ctx.on('agent/status', (payload) => {
    if (!watched.has(payload.agent.id)) return
    broadcast({ type: 'agent_status', sessionId: payload.agent.id, status: payload.status })
  })

  ctx.on('agent/error', (payload) => {
    if (!watched.has(payload.agent.id)) return
    broadcast({ type: 'agent_error', sessionId: payload.agent.id, turn: payload.turn, step: payload.step, error: errText(payload.error) })
  })

  ctx.effect(() => {
    const disposeEvents = webServer.register({
      kind: 'exact',
      path: '/tui/events',
      handler: (req, res) => {
        return new Promise((resolve) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          })
          const client = { res: res, id: makeId('c-') }
          sseClients.add(client)
          try { res.write('data: ' + JSON.stringify({ type: 'hello', clientId: client.id }) + '\n\n') } catch (err) { /* ignore */ }
          const cleanup = () => { sseClients.delete(client); resolve() }
          req.on('close', cleanup)
          req.on('aborted', cleanup)
        })
      }
    })

    const disposeCommand = webServer.register({
      kind: 'exact',
      path: '/tui/command',
      handler: (req, res) => {
        return new Promise((resolve) => {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            let msg
            try {
              msg = JSON.parse(body)
            } catch (err) {
              sendJson(res, 400, { error: 'bad json' })
              resolve()
              return
            }
            handleCommand(msg).then(
              (result) => { sendJson(res, 200, result); resolve() },
              (err) => { sendJson(res, 500, { error: errText(err) }); resolve() }
            )
          })
        })
      }
    })

    return () => {
      disposeEvents()
      disposeCommand()
      for (const client of sseClients) {
        try { client.res.end() } catch (err) { /* ignore */ }
      }
      sseClients.clear()
      for (const handle of handles.values()) {
        try { handle.dispose() } catch (err) { /* ignore */ }
      }
      handles.clear()
      watched.clear()
    }
  })

  console.log('[tui-bridge] ready (GET /tui/events, POST /tui/command)')
}
