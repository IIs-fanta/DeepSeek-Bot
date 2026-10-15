import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { isTransientFailure } from '../src/host/turns.js'

// The rounds fixture: a fake team of two Bots in one group, member answers played back
// through the session/event listener, so a round runs with no model. Failures arrive as
// DSH delivers them: a turn/end whose reason carries the LlmFailure.
function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-retry-'))
  const ctx = fakeContext()
  const workspaces = new Map()
  const sent = []
  const inboxes = new Map()
  const inboxOf = (sessionId) => {
    if (!inboxes.has(sessionId)) {
      const inbox = { nextTurn: [], nextStep: [] }
      inbox.remove = (id) => {
        for (const list of ['nextTurn', 'nextStep']) {
          const at = inbox[list].findIndex(message => message.id === id)
          if (at !== -1) {
            inbox[list] = inbox[list].toSpliced(at, 1)
            return true
          }
        }
        return false
      }
      inboxes.set(sessionId, inbox)
    }
    return inboxes.get(sessionId)
  }
  let sessions = 0
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: id => workspaces.get(id),
      resolveByPath: async () => undefined,
      create: async (path) => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => sent.push({ sessionId, message }) } }),
      selectModel: async () => {},
      prompt: async (request) => {
        const inbox = inboxOf(request.sessionId)
        inbox[request.mode === 'steer' ? 'nextStep' : 'nextTurn'].push({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content })
        return { accepted: true }
      },
      page: async () => ({ events: [] }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  const rt = createRuntime(ctx, { home })
  // The retries run without wall-clock waits, and a member goes on working at once.
  rt.roomRetryDelays = [1, 1]
  rt.roomWorkGraceMs = 5
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const emit = async (sessionId, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id: sessionId }, event)
  }
  const userMessage = text => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const relay = (roomId, callId, signal = new AbortController().signal) => ctx.registeredTools.get('group_relay')
    .execute({}, { agent: { id: roomId, inbox: inboxOf(roomId) }, callId, signal })
  const answer = async (sessionId, exchangeId, text, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  }
  // A member turn that ends on a failed model call.
  const fail = async (sessionId, exchangeId, error, turn) => {
    await emit(sessionId, { type: 'turn/start', data: { turn } })
    await emit(sessionId, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
    await emit(sessionId, { type: 'turn/end', data: { reason: { kind: 'error', error } } })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, emit, userMessage, relay, inboxOf, answer, fail, stop, sent, ctx, home, rt }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const waitFor = async (check) => {
  for (let at = 0; at < 200; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}
const turnFor = (sent, ...earlier) => waitFor(() => sent.find(entry => !earlier.includes(entry) && entry.message.source.role === 'room'))

async function team(call, sent) {
  const chief = (await call('state', {})).value.mainBotId
  const writer = (await call('create-bot', { name: 'Writer' })).value
  const room = (await call('create-room', { name: 'R1', members: [chief, writer.id] })).value
  await call('update-room', { id: room.id, mode: 'everyone' })
  sent.length = 0
  return { room, chief, writer }
}

const RATE_LIMIT = { code: 'RATE_LIMIT', status: 429, message: 'Too Many Requests' }

test('a transient failure is what the group retries, and nothing else', () => {
  for (const failure of [
    { code: 'RATE_LIMIT' }, { code: 'RATE_LIMIT', status: 429 }, { code: 'SERVER', status: 503 },
    { code: 'TIMEOUT' }, { code: 'TRANSPORT' }, { code: 'EMPTY_RESPONSE' }, { code: 'UNKNOWN', status: 429 },
    { code: 'UNKNOWN', status: 500 }, { code: 'UNKNOWN', status: 408 },
  ]) {
    assert.equal(isTransientFailure(failure), true, JSON.stringify(failure))
  }
  for (const failure of [
    { code: 'QUOTA' }, { code: 'ACCOUNT_QUOTA' }, { code: 'AUTH', status: 401 }, { code: 'INVALID_REQUEST', status: 400 },
    { code: 'CONTEXT_WINDOW_EXCEEDED' }, { code: 'INVALID_CREDENTIAL' }, { code: 'UNKNOWN' }, undefined, null,
  ]) {
    assert.equal(isTransientFailure(failure), false, JSON.stringify(failure))
  }
})

test('a member that hits a 429 is woken again by its own round, and the round goes on', async (t) => {
  const { call, emit, userMessage, relay, answer, fail, stop, sent } = start()
  t.after(stop)
  const { room } = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here', 1)
  const second = await turnFor(sent, first)
  assert.ok(second, 'Writer gets its turn')

  // Writer's model call fails on a rate limit; the round wakes it again instead of
  // giving up, and the group is told a retry is on.
  await fail(second.sessionId, second.message.source.exchangeId, RATE_LIMIT, 1)
  const retry = await turnFor(sent, first, second)
  assert.ok(retry, 'the round wakes the member again')
  assert.equal(retry.sessionId, second.sessionId)
  assert.match(retry.message.content[0].text, /model call failed/)
  assert.match(retry.message.content[0].text, /RATE_LIMIT 429/)

  await answer(retry.sessionId, retry.message.source.exchangeId, 'Writer back', 2)
  const result = JSON.parse(await running)
  assert.deepEqual(result.replies.filter(reply => reply.kind === undefined).map(reply => reply.name), ['Chief', 'Writer'])
  assert.equal(result.failed, undefined)
  assert.equal(result.replies.some(reply => reply.kind === 'retrying' && reply.code === 'RATE_LIMIT'), true, 'the round shows the wake')
})

test('the wake is bounded: after the last retry the group hears the failure', async (t) => {
  const { call, emit, userMessage, relay, answer, fail, stop, sent } = start()
  t.after(stop)
  const { room } = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here', 1)
  const second = await turnFor(sent, first)
  await fail(second.sessionId, second.message.source.exchangeId, RATE_LIMIT, 1)
  const retryOne = await turnFor(sent, first, second)
  await fail(retryOne.sessionId, retryOne.message.source.exchangeId, RATE_LIMIT, 2)
  const retryTwo = await turnFor(sent, first, second, retryOne)
  await fail(retryTwo.sessionId, retryTwo.message.source.exchangeId, RATE_LIMIT, 3)

  const result = JSON.parse(await running)
  assert.deepEqual(result.failed, ['Writer'])
  assert.equal(result.replies.filter(reply => reply.kind === 'retrying').length, 2)
  const failedReply = result.replies.find(reply => reply.kind === 'failed')
  assert.equal(failedReply.code, 'RATE_LIMIT')
  assert.equal(failedReply.status, 429)
  // No fourth turn: the initial one plus two retries are all the group spends.
  assert.equal(sent.filter(entry => entry.message.source.role === 'room' && entry.sessionId === second.sessionId).length, 3)
})

test('a failure that will not clear on its own is not retried', async (t) => {
  const { call, emit, userMessage, relay, answer, fail, stop, sent } = start()
  t.after(stop)
  const { room } = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here', 1)
  const second = await turnFor(sent, first)
  await fail(second.sessionId, second.message.source.exchangeId, { code: 'QUOTA', message: 'out of quota' }, 1)

  const result = JSON.parse(await running)
  assert.deepEqual(result.failed, ['Writer'])
  assert.equal(result.replies.some(reply => reply.kind === 'retrying'), false)
  assert.equal(sent.filter(entry => entry.message.source.role === 'room' && entry.sessionId === second.sessionId).length, 1)
})

test('a member that failed after the round moved on is woken to pick its work back up', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const { room } = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here', 1)
  const second = await turnFor(sent, first)
  const writerSession = second.sessionId

  // Writer starts working: the round moves on and it keeps its turn.
  await emit(writerSession, { type: 'turn/start', data: { turn: 1 } })
  await emit(writerSession, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId: second.message.source.exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
  await emit(writerSession, { type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } })
  const result = JSON.parse(await running)
  assert.equal(result.replies.some(reply => reply.kind === 'working'), true)

  // Its model call then fails: the group wakes it instead of only posting the failure.
  await emit(writerSession, { type: 'turn/end', data: { reason: { kind: 'error', error: RATE_LIMIT } } })
  const wakeOne = await turnFor(sent, first, second)
  assert.ok(wakeOne, 'the first wake')
  assert.equal(wakeOne.sessionId, writerSession)
  assert.match(wakeOne.message.content[0].text, /model call failed/)
  assert.equal(wakeOne.message.source.exchangeId, second.message.source.exchangeId, 'the same exchange carries on')

  await emit(writerSession, { type: 'turn/start', data: { turn: 2 } })
  await emit(writerSession, { type: 'user/message', data: { source: wakeOne.message.source, content: wakeOne.message.content } })
  await emit(writerSession, { type: 'turn/end', data: { reason: { kind: 'error', error: RATE_LIMIT } } })
  const wakeTwo = await turnFor(sent, first, second, wakeOne)
  assert.ok(wakeTwo, 'the second wake')

  // The bounded wakes are spent: the failure reaches the group, and nobody answers it.
  await emit(writerSession, { type: 'turn/start', data: { turn: 3 } })
  await emit(writerSession, { type: 'user/message', data: { source: wakeTwo.message.source, content: wakeTwo.message.content } })
  await emit(writerSession, { type: 'turn/end', data: { reason: { kind: 'error', error: RATE_LIMIT } } })
  const posted = await waitFor(() => sent.find(entry => entry.sessionId === room.id && entry.message.source.failed !== undefined))
  assert.ok(posted, 'the group hears the failure after the last wake')
  assert.equal(posted.message.source.failed.code, 'RATE_LIMIT')
  assert.match(posted.message.content[0].text, /Could not finish/)
  const wakeThree = sent.find(entry => entry.sessionId === writerSession && entry !== second && entry !== wakeOne && entry !== wakeTwo && entry.message.source.role === 'room')
  assert.equal(wakeThree, undefined, 'no wake past the bound')
})

test('a member that recovers after a wake posts its result to the group', async (t) => {
  const { call, emit, userMessage, relay, answer, stop, sent } = start()
  t.after(stop)
  const { room } = await team(call, sent)

  await emit(room.id, userMessage('Start'))
  const running = relay(room.id, 'relay')
  const first = await turnFor(sent)
  await answer(first.sessionId, first.message.source.exchangeId, 'Chief here', 1)
  const second = await turnFor(sent, first)
  const writerSession = second.sessionId
  await emit(writerSession, { type: 'turn/start', data: { turn: 1 } })
  await emit(writerSession, { type: 'user/message', data: { source: { kind: 'bot', role: 'room', exchangeId: second.message.source.exchangeId }, content: [{ type: 'text', text: 'your turn' }] } })
  await emit(writerSession, { type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } })
  await running

  await emit(writerSession, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'connection reset' } } } })
  const wake = await turnFor(sent, first, second)
  assert.ok(wake)
  // The wake answers like any group turn: what it ends with reaches the group.
  await emit(writerSession, { type: 'turn/start', data: { turn: 2 } })
  await emit(writerSession, { type: 'user/message', data: { source: wake.message.source, content: wake.message.content } })
  await emit(writerSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done: the report is written.' }] } } })
  await emit(writerSession, { type: 'turn/end', data: { reason: { kind: 'stop' } } })
  const posted = await waitFor(() => sent.find(entry => entry.sessionId === room.id && entry.message.source.late === true))
  assert.ok(posted, 'the finished work reaches the group')
  assert.match(posted.message.content[0].text, /Done: the report is written\./)
})
