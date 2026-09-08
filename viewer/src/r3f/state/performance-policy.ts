/** Frame-time feedback independent of React and the display refresh rate. */
export interface GovernorConfig {
  enabled: boolean
  targetFps: number
  budgetFactor: number
  warmupMs: number
  overloadMs: number
  recoveryMs: number
  minChangeIntervalMs: number
  scaleMin: number
  scaleMax: number
  scaleStep: number
  sseSteps: readonly number[]
}

export class PerformanceGovernor {
  readonly state = {
    scale: 1, sse: 1, effects: 0, refreshMs: 16.67, budgetMs: 18.33,
    medianMs: 0, p95Ms: 0, stutterShare: 0,
  }
  private samples: Array<{ at: number; ms: number }> = []
  private warmUntil = 0
  private lastDecision = -Infinity
  private lastChange = -Infinity
  private overloadedSince: number | null = null
  private healthySince: number | null = null

  constructor(private readonly config: GovernorConfig) {
    this.state.budgetMs = 1000 / config.targetFps * config.budgetFactor
  }

  reset(now: number): void {
    this.samples.length = 0
    this.warmUntil = now + this.config.warmupMs
    this.overloadedSince = this.healthySince = null
    this.lastDecision = this.lastChange = -Infinity
    Object.assign(this.state, { scale: 1, sse: 1, effects: 0, medianMs: 0, p95Ms: 0, stutterShare: 0 })
  }

  update(input: { now: number; frameMs: number; active: boolean; streaming: boolean }) {
    const { now, frameMs, active, streaming } = input
    const cfg = this.config
    if (!cfg.enabled) { this.reset(now); return this.state }
    if (!active || !Number.isFinite(frameMs) || frameMs <= 0) {
      this.samples.length = 0
      this.overloadedSince = this.healthySince = null
      this.warmUntil = now + cfg.warmupMs
      return this.state
    }
    this.samples.push({ at: now, ms: frameMs })
    while (this.samples.length && this.samples[0].at < now - 1500) this.samples.shift()
    if (now < this.warmUntil || this.samples.length < 2
      || now - this.samples[0].at < 750 || now - this.lastDecision < 250) return this.state
    this.lastDecision = now
    const sorted = this.samples.map(s => s.ms).sort((a, b) => a - b)
    const quantile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    const targetMs = 1000 / cfg.targetFps
    // The observed p10 may itself be GPU-bound. It must never raise the budget.
    this.state.refreshMs = quantile(0.1)
    this.state.medianMs = quantile(0.5)
    this.state.p95Ms = quantile(0.95)
    this.state.stutterShare = sorted.filter(ms => ms > targetMs * 1.5).length / sorted.length
    const overloaded = this.state.medianMs > this.state.budgetMs
      || (!streaming && this.state.stutterShare > 0.1)
    const healthy = this.state.medianMs <= targetMs * 1.05 && this.state.stutterShare <= 0.03
    this.overloadedSince = overloaded ? this.overloadedSince ?? now : null
    this.healthySince = healthy ? this.healthySince ?? now : null
    if (now - this.lastChange < cfg.minChangeIntervalMs) return this.state
    if (this.overloadedSince !== null && now - this.overloadedSince >= cfg.overloadMs) {
      if (this.state.effects < 2) this.state.effects++
      else {
        const next = cfg.sseSteps.find(value => value > this.state.sse)
        if (next !== undefined) this.state.sse = next
        else this.state.scale = Math.max(cfg.scaleMin, this.state.scale - cfg.scaleStep)
      }
      this.lastChange = now
    } else if (this.healthySince !== null && now - this.healthySince >= cfg.recoveryMs) {
      if (this.state.scale < cfg.scaleMax) this.state.scale = Math.min(cfg.scaleMax, this.state.scale + cfg.scaleStep)
      else if (this.state.sse > 1) this.state.sse = [...cfg.sseSteps].reverse().find(value => value < this.state.sse) ?? 1
      else if (this.state.effects > 0) this.state.effects--
      this.lastChange = now
    }
    return this.state
  }
}
