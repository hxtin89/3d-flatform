/**
 * The drawn diameter of a cloud dot, in CSS pixels — the CPU copy of the size rule the
 * vertex stage applies (point-cloud.ts, cloudGraphFor's sizeNode), without the dome's fade.
 *
 * One copy, used by everything on the CPU that has to agree with the shader: the Overdraw
 * readout, the spacing table and the rotation pivot's pick. A pure function of numbers, so
 * node can test what uses it and a hot loop can call it without going through a closure.
 */
export interface DotSizeRule {
  /** `pointSize`: the base size, and the whole size in the fixed branch. */
  pointSizePx: number
  /** `sizeSpacingMix`: 0 is the fixed branch, 1 the spacing rule. */
  spacingMix: number
  /** `sizeRequestedPx`: the spacing the error target asks for, the shortfall's denominator. */
  requestedPx: number
  /** `sizePxPerMetre`: metres at 1 m depth to CSS pixels. */
  pxPerMetre: number
  minPx: number
  maxPx: number
}

/**
 * `thinScale` has to appear in BOTH branches and in the same places the shader puts it
 * (inside the delivered spacing before the clamp, and on `pointSize` in the fixed branch,
 * which is deliberately left unclamped). Without it the Overdraw readout once billed the
 * thinned instance count at the unwidened diameter, and claimed a 44% drop in painted area
 * where the true figure was 0%.
 */
export function drawnDotDiameterPx(rule: DotSizeRule, spacingM: number, viewDepthM: number, thinScale = 1): number {
  const deliveredPx = spacingM * thinScale * rule.pxPerMetre / Math.max(viewDepthM, 0.001)
  const shortfall = Math.max(1, deliveredPx / Math.max(rule.requestedPx, 0.001))
  // THREE.MathUtils.clamp and lerp, spelled out in their own operand order so the result is
  // the one the readouts computed with them, to the bit.
  const fixed = rule.pointSizePx * thinScale
  const spaced = Math.max(rule.minPx, Math.min(rule.maxPx, rule.pointSizePx * shortfall))
  return (1 - rule.spacingMix) * fixed + rule.spacingMix * spaced
}

/** The largest diameter the rule can draw for this thinning, at any depth. */
export function largestDotDiameterPx(rule: DotSizeRule, thinScale = 1): number {
  return Math.max(rule.pointSizePx * thinScale, rule.maxPx, rule.minPx)
}
