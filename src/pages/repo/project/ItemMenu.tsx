import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, IconButton, SelectPanel, useConfirm, type SelectPanelItemInput } from '@primer/react'
import { ArchiveIcon, ColumnsIcon, IssueOpenedIcon, KebabHorizontalIcon, MoveToBottomIcon, MoveToTopIcon, RepoIcon, TrashIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../../lib/github'
import {
  applyBoardMove,
  archiveProjectItem,
  columnOf,
  convertDraftToIssue,
  deleteProjectItem,
  fetchConvertTargets,
  moveBoardItem,
  planBoardMove,
  withoutItem,
  type ProjectItem,
} from '../../../lib/projects'
import { optionDot, type ProjectEditor } from './shared'

/**
 * The item "..." menu: "Row actions" in the table, the card menu on the board (which also moves
 * the card). Drafts can be converted to an issue in a repository picked from a panel.
 */
export function ItemMenu({ item, editor, board }: { item: ProjectItem; editor: ProjectEditor; board?: boolean }) {
  const { octokit, key } = useGitHub()
  const confirm = useConfirm()
  const { model, statusField } = editor
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState('')
  const repos = useQuery({
    queryKey: [key, 'project-convert-targets', model.id],
    enabled: picking,
    staleTime: 5 * 60_000,
    queryFn: () => fetchConvertTargets(octokit, model.id, model.repository),
  })
  const ref = { projectId: model.id, itemId: item.id }
  const draft = item.content?.__typename === 'DraftIssue'
  const label = board ? 'More actions for item' : 'Row actions'
  const column = columnOf(item, statusField?.id)
  const columnSize = model.items.filter((i) => columnOf(i, statusField?.id) === column).length

  /** "Move to top" / "Move to bottom": a position change within the card's column. */
  const move = (toColumn: string | null, index: number) => {
    if (!statusField) return
    const plan = planBoardMove(model.items, statusField.id, item.id, toColumn, index)
    if (plan) void editor.run(() => moveBoardItem(octokit, model.id, statusField.id, plan), (m) => applyBoardMove(m, statusField.id, plan))
  }
  /** "Move to column" changes the status only: the card lands where project order puts it. */
  const moveToColumn = (toColumn: string | null) => {
    if (!statusField || toColumn === column) return
    const plan = { itemId: item.id, toColumn, afterId: null, statusChange: true, reorder: false }
    void editor.run(() => moveBoardItem(octokit, model.id, statusField.id, plan), (m) => applyBoardMove(m, statusField.id, plan))
  }
  const repoItems = (repos.data ?? [])
    .filter((r) => r.nameWithOwner.toLowerCase().includes(filter.toLowerCase()))
    .map((r) => ({ id: r.id, text: r.nameWithOwner, leadingVisual: RepoIcon }))

  return (
    <>
      <ActionMenu anchorRef={anchorRef}>
        <ActionMenu.Anchor>
          <IconButton size="small" variant="invisible" icon={KebabHorizontalIcon} aria-label={label} className="project-item-menu" />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay align="end" width="small">
          <ActionList>
            {draft && (
              <ActionList.Item onSelect={() => setPicking(true)}>
                <ActionList.LeadingVisual>
                  <IssueOpenedIcon />
                </ActionList.LeadingVisual>
                Convert to issue
              </ActionList.Item>
            )}
            {board && statusField && (
              <>
                <ActionList.Item onSelect={() => move(column, 0)}>
                  <ActionList.LeadingVisual>
                    <MoveToTopIcon />
                  </ActionList.LeadingVisual>
                  Move to top
                </ActionList.Item>
                <ActionList.Item onSelect={() => move(column, columnSize)}>
                  <ActionList.LeadingVisual>
                    <MoveToBottomIcon />
                  </ActionList.LeadingVisual>
                  Move to bottom
                </ActionList.Item>
                <ActionMenu>
                  <ActionMenu.Anchor>
                    <ActionList.Item>
                      <ActionList.LeadingVisual>
                        <ColumnsIcon />
                      </ActionList.LeadingVisual>
                      Move to column
                    </ActionList.Item>
                  </ActionMenu.Anchor>
                  <ActionMenu.Overlay width="small">
                    <ActionList selectionVariant="single">
                      {[...(statusField.options ?? []).map((o) => ({ id: o.id as string | null, name: o.name, color: o.color })), { id: null, name: 'No Status', color: 'GRAY' }].map((o) => {
                        const Dot = optionDot(o.color)
                        return (
                          <ActionList.Item key={o.id ?? 'none'} selected={o.id === column} onSelect={() => moveToColumn(o.id)}>
                            <ActionList.LeadingVisual>
                              <Dot />
                            </ActionList.LeadingVisual>
                            {o.name}
                          </ActionList.Item>
                        )
                      })}
                    </ActionList>
                  </ActionMenu.Overlay>
                </ActionMenu>
              </>
            )}
            {(draft || (board && statusField)) && <ActionList.Divider />}
            <ActionList.Item
              onSelect={async () => {
                if (await confirm({ title: 'Archive item?', content: 'Are you sure you want to archive this item?', confirmButtonContent: 'Archive' }))
                  void editor.run(() => archiveProjectItem(octokit, ref), (m) => withoutItem(m, item.id))
              }}
            >
              <ActionList.LeadingVisual>
                <ArchiveIcon />
              </ActionList.LeadingVisual>
              Archive
            </ActionList.Item>
            <ActionList.Item
              variant="danger"
              onSelect={async () => {
                if (await confirm({ title: 'Delete item?', content: 'Are you sure you want to delete this item from this project?', confirmButtonType: 'danger', confirmButtonContent: 'Delete' }))
                  void editor.run(() => deleteProjectItem(octokit, ref), (m) => withoutItem(m, item.id))
              }}
            >
              <ActionList.LeadingVisual>
                <TrashIcon />
              </ActionList.LeadingVisual>
              Delete from project
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>
      {draft && (
        <SelectPanel
          title="Convert to issue"
          subtitle="Select the repository to create the issue in"
          renderAnchor={null}
          anchorRef={anchorRef}
          open={picking}
          onOpenChange={(open) => {
            setPicking(open)
            if (!open) setFilter('')
          }}
          items={repoItems}
          selected={undefined}
          onSelectedChange={(picked: SelectPanelItemInput | undefined) => {
            const repo = picked as { id?: string | number } | undefined
            setPicking(false)
            if (repo?.id) void editor.run(() => convertDraftToIssue(octokit, item.id, String(repo.id)))
          }}
          filterValue={filter}
          onFilterChange={setFilter}
          placeholderText="Filter repositories"
          loading={repos.isLoading}
          message={repos.error ? { title: 'Could not load repositories', body: errorMessage(repos.error), variant: 'error' } : undefined}
          width="medium"
        />
      )}
    </>
  )
}
