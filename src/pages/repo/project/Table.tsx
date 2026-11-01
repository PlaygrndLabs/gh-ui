import { useRef, useState, type KeyboardEvent } from 'react'
import { SelectPanel, type SelectPanelItemInput } from '@primer/react'
import { TriangleDownIcon } from '@primer/octicons-react'
import { useGitHub } from '../../../lib/github'
import {
  EDITABLE_TYPES,
  displayValue,
  iterationRange,
  parseFieldInput,
  sameValue,
  setItemField,
  withFieldValue,
  type ProjectField,
  type ProjectFieldValue,
  type ProjectItem,
} from '../../../lib/projects'
import { AddItem } from './AddItem'
import { ItemMenu } from './ItemMenu'
import { ItemIcon, ItemTitle, OptionToken, optionDot, type ProjectEditor } from './shared'

/** The table layout: a row per item, a column per text, number, date, single select and iteration field, editable in place. */
export function Table({ editor }: { editor: ProjectEditor }) {
  const { model, canEdit } = editor
  const fields = model.fields.filter((f) => EDITABLE_TYPES.includes(f.dataType))
  return (
    <div className="project-table-box">
      <div className="project-table-wrap">
        <table className="project-table">
          <thead>
            <tr>
              <th className="project-table-num">
                <span className="sr-only">Row</span>
              </th>
              <th className="project-table-title">Title</th>
              {fields.map((f) => (
                <th key={f.id}>{f.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.items.map((it, i) => (
              <tr key={it.id}>
                <td className="project-table-num">{i + 1}</td>
                <th scope="row" className="project-table-title">
                  <span className="project-table-title-inner">
                    <ItemIcon item={it} />
                    <ItemTitle item={it} className="project-table-title-text" />
                    {it.content?.number !== undefined && <span className="fg-muted">#{it.content.number}</span>}
                    {canEdit && <ItemMenu item={it} editor={editor} />}
                  </span>
                </th>
                {fields.map((f) => (
                  <FieldCell key={f.id} field={f} item={it} editor={editor} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="project-table-add">
          <AddItem editor={editor} />
        </div>
      )}
    </div>
  )
}

/**
 * One editable cell. Single select and iteration cells open a picker; text, number and date
 * cells turn into an input (Enter saves, Escape cancels). Delete or Backspace clears the value.
 */
function FieldCell({ field, item, editor }: { field: ProjectField; item: ProjectItem; editor: ProjectEditor }) {
  const { octokit } = useGitHub()
  const { model, canEdit } = editor
  const value = item.values[field.id]
  const text = displayValue(field, value)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState(false)
  const [filter, setFilter] = useState('')
  const picker = field.dataType === 'SINGLE_SELECT' || field.dataType === 'ITERATION'
  const numeric = field.dataType === 'NUMBER'

  const save = (next: ProjectFieldValue | null) => {
    if (sameValue(next, value)) return
    void editor.run(
      () => setItemField(octokit, { projectId: model.id, itemId: item.id, fieldId: field.id }, next),
      (m) => withFieldValue(m, item.id, field.id, next),
    )
  }

  const shown =
    value && 'singleSelectOptionId' in value ? (
      <OptionToken name={text} color={field.options?.find((o) => o.id === value.singleSelectOptionId)?.color} />
    ) : (
      <span className="text-truncate">{text}</span>
    )

  if (!canEdit)
    return (
      <td className="project-cell" data-numeric={numeric || undefined}>
        {shown}
      </td>
    )

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && value) {
      e.preventDefault()
      save(null)
    }
  }

  if (editing && !picker)
    return (
      <td className="project-cell is-editing">
        <CellInput
          field={field}
          initial={value ? ('text' in value ? value.text : 'number' in value ? String(value.number) : 'date' in value ? value.date : '') : ''}
          onDone={(next, keyboard) => {
            setEditing(false)
            if (next !== undefined) save(next)
            // Back to the cell after Enter or Escape (not after clicking elsewhere), so arrow keys and Enter keep working.
            if (keyboard) requestAnimationFrame(() => anchorRef.current?.focus())
          }}
        />
      </td>
    )

  const items = picker ? pickerItems(field, filter) : []
  const selectedId = value && ('singleSelectOptionId' in value ? value.singleSelectOptionId : 'iterationId' in value ? value.iterationId : null)
  return (
    <td className="project-cell" data-numeric={numeric || undefined}>
      <button
        ref={anchorRef}
        type="button"
        className="project-cell-button"
        aria-label={`${field.name}: ${text || 'empty'}. Press Enter to edit.`}
        aria-haspopup={picker ? 'listbox' : undefined}
        onClick={() => setEditing(true)}
        onKeyDown={onKeyDown}
      >
        {shown}
        {picker && <TriangleDownIcon className="project-cell-caret" />}
      </button>
      {picker && (
        <SelectPanel
          title={field.name}
          renderAnchor={null}
          anchorRef={anchorRef}
          open={editing}
          onOpenChange={(open) => {
            setEditing(open)
            if (!open) setFilter('')
          }}
          items={items}
          selected={items.find((i) => i.id === selectedId)}
          onSelectedChange={(picked: SelectPanelItemInput | undefined) => {
            const id = (picked as { id?: string | number } | undefined)?.id
            // Picking the selected option again deselects it, which clears the field.
            save(id === undefined ? null : field.dataType === 'ITERATION' ? { iterationId: String(id) } : { singleSelectOptionId: String(id) })
          }}
          filterValue={filter}
          onFilterChange={setFilter}
          placeholderText="Filter options"
          groupMetadata={field.dataType === 'ITERATION' ? ITERATION_GROUPS.filter((g) => items.some((i) => 'groupId' in i && i.groupId === g.groupId)) : undefined}
          width="small"
        />
      )}
    </td>
  )
}

const ITERATION_GROUPS = [
  { groupId: 'active', header: { title: 'Iterations', variant: 'subtle' as const } },
  { groupId: 'completed', header: { title: 'Completed', variant: 'subtle' as const } },
]

function pickerItems(field: ProjectField, filter: string) {
  const term = filter.trim().toLowerCase()
  if (field.dataType === 'ITERATION')
    return (field.iterations ?? [])
      .filter((it) => !term || it.title.toLowerCase().includes(term))
      .map((it) => ({ id: it.id, text: it.title, description: iterationRange(it), descriptionVariant: 'block' as const, groupId: it.completed ? 'completed' : 'active' }))
  return (field.options ?? [])
    .filter((o) => !term || o.name.toLowerCase().includes(term))
    .map((o) => ({ id: o.id, text: o.name, description: o.description ?? undefined, descriptionVariant: 'block' as const, leadingVisual: optionDot(o.color) }))
}

/** The in-cell input for text, number and date fields; reports undefined when nothing should be saved. */
function CellInput({ field, initial, onDone }: { field: ProjectField; initial: string; onDone(next: ProjectFieldValue | null | undefined, keyboard: boolean): void }) {
  const done = useRef(false)
  const finish = (next: ProjectFieldValue | null | undefined, keyboard = true) => {
    if (done.current) return
    done.current = true
    onDone(next, keyboard)
  }
  return (
    <input
      autoFocus
      className="project-cell-input"
      type={field.dataType === 'NUMBER' ? 'number' : field.dataType === 'DATE' ? 'date' : 'text'}
      step={field.dataType === 'NUMBER' ? 'any' : undefined}
      defaultValue={initial}
      aria-label={field.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(parseFieldInput(field.dataType, e.currentTarget.value))
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(undefined)
        }
      }}
      onBlur={(e) => finish(parseFieldInput(field.dataType, e.currentTarget.value), false)}
    />
  )
}
