import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconButton, Textarea } from '@primer/react'
import {
  BoldIcon,
  CodeIcon,
  CrossReferenceIcon,
  FileDiffIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ListOrderedIcon,
  ListUnorderedIcon,
  MarkdownIcon,
  MentionIcon,
  QuoteIcon,
  TasklistIcon,
} from '@primer/octicons-react'
import { Markdown } from './Markdown'
import { insertSuggestion } from '../lib/suggestions'
import { codeSelection, continueList, insertTrigger, linkSelection, pasteLink, styleLines, wrapSelection, type TextEdit } from '../lib/markdownEdit'

type Format = (text: string, start: number, end: number) => TextEdit

const FORMATS = {
  heading: (t, s, e) => styleLines(t, s, e, 'heading'),
  bold: (t, s, e) => wrapSelection(t, s, e, '**'),
  italic: (t, s, e) => wrapSelection(t, s, e, '_'),
  quote: (t, s, e) => styleLines(t, s, e, 'quote'),
  code: codeSelection,
  link: linkSelection,
  ordered: (t, s, e) => styleLines(t, s, e, 'ordered'),
  bullet: (t, s, e) => styleLines(t, s, e, 'bullet'),
  task: (t, s, e) => styleLines(t, s, e, 'task'),
  mention: (t, s, e) => insertTrigger(t, s, e, '@'),
  reference: (t, s, e) => insertTrigger(t, s, e, '#'),
} satisfies Record<string, Format>

// github.com's editor shortcuts. Symbols use the physical key: Shift+7 reports "&" as its character.
function shortcutFormat(e: KeyboardEvent<HTMLTextAreaElement>): Format | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  if (!e.shiftKey) {
    const plain: Record<string, Format> = { b: FORMATS.bold, i: FORMATS.italic, e: FORMATS.code, k: FORMATS.link }
    return plain[e.key.toLowerCase()] ?? null
  }
  const shifted: Record<string, Format> = { Period: FORMATS.quote, Digit7: FORMATS.ordered, Digit8: FORMATS.bullet, KeyL: FORMATS.task }
  return shifted[e.code] ?? null
}

interface ComposerProps {
  value: string
  onChange(value: string): void
  /** owner/repo, so the preview resolves #refs and @mentions. */
  context?: string
  placeholder?: string
  rows?: number
  autoFocus?: boolean
  disabled?: boolean
  /** Buttons rendered in the footer (right-aligned). */
  actions: ReactNode
  /** Controls at the right end of the Write/Preview tab bar (the release form's "Generate release notes"). */
  tabsExtra?: ReactNode
  /** Cmd/Ctrl+Enter. */
  onSubmitShortcut?(): void
  ariaLabel?: string
  /** A review comment on new-file lines: adds github.com's "Add a suggestion" button, prefilled with their code. */
  suggestion?: { path: string; startLine: number; lines: string[] }
}

export function Composer({ value, onChange, context, placeholder = 'Leave a comment', rows = 8, autoFocus, disabled, actions, tabsExtra, onSubmitShortcut, ariaLabel = 'Comment body', suggestion }: ComposerProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const textarea = useRef<HTMLTextAreaElement>(null)
  // Types the change into the textarea, so Undo steps through formatting the same way it does typing.
  const applyEdit = (edit: TextEdit) => {
    const el = textarea.current
    if (!el) return onChange(edit.text)
    const old = el.value
    let head = 0
    while (head < old.length && head < edit.text.length && old[head] === edit.text[head]) head++
    let tail = 0
    while (tail < old.length - head && tail < edit.text.length - head && old[old.length - 1 - tail] === edit.text[edit.text.length - 1 - tail]) tail++
    el.focus()
    el.setSelectionRange(head, old.length - tail)
    const typed = edit.text.slice(head, edit.text.length - tail)
    if (!document.execCommand(typed ? 'insertText' : 'delete', false, typed)) onChange(edit.text)
    el.setSelectionRange(edit.start, edit.end)
  }
  const format = (f: Format) => {
    const el = textarea.current
    if (el) applyEdit(f(el.value, el.selectionStart, el.selectionEnd))
  }
  const addSuggestion = () => {
    if (!suggestion) return
    const el = textarea.current
    const next = insertSuggestion(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, suggestion.lines)
    onChange(next.text)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(next.cursor, next.cursor)
    })
  }
  return (
    <div className="composer">
      {/* Preview has no textarea, and a tab must not unload with text in it (src/lib/TabsProvider.tsx). */}
      {value.trim() && <span hidden data-tab-draft />}
      <div className="composer-tabs">
        <div className="composer-tablist" role="tablist">
          <button type="button" role="tab" className="composer-tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}>
            Write
          </button>
          <button type="button" role="tab" className="composer-tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>
            Preview
          </button>
        </div>
        {tab === 'write' && (
          <div className="composer-toolbar" role="toolbar" aria-label="Formatting">
            {suggestion && <IconButton size="small" variant="invisible" icon={FileDiffIcon} aria-label="Add a suggestion" keybindingHint="Mod+g" disabled={disabled} onClick={addSuggestion} />}
            <span className="composer-toolbar-group">
              <IconButton size="small" variant="invisible" icon={HeadingIcon} aria-label="Heading" disabled={disabled} onClick={() => format(FORMATS.heading)} />
              <IconButton size="small" variant="invisible" icon={BoldIcon} aria-label="Bold" keybindingHint="Mod+b" disabled={disabled} onClick={() => format(FORMATS.bold)} />
              <IconButton size="small" variant="invisible" icon={ItalicIcon} aria-label="Italic" keybindingHint="Mod+i" disabled={disabled} onClick={() => format(FORMATS.italic)} />
              <IconButton size="small" variant="invisible" icon={QuoteIcon} aria-label="Quote" keybindingHint="Mod+Shift+." disabled={disabled} onClick={() => format(FORMATS.quote)} />
              <IconButton size="small" variant="invisible" icon={CodeIcon} aria-label="Code" keybindingHint="Mod+e" disabled={disabled} onClick={() => format(FORMATS.code)} />
              <IconButton size="small" variant="invisible" icon={LinkIcon} aria-label="Link" keybindingHint="Mod+k" disabled={disabled} onClick={() => format(FORMATS.link)} />
            </span>
            <span className="composer-toolbar-group">
              <IconButton size="small" variant="invisible" icon={ListOrderedIcon} aria-label="Numbered list" keybindingHint="Mod+Shift+7" disabled={disabled} onClick={() => format(FORMATS.ordered)} />
              <IconButton size="small" variant="invisible" icon={ListUnorderedIcon} aria-label="Bulleted list" keybindingHint="Mod+Shift+8" disabled={disabled} onClick={() => format(FORMATS.bullet)} />
              <IconButton size="small" variant="invisible" icon={TasklistIcon} aria-label="Task list" keybindingHint="Mod+Shift+l" disabled={disabled} onClick={() => format(FORMATS.task)} />
            </span>
            <span className="composer-toolbar-group">
              <IconButton size="small" variant="invisible" icon={MentionIcon} aria-label="Mention someone" disabled={disabled} onClick={() => format(FORMATS.mention)} />
              <IconButton size="small" variant="invisible" icon={CrossReferenceIcon} aria-label="Reference an issue or pull request" disabled={disabled} onClick={() => format(FORMATS.reference)} />
            </span>
          </div>
        )}
        {tabsExtra && <div className="composer-tabs-extra">{tabsExtra}</div>}
      </div>
      <div className="composer-body">
        {tab === 'write' ? (
          <Textarea
            block
            resize="vertical"
            rows={rows}
            value={value}
            ref={textarea}
            placeholder={placeholder}
            aria-label={ariaLabel}
            autoFocus={autoFocus}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onPaste={(e) => {
              const el = e.currentTarget
              const link = pasteLink(el.value, el.selectionStart, el.selectionEnd, e.clipboardData.getData('text/plain'))
              if (!link) return
              e.preventDefault()
              applyEdit(link)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmitShortcut) {
                e.preventDefault()
                onSubmitShortcut()
              }
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                const el = e.currentTarget
                const next = continueList(el.value, el.selectionStart, el.selectionEnd)
                if (next) {
                  e.preventDefault()
                  applyEdit(next)
                }
              }
              const shortcut = shortcutFormat(e)
              if (shortcut) {
                e.preventDefault()
                format(shortcut)
              }
              if (suggestion && e.key.toLowerCase() === 'g' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
                e.preventDefault()
                addSuggestion()
              }
            }}
          />
        ) : (
          <div className="composer-preview">
            {value.trim() ? (
              <Markdown text={value} context={context} suggestions={suggestion && { path: suggestion.path, base: suggestion.lines, startLine: suggestion.startLine }} />
            ) : (
              <span className="fg-muted">Nothing to preview</span>
            )}
          </div>
        )}
      </div>
      <div className="composer-footer">
        <span className="hint flex-center gap-1">
          <MarkdownIcon size={16} /> Markdown is supported
        </span>
        {actions}
      </div>
    </div>
  )
}
