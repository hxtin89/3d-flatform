// ?compare=1: once the scene exists, switch every optimisation off in one
// atomic pass — the same code path as the panel toggle.
import { useEffect } from 'react'
import { APP_PARAMS } from '../params'
import { useBootStore } from '../state/boot-store'
import { setCompareMode } from '../state/render-options-bridge'

export function CompareBoot() {
  const framesReady = useBootStore((s) => s.framesReady)
  useEffect(() => {
    if (framesReady && APP_PARAMS.compareParam) setCompareMode(true)
  }, [framesReady])
  return null
}
