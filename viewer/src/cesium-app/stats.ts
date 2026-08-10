// Tiny rolling FPS / frame-time meter. Call tick(now) once per rendered frame.
export class Fps {
  private last = 0
  private acc = 0
  private frames = 0
  fps = 0
  frameMs = 0

  tick(now: number): void {
    if (this.last === 0) { this.last = now; return }
    const dt = now - this.last
    this.last = now
    this.acc += dt
    this.frames++
    if (this.acc >= 250) { // refresh 4×/s
      this.fps = (this.frames * 1000) / this.acc
      this.frameMs = this.acc / this.frames
      this.acc = 0
      this.frames = 0
    }
  }
}
