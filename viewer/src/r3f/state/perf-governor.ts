import { EXPERIENCE_CONFIG } from '../../threejs-test/config'
import { PerformanceGovernor } from './performance-policy'
import { frame } from './frame'
import { isBootLoading } from './boot-store'

const governor = new PerformanceGovernor(EXPERIENCE_CONFIG.perf)
export function resetPerfGovernor(): void { governor.reset(frame.now) }
export function perfScale(): number { return governor.state.scale }
/** Applies only to distant tiles. Near detail has its own protected target. */
export function perfSseFactor(): number { return governor.state.sse }
export function perfEffectLevel(): number { return governor.state.effects }
export function perfDebug() { return { ...governor.state } }
export function updatePerfGovernor(dtMs: number): number {
  return governor.update({
    now: frame.now,
    frameMs: dtMs,
    active: !document.hidden && !isBootLoading() && frame.pointCloudRevealed && !frame.cameraBusy,
    streaming: (frame.lastStreamStats?.progress ?? 0) < 0.999,
  }).scale
}
