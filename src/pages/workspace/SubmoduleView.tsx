import { createContext, useContext, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { DiffAddedIcon, DiffModifiedIcon, DiffRemovedIcon, FileSubmoduleIcon, InfoIcon } from '@primer/octicons-react'
import { CopyButton } from '../../components/Bits'
import { shortSha } from '../../lib/format'
import { useGitHub } from '../../lib/github'
import { appPathFromUrl } from '../../lib/links'
import { openExternal } from '../../lib/platform'
import { submoduleCommitChanged, submoduleRepository, type SubmoduleChange } from '../../lib/submodule'

/** Each submodule's folder and the address it was added from, as the folder's .gitmodules has them now. */
export const SubmoduleUrls = createContext<ReadonlyMap<string, string>>(new Map())

function Sha({ sha }: { sha: string }) {
  return (
    <span className="ws-submodule-sha">
      <code>{shortSha(sha)}</code>
      <CopyButton text={sha} label="Copy the full commit id" />
    </span>
  )
}

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="ws-submodule-line">
      <span className="ws-submodule-icon">{icon}</span>
      <p>{children}</p>
    </div>
  )
}

/**
 * What a submodule's change is, said in words as GitHub Desktop does: a diff of it is one line with a commit id on it.
 * `past` is for a commit already made, where nothing is left to do about it; `action` is what can be done, when something can.
 */
export function SubmoduleView({ path, change, past, action }: { path: string; change: SubmoduleChange; past?: boolean; action?: ReactNode }) {
  const { account } = useGitHub()
  const url = useContext(SubmoduleUrls).get(path)
  const repository = url ? submoduleRepository(url) : null
  const appPath = repository ? appPathFromUrl(repository.href, account.host) : null
  const inside = change.modified && change.untracked ? 'modified and new files' : change.modified ? 'modified files' : 'new files'
  const here = past ? '' : ' You can commit that here, in the parent repository.'

  return (
    <div className="ws-submodule">
      <Line icon={<InfoIcon className="fg-accent" />}>
        This is a submodule
        {repository ? (
          <>
            {' '}
            based on the repository{' '}
            {appPath ? (
              <Link to={appPath}>{repository.label}</Link>
            ) : (
              <a
                href={repository.href}
                onClick={(e) => {
                  e.preventDefault()
                  void openExternal(repository.href)
                }}
              >
                {repository.label}
              </a>
            )}
          </>
        ) : url ? (
          <>
            {' '}
            based on <code>{url}</code>
          </>
        ) : (
          // Nothing names it, so say what one is.
          ': another repository, kept in this folder at one commit'
        )}
        .
      </Line>
      {submoduleCommitChanged(change) &&
        (change.from && change.to ? (
          <Line icon={<DiffModifiedIcon className="fg-attention" />}>
            Its commit changed from <Sha sha={change.from} /> to <Sha sha={change.to} />.{here}
          </Line>
        ) : change.to ? (
          <Line icon={<DiffAddedIcon className="fg-success" />}>
            It was added at commit <Sha sha={change.to} />.{here}
          </Line>
        ) : (
          <Line icon={<DiffRemovedIcon className="fg-danger" />}>
            It was removed. It was at commit <Sha sha={change.from!} />.{here}
          </Line>
        ))}
      {(change.modified || change.untracked) && (
        <Line icon={<InfoIcon className="fg-muted" />}>
          It has {inside} inside that aren’t committed. Commit them inside the submodule first: only its commit can be recorded here.
        </Line>
      )}
      {action}
    </div>
  )
}

/** A submodule among a commit's files, in the place its one-line diff would take. */
export function SubmoduleDiffBox({ path, change }: { path: string; change: SubmoduleChange }) {
  return (
    <div className="Box file-diff ws-submodule-box">
      <div className="file-diff-header">
        <FileSubmoduleIcon className="fg-muted" />
        <span className="file-diff-name">{path}</span>
        <CopyButton text={path} label="Copy file path" />
        <span className="ml-auto fg-muted text-small">Submodule</span>
      </div>
      <SubmoduleView path={path} change={change} past />
    </div>
  )
}
