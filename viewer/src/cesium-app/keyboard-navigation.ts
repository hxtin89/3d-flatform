import * as Cesium from 'cesium'
import { EXPERIENCE_CONFIG } from './config'
import type { EnuFrame } from './enu'

const PAN_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
])
const ZOOM_CODES = new Set(['Space', 'Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'])
const MOVE_CODES = new Set([...PAN_CODES, ...ZOOM_CODES])
const SHIFT_CODES = new Set(['ShiftLeft', 'ShiftRight'])
const ACTION_CODES = new Set(['KeyC', 'Enter', 'Escape'])
const REQUIRED_NAVIGATION_TASKS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'zoom-in', 'zoom-out'])

export interface KeyboardNavigation {
  update(
    now: number,
    cameraGroundRange: number,
    enabled: boolean,
    zoomInBlocked?: boolean,
    zoomStopM?: number,
  ): void
  setAimActive(active: boolean): void
  dispose(): void
}

export function createKeyboardNavigation(options: {
  camera: Cesium.Camera
  controls: Cesium.ScreenSpaceCameraController
  enuFrame: EnuFrame
  guide: HTMLElement
  guideToggle: HTMLButtonElement
  guideClose: HTMLButtonElement
  aimToggle: HTMLButtonElement
  /** WP9 supplies the real aim-mode actions; WP3 may pass no-op stubs. */
  onToggleAim(): void
  onActivateAim(): boolean
  onDismissAim(): boolean
}): KeyboardNavigation {
  const { camera, controls, enuFrame, guide, guideToggle, guideClose, aimToggle } = options
  const pressed = new Set<string>()
  const completedTasks = new Set<string>()
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)')
  const keycaps = Array.from(guide.querySelectorAll<HTMLElement>('[data-key]'))
  const taskElements = Array.from(guide.querySelectorAll<HTMLElement>('[data-nav-task]'))
  let keyboardObserved = false
  let shortcutsEnabled = false
  let guideOpen = finePointer.matches
  let aimActive = false
  let trainingCompleted = false
  let guideDismissTimer = 0
  let lastUpdate = performance.now()
  let zoomVelocity = 0

  const screenForward = new Cesium.Cartesian3()
  const screenRight = new Cesium.Cartesian3()
  const inputPan = new Cesium.Cartesian3()
  const targetPanVelocity = new Cesium.Cartesian3()
  const panVelocity = new Cesium.Cartesian3()
  const frameDelta = new Cesium.Cartesian3()
  const zoomDirection = new Cesium.Cartesian3()
  const positionEnu = new Cesium.Cartesian3()
  const destinationWorld = new Cesium.Cartesian3()
  const directionWorld = new Cesium.Cartesian3()
  const upWorld = new Cesium.Cartesian3()

  function hasShift(): boolean {
    return pressed.has('ShiftLeft') || pressed.has('ShiftRight')
  }

  function syncGuide(): void {
    const capable = finePointer.matches || keyboardObserved
    const visible = capable && guideOpen
    document.body.classList.toggle('has-physical-keyboard', capable)
    guide.classList.toggle('is-open', visible)
    guide.setAttribute('aria-hidden', String(!visible))
    guideToggle.setAttribute('aria-expanded', String(visible))
    guideToggle.setAttribute('aria-label', visible ? 'Field Navigation ausblenden' : 'Field Navigation einblenden')
    aimToggle.setAttribute('aria-pressed', String(aimActive))
    aimToggle.classList.toggle('is-on', aimActive)
    const engaged = Array.from(MOVE_CODES).some((code) => pressed.has(code))
    guide.classList.toggle('is-engaged', engaged)
    for (const keycap of keycaps) {
      const code = keycap.dataset.key
      const active = code === 'Shift' ? hasShift() : Boolean(code && pressed.has(code))
      keycap.classList.toggle('is-active', active)
      keycap.classList.toggle('is-latched', code === 'KeyC' && aimActive)
    }
    for (const element of taskElements) {
      element.classList.toggle('is-tried', completedTasks.has(element.dataset.navTask ?? ''))
    }
  }

  function isTextEntryTarget(target: EventTarget | null): boolean {
    const element = target instanceof HTMLElement ? target : null
    return Boolean(element?.closest('input, textarea, select, video, [contenteditable="true"]'))
  }

  function isNativeActivationTarget(target: EventTarget | null): boolean {
    const element = target instanceof HTMLElement ? target : null
    return Boolean(element?.closest('button, a[href], input, select, textarea, video'))
  }

  function observeKeyboard(): void {
    if (!keyboardObserved) guideOpen = true
    keyboardObserved = true
  }

  function setGuideOpen(nextOpen: boolean): void {
    window.clearTimeout(guideDismissTimer)
    guideDismissTimer = 0
    guide.classList.remove('is-complete')
    guideOpen = nextOpen
    syncGuide()
  }

  function markNavigationTask(task: string): void {
    if (trainingCompleted) return
    completedTasks.add(task)
    if (completedTasks.size !== REQUIRED_NAVIGATION_TASKS.size || guideDismissTimer) return
    trainingCompleted = true
    guide.classList.add('is-complete')
    guideDismissTimer = window.setTimeout(() => {
      guideDismissTimer = 0
      guideOpen = false
      guide.classList.remove('is-complete')
      syncGuide()
    }, 900)
  }

  function panTaskForCode(code: string): string {
    if (code === 'ArrowUp') return 'KeyW'
    if (code === 'ArrowLeft') return 'KeyA'
    if (code === 'ArrowDown') return 'KeyS'
    if (code === 'ArrowRight') return 'KeyD'
    return code
  }

  function isZoomOutCode(code: string): boolean {
    return code === 'Minus' || code === 'NumpadSubtract' || (code === 'Space' && hasShift())
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (isTextEntryTarget(event.target)) return
    if (!MOVE_CODES.has(event.code) && !SHIFT_CODES.has(event.code) && !ACTION_CODES.has(event.code)) return
    if (!shortcutsEnabled) return
    if (event.code === 'Enter' && isNativeActivationTarget(event.target)) return
    pressed.add(event.code)
    observeKeyboard()
    if (MOVE_CODES.has(event.code)) {
      if (ZOOM_CODES.has(event.code)) markNavigationTask(isZoomOutCode(event.code) ? 'zoom-out' : 'zoom-in')
      else markNavigationTask(panTaskForCode(event.code))
      event.preventDefault()
    } else if (event.code === 'KeyC') {
      event.preventDefault()
      if (!event.repeat) options.onToggleAim()
    } else if (event.code === 'Enter') {
      if (!event.repeat && options.onActivateAim()) event.preventDefault()
    } else if (event.code === 'Escape') {
      if (!event.repeat && options.onDismissAim()) event.preventDefault()
    }
    syncGuide()
  }

  const onKeyUp = (event: KeyboardEvent) => {
    if (!MOVE_CODES.has(event.code) && !SHIFT_CODES.has(event.code) && !ACTION_CODES.has(event.code)) return
    pressed.delete(event.code)
    if (MOVE_CODES.has(event.code)) event.preventDefault()
    syncGuide()
  }

  const clearPressed = () => {
    pressed.clear()
    Cesium.Cartesian3.ZERO.clone(panVelocity)
    zoomVelocity = 0
    syncGuide()
  }
  const onPointerChange = () => syncGuide()
  const onGuideToggle = () => setGuideOpen(!guideOpen)
  const onGuideClose = () => setGuideOpen(false)
  const onAimToggle = () => {
    if (shortcutsEnabled) options.onToggleAim()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', clearPressed)
  document.addEventListener('visibilitychange', clearPressed)
  finePointer.addEventListener('change', onPointerChange)
  guideToggle.addEventListener('click', onGuideToggle)
  guideClose.addEventListener('click', onGuideClose)
  aimToggle.addEventListener('click', onAimToggle)
  syncGuide()

  return {
    update(now, cameraGroundRange, enabled, zoomInBlocked = false, zoomStopM = 0) {
      shortcutsEnabled = enabled
      const elapsed = Math.min(64, Math.max(0, now - lastUpdate))
      lastUpdate = now
      if (!enabled || !controls.enableInputs) {
        Cesium.Cartesian3.ZERO.clone(panVelocity)
        zoomVelocity = 0
        return
      }

      Cesium.Matrix4.multiplyByPointAsVector(enuFrame.inverse, camera.rightWC, screenRight)
      screenRight.z = 0
      if (Cesium.Cartesian3.magnitudeSquared(screenRight) > 1e-8) {
        Cesium.Cartesian3.normalize(screenRight, screenRight)
      }

      // Camera up is the screen's vertical axis. Projecting it onto the ENU
      // ground plane makes W/ArrowUp travel toward the top of the viewport.
      Cesium.Matrix4.multiplyByPointAsVector(enuFrame.inverse, camera.upWC, screenForward)
      screenForward.z = 0
      if (Cesium.Cartesian3.magnitudeSquared(screenForward) < 1e-8) {
        Cesium.Matrix4.multiplyByPointAsVector(enuFrame.inverse, camera.directionWC, screenForward)
        screenForward.z = 0
      }
      if (Cesium.Cartesian3.magnitudeSquared(screenForward) > 1e-8) {
        Cesium.Cartesian3.normalize(screenForward, screenForward)
      }

      Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO, inputPan)
      if (pressed.has('KeyW') || pressed.has('ArrowUp')) Cesium.Cartesian3.add(inputPan, screenForward, inputPan)
      if (pressed.has('KeyS') || pressed.has('ArrowDown')) Cesium.Cartesian3.subtract(inputPan, screenForward, inputPan)
      if (pressed.has('KeyD') || pressed.has('ArrowRight')) Cesium.Cartesian3.add(inputPan, screenRight, inputPan)
      if (pressed.has('KeyA') || pressed.has('ArrowLeft')) Cesium.Cartesian3.subtract(inputPan, screenRight, inputPan)
      if (Cesium.Cartesian3.magnitudeSquared(inputPan) > 1) Cesium.Cartesian3.normalize(inputPan, inputPan)

      const range = Number.isFinite(cameraGroundRange)
        ? cameraGroundRange
        : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM
      const panSpeed = Cesium.Math.clamp(
        range * EXPERIENCE_CONFIG.keyboard.panRangeFactor,
        EXPERIENCE_CONFIG.keyboard.minimumPanSpeedMps,
        EXPERIENCE_CONFIG.keyboard.maximumPanSpeedMps,
      )
      Cesium.Cartesian3.multiplyByScalar(inputPan, panSpeed, targetPanVelocity)

      const zoomIn = pressed.has('Space') && !hasShift()
        || pressed.has('Equal')
        || pressed.has('NumpadAdd')
      const zoomOut = pressed.has('Space') && hasShift()
        || pressed.has('Minus')
        || pressed.has('NumpadSubtract')
      let zoomInput = Number(zoomIn) - Number(zoomOut)
      // At the zoom stop (range limit or navigation floor) zoom-in must not
      // keep sliding forward. Lateral travel is what WASD/arrows are for.
      if (zoomInput > 0 && (zoomInBlocked || cameraGroundRange <= zoomStopM)) {
        zoomInput = 0
        zoomVelocity = Math.min(0, zoomVelocity)
      }
      const zoomSpeed = Cesium.Math.clamp(
        range * EXPERIENCE_CONFIG.keyboard.zoomRangeFactor,
        EXPERIENCE_CONFIG.keyboard.minimumZoomSpeedMps,
        EXPERIENCE_CONFIG.keyboard.maximumZoomSpeedMps,
      )
      const blend = 1 - Math.exp(-elapsed / EXPERIENCE_CONFIG.keyboard.responseMs)
      Cesium.Cartesian3.lerp(panVelocity, targetPanVelocity, blend, panVelocity)
      zoomVelocity += (zoomInput * zoomSpeed - zoomVelocity) * blend

      const seconds = elapsed * 0.001
      Cesium.Cartesian3.multiplyByScalar(panVelocity, seconds, frameDelta)
      if (Math.abs(zoomVelocity) > 0.1) {
        Cesium.Matrix4.multiplyByPointAsVector(enuFrame.inverse, camera.directionWC, zoomDirection)
        Cesium.Cartesian3.normalize(zoomDirection, zoomDirection)
        Cesium.Cartesian3.multiplyByScalar(zoomDirection, zoomVelocity * seconds, zoomDirection)
        Cesium.Cartesian3.add(frameDelta, zoomDirection, frameDelta)
      }
      if (Cesium.Cartesian3.magnitudeSquared(frameDelta) <= 0.0001) return

      enuFrame.worldToEnu(camera.positionWC, positionEnu)
      Cesium.Cartesian3.add(positionEnu, frameDelta, positionEnu)
      enuFrame.enuToWorld(positionEnu, destinationWorld)
      Cesium.Cartesian3.clone(camera.directionWC, directionWorld)
      Cesium.Cartesian3.clone(camera.upWC, upWorld)
      camera.setView({
        destination: destinationWorld,
        orientation: { direction: directionWorld, up: upWorld },
      })
    },

    setAimActive(active) {
      aimActive = active
      syncGuide()
    },

    dispose() {
      window.clearTimeout(guideDismissTimer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clearPressed)
      document.removeEventListener('visibilitychange', clearPressed)
      finePointer.removeEventListener('change', onPointerChange)
      guideToggle.removeEventListener('click', onGuideToggle)
      guideClose.removeEventListener('click', onGuideClose)
      aimToggle.removeEventListener('click', onAimToggle)
      document.body.classList.remove('has-physical-keyboard')
      document.body.classList.remove('aim-mode')
    },
  }
}
