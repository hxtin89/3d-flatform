// Real content for SpeciesWidget's `icon`/`image` snippet slots -- Figma's
// page has real line-art bird/frog/butterfly icons and a real frog photo
// here (see recreation-content.ts's header), but @wi/ui never had an icon
// system or image pipeline wired in, so those slots were simply never
// passed and rendered empty. This is the shared source recreation-content.ts
// pulls from (icon/image are plain Snippet values on BentoGridItem), so
// every consumer -- ScreenExample.svelte, BentoGrid.stories.ts's SpeciesRow,
// and the viewer's storyboard -- gets them for free.
//
// Vogel/Morphofalter's collapsed cards used to fall back to a 64x64 generic
// path icon in a small tinted badge -- next to Giftfrosch's real photo,
// which is exactly the fidelity mismatch this round fixes: Figma's own file
// has a real "band-tailed_manakin"/"Blauer Morphofalter" illustration
// sitting large in each card (see species-illustrations.ts, same
// real-asset sourcing as the frog photo), not a tiny badge -- birdImage/
// butterflyImage below pull that in instead, and SpeciesWidget now shows
// whichever of `image`/`icon` a species actually has rather than gating
// `image` on `selected`, so it renders regardless of which card is
// currently expanded.
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
import { birdPhoto, butterflyPhoto } from "./species-illustrations";

function iconSnippet(svgInner: string): Snippet {
  return createRawSnippet(() => ({
    render: () => `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:72px;height:72px" aria-hidden="true">${svgInner}</svg>`,
  }));
}

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

// Vogel/Morphofalter, both states -- takes SpeciesWidget's `image` slot the
// same as the frog photo above (see species-illustrations.ts for sourcing).
// The source PNG is a solid dark-green line drawing on a transparent
// ground; get_screenshot on the real Figma frame shows both illustrations
// rendered as large, pale/near-white line art sitting directly on the grey
// card, not in their original green -- brightness(0) crushes every opaque
// pixel to black while leaving alpha alone, invert(1) flips that black to
// white, so the filter reproduces Figma's actual on-canvas color without
// needing a second recolored asset.
const RECOLOR_TO_WHITE = "filter:brightness(0) invert(1)";

export const birdImage: Snippet = createRawSnippet(() => ({
  render: () => `<img src="${birdPhoto}" alt="" style="width:100%;height:100%;object-fit:contain;${RECOLOR_TO_WHITE}" aria-hidden="true" />`,
}));

export const butterflyImage: Snippet = createRawSnippet(() => ({
  render: () => `<img src="${butterflyPhoto}" alt="" style="width:100%;height:100%;object-fit:contain;${RECOLOR_TO_WHITE}" aria-hidden="true" />`,
}));
