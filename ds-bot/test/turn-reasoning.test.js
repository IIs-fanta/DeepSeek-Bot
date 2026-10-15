import test from 'node:test'
import assert from 'node:assert/strict'
import { reasoningLive, stepReasoning, thinkingPreview } from '../src/client/turn-reasoning.js'

const step = (n, blocks, status = 'settled') => ({ turn: 1, step: n, status, blocks })
const think = text => ({ kind: 'reasoning', text })
const text = value => ({ kind: 'text', text: value })
const tool = { kind: 'tool-call', name: 'read' }

test('every step shows its own reasoning, in block order', () => {
  const steps = Array.from({ length: 24 }, (_, i) => step(i + 1, [think(`Reasoning ${i + 1}`), tool]))
  assert.deepEqual(steps.map(stepReasoning), steps.map((_, i) => `Reasoning ${i + 1}`))
  assert.equal(stepReasoning(step(1, [think('A'), tool, think('B')])), 'A\n\nB')
})

test('a step without reasoning shows no row, and a step outside a Turn list still shows its own', () => {
  assert.equal(stepReasoning(step(1, [text('Looking'), tool])), '')
  assert.equal(stepReasoning(undefined), '')
  assert.equal(stepReasoning(step(1, [think(' A ')])), 'A')
})

test('thinking is live while the newest content of the running step is reasoning', () => {
  assert.equal(reasoningLive(step(2, [think('B')], 'running')), true)
  // The reply started: the thinking settled even though the step still runs.
  assert.equal(reasoningLive(step(2, [think('B'), text('Reply')], 'running')), false)
  // A tool call after the reasoning keeps it live: no reply text yet.
  assert.equal(reasoningLive(step(2, [think('B'), tool], 'running')), true)
  assert.equal(reasoningLive(step(2, [think('B')])), false)
  assert.equal(reasoningLive(step(2, [text('Reply')], 'running')), false)
})

test('the collapsed preview is the first line, settled, and advances while streaming', () => {
  assert.equal(thinkingPreview('First line\nsecond line', false), 'First line')
  // While streaming: the first line of the latest completed paragraph.
  const streaming = 'Plan the work\n\nCheck the files\n\nstill typing a thi'
  assert.equal(thinkingPreview(streaming, true), 'Check the files')
  assert.equal(thinkingPreview('One paragraph still growing', true), '')
  assert.equal(thinkingPreview('**Bold** markers stay out', false), 'Bold markers stay out')
  assert.equal(thinkingPreview('', false), '')
})
