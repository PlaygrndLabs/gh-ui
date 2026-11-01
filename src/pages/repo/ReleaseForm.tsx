import { useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ActionList, AnchoredOverlay, Breadcrumbs, Button, Checkbox, FormControl, IconButton, Select, Spinner, TextInput, useConfirm } from '@primer/react'
import { AlertIcon, FileIcon, PackageIcon, PlusIcon, SearchIcon, TagIcon, TrashIcon, TriangleDownIcon, XIcon } from '@primer/octicons-react'
import { useGitHub, errorMessage } from '../../lib/github'
import { useRepo, useTags, encodePath } from '../../lib/repo'
import { useAgentPageContext } from '../../lib/agent/AgentProvider'
import { formatBytes } from '../../lib/format'
import {
  canUploadAssets,
  invalidateReleases,
  makeLatestValue,
  tagMenu,
  uploadReleaseAsset,
  useLatestRelease,
  useReleaseByTag,
  type Release,
} from '../../lib/releases'
import { Blankslate, ErrorBox, Loading } from '../../components/Bits'
import { Composer } from '../../components/Composer'
import { BranchPicker } from '../../components/BranchPicker'

/** Creating, editing and deleting releases needs write access, as on github.com. */
export function useCanPush() {
  return !!useRepo().data.permissions?.push
}

/** github.com's release delete confirmation; resolves true once the release is gone. */
export function useDeleteRelease() {
  const { owner, repo } = useRepo()
  const { octokit, key } = useGitHub()
  const qc = useQueryClient()
  const confirm = useConfirm()
  return async (release: Pick<Release, 'id'>, onDeleted?: () => void) => {
    const ok = await confirm({
      title: 'Delete this release?',
      content: 'This will delete the information for this release.',
      confirmButtonType: 'danger',
      confirmButtonContent: 'Delete this release',
    })
    if (!ok) return false
    await octokit.rest.repos.deleteRelease({ owner, repo, release_id: release.id })
    // Leave the page first: refetching the deleted release's tag page would redirect to the code at that tag.
    onDeleted?.()
    invalidateReleases(qc, key, owner, repo)
    return true
  }
}

/** Whether refs/tags/<tag> exists. GraphQL answers null for a missing ref, where REST would log a 404. */
function useTagExists(owner: string, repo: string, tag: string) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'tag-exists', owner, repo, tag],
    enabled: !!tag,
    staleTime: 60_000,
    queryFn: async () => {
      const res: { repository: { ref: { id: string } | null } } = await octokit.graphql(
        `query($owner:String!,$repo:String!,$ref:String!){ repository(owner:$owner,name:$repo){ ref(qualifiedName:$ref){ id } } }`,
        { owner, repo, ref: `refs/tags/${tag}` },
      )
      return !!res.repository.ref
    },
  })
}

function useDiscussionCategoryNames(owner: string, repo: string, enabled: boolean) {
  const { octokit, key } = useGitHub()
  return useQuery({
    queryKey: [key, 'discussion-category-names', owner, repo],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res: { repository: { discussionCategories: { nodes: Array<{ name: string }> } } } = await octokit.graphql(
        `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ discussionCategories(first:25){ nodes{ name } } } }`,
        { owner, repo },
      )
      return res.repository.discussionCategories.nodes.map((n) => n.name)
    },
  })
}

function NoPermission() {
  return (
    <div className="container-xl">
      <Blankslate icon={<AlertIcon size={24} />} title="You can’t create releases in this repository">
        Creating and editing releases needs write access.
      </Blankslate>
    </div>
  )
}

function FormBreadcrumbs({ current }: { current: string }) {
  const { owner, repo } = useRepo()
  return (
    <Breadcrumbs className="release-breadcrumbs">
      <Breadcrumbs.Item as={Link} to={`/${owner}/${repo}/releases`}>
        Releases
      </Breadcrumbs.Item>
      <Breadcrumbs.Item selected>{current}</Breadcrumbs.Item>
    </Breadcrumbs>
  )
}

/** /releases/new. Takes github.com's query parameters (?tag=, target=, title=, body=, prerelease=1). */
export function NewReleasePage() {
  const { owner, repo, fullName, data } = useRepo()
  const canPush = useCanPush()
  const [params] = useSearchParams()
  useAgentPageContext({ label: `the new release form in ${fullName}`, owner, repo })
  if (!canPush) return <NoPermission />
  return (
    <div className="container-xl">
      <FormBreadcrumbs current="New release" />
      <ReleaseForm
        tag={params.get('tag') ?? ''}
        target={params.get('target') || data.default_branch}
        title={params.get('title') ?? ''}
        body={params.get('body') ?? ''}
        prerelease={['1', 'true'].includes(params.get('prerelease') ?? '')}
      />
    </div>
  )
}

/** /releases/edit/<tag>. */
export function EditReleasePage() {
  const { owner, repo, fullName } = useRepo()
  const { '*': tag = '' } = useParams()
  const canPush = useCanPush()
  const release = useReleaseByTag(owner, repo, tag, canPush)
  const latestRelease = useLatestRelease(owner, repo)
  useAgentPageContext({ label: `the edit form of release ${tag} in ${fullName}`, owner, repo })
  if (!canPush) return <NoPermission />
  const r = release.data
  return (
    <div className="container-xl">
      <FormBreadcrumbs current={r ? r.name || r.tag_name : tag} />
      {release.isLoading || latestRelease.isLoading ? (
        <Loading />
      ) : release.error ? (
        <ErrorBox error={release.error} />
      ) : !r ? (
        <Blankslate icon={<TagIcon size={24} />} title="Release not found">
          There is no release for {tag}.
        </Blankslate>
      ) : (
        <ReleaseForm
          key={r.id}
          release={r}
          wasLatest={r.id === latestRelease.data?.id}
          tag={r.tag_name}
          target={r.target_commitish}
          title={r.name ?? ''}
          body={r.body ?? ''}
          prerelease={r.prerelease}
        />
      )}
    </div>
  )
}

interface ReleaseFormProps {
  /** The release being edited; omitted on /releases/new. */
  release?: Release
  wasLatest?: boolean
  tag: string
  target: string
  title: string
  body: string
  prerelease: boolean
}

function ReleaseForm(props: ReleaseFormProps) {
  const { owner, repo, fullName, data } = useRepo()
  const { octokit, key, account } = useGitHub()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const deleteRelease = useDeleteRelease()
  // A failed save can leave a new release created (as a draft); later saves update it instead of creating another.
  const [saved, setSaved] = useState<Release | undefined>(props.release)
  const [tag, setTag] = useState(props.tag)
  const [target, setTarget] = useState(props.target)
  const [previousTag, setPreviousTag] = useState('')
  const [title, setTitle] = useState(props.title)
  const [body, setBody] = useState(props.body)
  const [prerelease, setPrerelease] = useState(props.prerelease)
  // Drafts can't be latest yet, so on a draft the box starts checked like on a new release.
  const [latest, setLatest] = useState(props.release && !props.release.draft ? !!props.wasLatest : true)
  const [discussion, setDiscussion] = useState(false)
  const [category, setCategory] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [removed, setRemoved] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)

  const tagExists = useTagExists(owner, repo, tag)
  const isNewTag = !!tag && tagExists.data === false
  const isDraft = !saved || saved.draft
  const canDiscuss = !!data.has_discussions && !saved?.discussion_url
  const categories = useDiscussionCategoryNames(owner, repo, canDiscuss)
  const categoryNames = categories.data ?? []
  const chosenCategory = category || (categoryNames.includes('Announcements') ? 'Announcements' : (categoryNames[0] ?? ''))
  const assets = (saved?.assets ?? []).filter((a) => !removed.includes(a.id))

  const generate = useMutation({
    mutationFn: async () =>
      (
        await octokit.rest.repos.generateReleaseNotes({
          owner,
          repo,
          tag_name: tag,
          ...(isNewTag ? { target_commitish: target } : {}),
          ...(previousTag ? { previous_tag_name: previousTag } : {}),
        })
      ).data,
    onSuccess: async (notes) => {
      const overwrites = (title.trim() && title !== notes.name) || (body.trim() && body !== notes.body)
      if (
        overwrites &&
        !(await confirm({
          title: 'Overwrite release notes?',
          content: 'The generated release notes will replace the release title and description you have entered.',
          confirmButtonContent: 'Overwrite',
        }))
      )
        return
      setTitle(notes.name)
      setBody(notes.body)
    },
  })

  const save = useMutation({
    mutationFn: async (publish: boolean) => {
      const makeLatest = makeLatestValue({ checked: latest, prerelease, publishing: publish, isNew: !saved || saved.draft, wasLatest: !!props.wasLatest })
      const extras = {
        ...(makeLatest ? { make_latest: makeLatest } : {}),
        ...(publish && canDiscuss && discussion && chosenCategory ? { discussion_category_name: chosenCategory } : {}),
      }
      const fields = { tag_name: tag, name: title, body, prerelease, ...(isNewTag ? { target_commitish: target } : {}) }
      // Assets change while the release is still a draft, so it is published with them (immutable releases
      // refuse asset changes after publishing).
      const assetChanges = files.length > 0 || removed.some((id) => saved?.assets.some((a) => a.id === id))
      const publishing = publish && isDraft
      const publishLater = publishing && assetChanges
      let r = saved
        ? (
            await octokit.rest.repos.updateRelease({
              owner,
              repo,
              release_id: saved.id,
              ...fields,
              ...(publishing && !publishLater ? { draft: false } : {}),
              ...(publish && !publishLater ? extras : {}),
            })
          ).data
        : (await octokit.rest.repos.createRelease({ owner, repo, ...fields, draft: !publish || publishLater, ...(publish && !publishLater ? extras : {}) })).data
      setSaved(r as Release)
      for (const id of removed) {
        if (!r.assets.some((a) => a.id === id)) continue
        await octokit.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: id })
        r = { ...r, assets: r.assets.filter((a) => a.id !== id) }
        setSaved(r as Release)
      }
      for (const file of files) {
        await uploadReleaseAsset(account, r.upload_url, file)
        setFiles((list) => list.filter((f) => f !== file))
      }
      if (publishLater) r = (await octokit.rest.repos.updateRelease({ owner, repo, release_id: r.id, draft: false, ...extras })).data
      return r
    },
    onMutate: () => setError(null),
    onError: (e) => {
      // REST only says "Validation Failed" when the tag already has a release.
      const taken = (e as { response?: { data?: { errors?: Array<{ code?: string; field?: string }> } } }).response?.data?.errors?.some((x) => x.code === 'already_exists' && x.field === 'tag_name')
      setError(taken ? `Tag ${tag} already has a release.` : errorMessage(e))
      invalidateReleases(qc, key, owner, repo)
    },
    onSuccess: (r) => {
      invalidateReleases(qc, key, owner, repo)
      navigate(r.draft ? `/${owner}/${repo}/releases` : `/${owner}/${repo}/releases/tag/${encodePath(r.tag_name)}`)
    },
  })

  const addFiles = (list: File[]) => setFiles((current) => [...current, ...list.filter((f) => !current.some((c) => c.name === f.name && c.size === f.size))])
  const busy = save.isPending
  // Whether the tag is new decides if the target is sent, so wait for that check.
  const ready = !!tag && !busy && !tagExists.isLoading

  return (
    <form className="release-form" onSubmit={(e) => e.preventDefault()}>
      <div className="release-form-refs">
        <TagSelect mode="release" value={tag} onChange={setTag} />
        {isNewTag && <BranchPicker owner={owner} repo={repo} value={target} onChange={setTarget} prefix="Target:" defaultBranch={data.default_branch} recentCommits />}
      </div>
      {!tag ? (
        <p className="release-form-note">Choose an existing tag, or create a new tag when you publish this release.</p>
      ) : isNewTag ? (
        <p className="release-form-note">Excellent! This tag will be created from the target when you publish this release.</p>
      ) : null}
      <TextInput data-tab-draft className="release-form-title" placeholder="Release title" aria-label="Release title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Composer
        value={body}
        onChange={setBody}
        context={fullName}
        rows={12}
        placeholder="Describe this release"
        ariaLabel="Describe this release"
        tabsExtra={
          <>
            <TagSelect mode="previous" value={previousTag} onChange={setPreviousTag} exclude={tag} />
            <Button size="small" disabled={!tag} loading={generate.isPending} onClick={() => generate.mutate()}>
              Generate release notes
            </Button>
          </>
        }
        actions={null}
      />
      {generate.error && <div className="error-box mt-2">{errorMessage(generate.error)}</div>}
      {(assets.length > 0 || removed.length > 0 || files.length > 0) && (
        <div className="Box release-form-assets">
          {(saved?.assets ?? []).map((a) => {
            const gone = removed.includes(a.id)
            return (
              <div key={a.id} className="Box-row release-form-asset">
                <PackageIcon className="fg-muted shrink-0" />
                <span className={`text-bold text-break flex-1 ${gone ? 'release-form-asset-removed' : ''}`}>{a.name}</span>
                <span className="fg-muted no-wrap">{formatBytes(a.size)}</span>
                {gone ? (
                  <Button size="small" variant="invisible" onClick={() => setRemoved((ids) => ids.filter((id) => id !== a.id))}>
                    Undo
                  </Button>
                ) : (
                  <IconButton size="small" variant="invisible" icon={TrashIcon} aria-label={`Delete ${a.name}`} onClick={() => setRemoved((ids) => [...ids, a.id])} />
                )}
              </div>
            )
          })}
          {files.map((f) => (
            <div key={`${f.name}:${f.size}`} className="Box-row release-form-asset">
              <FileIcon className="fg-muted shrink-0" />
              <span className="text-bold text-break flex-1">{f.name}</span>
              <span className="fg-muted no-wrap">{formatBytes(f.size)}</span>
              {busy ? (
                <Spinner size="small" srText={`Uploading ${f.name}`} />
              ) : (
                <IconButton size="small" variant="invisible" icon={XIcon} aria-label={`Remove ${f.name}`} onClick={() => setFiles((list) => list.filter((x) => x !== f))} />
              )}
            </div>
          ))}
        </div>
      )}
      {canUploadAssets ? (
        <AssetDropzone onFiles={addFiles} disabled={busy} />
      ) : (
        <p className="release-form-note">Attaching binaries needs the gh-ui desktop app: GitHub’s upload server doesn’t accept uploads from web pages.</p>
      )}
      <div className="release-form-options">
        <FormControl>
          <Checkbox checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} />
          <FormControl.Label>Set as a pre-release</FormControl.Label>
          <FormControl.Caption>This release will be labeled as non-production ready</FormControl.Caption>
        </FormControl>
        <FormControl disabled={prerelease}>
          <Checkbox checked={latest && !prerelease} onChange={(e) => setLatest(e.target.checked)} />
          <FormControl.Label>Set as the latest release</FormControl.Label>
          <FormControl.Caption>This release will be labeled as the latest release for this repository.</FormControl.Caption>
        </FormControl>
        {canDiscuss && categoryNames.length > 0 && (
          <>
            <FormControl>
              <Checkbox checked={discussion} onChange={(e) => setDiscussion(e.target.checked)} />
              <FormControl.Label>Create a discussion for this release</FormControl.Label>
              <FormControl.Caption>People will be able to leave comments and reactions on this release using Discussions.</FormControl.Caption>
            </FormControl>
            {discussion && (
              <FormControl className="release-form-category">
                <FormControl.Label>Category</FormControl.Label>
                <Select value={chosenCategory} onChange={(e) => setCategory(e.target.value)}>
                  {categoryNames.map((c) => (
                    <Select.Option key={c} value={c}>
                      {c}
                    </Select.Option>
                  ))}
                </Select>
              </FormControl>
            )}
          </>
        )}
      </div>
      {error && <div className="error-box mb-3">{error}</div>}
      <div className="release-form-actions">
        {isDraft ? (
          <>
            <Button variant="primary" disabled={!ready} loading={busy && save.variables === true} onClick={() => save.mutate(true)}>
              Publish release
            </Button>
            <Button disabled={!ready} loading={busy && save.variables === false} onClick={() => save.mutate(false)}>
              Save draft
            </Button>
          </>
        ) : (
          <Button variant="primary" disabled={!ready} loading={busy} onClick={() => save.mutate(true)}>
            Update release
          </Button>
        )}
        {saved && (
          <Button
            variant="danger"
            className="ml-auto"
            disabled={busy}
            onClick={() =>
              deleteRelease(saved, () => navigate(`/${owner}/${repo}/releases`)).catch((e) => setError(errorMessage(e)))
            }
          >
            Delete
          </Button>
        )}
      </div>
    </form>
  )
}

/** "Attach binaries by dropping them here or selecting them." */
function AssetDropzone({ onFiles, disabled }: { onFiles(files: File[]): void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      className={`release-dropzone ${over ? 'is-over' : ''}`}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (!disabled) onFiles([...e.dataTransfer.files])
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Attach binaries"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      Attach binaries by dropping them here or{' '}
      <button type="button" className="dx-link-button fg-accent" disabled={disabled} onClick={() => input.current?.click()}>
        selecting them
      </button>
      .
    </div>
  )
}

/**
 * The form's tag menus. "release" is "Choose a tag": existing tags, or "Create new tag: <name> on publish" for
 * a new name. "previous" is "Previous tag: auto", the base the generated notes start from.
 */
function TagSelect({ mode, value, onChange, exclude }: { mode: 'release' | 'previous'; value: string; onChange(tag: string): void; exclude?: string }) {
  const { owner, repo } = useRepo()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const tags = useTags(owner, repo, open)
  const names = (tags.data ?? []).map((t) => t.name).filter((t) => t !== exclude)
  const { matches, create } = tagMenu(names, filter)
  const showAuto = mode === 'previous' && 'auto'.includes(filter.trim().toLowerCase())
  const offerCreate = mode === 'release' ? create : null
  const pick = (t: string) => {
    onChange(t)
    setOpen(false)
  }
  return (
    <AnchoredOverlay
      open={open}
      onOpen={() => {
        setFilter('')
        setOpen(true)
      }}
      onClose={() => setOpen(false)}
      width="medium"
      focusTrapSettings={{ initialFocusRef: inputRef }}
      renderAnchor={(anchorProps) =>
        mode === 'release' ? (
          <Button {...anchorProps} leadingVisual={TagIcon} trailingVisual={TriangleDownIcon}>
            <span className="release-form-ref-name">{value || 'Choose a tag'}</span>
          </Button>
        ) : (
          <Button {...anchorProps} size="small" trailingVisual={TriangleDownIcon}>
            <span className="fg-muted text-normal">Previous tag: </span>
            <span className="release-form-ref-name">{value || 'auto'}</span>
          </Button>
        )
      }
    >
      <div className="ref-picker">
        <div className="ref-picker-header">
          <h2>{mode === 'release' ? 'Choose a tag' : 'Select previous tag'}</h2>
          <IconButton icon={XIcon} variant="invisible" size="small" aria-label="Cancel" className="fg-muted" onClick={() => setOpen(false)} />
        </div>
        <div className="ref-picker-filter">
          <TextInput
            ref={inputRef}
            block
            leadingVisual={SearchIcon}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the exact tag, else the new one, like github.com's menu.
              if (e.key !== 'Enter') return
              e.preventDefault()
              const exact = matches.find((t) => t === filter.trim())
              if (exact) pick(exact)
              else if (offerCreate) pick(offerCreate)
            }}
            placeholder={mode === 'release' ? 'Find or create a new tag' : 'Find a tag'}
            aria-label={mode === 'release' ? 'Find or create a new tag' : 'Find a tag'}
          />
        </div>
        <div className="ref-picker-list">
          {tags.isLoading ? (
            <div className="ref-picker-empty">
              <Spinner size="medium" aria-label="Loading tags..." />
            </div>
          ) : !showAuto && matches.length === 0 && !offerCreate ? (
            <div className="ref-picker-empty">Nothing to show</div>
          ) : (
            <ActionList selectionVariant="single" role="listbox" aria-label="Tags">
              {showAuto && (
                <ActionList.Item role="option" selected={!value} onSelect={() => pick('')}>
                  auto
                </ActionList.Item>
              )}
              {matches.slice(0, 100).map((t) => (
                <ActionList.Item key={t} role="option" selected={t === value} onSelect={() => pick(t)}>
                  <span className="ref-picker-name">{t}</span>
                </ActionList.Item>
              ))}
              {offerCreate && (
                <ActionList.Item role="option" selected={false} onSelect={() => pick(offerCreate)}>
                  <ActionList.LeadingVisual>
                    <PlusIcon />
                  </ActionList.LeadingVisual>
                  <span className="ref-picker-name">
                    Create new tag: <strong>{offerCreate}</strong> on publish
                  </span>
                </ActionList.Item>
              )}
            </ActionList>
          )}
        </div>
      </div>
    </AnchoredOverlay>
  )
}
