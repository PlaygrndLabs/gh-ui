import { useId, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button, ButtonGroup, NavList, RelativeTime, SegmentedControl, TextInput } from '@primer/react'
import {
  CommentDiscussionIcon,
  CheckCircleFillIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  CommentIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SparkleFillIcon,
  ReplyIcon,
  SearchIcon,
  QuestionIcon,
} from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../lib/github'
import { useRepo } from '../../lib/repo'
import { useAgent, useAgentPageContext } from '../../lib/agent/AgentProvider'
import { Blankslate, ErrorBox, IssueLabel, Loading, UserAvatar, UserLink } from '../../components/Bits'
import { Markdown } from '../../components/Markdown'
import { Composer } from '../../components/Composer'

interface Author {
  login: string
  avatarUrl: string
}

interface DiscussionListItem {
  number: number
  title: string
  author: Author | null
  createdAt: string
  updatedAt: string
  category: { id: string; slug: string; name: string; emoji: string; emojiHTML: string; isAnswerable: boolean }
  comments: { totalCount: number; nodes: Array<{ replies: { totalCount: number } } | null> }
  upvoteCount: number
  isAnswered: boolean | null
}

// Reply counts too: github.com's comment count includes replies.
const LIST_FIELDS = 'number title createdAt updatedAt upvoteCount isAnswered author{login avatarUrl} category{id slug name emoji emojiHTML isAnswerable} comments(first:100){totalCount nodes{replies{totalCount}}}'

/** Comments plus their replies, as github.com counts them in the list. */
function commentCount(n: DiscussionListItem) {
  return n.comments.totalCount + n.comments.nodes.reduce((sum, c) => sum + (c?.replies.totalCount ?? 0), 0)
}

type CategoryRef = { id: string; slug: string }

const SORTS = [
  ['UPDATED_AT', 'Latest activity'],
  ['CREATED_AT', 'Date created'],
] as const
const FILTERS = [
  ['open', 'Open'],
  ['closed', 'Closed'],
  ['answered', 'Answered'],
  ['unanswered', 'Unanswered'],
  ['all', 'All'],
] as const

/** Category emoji in the rounded tile github.com puts next to discussion titles. */
function EmojiTile({ html, small }: { html: string; small?: boolean }) {
  return <span className={small ? 'dx-emoji-tile small' : 'dx-emoji-tile'} aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
}

function VoteCount({ count }: { count: number }) {
  return (
    <span className="dx-vote" aria-label={`Upvotes: ${count}`}>
      <ArrowUpIcon size={16} />
      <span>{count}</span>
    </span>
  )
}

export function DiscussionsPage() {
  const { owner, repo, fullName } = useRepo()
  const { octokit, key } = useGitHub()
  const navigate = useNavigate()
  const { slug } = useParams()
  const [params, setParams] = useSearchParams()
  // github.com's /discussions/categories/<slug>: the list filters by category id, so resolve the slug first.
  const categories = useQuery({
    queryKey: [key, 'discussion-categories', owner, repo],
    enabled: !!slug,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res: { repository: { discussionCategories: { nodes: CategoryRef[] } } } = await octokit.graphql(
        `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ discussionCategories(first:25){ nodes{ id slug } } } }`,
        { owner, repo },
      )
      return res.repository.discussionCategories.nodes
    },
  })
  const category = slug ? (categories.data?.find((c) => c.slug === slug)?.id ?? null) : params.get('category')
  // github.com keeps the page for a slug that names no category, with no category selected and an empty list.
  const unknownCategory = !!slug && categories.isSuccess && !category
  const q = params.get('discussions_q') ?? ''
  const sort = (SORTS.some(([v]) => v === params.get('sort')) ? params.get('sort') : 'UPDATED_AT') as (typeof SORTS)[number][0]
  // github.com opens the list on "Filter: Open".
  const filter = FILTERS.some(([v]) => v === params.get('filter')) ? params.get('filter')! : 'open'
  const [search, setSearch] = useState(q)
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const listHeadingId = useId()
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setCursors([null])
    setParams(next)
  }
  const selectCategory = (c: CategoryRef | null) => {
    const next = new URLSearchParams(params)
    next.delete('category')
    setCursors([null])
    navigate({ pathname: `/${owner}/${repo}/discussions${c ? `/categories/${c.slug}` : ''}`, search: next.toString() })
  }

  useAgentPageContext({
    label: `discussions of ${fullName}`,
    owner,
    repo,
    suggestions: [{ label: 'Unanswered questions', prompt: `Which recent discussions in ${fullName} are unanswered questions? Summarize each in one line.` }],
  })

  const list = useQuery({
    queryKey: [key, 'discussions', owner, repo, category, unknownCategory, sort, filter, q, cursors[cursors.length - 1]],
    enabled: !slug || categories.isFetched,
    queryFn: async () => {
      const after = cursors[cursors.length - 1]
      const res: {
        repository: {
          hasDiscussionsEnabled: boolean
          discussionCategories: { nodes: Array<{ id: string; slug: string; name: string; emojiHTML: string }> }
          pinnedDiscussions: { nodes: Array<{ gradientStopColors: string[]; discussion: { number: number; title: string; author: Author | null; category: { id: string; slug: string; name: string; emojiHTML: string } } }> }
          discussions?: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: DiscussionListItem[] }
        }
      } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$after:String,$category:ID,$order:DiscussionOrderField!,$answered:Boolean,$states:[DiscussionState!],$skipList:Boolean!){
          repository(owner:$owner,name:$repo){
            hasDiscussionsEnabled
            discussionCategories(first:25){ nodes{ id slug name emojiHTML } }
            pinnedDiscussions(first:4){ nodes{ gradientStopColors discussion{ number title author{login avatarUrl} category{id slug name emojiHTML} } } }
            discussions(first:25, after:$after, categoryId:$category, answered:$answered, states:$states, orderBy:{field:$order, direction:DESC}) @skip(if:$skipList){
              totalCount pageInfo{hasNextPage endCursor}
              nodes{ ${LIST_FIELDS} }
            }
          }
        }`,
        {
          owner,
          repo,
          after,
          category,
          order: sort,
          answered: filter === 'answered' ? true : filter === 'unanswered' ? false : null,
          states: filter === 'open' ? ['OPEN'] : filter === 'closed' ? ['CLOSED'] : null,
          skipList: unknownCategory,
        },
      )
      const r = { ...res.repository, discussions: res.repository.discussions ?? { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }
      if (!q.trim() || !r.hasDiscussionsEnabled || unknownCategory) return r
      // Free-text search goes through the search API, like github.com's discussions_q.
      const cat = r.discussionCategories.nodes.find((c) => c.id === category)
      const terms = [`repo:${owner}/${repo}`, q, cat ? `category:"${cat.name}"` : '', filter === 'all' ? '' : `is:${filter}`]
      const found: { search: { discussionCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: DiscussionListItem[] } } = await octokit.graphql(
        `query($q:String!,$after:String){ search(type:DISCUSSION, query:$q, first:25, after:$after){ discussionCount pageInfo{hasNextPage endCursor} nodes{ ... on Discussion{ ${LIST_FIELDS} } } } }`,
        { q: terms.filter(Boolean).join(' '), after },
      )
      return { ...r, discussions: { totalCount: found.search.discussionCount, pageInfo: found.search.pageInfo, nodes: found.search.nodes } }
    },
  })

  if (list.isPending) return <Loading />
  if (list.error)
    return (
      <div className="container-xl">
        <ErrorBox error={list.error} />
      </div>
    )
  const d = list.data!
  if (!d.hasDiscussionsEnabled)
    return (
      <div className="container-xl">
        <Blankslate icon={<CommentDiscussionIcon size={32} />} title="Discussions are not enabled for this repository" />
      </div>
    )
  const pinned = !category && !q && filter === 'open' ? d.pinnedDiscussions.nodes : []

  return (
    <div className="container-xl dx-page">
      <h1 className="sr-only">
        {owner} {repo} Discussions
      </h1>
      {pinned.length > 0 && (
        <ul className="dx-spotlights" aria-label="Pinned Discussions">
          {pinned.map(({ discussion: p, gradientStopColors: g }) => (
            <li key={p.number} className="dx-spotlight">
              <div className="dx-spotlight-band" style={g?.length ? { background: `linear-gradient(to right, ${g.map((c) => (/^[0-9a-f]{3,8}$/i.test(c) ? `#${c}` : c)).join(', ')})` } : undefined} />
              <div className="dx-spotlight-body">
                <UserAvatar login={p.author?.login} src={p.author?.avatarUrl} size={32} />
                <h3>
                  <Link to={`/${owner}/${repo}/discussions/${p.number}`}>{p.title}</Link>
                </h3>
                <div className="dx-spotlight-meta">
                  <button type="button" className="dx-link-button text-bold fg-muted" onClick={() => selectCategory(p.category)}>
                    <span dangerouslySetInnerHTML={{ __html: p.category.emojiHTML }} /> {p.category.name}
                  </button>
                  {' · '}
                  <UserLink login={p.author?.login} className="fg-muted" />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="dx-toolbar">
        <form
          className="flex-1"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            setParam('discussions_q', search.trim() || null)
          }}
        >
          <TextInput block leadingVisual={SearchIcon} placeholder="Search all discussions" aria-label="Search all discussions" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
        <ActionMenu>
          <ActionMenu.Button>
            <span className="fg-muted">Sort by: </span>
            {SORTS.find(([v]) => v === sort)?.[1]}
          </ActionMenu.Button>
          <ActionMenu.Overlay>
            <ActionList selectionVariant="single">
              {SORTS.map(([v, label]) => (
                <ActionList.Item key={v} selected={sort === v} onSelect={() => setParam('sort', v === 'UPDATED_AT' ? null : v)}>
                  {label}
                </ActionList.Item>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <ActionMenu>
          <ActionMenu.Button>
            <span className="fg-muted">Filter: </span>
            {FILTERS.find(([v]) => v === filter)?.[1]}
          </ActionMenu.Button>
          <ActionMenu.Overlay>
            <ActionList selectionVariant="single">
              {FILTERS.map(([v, label]) => (
                <ActionList.Item key={v} selected={filter === v} onSelect={() => setParam('filter', v === 'open' ? null : v)}>
                  {label}
                </ActionList.Item>
              ))}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
      <div className="layout-sidebar-left dx-layout">
        <div>
          <h2 className="sr-only">Categories</h2>
          <h3 className="dx-side-title">Categories</h3>
          <NavList aria-label="Categories">
            <NavList.Item aria-current={!category && !unknownCategory ? 'page' : undefined} onClick={() => selectCategory(null)}>
              <NavList.LeadingVisual>
                <CommentDiscussionIcon />
              </NavList.LeadingVisual>
              View all discussions
            </NavList.Item>
            {d.discussionCategories.nodes.map((c) => (
              <NavList.Item key={c.id} aria-current={category === c.id ? 'page' : undefined} onClick={() => selectCategory(c)}>
                <NavList.LeadingVisual>
                  <span dangerouslySetInnerHTML={{ __html: c.emojiHTML }} />
                </NavList.LeadingVisual>
                {c.name}
              </NavList.Item>
            ))}
          </NavList>
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 id={listHeadingId} className="dx-list-title">
            {q ? `${d.discussions.totalCount.toLocaleString()} ${d.discussions.totalCount === 1 ? 'result' : 'results'}` : 'Discussions'}
          </h2>
          <div className="Box">
            {d.discussions.nodes.length === 0 ? (
              <Blankslate
                icon={<CommentDiscussionIcon size={24} />}
                title={unknownCategory ? 'There are no matching discussions.' : q || filter !== 'all' ? 'No discussions match your search' : 'There aren’t any discussions yet'}
              />
            ) : (
              <ul className="dx-list" aria-labelledby={listHeadingId}>
                {d.discussions.nodes.map((n) => (
                  <li key={n.number} className="Box-row hoverable dx-row">
                    <div className="dx-row-vote">
                      <VoteCount count={n.upvoteCount} />
                    </div>
                    <EmojiTile html={n.category.emojiHTML} />
                    <div className="dx-row-main">
                      <h3>
                        <Link to={`/${owner}/${repo}/discussions/${n.number}`}>{n.title}</Link>
                      </h3>
                      <div className="dx-row-meta">
                        <UserLink login={n.author?.login} className="fg-muted" /> {n.category.isAnswerable ? 'asked' : 'started'} <RelativeTime date={new Date(n.createdAt)} /> in{' '}
                        <button type="button" className="dx-link-button" onClick={() => selectCategory(n.category)}>
                          {n.category.name}
                        </button>
                        {n.category.isAnswerable && <span className={n.isAnswered ? 'text-bold fg-success' : 'text-bold'}> · {n.isAnswered ? 'Answered' : 'Unanswered'}</span>}
                      </div>
                    </div>
                    <Link to={`/${owner}/${repo}/discussions/${n.number}`} className="dx-row-comments" aria-label={`${commentCount(n)} comments`}>
                      <CommentIcon /> {commentCount(n)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(cursors.length > 1 || d.discussions.pageInfo.hasNextPage) && (
            <div className="flex-center mt-3" style={{ justifyContent: 'center' }}>
              <ButtonGroup>
                <Button leadingVisual={ChevronLeftIcon} disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
                  Previous
                </Button>
                <Button trailingVisual={ChevronRightIcon} disabled={!d.discussions.pageInfo.hasNextPage} onClick={() => setCursors((c) => [...c, d.discussions.pageInfo.endCursor])}>
                  Next
                </Button>
              </ButtonGroup>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface DComment {
  id: string
  bodyHTML: string
  author: Author | null
  createdAt: string
  isAnswer?: boolean
  upvoteCount: number
  replies?: { totalCount: number; nodes: DComment[] }
}

export function DiscussionPage() {
  const { owner, repo, fullName } = useRepo()
  const { number: n = '' } = useParams()
  const number = Number(n)
  const [params, setParams] = useSearchParams()
  const commentSort = (['new', 'top'] as const).find((v) => v === params.get('sort')) ?? 'old'
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const agent = useAgent()
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')

  const disc = useQuery({
    queryKey: [key, 'discussion', owner, repo, number],
    queryFn: async () => {
      const res: {
        repository: {
          discussion: {
            id: string
            title: string
            bodyHTML: string
            createdAt: string
            upvoteCount: number
            closed: boolean
            author: Author | null
            category: { id: string; slug: string; name: string; emojiHTML: string; isAnswerable: boolean }
            labels: { nodes: Array<{ name: string; color: string; description: string | null }> }
            answer: { id: string; bodyHTML: string; createdAt: string; author: Author | null } | null
            answerChosenBy: { login: string } | null
            comments: { totalCount: number; nodes: DComment[] }
          }
        }
      } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$number:Int!){
          repository(owner:$owner,name:$repo){
            discussion(number:$number){
              id title bodyHTML createdAt upvoteCount closed author{login avatarUrl} category{id slug name emojiHTML isAnswerable}
              labels(first:20){ nodes{ name color description } }
              answer{ id bodyHTML createdAt author{login avatarUrl} } answerChosenBy{ login }
              comments(first:100){ totalCount nodes{ id bodyHTML createdAt upvoteCount isAnswer author{login avatarUrl}
                replies(first:50){ totalCount nodes{ id bodyHTML createdAt upvoteCount author{login avatarUrl} } } } }
            }
          }
        }`,
        { owner, repo, number },
      )
      return res.repository.discussion
    },
  })

  const comment = useMutation({
    mutationFn: async ({ body, replyToId }: { body: string; replyToId?: string }) =>
      octokit.graphql(`mutation($id:ID!,$body:String!,$replyTo:ID){ addDiscussionComment(input:{discussionId:$id, body:$body, replyToId:$replyTo}){ comment{ id } } }`, {
        id: disc.data!.id,
        body,
        replyTo: replyToId ?? null,
      }),
    onSuccess: () => {
      setDraft('')
      setReplyDraft('')
      setReplyTo(null)
      void qc.invalidateQueries({ queryKey: [key, 'discussion', owner, repo, number] })
    },
  })

  const d = disc.data
  useAgentPageContext(
    d
      ? {
          label: `discussion ${fullName}#${number} “${d.title}”`,
          tabTitle: `#${number} ${d.title}`,
          owner,
          repo,
          suggestions: [
            { label: 'Summarize thread', prompt: `Summarize discussion #${number} in ${fullName}: the question, proposed answers and whether it's resolved.` },
          ],
        }
      : null,
  )

  if (disc.isLoading) return <Loading />
  if (disc.error || !d)
    return (
      <div className="container-xl">
        <ErrorBox error={disc.error} />
      </div>
    )

  const replyCount = d.comments.nodes.reduce((sum, c) => sum + (c.replies?.totalCount ?? 0), 0)
  const participants = [d.author, ...d.comments.nodes.flatMap((c) => [c.author, ...(c.replies?.nodes ?? []).map((r) => r.author)])]
    .filter((a): a is Author => !!a)
    .filter((a, i, all) => all.findIndex((b) => b.login === a.login) === i)
  const categoryLink = `/${owner}/${repo}/discussions/categories/${d.category.slug}`
  const SORT_OPTIONS = ['old', 'new', 'top'] as const
  const comments =
    commentSort === 'new' ? [...d.comments.nodes].reverse() : commentSort === 'top' ? [...d.comments.nodes].sort((a, b) => b.upvoteCount - a.upvoteCount) : d.comments.nodes

  const header = (c: { author: Author | null; createdAt: string }, anchor: string) => (
    <div className="dx-comment-header">
      <UserAvatar login={c.author?.login} src={c.author?.avatarUrl} size={32} />
      <UserLink login={c.author?.login} className="text-bold fg-default" />
      <a href={`#${anchor}`} className="fg-muted">
        <RelativeTime date={new Date(c.createdAt)} />
      </a>
    </div>
  )

  return (
    <div className="container-xl dx-page">
      <div className="dx-header">
        <div className="flex gap-2" style={{ alignItems: 'flex-start' }}>
          <h1 className="page-title flex-1">
            {d.title} <span className="num">#{number}</span>
          </h1>
          <Button size="small" leadingVisual={SparkleFillIcon} onClick={() => agent.ask(`Help me answer discussion #${number} in ${fullName} titled "${d.title}". Read it with get_discussion, look at the relevant code and draft a reply; don't post it until I confirm.`)}>
            Draft answer
          </Button>
        </div>
        <div className="dx-header-meta">
          {d.category.isAnswerable && (
            <span className="dx-state">
              {d.answer ? (
                <>
                  <CheckCircleFillIcon className="fg-success" />{' '}
                  <a href={`#discussioncomment-${d.answer.id}`} className="text-bold fg-muted">
                    Answered
                  </a>
                  {d.answer.author && (
                    <>
                      {' '}
                      <span className="fg-muted">by</span> <UserLink login={d.answer.author.login} className="text-bold fg-muted" />
                    </>
                  )}
                </>
              ) : (
                <>
                  <QuestionIcon className="fg-muted" /> <span className="text-bold fg-muted">Unanswered</span>
                </>
              )}
            </span>
          )}
          {d.closed && <span className="dx-state text-bold">Closed</span>}
          <span className="fg-muted">
            <UserLink login={d.author?.login} className="text-bold fg-muted" /> {d.category.isAnswerable ? 'asked this question in' : 'started this conversation in'}{' '}
            <Link to={categoryLink} className="text-bold fg-default">
              {d.category.name}
            </Link>
          </span>
        </div>
      </div>
      <div className="layout-sidebar">
        <div style={{ minWidth: 0 }}>
          <div className="dx-comment" id="discussion-body">
            {header(d, 'discussion-body')}
            <div className="dx-comment-body">
              <Markdown html={d.bodyHTML} context={fullName} />
            </div>
            <div className="dx-comment-footer">
              <VoteCount count={d.upvoteCount} />
            </div>
            {d.answer && (
              <div className="dx-answer-box">
                <div className="flex-center gap-2">
                  <CheckCircleFillIcon className="fg-success" />
                  <span className="fg-success">
                    Answered by <UserLink login={d.answer.author?.login} className="text-bold fg-success" />
                  </span>
                  <a href={`#discussioncomment-${d.answer.id}`} className="fg-muted">
                    <RelativeTime date={new Date(d.answer.createdAt)} />
                  </a>
                </div>
                <div className="dx-answer-excerpt">
                  <Markdown html={d.answer.bodyHTML} context={fullName} />
                </div>
                <a href={`#discussioncomment-${d.answer.id}`} className="text-bold">
                  View full answer <ArrowDownIcon />
                </a>
              </div>
            )}
          </div>
          <div className="dx-comment-count-row">
            <h2 className="dx-comment-count">
              {d.comments.totalCount === 1 ? '1 comment' : `${d.comments.totalCount.toLocaleString()} comments`}
              {replyCount > 0 && ` · ${replyCount === 1 ? '1 reply' : `${replyCount.toLocaleString()} replies`}`}
            </h2>
            {d.comments.nodes.length > 0 && (
              <SegmentedControl aria-label="Sort comments" onChange={(i) => setParams(i === 0 ? {} : { sort: SORT_OPTIONS[i] }, { replace: true })}>
                <SegmentedControl.Button selected={commentSort === 'old'}>Oldest</SegmentedControl.Button>
                <SegmentedControl.Button selected={commentSort === 'new'}>Newest</SegmentedControl.Button>
                <SegmentedControl.Button selected={commentSort === 'top'}>Top</SegmentedControl.Button>
              </SegmentedControl>
            )}
          </div>
          {comments.map((c) => (
            <div key={c.id} id={`discussioncomment-${c.id}`} className={c.isAnswer ? 'dx-comment answer' : 'dx-comment'}>
              {header(c, `discussioncomment-${c.id}`)}
              <div className="dx-comment-body">
                <Markdown html={c.bodyHTML} context={fullName} />
              </div>
              <div className="dx-comment-footer">
                {c.isAnswer && (
                  <span className="dx-answer-badge">
                    <CheckCircleFillIcon /> Marked as answer
                  </span>
                )}
                <VoteCount count={c.upvoteCount} />
                <span className="ml-auto text-small fg-muted">{(c.replies?.totalCount ?? 0) === 1 ? '1 reply' : `${c.replies?.totalCount ?? 0} replies`}</span>
              </div>
              <div className="dx-replies">
                {(c.replies?.nodes ?? []).map((r) => (
                  <div key={r.id} id={`discussioncomment-${r.id}`} className="dx-reply">
                    <div className="flex-center gap-2 text-small mb-1">
                      <UserAvatar login={r.author?.login} src={r.author?.avatarUrl} size={24} />
                      <UserLink login={r.author?.login} className="text-bold fg-default" />
                      <span className="fg-muted">
                        <RelativeTime date={new Date(r.createdAt)} />
                      </span>
                    </div>
                    <Markdown html={r.bodyHTML} context={fullName} />
                  </div>
                ))}
                {replyTo === c.id ? (
                  <Composer
                    value={replyDraft}
                    onChange={setReplyDraft}
                    context={fullName}
                    rows={3}
                    autoFocus
                    actions={
                      <>
                        <Button onClick={() => setReplyTo(null)}>Cancel</Button>
                        <Button variant="primary" disabled={!replyDraft.trim()} loading={comment.isPending} onClick={() => comment.mutate({ body: replyDraft, replyToId: c.id })}>
                          Reply
                        </Button>
                      </>
                    }
                  />
                ) : (
                  <Button size="small" variant="invisible" leadingVisual={ReplyIcon} onClick={() => setReplyTo(c.id)}>
                    Reply
                  </Button>
                )}
              </div>
              {c.isAnswer && d.answerChosenBy && (
                <div className="dx-answer-chosen">
                  Answer selected by <UserLink login={d.answerChosenBy.login} className="text-bold fg-success" />
                </div>
              )}
            </div>
          ))}
          {comment.error && <div className="error-box mb-3">{errorMessage(comment.error)}</div>}
          <div className="timeline-comment-group mt-3">
            <div className="avatar-col">
              <UserAvatar login={account.login} src={account.avatarUrl} size={40} />
            </div>
            <div className="flex-1" style={{ minWidth: 0 }}>
              <Composer
                value={draft}
                onChange={setDraft}
                context={fullName}
                actions={
                  <Button variant="primary" disabled={!draft.trim()} loading={comment.isPending} onClick={() => comment.mutate({ body: draft })}>
                    Comment
                  </Button>
                }
              />
            </div>
          </div>
        </div>
        <aside className="dx-sidebar">
          <div className="dx-sidebar-item">
            <div className="dx-sidebar-heading">Category</div>
            <Link to={categoryLink} className="dx-sidebar-category">
              <EmojiTile html={d.category.emojiHTML} small />
              {d.category.name}
            </Link>
          </div>
          <div className="dx-sidebar-item">
            <div className="dx-sidebar-heading">Labels</div>
            {d.labels.nodes.length ? (
              <div className="flex wrap gap-1">
                {d.labels.nodes.map((l) => (
                  <IssueLabel key={l.name} name={l.name} color={l.color} description={l.description} />
                ))}
              </div>
            ) : (
              <span>None yet</span>
            )}
          </div>
          <div className="dx-sidebar-item">
            <div className="dx-sidebar-heading">{participants.length === 1 ? '1 participant' : `${participants.length} participants`}</div>
            <div className="dx-participants">
              {participants.map((p) => (
                <Link key={p.login} to={`/${p.login}`} aria-label={p.login} title={p.login}>
                  <UserAvatar login={p.login} src={p.avatarUrl} size={24} />
                </Link>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
