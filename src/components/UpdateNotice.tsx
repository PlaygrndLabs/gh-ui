import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ActionList, ActionMenu, Button } from '@primer/react'
import { DownloadIcon, LinkExternalIcon, TriangleDownIcon } from '@primer/octicons-react'
import { useFeature } from '../lib/features'
import { copyText } from '../lib/format'
import { native, openExternal } from '../lib/platform'
import { useSharedPref } from '../lib/storage'
import { BREW_UPGRADE_COMMAND, isNewerVersion, LATEST_RELEASE_API, releasePage, releaseVersion } from '../lib/updates'

const CHECK_EVERY = 6 * 60 * 60 * 1000

/** Asks GitHub for the latest release, without any account's token: the repository is public. */
export function useUpdateCheck() {
  const query = useQuery({
    queryKey: ['app-latest-release'],
    enabled: !!native,
    staleTime: CHECK_EVERY / 2,
    refetchInterval: CHECK_EVERY,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const res = await native!.http({ url: LATEST_RELEASE_API, headers: { accept: 'application/vnd.github+json', 'user-agent': 'gh-ui' } })
      if (res.status !== 200) throw new Error(`GitHub answered ${res.status}`)
      return releaseVersion(JSON.parse(res.body))
    },
  })
  const install = useQuery({ queryKey: ['app-install-kind'], enabled: !!native, staleTime: Infinity, queryFn: () => native!.installKind() })
  const current = native?.version ?? ''
  const latest = query.data ?? null
  return { current, latest, available: !!latest && isNewerVersion(latest, current), homebrew: install.data === 'homebrew', query }
}

/** Homebrew does the update, so this hands over its command; a download goes through the release page. */
export function useStartUpdate(version: string | null, homebrew: boolean) {
  const [copied, setCopied] = useState(false)
  const start = async () => {
    if (!homebrew) {
      if (version) openExternal(releasePage(version))
      return
    }
    if (await copyText(BREW_UPGRADE_COMMAND)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 6000)
      void native!.openTerminal()
    }
  }
  return { copied, start }
}

/** In the tab strip, only when there's something new. Later hides it until the next version. */
export function UpdateNotice() {
  const on = useFeature('updateNotice')
  const { current, latest, available, homebrew } = useUpdateCheck()
  const [dismissed, setDismissed] = useSharedPref<string | null>('updateDismissed', null)
  const { copied, start } = useStartUpdate(latest, homebrew)
  if (!on || !available || !latest || (dismissed === latest && !copied)) return null
  if (copied) return <span className="update-copied">Command copied. Paste it in Terminal.</span>
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <Button className="update-notice" size="small" variant="invisible" leadingVisual={DownloadIcon} trailingVisual={TriangleDownIcon}>
          Update available
        </Button>
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="medium" align="end">
        <div className="update-heading">
          Version {latest} is available (you have {current})
        </div>
        <ActionList>
          <ActionList.Item onSelect={() => void start()}>
            <ActionList.LeadingVisual>{homebrew ? <DownloadIcon /> : <LinkExternalIcon />}</ActionList.LeadingVisual>
            {homebrew ? 'Update with Homebrew' : 'Download'}
            <ActionList.Description variant="block">
              {homebrew ? 'Copies the command and opens Terminal. Restart the app afterwards.' : 'Opens the release page on GitHub.'}
            </ActionList.Description>
          </ActionList.Item>
          {homebrew && (
            <ActionList.Item onSelect={() => openExternal(releasePage(latest))}>
              <ActionList.LeadingVisual>
                <LinkExternalIcon />
              </ActionList.LeadingVisual>
              What's new
            </ActionList.Item>
          )}
          <ActionList.Item onSelect={() => setDismissed(latest)}>Later</ActionList.Item>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  )
}
