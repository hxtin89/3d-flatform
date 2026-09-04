// Store → document.body classes the stylesheet keys on.
import { useEffect } from 'react'
import { APP_PARAMS } from '../params'
import { useUiStore } from '../state/ui-store'

export function BodyClasses() {
  const hudOpen = useUiStore((s) => s.hudOpen)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const maskMode = useUiStore((s) => s.maskMode)
  const compareMode = useUiStore((s) => s.compareMode)
  const splatSolo = useUiStore((s) => s.splatSolo)
  const aimMode = useUiStore((s) => s.aimMode)
  useEffect(() => {
    const body = document.body.classList
    body.toggle('hud-open', hudOpen)
    body.toggle('ui-minimal', !APP_PARAMS.panelEnabled)
    body.toggle('panel-open', APP_PARAMS.panelEnabled && panelOpen)
    body.toggle('mask-vignette', maskMode === 2)
    body.toggle('compare-mode', compareMode)
    body.toggle('splat-solo', splatSolo)
    body.toggle('aim-mode', aimMode)
  }, [hudOpen, panelOpen, maskMode, compareMode, splatSolo, aimMode])
  return null
}
