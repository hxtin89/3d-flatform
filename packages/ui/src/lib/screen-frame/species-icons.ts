// Real content for SpeciesWidget's `icon`/`image` snippet slots -- Figma's
// page has real line-art bird/frog/butterfly icons and a real frog photo
// here (see recreation-content.ts's header), but @wi/ui never had an icon
// system or image pipeline wired in, so those slots were simply never
// passed and rendered empty. This is the shared source recreation-content.ts
// pulls from (icon/image are plain Snippet values on BentoGridItem), so
// every consumer -- ScreenExample.svelte, BentoGrid.stories.ts's SpeciesRow,
// and the viewer's design-system-demo.ts -- gets them for free.
//
// `createRawSnippet` (not a .svelte file) because recreation-content.ts,
// which needs to attach these to plain data objects, is plain TypeScript --
// Svelte's `{#snippet}` syntax only exists inside .svelte files.
//
// These are still line-art/illustration, not photography -- there's no
// asset pipeline or licensed drone/specimen photography in this repo to
// pull a real photo from. The frog's `image` (shown selected, replacing the
// icon) is a richer colored illustration instead of a plain outline, using
// the same gold/coral/forest-green values already assigned to real cards in
// widget-accent.css, so it at least reads as a specimen rendering doing real
// work rather than a blank slot.
import { createRawSnippet } from "svelte";
import type { Snippet } from "svelte";
import { giftfroschPhoto } from "./giftfrosch-photo";

function iconSnippet(svgInner: string): Snippet {
  return createRawSnippet(() => ({
    render: () => `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:72px;height:72px" aria-hidden="true">${svgInner}</svg>`,
  }));
}

/** Side-profile bird -- Vogel/"SCHNURRVOGEL". */
export const birdIcon: Snippet = iconSnippet(`
  <path d="M14 40c0-10 8-18 20-18 6 0 11 2 14 6l6-2-3 6 3 5-7-1c-2 5-7 9-13 9-6 0-9-2-11-5" />
  <path d="M20 42c-3 2-6 3-9 3" />
  <path d="M30 46l-2 6M36 46l1 6" />
  <circle cx="40" cy="24" r="1.4" fill="currentColor" stroke="none" />
  <path d="M24 30c4-3 9-4 14-3" />
`);

/** Frog, unselected/outline state -- Giftfrosch when NOT the expanded card. */
export const frogIcon: Snippet = iconSnippet(`
  <ellipse cx="32" cy="36" rx="16" ry="12" />
  <circle cx="22" cy="24" r="5" />
  <circle cx="42" cy="24" r="5" />
  <circle cx="22" cy="24" r="1.4" fill="currentColor" stroke="none" />
  <circle cx="42" cy="24" r="1.4" fill="currentColor" stroke="none" />
  <path d="M18 44c-4 3-7 8-7 12M46 44c4 3 7 8 7 12" />
  <path d="M14 34c-4 0-7-2-9-5M50 34c4 0 7-2 9-5" />
`);

/** Symmetric butterfly -- Morphofalter/"BLAUER MORPHOFALTER". */
export const butterflyIcon: Snippet = iconSnippet(`
  <path d="M32 14v36" />
  <path d="M32 20c-6-10-20-10-24-2-3 6 2 12 10 12 8 0 12-4 14-10Z" />
  <path d="M32 20c6-10 20-10 24-2 3 6-2 12-10 12-8 0-12-4-14-10Z" />
  <path d="M32 32c-5 8-15 9-18 4-2-4 1-9 7-9 5 0 9 2 11 5Z" />
  <path d="M32 32c5 8 15 9 18 4 2-4-1-9-7-9-5 0-9 2-11 5Z" />
  <path d="M28 12c-1-3 0-5 2-6M36 12c1-3 0-5-2-6" />
`);

/** Giftfrosch, selected state -- takes SpeciesWidget's `image` slot instead of `icon`.
 *
 * This used to be a hand-drawn SVG (flat gradient fills standing in for a key
 * light, a feTurbulence mottle standing in for skin texture) because no real
 * photo asset was thought to exist in this repo. One does: the Figma source
 * file's own "S1 Sira Giftfrosch"/"images (5) 2" node is a real image fill,
 * the same category of asset habitat-photo.ts already pulls for the drone
 * backdrop -- see giftfrosch-photo.ts's header. A hand-drawn cartoon next to
 * that same screen's photoreal drone backdrop was the exact material-quality
 * mismatch this file used to flag as unavoidable; it wasn't. */
export const giftfroschImage: Snippet = createRawSnippet(() => ({
  render: () => `<img src="${giftfroschPhoto}" alt="" style="width:100%;height:100%;object-fit:contain;object-position:center bottom" aria-hidden="true" />`,
}));
