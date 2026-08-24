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

/** Giftfrosch, selected state -- takes SpeciesWidget's `image` slot instead of `icon`. */
export const giftfroschImage: Snippet = createRawSnippet(() => ({
  render: () => `
    <svg viewBox="0 0 120 120" style="width:132px;height:132px" aria-hidden="true">
      <defs>
        <radialGradient id="giftfrosch-vignette" cx="50%" cy="45%" r="65%">
          <stop offset="0%" stop-color="rgb(0 68 50 / 0.35)" />
          <stop offset="100%" stop-color="rgb(0 68 50 / 0)" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" r="58" fill="url(#giftfrosch-vignette)" />
      <ellipse cx="60" cy="70" rx="30" ry="22" fill="rgb(0 68 50)" />
      <path d="M34 66c8-6 18-9 26-9s18 3 26 9" stroke="rgb(230 206 0)" stroke-width="5" fill="none" stroke-linecap="round" />
      <path d="M38 78c7 5 14 7 22 7s15-2 22-7" stroke="rgb(249 115 22)" stroke-width="5" fill="none" stroke-linecap="round" />
      <path d="M32 82c-6 4-10 10-11 17M88 82c6 4 10 10 11 17" stroke="rgb(0 68 50)" stroke-width="6" fill="none" stroke-linecap="round" />
      <circle cx="46" cy="46" r="9" fill="rgb(0 68 50)" />
      <circle cx="74" cy="46" r="9" fill="rgb(0 68 50)" />
      <circle cx="46" cy="46" r="4" fill="rgb(230 206 0)" />
      <circle cx="74" cy="46" r="4" fill="rgb(230 206 0)" />
      <circle cx="46" cy="46" r="1.6" fill="rgb(20 20 20)" />
      <circle cx="74" cy="46" r="1.6" fill="rgb(20 20 20)" />
    </svg>
  `,
}));
