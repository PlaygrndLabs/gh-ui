import { Fragment, useState, type DragEvent } from 'react'
import { CounterLabel } from '@primer/react'
import { useGitHub } from '../../../lib/github'
import { applyBoardMove, columnOf, displayValue, moveBoardItem, planBoardMove, type ProjectItem } from '../../../lib/projects'
import { AddItem } from './AddItem'
import { ItemMenu } from './ItemMenu'
import { ItemIcon, ItemTitle, OptionToken, type ProjectEditor } from './shared'

interface Column {
  /** Option id of the status field; null for "No Status". */
  id: string | null
  name: string
  color: string
  description?: string | null
  items: ProjectItem[]
}

/** Where a dragged card would land: a column and an index among its other cards. */
interface DropTarget {
  column: string | null
  index: number
}

/**
 * The board layout grouped by Status. With edit access, cards drag between and within columns
 * (status via updateProjectV2ItemFieldValue, order via updateProjectV2ItemPosition), applied
 * optimistically and rolled back if GitHub refuses.
 */
export function Board({ editor }: { editor: ProjectEditor }) {
  const { octokit } = useGitHub()
  const { model, statusField, canEdit } = editor
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const statusId = statusField?.id
  const columns: Column[] = [
    { id: null, name: 'No Status', color: 'GRAY', items: [] as ProjectItem[] },
    ...(statusField?.options ?? []).map((o) => ({ id: o.id as string | null, name: o.name, color: o.color, description: o.description, items: [] as ProjectItem[] })),
  ]
  for (const it of model.items) (columns.find((c) => c.id === columnOf(it, statusId)) ?? columns[0]).items.push(it)
  const canDrag = canEdit && !!statusField

  const indexAt = (e: DragEvent<HTMLElement>) => {
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-item-id]')].filter((el) => el.dataset.itemId !== dragging)
    const i = cards.findIndex((el) => {
      const r = el.getBoundingClientRect()
      return e.clientY < r.top + r.height / 2
    })
    return i === -1 ? cards.length : i
  }

  const drop = (column: string | null, index: number) => {
    const itemId = dragging
    setDragging(null)
    setTarget(null)
    if (!itemId || !statusField) return
    const plan = planBoardMove(model.items, statusField.id, itemId, column, index)
    if (plan) void editor.run(() => moveBoardItem(octokit, model.id, statusField.id, plan), (m) => applyBoardMove(m, statusField.id, plan))
  }

  return (
    <div className="project-board">
      {columns.map((col) => {
        // An empty "No Status" column stays hidden, as on github.com ("Move to column" still clears the status).
        if (col.id === null && !col.items.length) return null
        const others = col.items.filter((i) => i.id !== dragging)
        const showDrop = !!dragging && target?.column === col.id
        let slot = 0
        return (
          <section
            key={col.id ?? 'none'}
            className="project-column"
            aria-label={col.name}
            data-drop-active={showDrop || undefined}
            onDragOver={(e) => {
              if (!dragging) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const index = indexAt(e)
              if (target?.column !== col.id || target.index !== index) setTarget({ column: col.id, index })
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null) && target?.column === col.id) setTarget(null)
            }}
            onDrop={(e) => {
              if (!dragging) return
              e.preventDefault()
              drop(col.id, indexAt(e))
            }}
          >
            <header className="project-column-header">
              <span className="project-column-dot" data-color={col.color} aria-hidden />
              <h3 className="project-column-name">{col.name}</h3>
              <CounterLabel>{col.items.length}</CounterLabel>
            </header>
            {col.description && <p className="project-column-description">{col.description}</p>}
            <div className="project-column-cards">
              {col.items.map((it) => {
                // The dragged card stays mounted where it was (dimmed): removing a drag source cancels the drag.
                const isDragged = it.id === dragging
                const indicator = showDrop && !isDragged && target!.index === slot
                if (!isDragged) slot++
                return (
                  <Fragment key={it.id}>
                    {indicator && <div className="project-drop-indicator" />}
                    <Card
                      item={it}
                      editor={editor}
                      draggable={canDrag}
                      dragged={isDragged}
                      // Deferred so the browser snapshots the drag image before the card dims.
                      onDragStart={() => setTimeout(() => setDragging(it.id))}
                      onDragEnd={() => {
                        setDragging(null)
                        setTarget(null)
                      }}
                    />
                  </Fragment>
                )
              })}
              {showDrop && target!.index >= others.length && <div className="project-drop-indicator" />}
            </div>
            {canEdit && (
              <div className="project-column-footer">
                <AddItem editor={editor} column={col.id} />
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function Card({
  item,
  editor,
  draggable,
  dragged,
  onDragStart,
  onDragEnd,
}: {
  item: ProjectItem
  editor: ProjectEditor
  draggable?: boolean
  dragged?: boolean
  onDragStart?(): void
  onDragEnd?(): void
}) {
  const { model, statusField, canEdit } = editor
  const c = item.content
  const tokens = model.fields
    .filter((f) => f.id !== statusField?.id && item.values[f.id])
    .slice(0, 4)
    .map((f) => ({ field: f, text: displayValue(f, item.values[f.id]), value: item.values[f.id] }))
  return (
    <article
      className="project-card"
      data-item-id={item.id}
      data-dragged={dragged || undefined}
      draggable={draggable}
      aria-roledescription={draggable ? 'draggable' : undefined}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', item.id)
        onDragStart?.()
      }}
      onDragEnd={onDragEnd}
    >
      <div className="project-card-header">
        <ItemIcon item={item} />
        <span className="flex-1 text-truncate">{c?.repository ? `${c.repository.nameWithOwner.split('/')[1]} #${c.number}` : c ? 'Draft' : ''}</span>
        {canEdit && <ItemMenu item={item} editor={editor} board />}
      </div>
      <h4 className="project-card-title">
        <ItemTitle item={item} className={c ? 'fg-default' : 'fg-muted'} />
      </h4>
      {tokens.length > 0 && (
        <ul className="project-card-fields" aria-label="Fields">
          {tokens.map(({ field, text, value }) => (
            <li key={field.id}>
              {value && 'singleSelectOptionId' in value ? (
                <OptionToken name={text} color={field.options?.find((o) => o.id === value.singleSelectOptionId)?.color} title={`${field.name}: ${text}`} />
              ) : (
                <span className="project-token" data-color="GRAY" title={`${field.name}: ${text}`}>
                  {text}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
