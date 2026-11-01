import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { Button, CounterLabel, Dialog, FormControl, TextInput, Textarea } from '@primer/react'
import { useGitHub, errorMessage, setThreadResolved, type PullRequest } from '../lib/github'
import { commitSuggestions } from '../lib/commit'
import { defaultSuggestionTitle, editsOverlap, suggestionCommitMessage, suggestionState, type SuggestionEdit, type SuggestionSource } from '../lib/suggestions'

// "Commit suggestion" and the suggestion batch for review threads on a pull request page.

interface BatchItem {
  commentId: number
  /** GraphQL id of the comment's thread, resolved once the suggestion is committed. */
  threadId?: string
  author: { login: string; id: number }
  edit: SuggestionEdit
}

interface SuggestionsValue {
  pr: PullRequest
  /** Code at a line of the head commit, from the loaded diff (undefined when the diff doesn't show it). */
  currentLine(path: string, n: number): string | undefined
  batch: BatchItem[]
  add(item: BatchItem): void
  remove(commentId: number): void
  commit(items: BatchItem[]): void
}

const SuggestionsContext = createContext<SuggestionsValue | null>(null)

interface ProviderProps {
  pr: PullRequest
  /** GraphQL viewerCanApplySuggestion: push access to the head branch (or maintainer edits on a fork). */
  canApply: boolean
  currentLine(path: string, n: number): string | undefined
  onCommitted(): void
  children: ReactNode
}

export function SuggestionProvider({ pr, canApply, currentLine, onCommitted, children }: ProviderProps) {
  const [batch, setBatch] = useState<BatchItem[]>([])
  const [committing, setCommitting] = useState<BatchItem[] | null>(null)
  // A new head (or another pull request) can move every batched line, so start the batch over.
  const [batchHead, setBatchHead] = useState(pr.head.sha)
  if (batchHead !== pr.head.sha) {
    setBatchHead(pr.head.sha)
    setBatch([])
  }
  const value = useMemo<SuggestionsValue>(
    () => ({
      pr,
      currentLine,
      batch,
      add: (item) => setBatch((b) => [...b.filter((x) => x.commentId !== item.commentId), item]),
      remove: (id) => setBatch((b) => b.filter((x) => x.commentId !== id)),
      commit: setCommitting,
    }),
    [pr, currentLine, batch],
  )
  return (
    // Readers who can't push see suggestions without any controls, as on github.com.
    <SuggestionsContext.Provider value={canApply ? value : null}>
      {children}
      {committing && (
        <CommitSuggestionDialog
          pr={pr}
          items={committing}
          onClose={() => setCommitting(null)}
          onDone={() => {
            setBatch((b) => b.filter((x) => !committing.some((c) => c.commentId === x.commentId)))
            setCommitting(null)
            onCommitted()
            // GitHub moves the pull request to the new head, and marks the changed threads outdated, a moment after the push.
            window.setTimeout(onCommitted, 4000)
          }}
        />
      )}
    </SuggestionsContext.Provider>
  )
}

interface ActionsProps {
  source: SuggestionSource
  commentId: number
  threadId?: string
  author: { login: string; id: number }
  outdated: boolean
  resolved?: boolean
  pending?: boolean
}

/** The footer of a "Suggested change" box: commit or batch it, or github.com's reason it can't be applied. */
export function SuggestionActions({ source, commentId, threadId, author, outdated, resolved, pending }: ActionsProps) {
  const ctx = useContext(SuggestionsContext)
  if (!ctx) return null
  const state = suggestionState(source, { prOpen: ctx.pr.state === 'open', outdated, resolved, pending, currentLine: (n) => ctx.currentLine(source.path, n) })
  if (!state) return null
  if (!state.ok) {
    return (
      <div className="suggestion-footer">
        <span className="suggestion-footer-note">{state.reason}</span>
      </div>
    )
  }
  const item: BatchItem = { commentId, threadId, author, edit: state.edit }
  const inBatch = ctx.batch.some((b) => b.commentId === commentId)
  const overlaps = !inBatch && ctx.batch.some((b) => editsOverlap(b.edit, state.edit))
  return (
    <div className="suggestion-footer">
      {overlaps && <span className="suggestion-footer-note">Only one suggestion per line can be added to a batch.</span>}
      {inBatch ? (
        <>
          <Button size="small" onClick={() => ctx.remove(commentId)}>
            Remove from batch
          </Button>
          <Button size="small" variant="primary" onClick={() => ctx.commit(ctx.batch)}>
            Commit suggestions <CounterLabel>{ctx.batch.length}</CounterLabel>
          </Button>
        </>
      ) : (
        <>
          {/* Committing one suggestion while a batch is open would move the head under the batch. */}
          <Button size="small" variant="primary" disabled={ctx.batch.length > 0} onClick={() => ctx.commit([item])}>
            Commit suggestion
          </Button>
          <Button size="small" disabled={overlaps} onClick={() => ctx.add(item)}>
            Add suggestion to batch
          </Button>
        </>
      )}
    </div>
  )
}

function CommitSuggestionDialog({ pr, items, onClose, onDone }: { pr: PullRequest; items: BatchItem[]; onClose(): void; onDone(): void }) {
  const { octokit, account } = useGitHub()
  const [title, setTitle] = useState(() => defaultSuggestionTitle(items.map((i) => i.author.login)))
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const message = suggestionCommitMessage({ title, description, authors: items.map((i) => i.author), viewerLogin: account.login, host: account.host })
      await commitSuggestions(octokit, pr, items.map((i) => i.edit), message)
      // As on github.com, an applied suggestion's conversation is resolved (best effort: the commit is what matters).
      await Promise.allSettled(items.flatMap((i) => (i.threadId ? [setThreadResolved(octokit, i.threadId, true)] : [])))
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={items.length === 1 ? 'Commit suggestion' : 'Commit suggestions'}
      width="large"
      onClose={onClose}
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: 'Commit changes', buttonType: 'primary', onClick: () => void submit(), disabled: busy || !title.trim(), loading: busy },
      ]}
    >
      <FormControl required>
        <FormControl.Label>Commit message</FormControl.Label>
        <TextInput block value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormControl>
      <FormControl className="mt-3">
        <FormControl.Label>Extended description</FormControl.Label>
        <Textarea block rows={4} resize="vertical" value={description} placeholder="Add an optional extended description…" onChange={(e) => setDescription(e.target.value)} />
      </FormControl>
      <p className="text-small fg-muted mb-0">
        {items.length === 1 ? 'The suggestion' : `${items.length} suggestions`} will be committed to <span className="text-mono">{pr.head.ref}</span>.
      </p>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}
