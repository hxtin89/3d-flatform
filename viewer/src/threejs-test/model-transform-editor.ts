import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { FieldModelEditTargets } from './field-model-layer'

type ModelKey = 'tower' | 'boat'
type TransformMode = 'translate' | 'rotate' | 'scale'

export interface ModelTransformEditor {
  dispose(): void
}

interface ModelTransformEditorOptions {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  domElement: HTMLElement
  globeControls: { enabled: boolean }
  targets: FieldModelEditTargets
  onTowerTransform(positionM: readonly [number, number, number], sensorHeightM: number): void
}

function rounded(value: number): number {
  return Number(value.toFixed(3))
}

export function createModelTransformEditor(options: ModelTransformEditorOptions): ModelTransformEditor {
  const { scene, camera, domElement, globeControls, targets, onTowerTransform } = options
  const controls = new TransformControls(camera, domElement)
  const helper = controls.getHelper()
  helper.name = 'field-model-transform-gizmo'
  scene.add(helper)
  controls.setSize(0.82)
  controls.setSpace('local')

  const panel = document.createElement('aside')
  panel.id = 'modelTransformEditor'
  panel.setAttribute('aria-label', 'Field model transform editor')
  panel.innerHTML = `
    <div class="model-editor-head"><b>FIELD OBJECT EDITOR</b><span>Clipboard on release</span></div>
    <div class="model-editor-segment" data-editor-group="model">
      <button type="button" data-model="tower" class="is-active">Tower</button>
      <button type="button" data-model="boat">Boat</button>
    </div>
    <div class="model-editor-segment" data-editor-group="mode">
      <button type="button" data-mode="translate" class="is-active">Move</button>
      <button type="button" data-mode="rotate">Rotate</button>
      <button type="button" data-mode="scale">Scale</button>
    </div>
    <output id="modelEditorReadout">—</output>
    <textarea id="modelEditorOutput" readonly aria-label="Current model transform JSON"></textarea>
    <div id="modelEditorStatus" role="status" aria-live="polite">Drag a gizmo handle</div>
  `
  document.body.append(panel)
  const readout = panel.querySelector<HTMLOutputElement>('#modelEditorReadout')!
  const output = panel.querySelector<HTMLTextAreaElement>('#modelEditorOutput')!
  const status = panel.querySelector<HTMLElement>('#modelEditorStatus')!
  let selected: ModelKey = 'tower'
  let mode: TransformMode = 'translate'
  let disposed = false

  function model(key: ModelKey) {
    return targets[key]
  }

  function transformForMode() {
    const selectedModel = model(selected)
    return mode === 'translate' ? selectedModel.positionNode : selectedModel.transformNode
  }

  function snapshotModel(key: ModelKey) {
    const target = model(key)
    const relative = target.positionNode.position.clone().sub(targets.originEnu)
    return {
      positionM: [rounded(relative.x), rounded(relative.y), rounded(relative.z)],
      rotationRad: [
        rounded(target.modelRotationRad[0]),
        rounded(target.modelRotationRad[1]),
        rounded(target.transformNode.rotation.z),
      ],
      scale: rounded(target.transformNode.scale.x),
    }
  }

  function snapshot(): string {
    const tower = snapshotModel('tower')
    const boat = snapshotModel('boat')
    return JSON.stringify({
      tower: {
        ...tower,
        sensorHeightM: rounded(targets.towerHeightUnits * tower.scale + 5),
      },
      boat,
    }, null, 2)
  }

  function notifyTower(): void {
    const tower = snapshotModel('tower')
    onTowerTransform(
      tower.positionM as [number, number, number],
      targets.towerHeightUnits * tower.scale + 5,
    )
  }

  function paint(): void {
    const value = snapshotModel(selected)
    readout.textContent = mode === 'translate'
      ? `XYZ ${value.positionM.join(' · ')} m`
      : mode === 'rotate'
        ? `Z ${THREE.MathUtils.radToDeg(value.rotationRad[2]).toFixed(1)}°`
        : `Scale ${value.scale}`
    output.value = snapshot()
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-model]')) {
      button.classList.toggle('is-active', button.dataset.model === selected)
    }
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      button.classList.toggle('is-active', button.dataset.mode === mode)
    }
  }

  function attach(): void {
    controls.setMode(mode)
    controls.setSpace('local')
    controls.showX = mode !== 'rotate'
    controls.showY = mode !== 'rotate'
    controls.showZ = true
    controls.attach(transformForMode())
    paint()
  }

  async function copySnapshot(): Promise<void> {
    const value = snapshot()
    output.value = value
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(value)
      status.textContent = `${selected} config copied`
    } catch {
      output.focus()
      output.select()
      const copied = document.execCommand('copy')
      status.textContent = copied ? `${selected} config copied` : 'Select the JSON and copy it manually'
    }
  }

  const onPanelClick = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button')
    if (!button) return
    if (button.dataset.model === 'tower' || button.dataset.model === 'boat') selected = button.dataset.model
    if (button.dataset.mode === 'translate' || button.dataset.mode === 'rotate' || button.dataset.mode === 'scale') mode = button.dataset.mode
    attach()
  }
  const onDraggingChanged = (event: any) => {
    globeControls.enabled = !event.value
    panel.classList.toggle('is-dragging', Boolean(event.value))
  }
  const onObjectChange = () => {
    if (mode === 'scale') {
      const target = model(selected).transformNode
      const axis = controls.axis
      const value = axis === 'Y' ? target.scale.y : axis === 'Z' ? target.scale.z : target.scale.x
      target.scale.setScalar(THREE.MathUtils.clamp(value, 0.01, 250))
    }
    if (selected === 'tower') notifyTower()
    paint()
  }
  const onMouseUp = () => { void copySnapshot() }

  panel.addEventListener('click', onPanelClick)
  controls.addEventListener('dragging-changed', onDraggingChanged)
  controls.addEventListener('objectChange', onObjectChange)
  controls.addEventListener('mouseUp', onMouseUp)
  notifyTower()
  attach()

  return {
    dispose() {
      if (disposed) return
      disposed = true
      globeControls.enabled = true
      panel.removeEventListener('click', onPanelClick)
      controls.removeEventListener('dragging-changed', onDraggingChanged)
      controls.removeEventListener('objectChange', onObjectChange)
      controls.removeEventListener('mouseUp', onMouseUp)
      controls.detach()
      scene.remove(helper)
      controls.dispose()
      panel.remove()
    },
  }
}
