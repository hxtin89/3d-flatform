// 3D-Gaussian-Splatting-Ansicht (Spark) — bewusst eine eigenständige, von der
// Karten-App entkoppelte Mini-Anwendung auf einem eigenen WebGL-Overlay.
//
// Grund für den eigenen Renderer: Spark (@sparkjsdev/spark) verlangt einen
// echten THREE.WebGLRenderer (SparkRenderer greift auf `.state`, `.properties`,
// `.setRenderTarget` zu). Die App rendert aber über `WebGPURenderer` — auch mit
// `?webgl` bleibt es der WebGPU-Renderer mit WebGL-Backend, nicht die klassische
// WebGL-Klasse. Spark kann sich dort NICHT einklinken. Deshalb: eigener
// WebGLRenderer, eigene Kamera, eigene Steuerung (SparkControls, KEIN Orbit-/
// Globe-Control). Der Aufrufer schaltet parallel die Hauptszene stumm (Solo).
//
// Dieser Umweg IST ein Kernbefund des Scopings: 3DGS im Three.js-Pfad heißt
// heute entweder die ganze App auf klassisches WebGL zurückbauen (und den
// TSL/WebGPU-Wolken-Stack verlieren) oder einen WebGPU-nativen Splat-Renderer
// (@three-blocks GaussianSplatsMaterial) selbst integrieren.
import * as THREE from 'three'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'

export type GaussianSplatStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface GaussianSplatState {
  status: GaussianSplatStatus
  message: string
  /** Gesplatterte Primitive nach dem Laden — Kennzahl für Datenumfang. */
  splats: number
  /** Zeit vom Ladebeginn bis „ready" in ms. */
  loadMs: number
}

export interface GaussianSplatLayer {
  /** Overlay ein-/ausblenden. Erstes Aktivieren stößt den Ladevorgang an. */
  setEnabled(on: boolean): void
  isEnabled(): boolean
  /** Pro Frame aus der Hauptschleife aufrufen (nur aktiv, wenn eingeblendet). */
  update(): void
  resize(): void
  getState(): GaussianSplatState
  dispose(): void
}

/** INRIA-/COLMAP-Splats sind Z-up. Um sie in die three-Welt (Y-up) zu stellen,
 * wird die Splat-Wurzel um diesen Winkel um X gedreht. Als Konstante gehalten,
 * damit die Kalibrierung ein einziger Wert bleibt. */
const SPLAT_FLIP_X = -Math.PI / 2
/** Gehgeschwindigkeit in Szenen-Einheiten pro Sekunde. Die Person läuft, sie
 * fliegt nicht. */
const WALK_SPEED = 4

interface StartupCamera {
  position: [number, number, number]
  rotation: number[][]
}

export function createGaussianSplatLayer(opts: {
  url: string
  /** cameras.json neben dem Modell; wird sonst aus `url` abgeleitet. */
  camerasUrl?: string
  onStateChange?: (state: GaussianSplatState) => void
}): GaussianSplatLayer {
  const camerasUrl = opts.camerasUrl
    ?? opts.url.replace(/point_cloud\/iteration_\d+\/[^/]+$/, 'cameras.json')

  // Vollbild-Overlay über der WebGPU-Canvas. Opak (kein `alpha`): im Solo-Modus
  // ist die Hauptszene verborgen, Splat-Lücken sollen den Himmel zeigen, nicht
  // ein eingefrorenes Kartenbild. `pointer-events` nur aktiv, wenn eingeblendet.
  const canvas = document.createElement('canvas')
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;z-index:6;display:none;pointer-events:none;touch-action:none'
  document.body.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setClearColor(0x8fb4d6, 1) // heller Himmel als Hintergrund

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 4000)
  camera.position.set(0, 1, 0)

  // Splat-Wurzel trägt die Z-up → Y-up-Drehung. Kein Recentern: die Startkamera
  // aus cameras.json sitzt bereits mitten im Modell.
  const splatRoot = new THREE.Group()
  splatRoot.rotation.x = SPLAT_FLIP_X
  scene.add(splatRoot)
  const flip = new THREE.Matrix4().makeRotationX(SPLAT_FLIP_X)

  let enabled = false
  let loadStarted = false
  let startupCam: StartupCamera | null = null
  let splat: { dispose?: () => void } | null = null
  let spark: ({ dispose?: () => void; activeSplats?: number }) | null = null

  // Ego-Shooter-Steuerung über die Standard-`PointerLockControls`: Klick sperrt
  // den Zeiger (versteckt ihn), Mausbewegung liefert dann unbegrenzte Deltas →
  // volle 360°-Umsicht, der Cursor verlässt nie das Fenster. Esc löst die Sperre
  // (zurück zum Panel). Blickrichtung nicht invertiert, roll-frei.
  const controls = new PointerLockControls(camera, canvas)
  const onCanvasClick = () => { if (enabled && !controls.isLocked) controls.lock() }
  canvas.addEventListener('click', onCanvasClick)

  // WASD läuft auf konstanter Höhe. Der eingebaute `moveForward`/`moveRight`
  // bewegt bereits in der Bodenebene (unabhängig von der Blickneigung); danach
  // wird die Höhe hart gehalten, damit man nicht in Bäume steigt oder versinkt.
  const keys = new Set<string>()
  let walkHeight = 1
  let lastMoveMs = performance.now()
  const WALK_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD'])
  const onKeyDown = (e: KeyboardEvent) => { if (enabled && WALK_KEYS.has(e.code)) keys.add(e.code) }
  const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.code) }
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)

  function walk(dtMs: number): void {
    const step = (WALK_SPEED * dtMs) / 1000
    if (keys.has('KeyW')) controls.moveForward(step)
    if (keys.has('KeyS')) controls.moveForward(-step)
    if (keys.has('KeyD')) controls.moveRight(step)
    if (keys.has('KeyA')) controls.moveRight(-step)
    camera.position.y = walkHeight
  }

  const state: GaussianSplatState = { status: 'idle', message: 'off', splats: 0, loadMs: 0 }
  function setState(patch: Partial<GaussianSplatState>): void {
    Object.assign(state, patch)
    opts.onStateChange?.({ ...state })
  }

  /** Kamera auf die Startpose aus cameras.json setzen — nach der Z-up→Y-up-
   * Drehung, damit man aufrecht INNERHALB des Modells startet. `rotation` ist
   * Camera-to-World (COLMAP: Blick +Z, Up −Y). */
  function seatCamera(startup: StartupCamera | null): void {
    const pos = new THREE.Vector3(0, 1, 0)
    const fwd = new THREE.Vector3(0, 0, -1)
    const up = new THREE.Vector3(0, 1, 0)
    if (startup && Array.isArray(startup.rotation) && startup.rotation.length === 3) {
      const r = startup.rotation
      const m = new THREE.Matrix4().set(
        r[0][0], r[0][1], r[0][2], 0,
        r[1][0], r[1][1], r[1][2], 0,
        r[2][0], r[2][1], r[2][2], 0,
        0, 0, 0, 1,
      )
      pos.fromArray(startup.position)
      fwd.set(0, 0, 1).transformDirection(m)   // COLMAP-Blickrichtung +Z
      up.set(0, -1, 0).transformDirection(m)   // COLMAP-Up −Y
    }
    // In die gedrehte three-Welt überführen.
    pos.applyMatrix4(flip)
    fwd.transformDirection(flip)
    up.transformDirection(flip)
    camera.up.set(0, 1, 0)
    camera.position.copy(pos)
    // Blick horizontal ausrichten (kein Roll); PointerLockControls übernimmt die
    // Kamera-Quaternion von hier und dreht ab dann per Maus weiter.
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1)
    camera.lookAt(pos.clone().add(fwd.normalize()))
    walkHeight = camera.position.y
  }

  async function load(): Promise<void> {
    loadStarted = true
    const startedAt = performance.now()
    setState({ status: 'loading', message: 'loading 3DGS model …' })
    try {
      // Dynamischer Import: Spark landet in einem eigenen Chunk, nicht im
      // Haupt-Bundle, und wird erst beim ersten Einschalten geladen.
      const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark')
      spark = new SparkRenderer({ renderer })
      scene.add(spark as unknown as THREE.Object3D)

      // Startkamera parallel zum Modell laden (winzig; Fehler ist unkritisch).
      startupCam = await fetch(camerasUrl)
        .then((r) => (r.ok ? r.json() : null))
        .then((cams) => (Array.isArray(cams) && cams.length ? (cams[0] as StartupCamera) : null))
        .catch(() => null)

      const mesh = new SplatMesh({ url: opts.url })
      await mesh.initialized
      splatRoot.add(mesh as unknown as THREE.Object3D)
      splat = mesh as unknown as { dispose?: () => void }

      seatCamera(startupCam)
      lastMoveMs = performance.now()

      // activeSplats füllt sich erst über die ersten gerenderten Frames (Worker-
      // Sortierung). Kurz nachpollen, damit die Statuszeile die echte Zahl zeigt.
      const reportCount = () => {
        const n = spark?.activeSplats ?? 0
        setState({
          status: 'ready',
          message: n > 0 ? `ready · ${n.toLocaleString('en-US')} splats` : 'ready',
          splats: n,
          loadMs: Math.round(performance.now() - startedAt),
        })
        return n > 0
      }
      reportCount()
      let tries = 0
      const poll = setInterval(() => { if (reportCount() || ++tries > 20) clearInterval(poll) }, 150)

      if (import.meta.env.DEV) {
        ;(window as any).__splat = {
          scene, camera, renderer, splatRoot, mesh, spark, keys,
          setFlip: (angleX: number) => {
            splatRoot.rotation.x = angleX
            flip.makeRotationX(angleX)
            seatCamera(startupCam)
          },
          controls,
          isLocked: () => controls.isLocked,
          walkHeight: () => walkHeight,
        }
        console.info('[gaussian-splat] seated', {
          startup: startupCam?.position,
          camPos: camera.position.toArray().map((n) => +n.toFixed(3)),
          walkHeight,
        })
      }
    } catch (error) {
      console.error('[gaussian-splat] load failed', error)
      setState({ status: 'error', message: `Error: ${(error as Error)?.message ?? error}` })
    }
  }

  return {
    setEnabled(on: boolean): void {
      enabled = on
      canvas.style.display = on ? 'block' : 'none'
      canvas.style.pointerEvents = on ? 'auto' : 'none'
      keys.clear()
      lastMoveMs = performance.now()
      if (!on && controls.isLocked) controls.unlock()
      if (on && !loadStarted) void load()
      // Bei erneutem Eintritt wieder an der Startpose beginnen, nicht dort, wo
      // man beim letzten Mal stehen geblieben ist.
      else if (on && splat) seatCamera(startupCam)
    },
    isEnabled: () => enabled,
    update(): void {
      if (!enabled) return
      const now = performance.now()
      const dtMs = Math.min(100, now - lastMoveMs)
      lastMoveMs = now
      // Blick kommt von PointerLockControls (mousemove), hier nur laufen.
      walk(dtMs)
      renderer.render(scene, camera)
    },
    resize(): void {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    },
    getState: () => ({ ...state }),
    dispose(): void {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      canvas.removeEventListener('click', onCanvasClick)
      controls.dispose()
      splat?.dispose?.()
      spark?.dispose?.()
      renderer.dispose()
      canvas.remove()
    },
  }
}
