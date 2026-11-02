import { useRef, useState, type ReactNode } from 'react'
import { IconButton, Textarea } from '@primer/react'
import { FileDiffIcon, MarkdownIcon } from '@primer/octicons-react'
import { Markdown } from './Markdown'
import { insertSuggestion } from '../lib/suggestions'

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

export function Composer({ value, onChange, context, placeholder = 'Leave a comment', rows = 5, autoFocus, disabled, actions, tabsExtra, onSubmitShortcut, ariaLabel = 'Comment body', suggestion }: ComposerProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const textarea = useRef<HTMLTextAreaElement>(null)
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
        {suggestion && tab === 'write' && (
          <span className="composer-toolbar">
            <IconButton size="small" variant="invisible" icon={FileDiffIcon} aria-label="Add a suggestion" keybindingHint="Mod+g" disabled={disabled} onClick={addSuggestion} />
          </span>
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmitShortcut) {
                e.preventDefault()
                onSubmitShortcut()
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
