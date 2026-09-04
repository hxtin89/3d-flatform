// Open/close of the field film. The modal component owns the <video>; these
// actions only flip the store, which also stops the render loop.
import { setAimMode } from '../state/actions'
import { uiState, useUiStore } from '../state/ui-store'

export function openFieldVideo(): void {
  if (uiState().videoOpen) return
  setAimMode(false, false)
  useUiStore.setState({ videoOpen: true, frameloop: 'never' })
}

export function closeFieldVideo(): void {
  if (!uiState().videoOpen) return
  useUiStore.setState({ videoOpen: false, frameloop: uiState().splatSolo ? 'never' : 'always' })
}
