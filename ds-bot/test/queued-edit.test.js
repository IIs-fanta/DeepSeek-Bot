import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A two-Bot team: Chief (a) and Writer (b).
function team() {
  return {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }
}

// Services for a full apply(): each agent holds a working inbox, so a queued message
// really waits there and replace/remove act on it the way DSH's durable inbox does,
// including the agent/inbox/discarded event a removal publishes.
async function start(seed = team()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-queued-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const lists = { nextStep: [], nextTurn: [] }
      const discard = (message) => {
        for (const listener of ctx.listeners.get('agent/inbox/discarded') ?? []) listener({ message })
      }
      const splice = (list, at, removed, inserted) => {
        lists[list] = [...lists[list].slice(0, at), ...inserted, ...lists[list].slice(at + removed)]
      }
      const locate = (id) => {
        for (const list of ['nextStep', 'nextTurn']) {
          const at = lists[list].findIndex(message => message.id === id)
          if (at !== -1) return { list, at }
        }
        return undefined
      }
      const inbox = {
        get nextStep() { return lists.nextStep },
        get nextTurn() { return lists.nextTurn },
        replace(id, message) {
          const found = locate(id)
          if (found === undefined) return false
          const [removed] = lists[found.list].slice(found.at, found.at + 1)
          splice(found.list, found.at, 1, [message])
          discard(removed)
          return true
        },
        remove(id) {
          const found = locate(id)
          if (found === undefined) return false
          const [removed] = lists[found.list].slice(found.at, found.at + 1)
          splice(found.list, found.at, 1, [])
          discard(removed)
          return true
        },
      }
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        status: 'idle',
        inbox,
        followup(message) { calls.push(['followup', message]); lists.nextTurn.push(message) },
        steer(message) { calls.push(['steer', message]); lists.nextStep.push(message) },
        inject(message) { calls.push(['inject', message]); lists.nextStep.push(message) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
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
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const exchanges = async () => (await call('exchange', { a: 'a', b: 'b' })).value ?? []
  const inflight = () => {
    try { return JSON.parse(readFileSync(join(home, 'inflight.json'), 'utf8')) } catch { return { turns: {}, queued: {} } }
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { ctx, agents, agentOf, emit, tool, call, exchanges, inflight, home, stop }
}

const textOf = content => content.map(block => block.text ?? '').join('\n')

// The resume notes are written through a promise chain; wait for them to settle.
async function waitInflight(env, want = 2) {
  for (let at = 0; at < 200; at += 1) {
    const notes = env.inflight()
    if ((notes.queued.b ?? []).length === want) return notes
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return env.inflight()
}

// Two tasks queued behind Writer's running work.
async function queuedPair(env) {
  const { emit, tool, agentOf } = env
  emit('b', 'turn/start', { turn: 1 })
  await tool('message_bot', { to: 'Writer', message: 'Draft the spring announcement.', when: 'queue' }, 'a')
  await tool('message_bot', { to: 'Writer', message: 'Then list the March numbers.', when: 'queue' }, 'a')
  return agentOf('b').inbox.nextTurn
}

test('a queued task lists, and an edit replaces it in place under the same exchange', async (t) => {
  const env = await start()
  t.after(env.stop)
  const { tool, agentOf, exchanges } = env
  const inbox = await queuedPair(env)
  const [first, second] = inbox.map(message => message.id)

  // The listing names both, oldest first, without touching them.
  const listed = await tool('edit_queued_message', { to: 'Writer' }, 'a')
  assert.match(listed, /waiting unread in Writer's inbox/)
  assert.match(listed, /Draft the spring announcement\./)
  assert.match(listed, /Then list the March numbers\./)
  assert.equal(agentOf('b').inbox.nextTurn.length, 2)

  // The direction changed: the first task is replaced where it waits.
  const edited = await tool('edit_queued_message', { to: 'Writer', match: 'spring announcement', message: 'Draft the AUTUMN announcement instead; spring is off.' }, 'a')
  assert.match(edited, /^Replaced your message in Writer's queue, in the same place/)
  const after = agentOf('b').inbox.nextTurn
  assert.equal(after.length, 2)
  assert.equal(after[0].id !== first, true, 'the replacement is a fresh message')
  assert.equal(after[1].id, second, 'the second task kept its place')
  assert.match(textOf(after[0].content), /^\[Message from Chief · updated before you read it\]\nDraft the AUTUMN announcement instead; spring is off\.$/)
  // The reply still routes to the sender under the original exchange.
  assert.equal(after[0].source.exchangeId, inbox[0].source.exchangeId)
  assert.equal(after[0].source.role, 'request')
  assert.equal(after[0].source.senderSessionId, 'a')
  // The exchange log shows what Writer will actually read.
  const logged = await exchanges()
  assert.equal(logged.length, 2)
  assert.match(logged[0].text, /AUTUMN/)

  // The resume note follows the new text, so a restart picks up the edited task.
  const queued = (await waitInflight(env)).queued.b ?? []
  assert.equal(queued.length, 2)
  assert.match(queued.find(item => item.args.exchangeId === after[0].source.exchangeId).args.text, /AUTUMN/)
})

test('a queued task cancels whole, and the exchange log lets it go', async (t) => {
  const env = await start()
  t.after(env.stop)
  const { tool, agentOf, exchanges } = env
  await queuedPair(env)

  const canceled = await tool('edit_queued_message', { to: 'Writer', match: 'March numbers', cancel: true }, 'a')
  assert.match(canceled, /^Canceled your message in Writer's queue/)
  const after = agentOf('b').inbox.nextTurn
  assert.equal(after.length, 1)
  assert.match(textOf(after[0].content), /spring announcement/)
  const logged = await exchanges()
  assert.equal(logged.length, 1)
  assert.match(logged[0].text, /spring announcement/)
  // The resume note went with it: a restart resends nothing for that exchange.
  assert.equal((await waitInflight(env, 1)).queued.b.length, 1)
})

test('only the sender\'s own unread messages are listed or changed', async (t) => {
  const env = await start()
  t.after(env.stop)
  const { tool, agentOf } = env
  await queuedPair(env)

  // Writer has nothing of its own queued at Chief, and sees none of Chief's tasks.
  const empty = await tool('edit_queued_message', { to: 'Chief' }, 'b')
  assert.match(empty, /^Nothing of yours is waiting unread in Chief's inbox\./)
  const missed = await tool('edit_queued_message', { to: 'Chief', match: 'spring', message: 'hijack', cancel: false }, 'b')
  assert.match(missed, /Nothing of yours is waiting unread/)
  assert.equal(agentOf('a').inbox.nextTurn.length, 0)

  // A match nobody queued lists what is actually there.
  const noMatch = await tool('edit_queued_message', { to: 'Writer', match: 'winter', message: 'x' }, 'a')
  assert.match(noMatch, /Nothing of yours is waiting unread in Writer's inbox that matches/)
  assert.match(noMatch, /Draft the spring announcement\./)
  assert.equal(agentOf('b').inbox.nextTurn.length, 2)

  // Several matches ask for a better match instead of guessing.
  const ambiguous = await tool('edit_queued_message', { to: 'Writer', message: 'x' }, 'a')
  assert.match(ambiguous, /Several of your messages are waiting/)
  assert.equal(agentOf('b').inbox.nextTurn.length, 2)

  // Replace and cancel together refuse.
  const both = await tool('edit_queued_message', { to: 'Writer', match: 'spring', message: 'x', cancel: true }, 'a')
  assert.match(both, /not both/)
})

test('a message already read cannot be changed, and the sender is pointed at steering', async (t) => {
  const env = await start()
  t.after(env.stop)
  const { tool, agentOf } = env
  await queuedPair(env)
  // Writer's turn claims the first task.
  agentOf('b').inbox.nextTurn.shift()

  const late = await tool('edit_queued_message', { to: 'Writer', match: 'spring announcement', message: 'too late' }, 'a')
  assert.match(late, /Nothing of yours is waiting unread in Writer's inbox that matches/)
  assert.match(late, /message_bot with when "now"/)

  // A race: claimed between the pick and the replace. The tool reports, never throws.
  const race = await tool('edit_queued_message', { to: 'Writer', match: 'March numbers', message: 'changed plan' }, 'a')
  assert.match(race, /^Replaced/)
  agentOf('b').inbox.nextTurn.length = 0
  const after = await tool('edit_queued_message', { to: 'Writer', match: 'March', message: 'again' }, 'a')
  assert.match(after, /already read|Nothing of yours/)
})

test('a steered warning waiting at the next step can be rewritten too', async (t) => {
  const env = await start()
  t.after(env.stop)
  const { emit, tool, agentOf } = env
  emit('b', 'turn/start', { turn: 1 })
  await tool('message_bot', { to: 'Writer', message: 'stop using the old figures' }, 'a')
  assert.equal(agentOf('b').inbox.nextStep.length, 1)

  const edited = await tool('edit_queued_message', { to: 'Writer', message: 'stop using the old figures; the sheet was fixed' }, 'a')
  assert.match(edited, /^Replaced/)
  assert.equal(agentOf('b').inbox.nextStep.length, 1)
  assert.match(textOf(agentOf('b').inbox.nextStep[0].content), /the sheet was fixed$/)
  assert.equal(agentOf('b').inbox.nextTurn.length, 0)
})

test('an edited task still answers its sender when Writer reads it', async (t) => {
  const env = await start()
  t.after(env.stop)
  const { emit, tool, agentOf } = env
  await queuedPair(env)
  await tool('edit_queued_message', { to: 'Writer', match: 'spring', message: 'Draft the autumn announcement.' }, 'a')
  const replaced = agentOf('b').inbox.nextTurn[0]

  // Writer's work ends; the edited task opens the next turn and its reply goes to Chief.
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('b', 'turn/start', { turn: 2 })
  emit('b', 'user/message', { content: replaced.content, source: replaced.source })
  emit('b', 'assistant/message', { message: { content: [{ type: 'text', text: 'Autumn draft is ready.' }] } })
  emit('b', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  for (let count = 0; count < 200 && (agentOf('a').calls.length) < 1; count += 1) await new Promise(resolve => setTimeout(resolve, 5))
  const [kind, reply] = agentOf('a').calls.at(-1)
  assert.equal(kind, 'followup')
  assert.equal(textOf(reply.content), '[Reply from Writer]\nAutumn draft is ready.')
  assert.equal(reply.source.replyTo, replaced.source.exchangeId)
})
