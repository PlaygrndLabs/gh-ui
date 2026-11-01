import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Dialog, FormControl, TextInput, TextInputWithTokens } from '@primer/react'
import { useGitHub, errorMessage } from '../../../lib/github'
import { useRepo } from '../../../lib/repo'
import { MAX_TOPICS, addTopics, sameTopics } from '../../../lib/repoSettings'
import { usePatchRepoCache, useRepoUpdate, type RepoPatch } from './common'

/** The About gear's "Edit repository details" dialog: description, website and topics. */
export function RepoDetailsDialog({ onClose }: { onClose(): void }) {
  const { owner, repo, data } = useRepo()
  const { octokit } = useGitHub()
  const update = useRepoUpdate()
  const patchCache = usePatchRepoCache()
  const [description, setDescription] = useState(data.description ?? '')
  const [homepage, setHomepage] = useState(data.homepage ?? '')
  const [topics, setTopics] = useState<string[]>(data.topics ?? [])
  const [typed, setTyped] = useState('')
  const [topicNote, setTopicNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const descriptionRef = useRef<HTMLInputElement>(null)

  const commitTyped = (text: string) => {
    const { topics: next, rejected } = addTopics(topics, text)
    setTopics(next)
    setTyped('')
    setTopicNote(rejected.length ? (next.length >= MAX_TOPICS ? `You can add up to ${MAX_TOPICS} topics.` : `Topics must start with a lowercase letter or number, consist of 50 characters or less, and can include hyphens: ${rejected.join(', ')}`) : null)
    return next
  }

  const save = useMutation({
    mutationFn: async () => {
      // Text still in the topics field counts, as on github.com.
      let nextTopics = topics
      if (typed.trim()) {
        const rejected = addTopics(topics, typed).rejected
        nextTopics = commitTyped(typed)
        // Don't save (and close) with part of what was typed silently dropped: the note under the field says why.
        if (rejected.length) throw new Error(`Not saved: ${rejected.join(', ')} can’t be added as a topic.`)
      }
      const patch: RepoPatch = {}
      // An emptied field goes back to null, which is how GitHub stores "no description / website".
      if (description.trim() !== (data.description ?? '')) patch.description = (description.trim() || null) as string
      if (homepage.trim() !== (data.homepage ?? '')) patch.homepage = (homepage.trim() || null) as string
      if (Object.keys(patch).length) await update(patch)
      if (!sameTopics(nextTopics, data.topics ?? [])) {
        const res = await octokit.rest.repos.replaceAllTopics({ owner, repo, names: nextTopics })
        patchCache({ topics: res.data.names })
      }
    },
    onSuccess: onClose,
    onError: (e) => setError(errorMessage(e)),
  })

  return (
    <Dialog
      title="Edit repository details"
      onClose={onClose}
      initialFocusRef={descriptionRef}
      width="large"
      footerButtons={[
        { content: 'Cancel', onClick: onClose },
        { content: 'Save changes', buttonType: 'primary', onClick: () => (setError(null), save.mutate()), disabled: save.isPending },
      ]}
    >
      <div className="repo-details-form">
        <FormControl>
          <FormControl.Label>Description</FormControl.Label>
          <TextInput block value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description of this repository" ref={descriptionRef} />
        </FormControl>
        <FormControl>
          <FormControl.Label>Website</FormControl.Label>
          <TextInput block value={homepage} onChange={(e) => setHomepage(e.target.value)} placeholder="Enter a valid URL" type="url" />
        </FormControl>
        <FormControl>
          <FormControl.Label>
            Topics <span className="fg-muted text-normal">(separate with spaces)</span>
          </FormControl.Label>
          <TextInputWithTokens
            block
            tokens={topics.map((t) => ({ id: t, text: t }))}
            onTokenRemove={(id) => setTopics((ts) => ts.filter((t) => t !== id))}
            value={typed}
            onChange={(e) => {
              const v = e.target.value
              if (/[\s,]$/.test(v)) commitTyped(v)
              else setTyped(v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (typed.trim()) commitTyped(typed)
              }
            }}
            onBlur={() => typed.trim() && commitTyped(typed)}
          />
          {topicNote && <FormControl.Validation variant="error">{topicNote}</FormControl.Validation>}
        </FormControl>
      </div>
      {error && <div className="error-box mt-3">{error}</div>}
    </Dialog>
  )
}
