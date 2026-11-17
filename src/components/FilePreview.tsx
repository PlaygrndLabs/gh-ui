import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { decodeFileBytes } from '../lib/suggestions'
import { formatBytes } from '../lib/format'
import { imageType, sameBytes, type FileSource, type FileVersion, type PreviewKind } from '../lib/filePreview'
import { Markdown } from './Markdown'
import { Loading } from './Bits'

export interface PreviewFile {
  path: string
  previousPath?: string | null
  status: string
}

/** Which versions a change has: a new file has no before, a deleted one no after. */
function versionsOf(file: PreviewFile): FileVersion[] {
  if (file.status === 'added' || file.status === 'untracked') return ['after']
  if (file.status === 'removed' || file.status === 'deleted') return ['before']
  return ['before', 'after']
}

const pathAt = (file: PreviewFile, version: FileVersion) => (version === 'before' ? file.previousPath || file.path : file.path)

function useFileBytes(source: FileSource, file: PreviewFile, version: FileVersion) {
  const path = pathAt(file, version)
  return useQuery({
    queryKey: ['file-preview', source.id, version, path],
    queryFn: () => source.read(version, path),
    staleTime: source.live && version === 'after' ? 0 : Infinity,
    refetchInterval: source.live && version === 'after' ? 4000 : false,
    // The same bytes keep the same image, so rereading the folder doesn't make it blink.
    structuralSharing: (old, next) => (sameBytes(old as Uint8Array | null, next as Uint8Array | null) ? old : next) as Uint8Array | null,
    retry: 1,
  })
}

/** A file as itself: images side by side, before and after; Markdown rendered. */
export function FilePreview({ file, source, kind }: { file: PreviewFile; source: FileSource; kind: PreviewKind }) {
  if (kind === 'markdown') return <MarkdownPreview file={file} source={source} />
  const versions = versionsOf(file)
  return (
    <div className={`file-preview file-preview-${versions.length === 2 ? 'two' : 'one'}`}>
      {versions.map((v) => (
        <ImageSide key={v} file={file} source={source} version={v} label={versions.length === 2 ? (v === 'before' ? 'Before' : 'After') : null} />
      ))}
    </div>
  )
}

function ImageSide({ file, source, version, label }: { file: PreviewFile; source: FileSource; version: FileVersion; label: string | null }) {
  const bytes = useFileBytes(source, file, version)
  const path = pathAt(file, version)
  const type = imageType(path) ?? 'application/octet-stream'
  const url = useMemo(() => (bytes.data ? URL.createObjectURL(new Blob([bytes.data as BlobPart], { type })) : null), [bytes.data, type])
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    setSize(null)
    setBroken(false)
  }, [url])

  return (
    <figure className={`file-preview-side ${label ? `file-preview-${version}` : ''}`}>
      {label && <figcaption className="file-preview-label">{label}</figcaption>}
      <div className="file-preview-canvas">
        {bytes.isLoading ? (
          <Loading />
        ) : bytes.error ? (
          <span className="file-preview-note">{bytes.error instanceof Error && bytes.error.message === 'Too large to preview.' ? 'Too large to preview.' : 'Couldn’t load this version.'}</span>
        ) : !url ? (
          <span className="file-preview-note">Not available.</span>
        ) : broken ? (
          <span className="file-preview-note">This image can’t be shown.</span>
        ) : (
          <img
            src={url}
            alt={`${path}${label ? ` (${label.toLowerCase()})` : ''}`}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setBroken(true)}
          />
        )}
      </div>
      {bytes.data && (
        <div className="file-preview-meta">
          {size && size.w > 0 && (
            <>
              <span>W: {size.w}px</span>
              <span>H: {size.h}px</span>
            </>
          )}
          <span>{formatBytes(bytes.data.length)}</span>
        </div>
      )}
    </figure>
  )
}

function MarkdownPreview({ file, source }: { file: PreviewFile; source: FileSource }) {
  const version: FileVersion = versionsOf(file).includes('after') ? 'after' : 'before'
  const bytes = useFileBytes(source, file, version)
  const text = useMemo(() => (bytes.data ? decodeFileBytes(bytes.data) : null), [bytes.data])
  return (
    <div className="file-preview-markdown">
      {bytes.isLoading ? (
        <Loading />
      ) : bytes.error || (bytes.data && text === null) ? (
        <span className="file-preview-note">Couldn’t load this file.</span>
      ) : (
        <Markdown text={text} context={source.context} emptyText="Empty file." />
      )}
    </div>
  )
}
