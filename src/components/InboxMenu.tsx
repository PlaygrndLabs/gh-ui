import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AnchoredOverlay } from '@primer/react'
import { InboxIcon } from '@primer/octicons-react'
import { useGitHub } from '../lib/github'
import { firstLine } from '../lib/format'
import { ErrorBox, Loading } from './Bits'

interface InboxPull {
  number: number
  title: string
  repository: { nameWithOwner: string }
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

const FIELDS = `nodes{ ... on PullRequest{ number title repository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}} } }`

/** What needs you, across every repository: reviews you were asked for, and your pull requests with failing checks. */
function useInbox() {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'workspace-inbox'],
    staleTime: 30_000,
    refetchInterval: 120_000,
    queryFn: async () => {
      const res: { reviews: { nodes: InboxPull[] }; mine: { nodes: InboxPull[] } } = await octokit.graphql(
        `query{ reviews: search(query:"is:pr is:open review-requested:@me archived:false sort:updated-desc",type:ISSUE,first:20){${FIELDS}} mine: search(query:"is:pr is:open author:@me archived:false sort:updated-desc",type:ISSUE,first:30){${FIELDS}} }`,
      )
      const failing = res.mine.nodes.filter((p) => ['FAILURE', 'ERROR'].includes(p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? ''))
      return { reviews: res.reviews.nodes, failing }
    },
  })
}

function Row({ pull, kind, onDone }: { pull: InboxPull; kind: 'review' | 'failing'; onDone(): void }) {
  return (
    <Link className="ws-list-row" to={`/${pull.repository.nameWithOwner}/pull/${pull.number}`} onClick={onDone}>
      <span className={`ws-mark ${kind === 'failing' ? 'ws-bad' : 'ws-run'}`}>{kind === 'failing' ? '✕' : '●'}</span>
      <span className="ws-list-text">
        <span className="ws-list-title">{firstLine(pull.title)}</span>
        <span className="ws-row-sub">
          {pull.repository.nameWithOwner} · #{pull.number} · {kind === 'failing' ? 'Checks failing' : 'Review requested'}
        </span>
      </span>
    </Link>
  )
}

export function InboxMenu() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const inbox = useInbox()
  const count = (inbox.data?.reviews.length ?? 0) + (inbox.data?.failing.length ?? 0)
  const close = () => setOpen(false)
  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => setOpen(true)}
      onClose={close}
      anchorRef={anchor}
      renderAnchor={(props) => (
        <button {...props} ref={anchor} type="button" className="ws-tool" aria-label={count ? `Inbox, ${count} items` : 'Inbox'}>
          <InboxIcon /> Inbox
          {count > 0 && <span className="ws-seg-count">{count}</span>}
        </button>
      )}
      width="large"
      focusZoneSettings={{ disabled: true }}
    >
      {open && (
        <div className="ws-inbox">
          <div className="ws-picker-heading">Across all repositories</div>
          <div className="ws-picker-list">
            {inbox.isLoading ? (
              <Loading />
            ) : inbox.error ? (
              <div className="p-3">
                <ErrorBox error={inbox.error} />
              </div>
            ) : count ? (
              <>
                {inbox.data?.reviews.map((p) => <Row key={`r${p.repository.nameWithOwner}${p.number}`} pull={p} kind="review" onDone={close} />)}
                {inbox.data?.failing.map((p) => <Row key={`f${p.repository.nameWithOwner}${p.number}`} pull={p} kind="failing" onDone={close} />)}
              </>
            ) : (
              <p className="ws-note p-3">You’re all caught up.</p>
            )}
          </div>
          <div className="ws-list-foot">
            <Link to="/notifications" onClick={close}>
              All notifications
            </Link>
            <Link to="/pulls" onClick={close}>
              Your pull requests
            </Link>
          </div>
        </div>
      )}
    </AnchoredOverlay>
  )
}
