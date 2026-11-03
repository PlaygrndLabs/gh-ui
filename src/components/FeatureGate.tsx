import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Button } from '@primer/react'
import { LinkExternalIcon } from '@primer/octicons-react'
import { Blankslate } from './Bits'
import { useAccount } from '../lib/auth'
import { FEATURES, useFeatures, type Feature } from '../lib/features'
import { webBaseFor } from '../lib/hosts'
import { openExternal } from '../lib/platform'

/** A link can still lead to a part that's switched off, so it says so and offers both ways forward. Nothing loads until then. */
export function FeatureGate({ feature, children }: { feature: Feature; children: ReactNode }) {
  const { isOn, setFeature } = useFeatures()
  const { host } = useAccount()
  const { pathname, search, hash } = useLocation()
  if (isOn(feature)) return <>{children}</>
  return (
    <div className="container-lg">
      <Blankslate
        title={`${FEATURES[feature].label} is switched off`}
        action={
          <div className="flex-center gap-2" style={{ justifyContent: 'center' }}>
            <Button variant="primary" onClick={() => setFeature(feature, true)}>
              Turn it on
            </Button>
            <Button leadingVisual={LinkExternalIcon} onClick={() => openExternal(`${webBaseFor(host)}${pathname}${search}${hash}`)}>
              Open on GitHub
            </Button>
          </div>
        }
      >
        You can change this any time in Settings → Features.
      </Blankslate>
    </div>
  )
}
