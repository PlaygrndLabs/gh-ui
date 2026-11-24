import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ActionList, ActionMenu, IconButton, useConfirm } from '@primer/react'
import { PencilIcon, PlusIcon, ProjectIcon, ProjectRoadmapIcon, TableIcon, TrashIcon, TriangleDownIcon } from '@primer/octicons-react'
import type { ProjectLayout, ProjectView } from '../../../lib/projects'

const LAYOUT_ICONS = { TABLE_LAYOUT: TableIcon, BOARD_LAYOUT: ProjectIcon, ROADMAP_LAYOUT: ProjectRoadmapIcon }

/** The layouts a view can be switched to here; a roadmap view shows as a table. */
const LAYOUTS: Array<[ProjectLayout, string]> = [
  ['TABLE_LAYOUT', 'Table'],
  ['BOARD_LAYOUT', 'Board'],
]

export interface ViewTabsProps {
  views: ProjectView[]
  current: ProjectView
  /** The layout showing: the view's, or the one picked since and not saved yet. */
  layout: ProjectLayout
  /** The filter or layout differs from what the view has saved. */
  dirty: boolean
  /** The viewer may change the project, so views can be saved, renamed, added and deleted. */
  canEdit: boolean
  pathOf(view: ProjectView): string
  onLayout(layout: ProjectLayout): void
  onSave(): void
  onDiscard(): void
  onRename(name: string): void
  onDelete(): void
  onCreate(layout: ProjectLayout): void
}

/**
 * github.com's row of saved views: a tab per view, the current one with a menu for its layout and
 * (with edit access) saving, renaming and deleting it, then "New view".
 */
export function ViewTabs({ views, current, layout, dirty, canEdit, pathOf, onLayout, onSave, onDiscard, onRename, onDelete, onCreate }: ViewTabsProps) {
  const confirm = useConfirm()
  const [renaming, setRenaming] = useState(false)
  const renameRef = useRef<HTMLInputElement>(null)
  // The menu hands focus back to its button as it closes. The input takes it after that: focused
  // any sooner it would lose it at once, and leaving the input ends the rename.
  useEffect(() => {
    if (!renaming) return
    const t = setTimeout(() => {
      renameRef.current?.focus()
      renameRef.current?.select()
    }, 50)
    return () => clearTimeout(t)
  }, [renaming])
  const CurrentIcon = LAYOUT_ICONS[layout]

  const remove = async () => {
    if (await confirm({ title: `Delete “${current.name}”?`, content: 'The view is removed for everyone. The items in the project stay.', confirmButtonContent: 'Delete view', confirmButtonType: 'danger' })) onDelete()
  }

  return (
    <nav className="project-views" aria-label="Views">
      {views.map((v) => {
        if (v.id !== current.id) {
          const Icon = LAYOUT_ICONS[v.layout]
          return (
            <Link key={v.id} to={pathOf(v)} className="project-view-tab">
              <Icon />
              <span className="text-truncate">{v.name}</span>
            </Link>
          )
        }
        return (
          <div key={v.id} className="project-view-tab" aria-current="page">
            <CurrentIcon />
            {renaming ? (
              <input
                ref={renameRef}
                className="project-view-rename"
                aria-label="View name"
                defaultValue={v.name}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  else if (e.key === 'Escape') setRenaming(false)
                }}
                // Leaving the input saves, as Enter does; Escape unmounts it first, so nothing is saved.
                onBlur={(e) => {
                  const name = e.currentTarget.value.trim()
                  setRenaming(false)
                  if (name && name !== v.name) onRename(name)
                }}
              />
            ) : (
              <span className="text-truncate">{v.name}</span>
            )}
            {dirty && <span className="project-view-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
            <ActionMenu>
              <ActionMenu.Anchor>
                <IconButton size="small" variant="invisible" icon={TriangleDownIcon} aria-label="View options" className="project-view-menu" />
              </ActionMenu.Anchor>
              <ActionMenu.Overlay width="small">
                <ActionList>
                  <ActionList.Group selectionVariant="single">
                    <ActionList.GroupHeading>Layout</ActionList.GroupHeading>
                    {LAYOUTS.map(([value, label]) => (
                      <ActionList.Item key={value} selected={layout === value || (value === 'TABLE_LAYOUT' && layout === 'ROADMAP_LAYOUT')} onSelect={() => onLayout(value)}>
                        {label}
                      </ActionList.Item>
                    ))}
                  </ActionList.Group>
                  {dirty && (
                    <>
                      <ActionList.Divider />
                      {canEdit && <ActionList.Item onSelect={onSave}>Save changes</ActionList.Item>}
                      <ActionList.Item onSelect={onDiscard}>Discard changes</ActionList.Item>
                    </>
                  )}
                  {canEdit && (
                    <>
                      <ActionList.Divider />
                      <ActionList.Item onSelect={() => setRenaming(true)}>
                        <ActionList.LeadingVisual>
                          <PencilIcon />
                        </ActionList.LeadingVisual>
                        Rename view
                      </ActionList.Item>
                      {/* A project always keeps one view. */}
                      <ActionList.Item variant="danger" disabled={views.length < 2} onSelect={() => void remove()}>
                        <ActionList.LeadingVisual>
                          <TrashIcon />
                        </ActionList.LeadingVisual>
                        Delete view
                      </ActionList.Item>
                    </>
                  )}
                </ActionList>
              </ActionMenu.Overlay>
            </ActionMenu>
          </div>
        )
      })}
      {canEdit && (
        <ActionMenu>
          <ActionMenu.Button variant="invisible" leadingVisual={PlusIcon} className="project-view-new">
            New view
          </ActionMenu.Button>
          <ActionMenu.Overlay width="small">
            <ActionList>
              {LAYOUTS.map(([value, label]) => {
                const Icon = LAYOUT_ICONS[value]
                return (
                  <ActionList.Item key={value} onSelect={() => onCreate(value)}>
                    <ActionList.LeadingVisual>
                      <Icon />
                    </ActionList.LeadingVisual>
                    {label}
                  </ActionList.Item>
                )
              })}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      )}
    </nav>
  )
}
