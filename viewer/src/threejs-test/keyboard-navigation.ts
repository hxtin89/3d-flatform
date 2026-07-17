import * as THREE from 'three'
import type { GlobeControls } from '3d-tiles-renderer'
import { EXPERIENCE_CONFIG } from './config'

const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'])
const SHIFT_CODES = new Set(['ShiftLeft', 'ShiftRight'])
const ACTION_CODES = new Set(['KeyC', 'Enter', 'Escape'])
const REQUIRED_NAVIGATION_TASKS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'zoom-in', 'zoom-out'])

export interface KeyboardNavigation {
  update(now: number, cameraGroundRange: number, enabled: boolean, zoomInBlocked?: boolean): void
  setAimActive(active: boolean): void
  dispose(): void
}

export function createKeyboardNavigation(options: {
  camera: THREE.PerspectiveCamera
  controls: GlobeControls
  guide: HTMLElement
  guideToggle: HTMLButtonElement
  guideClose: HTMLButtonElement
  aimToggle: HTMLButtonElement
  onToggleAim(): void
  onActivateAim(): boolean
  onDismissAim(): boolean
}): KeyboardNavigation {
  const { camera, controls, guide, guideToggle, guideClose, aimToggle } = options
  const controlState = controls as GlobeControls & {
    pivotPoint?: THREE.Vector3
    needsUpdate?: boolean
  }
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

  const localUp = new THREE.Vector3()
  const screenForward = new THREE.Vector3()
  const screenRight = new THREE.Vector3()
  const inputPan = new THREE.Vector3()
  const targetPanVelocity = new THREE.Vector3()
  const panVelocity = new THREE.Vector3()
  const frameDelta = new THREE.Vector3()
  const zoomDirection = new THREE.Vector3()

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
    const engaged = pressed.has('KeyW') || pressed.has('KeyA') || pressed.has('KeyS')
      || pressed.has('KeyD') || pressed.has('Space')
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

  const onKeyDown = (event: KeyboardEvent) => {
    if (isTextEntryTarget(event.target)) return
    if (!MOVE_CODES.has(event.code) && !SHIFT_CODES.has(event.code) && !ACTION_CODES.has(event.code)) return
    if (!shortcutsEnabled) return
    if (event.code === 'Enter' && isNativeActivationTarget(event.target)) return
    pressed.add(event.code)
    observeKeyboard()
    if (MOVE_CODES.has(event.code)) {
      if (event.code === 'Space') markNavigationTask(hasShift() ? 'zoom-out' : 'zoom-in')
      else markNavigationTask(event.code)
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
    panVelocity.set(0, 0, 0)
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
    update(now, cameraGroundRange, enabled, zoomInBlocked = false) {
      shortcutsEnabled = enabled
      const elapsed = Math.min(64, Math.max(0, now - lastUpdate))
      lastUpdate = now
      if (!enabled || !controls.enabled) {
        panVelocity.set(0, 0, 0)
        zoomVelocity = 0
        return
      }

      camera.updateMatrixWorld()
      controls.getCameraUpDirection(localUp)

      screenRight.setFromMatrixColumn(camera.matrixWorld, 0)
      screenRight.addScaledVector(localUp, -screenRight.dot(localUp))
      if (screenRight.lengthSq() > 1e-8) screenRight.normalize()

      screenForward.setFromMatrixColumn(camera.matrixWorld, 1)
      screenForward.addScaledVector(localUp, -screenForward.dot(localUp))
      if (screenForward.lengthSq() < 1e-8) {
        camera.getWorldDirection(screenForward)
        screenForward.addScaledVector(localUp, -screenForward.dot(localUp))
      }
      if (screenForward.lengthSq() > 1e-8) screenForward.normalize()

      inputPan.set(0, 0, 0)
      if (pressed.has('KeyW')) inputPan.add(screenForward)
      if (pressed.has('KeyS')) inputPan.sub(screenForward)
      if (pressed.has('KeyD')) inputPan.add(screenRight)
      if (pressed.has('KeyA')) inputPan.sub(screenRight)
      if (inputPan.lengthSq() > 1) inputPan.normalize()

      const range = Number.isFinite(cameraGroundRange)
        ? cameraGroundRange
        : EXPERIENCE_CONFIG.atmosphere.fallbackRangeM
      const panSpeed = THREE.MathUtils.clamp(
        range * EXPERIENCE_CONFIG.keyboard.panRangeFactor,
        EXPERIENCE_CONFIG.keyboard.minimumPanSpeedMps,
        EXPERIENCE_CONFIG.keyboard.maximumPanSpeedMps,
      )
      targetPanVelocity.copy(inputPan).multiplyScalar(panSpeed)

      let zoomInput = pressed.has('Space') ? (hasShift() ? -1 : 1) : 0
      // At the zoom stop (range limit or navigation floor) Space must not keep
      // sliding the camera forward — lateral travel is what WASD is for.
      if (zoomInput > 0 && (zoomInBlocked
        || cameraGroundRange <= EXPERIENCE_CONFIG.navigation.minimumZoomDistanceM)) {
        zoomInput = 0
        zoomVelocity = Math.min(0, zoomVelocity)
      }
      const zoomSpeed = THREE.MathUtils.clamp(
        range * EXPERIENCE_CONFIG.keyboard.zoomRangeFactor,
        EXPERIENCE_CONFIG.keyboard.minimumZoomSpeedMps,
        EXPERIENCE_CONFIG.keyboard.maximumZoomSpeedMps,
      )
      const blend = 1 - Math.exp(-elapsed / EXPERIENCE_CONFIG.keyboard.responseMs)
      panVelocity.lerp(targetPanVelocity, blend)
      zoomVelocity += (zoomInput * zoomSpeed - zoomVelocity) * blend

      const seconds = elapsed * 0.001
      let moved = false
      if (panVelocity.lengthSq() > 0.01) {
        frameDelta.copy(panVelocity).multiplyScalar(seconds)
        camera.position.add(frameDelta)
        controlState.pivotPoint?.add(frameDelta)
        moved = true
      }
      if (Math.abs(zoomVelocity) > 0.1) {
        camera.getWorldDirection(zoomDirection)
        camera.position.addScaledVector(zoomDirection, zoomVelocity * seconds)
        moved = true
      }

      if (moved) {
        camera.updateMatrixWorld()
        controlState.needsUpdate = true
      }
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
