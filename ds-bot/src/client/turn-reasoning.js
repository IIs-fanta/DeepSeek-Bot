// The thinking of one step, shown where it happened: every reasoning block of the step,
// in order, live while it streams and settled afterwards — every step of a Turn draws its
// own row, as DSH's own chat does, so nothing of the chain stays out of the transcript.
export function stepReasoning(step) {
  return (step?.blocks ?? [])
    .filter(block => block.kind === 'reasoning')
    .map(block => block.text)
    .join('\n\n')
    .trim()
}

// Whether the step's newest content block is reasoning still streaming: its row shows
// the live preview then. A step whose reply text started settles its thinking.
export function reasoningLive(step) {
  if (step?.status !== 'running') return false
  const blocks = (step.blocks ?? []).filter(block => block.kind === 'reasoning'
    || (block.kind === 'text' && String(block.text ?? '').trim() !== ''))
  return blocks.at(-1)?.kind === 'reasoning'
}

// The collapsed row's one-line preview: while streaming, the first line of the latest
// completed paragraph, which advances as the thoughts settle; once settled, the first
// line of the whole text. Bold markers stay out, as in DSH's own reasoning row.
export function thinkingPreview(text, running) {
  const source = String(text ?? '')
  const line = running ? latestCompletedParagraphFirstLine(source) : firstLine(source)
  return line.replaceAll('**', '').trim().slice(0, 160)
}

function firstLine(text) {
  const at = text.indexOf('\n')
  return at === -1 ? text : text.slice(0, at)
}

// The same walk DSH's reasoning row makes: the preview advances when a paragraph's
// first line completes, so a streaming thought shows its latest settled sentence.
function latestCompletedParagraphFirstLine(text) {
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  for (;;) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}
