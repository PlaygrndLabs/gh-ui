import { useEffect, useRef, useState } from 'react'
import { Button, CounterLabel, Spinner, TextInput } from '@primer/react'
import { FilterIcon, XCircleFillIcon } from '@primer/octicons-react'

export interface FilterBarProps {
  /** The filter applied: the view's saved one, or what was typed since. */
  value: string
  /** How many items match; undefined until the first answer. */
  count?: number
  loading: boolean
  /** The filter or layout differs from the saved view: offers Discard, and Save with edit access. */
  dirty: boolean
  canEdit: boolean
  onChange(filter: string): void
  onSave(): void
  onDiscard(): void
}

/**
 * github.com's project filter: field qualifiers and keywords ("assignee:octocat is:open login"),
 * applied by GitHub a moment after typing stops or at once on Enter.
 */
export function FilterBar({ value, count, loading, dirty, canEdit, onChange, onSave, onDiscard }: FilterBarProps) {
  const [text, setText] = useState(value)
  // What this input last applied: a `value` that is not it came from outside (another view, Discard), so the text follows.
  const applied = useRef(value)
  useEffect(() => {
    if (value === applied.current) return
    applied.current = value
    setText(value)
  }, [value])

  const apply = (next: string) => {
    const clean = next.trim()
    // Compared trimmed: a saved filter with a stray space is not a change the moment the view opens.
    if (clean === applied.current.trim()) return
    applied.current = clean
    onChange(clean)
  }
  const applyRef = useRef(apply)
  applyRef.current = apply
  useEffect(() => {
    const t = setTimeout(() => applyRef.current(text), 400)
    return () => clearTimeout(t)
  }, [text])

  return (
    <div className="project-filter">
      <TextInput
        block
        className="project-filter-input"
        leadingVisual={FilterIcon}
        aria-label="Filter by keyword or by field"
        placeholder="Filter by keyword or by field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply(text)
        }}
        trailingVisual={loading ? <Spinner size="small" srText="Loading items" /> : count !== undefined ? <CounterLabel aria-label={`${count} items`}>{count}</CounterLabel> : undefined}
        trailingAction={
          text ? (
            <TextInput.Action
              icon={XCircleFillIcon}
              aria-label="Clear filter"
              onClick={() => {
                setText('')
                apply('')
              }}
            />
          ) : undefined
        }
      />
      {dirty && (
        <>
          <Button onClick={onDiscard}>Discard</Button>
          {canEdit && (
            <Button variant="primary" onClick={onSave}>
              Save
            </Button>
          )}
        </>
      )}
    </div>
  )
}
