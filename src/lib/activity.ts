import { useEffect, useRef, type DependencyList, type EffectCallback } from 'react'

/**
 * An effect that runs when its dependencies change, but not again when a hidden tab is shown. <Activity> re-runs
 * every effect at that point, which is right for subscriptions and wrong for anything that changes what the user sees.
 */
export function useEffectOnChange(effect: EffectCallback, deps: DependencyList) {
  const seen = useRef<DependencyList | null>(null)
  useEffect(() => {
    if (seen.current && seen.current.length === deps.length && seen.current.every((d, i) => Object.is(d, deps[i]))) return
    seen.current = deps
    return effect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
