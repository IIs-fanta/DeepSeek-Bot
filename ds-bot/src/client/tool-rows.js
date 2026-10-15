// Ordinary tool calls, drawn the way DSH's own chat draws them: a 24px disclosure row
// naming the kind of work, a one-line summary of what it acts on, and its input and
// output behind the fold. Team tools keep their own event lines (cells.js); every other
// call a Bot makes is visible here, the sub-calls of a program included, so a Bot chat
// shows the whole turn and not only its reply.
import { createElement as h, useMemo, useState } from 'react'
import {
  DisclosureRow, IconApiOutlineRegular, IconBrowseOutlineRegular, IconCodeOutlineRegular,
  IconEditOutlineRegular, IconInspectOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular,
  MarkdownText, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './i18n.js'
import { toolName } from './text.js'

// The native variant table, plus the pattern fallback the activity phrases use, so an
// MCP tool or a plugin's own reads as the kind of work it is.
const TOOL_VARIANTS = {
  bash: 'bash', pwsh: 'bash', shell: 'bash',
  read: 'read', view: 'read', cat: 'read', web_fetch: 'read',
  read_image: 'image',
  web_search: 'search', grep: 'search', glob: 'search',
  write: 'write', edit: 'edit',
  run_code: 'code',
}
const VARIANT_PATTERNS = [
  [/search|grep|glob|find|query/i, 'search'],
  [/shell|bash|pwsh|powershell|exec|command|terminal/i, 'bash'],
  [/write|create/i, 'write'],
  [/edit|patch|replace/i, 'edit'],
  [/image|photo|draw/i, 'image'],
  [/fetch|browse|read|web|view/i, 'read'],
]
export const toolVariant = (name) => {
  const wire = String(name ?? '')
  return TOOL_VARIANTS[wire] ?? VARIANT_PATTERNS.find(([pattern]) => pattern.test(wire))?.[1] ?? 'others'
}

const VARIANT_TITLES = {
  search: 'Search', read: 'Read file', bash: 'Run commands', image: 'Read image',
  write: 'Write', edit: 'Edit', code: 'Code', others: 'Tool call',
}
// Tool-owned titles that read better than their variant's, as in DSH's own rows.
const TOOL_TITLES = { web_fetch: 'Read page', read_image: 'Read image', view: 'Read file' }
const VARIANT_ICONS = {
  search: h(IconSearchOutlineRegular, { size: 14 }),
  read: h(IconBrowseOutlineRegular, { size: 14 }),
  bash: h(IconApiOutlineRegular, { size: 14 }),
  image: h(IconBrowseOutlineRegular, { size: 14 }),
  write: h(IconEditOutlineRegular, { size: 14 }),
  edit: h(IconEditOutlineRegular, { size: 14 }),
  code: h(IconCodeOutlineRegular, { size: 14 }),
  others: h(IconSparkleRegular, { size: 14 }),
}
// Summary key preference per variant, as in DSH's own generic row.
const SUMMARY_KEYS = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  image: ['file_path', 'path'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: ['description'],
}
// File-tool variants whose summary may be an openable workspace path.
const FILE_PATH_VARIANTS = new Set(['read', 'write', 'edit', 'image'])

const firstLine = (text) => {
  const at = text.indexOf('\n')
  return at === -1 ? text : text.slice(0, at)
}
const parseArgs = (argsRaw) => {
  try { return JSON.parse(argsRaw) } catch { return undefined }
}
const pickString = (args, keys) => {
  for (const key of keys) {
    const value = args?.[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

// A path summary displays relative to the session workspace, as in DSH's own row.
const relativize = (path, cwd) => {
  if (typeof path !== 'string' || typeof cwd !== 'string' || cwd === '') return path
  const plain = cwd.replace(/[\\/]+$/, '')
  return path.startsWith(`${plain}/`) || path.startsWith(`${plain}\\`) ? path.slice(plain.length + 1) : path
}

export function callState(call) {
  if (call.kind === 'tool-result') {
    if (call.error?.code === 'interrupted') return 'stopped'
    return call.isError ? 'error' : 'ok'
  }
  return call.phase === 'preparing' ? 'preparing' : 'running'
}

const argsRawOf = call => (call.kind === 'tool-result' ? call.call?.argsRaw ?? '' : call.argsRaw ?? '')

// The settled result as display text: text blocks verbatim, anything else as JSON, and
// an empty failed call falls back to its error line — the native resultText rule.
export function resultText(content, error) {
  const parts = (Array.isArray(content) ? content : [])
    .map(block => (block?.type === 'text' ? block.text : JSON.stringify(block, null, 2)))
  if (parts.length === 0 && error !== undefined && error !== null) parts.push(`${error.name ?? 'error'}: ${error.code ?? ''}`.trim())
  return parts.join('\n')
}

function deriveSummary(variant, argsRaw, cwd) {
  if (argsRaw === '') return ''
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  if (variant === 'search' && Array.isArray(parsed.queries)) {
    const queries = parsed.queries.filter(query => typeof query === 'string' && query !== '')
    if (queries.length > 0) return queries.map(firstLine).join(', ')
  }
  const picked = pickString(parsed, SUMMARY_KEYS[variant] ?? [])
  if (picked !== undefined) return firstLine(relativize(picked, cwd))
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value !== '') return firstLine(relativize(value, cwd))
  }
  // An argument object with nothing nameable in it (or none at all) summarizes as
  // nothing rather than as its raw JSON.
  return Object.keys(parsed).length === 0 ? '' : firstLine(argsRaw)
}

// The input body when the row opens: a program shows its code, anything else its
// arguments, pretty-printed when they parse.
function formatBody(variant, argsRaw) {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return argsRaw
  if (variant === 'code' && typeof parsed === 'object' && parsed !== null && typeof parsed.code === 'string' && parsed.code !== '') return parsed.code
  return JSON.stringify(parsed, null, 2)
}

const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })

// The shell seeds the primitives module: on a DSH that lacks the row or the shimmer,
// the same content renders as a plain fold instead of failing the whole cell.
const shimmer = node => (typeof TextShimmer === 'function' ? h(TextShimmer, null, node) : node)

// One call's row: kind, summary, state, and its input/output behind the fold. `children`
// are its sub-calls, always visible below it as in DSH's call tree.
export function BotToolRow({ call, cwd, openFile, inspectCall, children }) {
  const name = toolName(call) ?? ''
  const variant = toolVariant(name)
  const state = callState(call)
  const argsRaw = argsRawOf(call)
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => deriveSummary(variant, argsRaw, cwd), [variant, argsRaw, cwd])
  const output = call.kind === 'tool-result' ? resultText(call.content, call.error) : ''
  const errorSummary = state === 'error' && output !== '' ? firstLine(output) : ''
  const running = state === 'running' || state === 'preparing'
  const body = formatBody(variant, argsRaw)
  const expandable = state !== 'preparing' && (body !== null || output !== '')
  const filePath = FILE_PATH_VARIANTS.has(variant) ? pickString(parseArgs(argsRaw), ['path', 'file_path']) : undefined
  const title = TOOL_TITLES[name] !== undefined
    ? t(TOOL_TITLES[name])
    : variant === 'others' && name !== '' ? `${t('Tool call')} · ${name}` : t(VARIANT_TITLES[variant])
  const shown = state === 'error' ? errorSummary || summary : summary
  const onOpenFile = filePath !== undefined && typeof openFile === 'function' && state !== 'error' && state !== 'stopped'
    ? (event) => { event.stopPropagation(); openFile(filePath) }
    : undefined
  const collapsed = shown === '' ? null : h('span', { className: 'bt-call-collapsed' },
    h('span', { className: 'bt-call-sep', 'aria-hidden': true }, '·'),
    onOpenFile
      ? h('button', { type: 'button', className: 'bt-call-file', onClick: onOpenFile }, shimmer(shown))
      : h('span', { className: 'bt-call-sum', 'data-error': state === 'error' || undefined, 'data-stopped': state === 'stopped' || undefined }, shimmer(shown)))
  const expanded = open && expandable ? toolBody(variant, body, output, state, call, inspectCall) : undefined
  const sub = children ? h('div', { className: 'bt-call-sub' }, children) : null
  if (typeof DisclosureRow !== 'function') {
    return h('details', { className: 'bt-call', 'data-variant': variant, 'data-state': state, open: open || undefined, onToggle: event => setOpen(event.target.open) },
      h('summary', null, title, collapsed),
      expanded,
      sub)
  }
  return h('div', { className: 'bt-call', 'data-variant': variant, 'data-state': state, 'data-chat-call-id': call.callId },
    h(DisclosureRow, {
      icon: VARIANT_ICONS[variant],
      title,
      running,
      open,
      expandable,
      expandOnRowClick: true,
      keepContentWhenOpen: true,
      onToggle: () => setOpen(value => !value),
      collapsedContent: collapsed,
      rowClassName: 'bt-call-row',
      titleClassName: 'bt-call-title',
      children: expanded,
    }),
    sub)
}

// The open row's content: a program's code, the arguments, the result, and DSH's own
// inspect action when the chat offers one.
function toolBody(variant, body, output, state, call, inspectCall) {
  return h('div', { className: 'bt-call-body' },
    variant === 'code' && body !== null
      ? h('div', { className: 'bt-call-code' }, h(MarkdownText, { text: `\`\`\`ts\n${body}\n\`\`\``, labels: mdLabels(), variant: 'compact' }))
      : null,
    body !== null && variant !== 'code'
      ? h('div', { className: 'bt-call-io' },
        h('span', { className: 'bt-call-io-label' }, t('Input')),
        h('pre', { className: 'bt-call-pre' }, body))
      : null,
    output !== ''
      ? h('div', { className: 'bt-call-io' },
        h('span', { className: 'bt-call-io-label' }, t('Output')),
        h('pre', { className: 'bt-call-pre', 'data-error': state === 'error' || undefined }, output))
      : null,
    typeof inspectCall === 'function' && call.callId
      ? h('button', { type: 'button', className: 'bt-call-inspect', onClick: () => inspectCall(call.callId) }, h(IconInspectOutlineRegular, {}), t('Inspect'))
      : null)
}
