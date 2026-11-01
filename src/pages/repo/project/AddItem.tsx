import { useEffect, useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ActionList, AnchoredOverlay, Button, Spinner } from '@primer/react'
import { PlusIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { addProjectItem, findItemByNumber, parseItemUrl, searchAddableItems, setItemField, type AddableItem, type NewItem } from '../../../lib/projects'
import { ItemIcon, type ProjectEditor } from './shared'

/**
 * github.com's "Add item" row: type a title and press Enter for a draft issue, type # to pick one of
 * the repository's issues or pull requests, or paste an issue / pull request URL. From a board
 * column the new item also gets that column's status.
 */
export function AddItem({ editor, column }: { editor: ProjectEditor; column?: string | null }) {
  const { octokit, key, account } = useGitHub()
  const { owner, repo } = useRepo()
  const { model, statusField } = editor
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const searching = open && text.startsWith('#')

  // Debounce the search so typing "#fix login" does not send a query per keystroke.
  useEffect(() => {
    const next = text.startsWith('#') ? text.slice(1).trim() : ''
    const t = setTimeout(() => setTerm(next), 200)
    return () => clearTimeout(t)
  }, [text])

  const results = useQuery({
    queryKey: [key, 'project-add-search', owner, repo, term],
    enabled: searching,
    staleTime: 30_000,
    queryFn: () => searchAddableItems(octokit, owner, repo, term),
  })
  const inProject = new Set(model.items.map((i) => i.content?.id).filter(Boolean))
  const options = (results.data ?? []).filter((r) => !inProject.has(r.id))

  // The input clears right away so the next title can be typed while this one is added; it comes back if adding fails.
  const add = async (item: NewItem) => {
    const typed = text
    setPending((n) => n + 1)
    setError(null)
    setText('')
    setActive(0)
    const status = column && statusField ? { fieldId: statusField.id, optionId: column } : undefined
    // Only the add itself brings the text back on failure: if the item was created but setting the column's status
    // failed, typing Enter again would add a duplicate.
    let created = false
    const ok = await editor.run(async () => {
      const itemId = await addProjectItem(octokit, model.id, item)
      created = true
      if (status) await setItemField(octokit, { projectId: model.id, itemId, fieldId: status.fieldId }, { singleSelectOptionId: status.optionId })
    })
    setPending((n) => n - 1)
    if (!ok && !created) setText((now) => now || typed)
    inputRef.current?.focus()
  }

  const submit = async () => {
    const value = text.trim()
    if (!value) return
    if (value.startsWith('#')) {
      const pick = options[active]
      if (pick) void add({ contentId: pick.id })
      return
    }
    const url = parseItemUrl(value, account.host)
    if (url) {
      const found = await findItemByNumber(octokit, url.owner, url.repo, url.number)
      if (found) void add({ contentId: found.id })
      else setError('No issue or pull request found at that URL.')
      return
    }
    void add({ title: value })
  }

  if (!open)
    return (
      <Button variant="invisible" block alignContent="start" leadingVisual={PlusIcon} className="project-add-button" onClick={() => setOpen(true)}>
        Add item
      </Button>
    )

  return (
    <div className="project-add">
      <div className="project-add-input">
        {pending ? <Spinner size="small" srText="Adding item" /> : <PlusIcon className="fg-muted" />}
        <input
          ref={inputRef}
          autoFocus
          value={text}
          role="combobox"
          aria-expanded={searching}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={searching && options[active] ? `${listId}-${active}` : undefined}
          aria-label="Create new item or add existing item"
          placeholder="Start typing to create a draft, or type # to select an issue or pull request"
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
            setError(null)
          }}
          onBlur={() => {
            if (!text.trim() && !pending) setOpen(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              if (text) setText('')
              else setOpen(false)
            } else if (searching && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              const n = options.length
              if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
            }
          }}
        />
      </div>
      {error && <div className="project-add-error">{error}</div>}
      <AnchoredOverlay
        open={searching}
        renderAnchor={null}
        anchorRef={inputRef}
        onClose={() => setText('')}
        focusTrapSettings={{ disabled: true }}
        focusZoneSettings={{ disabled: true }}
        overlayProps={{ preventFocusOnOpen: true }}
        width="large"
      >
        <div className="project-add-results">
          {results.isLoading || term !== text.slice(1).trim() ? (
            <div className="project-add-empty">
              <Spinner size="small" srText="Searching" />
            </div>
          ) : results.error ? (
            <div className="project-add-empty fg-danger">{errorMessage(results.error)}</div>
          ) : !options.length ? (
            <div className="project-add-empty fg-muted">No issues or pull requests found</div>
          ) : (
            <ActionList id={listId} role="listbox" aria-label={`Issues and pull requests in ${owner}/${repo}`}>
              {options.map((r: AddableItem, i) => (
                <ActionList.Item
                  key={r.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'project-add-active' : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onSelect={() => void add({ contentId: r.id })}
                >
                  <ActionList.LeadingVisual>
                    <ItemIcon item={{ content: { ...r, repository: { nameWithOwner: `${owner}/${repo}` } } }} />
                  </ActionList.LeadingVisual>
                  {r.title}
                  <ActionList.Description variant="inline">#{r.number}</ActionList.Description>
                </ActionList.Item>
              ))}
            </ActionList>
          )}
        </div>
      </AnchoredOverlay>
    </div>
  )
}
