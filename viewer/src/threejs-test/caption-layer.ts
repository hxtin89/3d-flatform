// Story captions: the text the intro shows under the scene.
//
// Plain DOM like marker-layer.ts — a fixed strip at the bottom, one caption
// at a time, faded by CSS. Text comes from config templates with {placeholder}
// substitution so the numbers (area, coordinates, date) are the donor's own.
export interface CaptionData {
  label: string
  value: string
}

export interface CaptionContent {
  kicker?: string
  title: string
  body?: string
  data?: CaptionData[]
}

export interface CaptionLayer {
  /** Show (or replace) the caption. Same id twice is a no-op. */
  show(id: string, content: CaptionContent): void
  hide(): void
  readonly currentId: string | null
  dispose(): void
}

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

export function createCaptionLayer(container: HTMLElement): CaptionLayer {
  const card = document.createElement('div')
  card.className = 'story-caption'
  card.setAttribute('role', 'status')
  card.setAttribute('aria-live', 'polite')
  container.appendChild(card)
  let currentId: string | null = null
  let hideTimer = 0

  const render = (content: CaptionContent) => {
    const kicker = content.kicker ? `<span class="story-caption-kicker">${content.kicker}</span>` : ''
    const body = content.body ? `<p class="story-caption-body">${content.body}</p>` : ''
    const data = content.data?.length
      ? `<dl class="story-caption-data">${content.data.map((entry) =>
        `<div><dt>${entry.label}</dt><dd>${entry.value}</dd></div>`).join('')}</dl>`
      : ''
    card.innerHTML = `${kicker}<strong class="story-caption-title">${content.title}</strong>${body}${data}`
  }

  return {
    get currentId() { return currentId },
    show(id, content) {
      if (id === currentId) return
      window.clearTimeout(hideTimer)
      currentId = id
      if (card.classList.contains('is-visible')) {
        // Swap through a short dip so the eye registers a new line.
        card.classList.remove('is-visible')
        hideTimer = window.setTimeout(() => {
          render(content)
          card.hidden = false
          card.classList.add('is-visible')
        }, 260)
      } else {
        render(content)
        card.hidden = false
        // Two frames: the element must be laid out before the transition starts.
        requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('is-visible')))
      }
    },
    hide() {
      if (currentId === null) return
      currentId = null
      window.clearTimeout(hideTimer)
      card.classList.remove('is-visible')
      hideTimer = window.setTimeout(() => { card.hidden = true }, 500)
    },
    dispose() {
      window.clearTimeout(hideTimer)
      card.remove()
    },
  }
}
