import type { ElementType } from 'react'
import { Link } from 'react-router-dom'
import { IssueDraftIcon } from '@primer/octicons-react'
import { IssueStateIcon, PullStateIcon } from '../../../components/Status'
import type { ProjectField, ProjectItem, ProjectModel } from '../../../lib/projects'

/** What the board and table need to show and edit a project, provided by ProjectPage. */
export interface ProjectEditor {
  model: ProjectModel
  statusField?: ProjectField
  /** viewerCanUpdate, and the token has not been refused the project scope. */
  canEdit: boolean
  /**
   * Runs a mutation, applying `optimistic` to the cached project first and rolling it back when the
   * mutation fails. Resolves false on failure (the page shows the error).
   */
  run(action: () => Promise<unknown>, optimistic?: (m: ProjectModel) => ProjectModel): Promise<boolean>
}

export function itemLink(it: ProjectItem) {
  const c = it.content
  return c && c.__typename !== 'DraftIssue' && c.repository ? `/${c.repository.nameWithOwner}/${c.__typename === 'PullRequest' ? 'pull' : 'issues'}/${c.number}` : null
}

export function ItemIcon({ item }: { item: Pick<ProjectItem, 'content'> }) {
  const c = item.content
  if (c?.__typename === 'PullRequest') return <PullStateIcon pull={{ state: c.state === 'OPEN' ? 'open' : 'closed', merged: c.state === 'MERGED', draft: c.isDraft }} />
  if (c?.__typename === 'Issue') return <IssueStateIcon issue={{ state: c.state === 'OPEN' ? 'open' : 'closed', state_reason: c.stateReason === 'NOT_PLANNED' ? 'not_planned' : null }} />
  return <IssueDraftIcon className="fg-muted" aria-label="Draft issue" />
}

export function ItemTitle({ item, className }: { item: ProjectItem; className?: string }) {
  const link = itemLink(item)
  const title = item.content?.title ?? 'You don’t have permission to access this item'
  return link ? (
    <Link to={link} className={className}>
      {title}
    </Link>
  ) : (
    <span className={className}>{title}</span>
  )
}

/** A single select value as github.com draws it: a token in the option's color. */
export function OptionToken({ name, color, title }: { name: string; color?: string; title?: string }) {
  return (
    <span className="project-token" data-color={color ?? 'GRAY'} title={title}>
      {name}
    </span>
  )
}

const dots = new Map<string, ElementType>()

/** The colored circle in front of a single select option (a component, for SelectPanel's leadingVisual). */
export function optionDot(color: string): ElementType {
  let dot = dots.get(color)
  if (!dot) {
    dot = function OptionDot() {
      return <span className="project-option-dot" data-color={color} aria-hidden />
    }
    dots.set(color, dot)
  }
  return dot
}
