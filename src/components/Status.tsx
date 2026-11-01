import {
  CheckCircleFillIcon,
  CheckIcon,
  CircleSlashIcon,
  ClockIcon,
  DotFillIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  IssueClosedIcon,
  IssueOpenedIcon,
  SkipIcon,
  StopIcon,
  XCircleFillIcon,
  XIcon,
  AlertIcon,
} from '@primer/octicons-react'
import { StateLabel } from '@primer/react'

export type RunConclusion = string | null | undefined

/** Icon for a check run / workflow run / job / step, matching github.com. */
export function CheckStatusIcon({ status, conclusion, size = 16 }: { status?: string | null; conclusion?: RunConclusion; size?: number }) {
  if (status && status !== 'completed') {
    if (status === 'in_progress') return <RunningIcon size={size} />
    if (status === 'waiting' || status === 'action_required') return <ClockIcon size={size} className="fg-attention" aria-label="Waiting" />
    return <DotFillIcon size={size} className="fg-attention" aria-label="Queued" />
  }
  switch (conclusion) {
    case 'success':
      return <CheckCircleFillIcon size={size} className="fg-success" aria-label="Success" />
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return <XCircleFillIcon size={size} className="fg-danger" aria-label="Failed" />
    case 'cancelled':
      return <StopIcon size={size} className="fg-muted" aria-label="Cancelled" />
    case 'skipped':
      return <SkipIcon size={size} className="fg-muted" aria-label="Skipped" />
    case 'action_required':
      return <AlertIcon size={size} className="fg-attention" aria-label="Action required" />
    case 'neutral':
    case 'stale':
      return <CircleSlashIcon size={size} className="fg-muted" aria-label="Neutral" />
    default:
      return <DotFillIcon size={size} className="fg-attention" aria-label="Pending" />
  }
}

/** Compact mark used next to commits (combined status): ✓ ✗ • */
export function CommitStatusMark({ state }: { state: 'success' | 'failure' | 'pending' | 'error' | null | undefined }) {
  if (state === 'success') return <CheckIcon size={16} className="fg-success" aria-label="All checks passed" />
  if (state === 'failure' || state === 'error') return <XIcon size={16} className="fg-danger" aria-label="Some checks failed" />
  if (state === 'pending') return <DotFillIcon size={16} className="fg-attention" aria-label="Checks pending" />
  return null
}

export function RunningIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="status-running" aria-label="In progress" role="img">
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--fgColor-attention)" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="var(--fgColor-attention)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export interface PullStateInput {
  state: string
  merged?: boolean | null
  merged_at?: string | null
  draft?: boolean | null
}

export function pullState(p: PullStateInput): 'open' | 'draft' | 'merged' | 'closed' {
  if (p.merged || p.merged_at) return 'merged'
  if (p.state === 'closed') return 'closed'
  if (p.draft) return 'draft'
  return 'open'
}

export function PullStateIcon({ pull, size = 16 }: { pull: PullStateInput; size?: number }) {
  switch (pullState(pull)) {
    case 'merged':
      return <GitMergeIcon size={size} className="fg-done" aria-label="Merged" />
    case 'closed':
      return <GitPullRequestClosedIcon size={size} className="fg-danger" aria-label="Closed" />
    case 'draft':
      return <GitPullRequestDraftIcon size={size} className="fg-muted" aria-label="Draft" />
    default:
      return <GitPullRequestIcon size={size} className="fg-success" aria-label="Open" />
  }
}

export function IssueStateIcon({ issue, size = 16 }: { issue: { state: string; state_reason?: string | null }; size?: number }) {
  if (issue.state === 'open') return <IssueOpenedIcon size={size} className="fg-success" aria-label="Open" />
  if (issue.state_reason === 'not_planned') return <SkipIcon size={size} className="fg-muted" aria-label="Closed as not planned" />
  return <IssueClosedIcon size={size} className="fg-done" aria-label="Closed" />
}

export function PullStateLabel({ pull }: { pull: PullStateInput }) {
  const s = pullState(pull)
  const status = s === 'merged' ? 'pullMerged' : s === 'closed' ? 'pullClosed' : s === 'draft' ? 'draft' : 'pullOpened'
  return <StateLabel status={status}>{s === 'merged' ? 'Merged' : s === 'closed' ? 'Closed' : s === 'draft' ? 'Draft' : 'Open'}</StateLabel>
}

export function IssueStateLabel({ issue }: { issue: { state: string; state_reason?: string | null } }) {
  if (issue.state === 'open') return <StateLabel status="issueOpened">Open</StateLabel>
  if (issue.state_reason === 'not_planned') return <StateLabel status="issueClosedNotPlanned">Closed</StateLabel>
  return <StateLabel status="issueClosed">Closed</StateLabel>
}
