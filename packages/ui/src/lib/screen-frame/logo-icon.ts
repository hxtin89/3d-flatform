// Real content for ScreenFrame's `logo` slot -- Figma's Frame 1/Frame 1
// Desktop both place a flying-eagle mark ("Vector", id 25547:2451 mobile /
// 25556:1042 desktop, identical 114x68 path in both) at the same fixed
// (51,30) offset from the frame's own top-left corner.
//
// The node metadata reports x=165, not 51, and that is NOT just a different
// anchor: Figma draws this vector with relativeTransform [[-1,0,165],[0,1,30]],
// i.e. MIRRORED, so 165 is its right edge (51 + 114). Rendering the raw path
// without that flip pointed the eagle the wrong way -- head and beak to the
// right instead of the left -- which is how it shipped until it was caught by
// cropping our render and Figma's export of the same frame side by side. The
// scale(-1,1) below is that transform; the path itself stays byte-identical to
// Figma's export so it can still be diffed against the node.
// Sitting over the
// grey Rahmen margin and the photo's top-left notch -- our frame had no
// content there at all. Path is the exact outline exported from that Figma
// node (get_design_context), not redrawn, since Figma's own vector is the
// correct source here.
import { createRawSnippet } from "svelte";
import type { Snippet } from "svelte";

// Plain markup (not just a Snippet) because this is needed in two totally
// different rendering contexts: ScreenFrame.svelte's Svelte-snippet `logo`
// slot below, AND any caller that hand-builds its
// frame via raw DOM (createFrame/dockElement) rather than ScreenFrame.svelte
// -- a Svelte Snippet can only be rendered with {@render} inside a .svelte
// template, not assigned to plain DOM's innerHTML.
export const EAGLE_LOGO_SVG = `<svg width="114" height="68" viewBox="0 0 114 68" fill="var(--text-on-emphasis)" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path transform="scale(-1,1) translate(-114,0)" d="M113.33 39.3332C113.998 38.2316 114.199 36.5194 113.785 36.599C111.586 38.0907 109.28 39.4215 106.887 40.5808C103.294 42.0332 99.5877 43.1917 95.805 44.045C89.1211 45.3723 86.6615 44.9874 86.6615 44.9874C87.1112 43.9798 87.7667 43.0759 88.5864 42.3328C88.8742 42.1414 89.2159 42.0459 89.562 42.0602C89.9081 42.0746 90.2406 42.1979 90.5114 42.4125C90.6909 41.9428 90.7625 41.4393 90.7209 40.9387C90.6792 40.4381 90.5254 39.953 90.2708 39.519C89.276 39.0986 88.2201 38.8387 87.1427 38.7492C86.2652 38.5597 85.3641 38.5015 84.4692 38.5766C83.9345 38.6961 77.9056 42.001 75.5663 42.1736C73.3987 42.1156 71.2473 41.7856 69.1632 41.1914C62.4793 39.3199 55.3276 35.4443 49.78 32.1792C42.6268 27.9584 35.9533 22.9833 29.8755 17.3403C20.0636 8.18217 17.0692 0.722908 16.4142 0.351273C15.9998 0.112364 15.425 0.722919 15.7191 3.24473C16.1562 7.05765 17.74 10.6514 20.2641 13.5576C21.1731 14.6593 22.1222 15.6812 22.9377 16.5307C11.4013 8.95198 10.1715 1.21401 9.06198 0.0725572C8.52727 -0.458351 7.59153 1.98383 8.40696 5.448C9.22239 8.91218 11.0805 13.1064 17.7644 18.1633C4.39665 11.726 3.05988 6.21781 1.88352 6.01872C1.2285 5.89927 0.239292 8.67326 1.54933 11.3278C3.15345 14.5531 7.83215 18.5349 14.2754 21.1496C6.76274 19.4772 0.613588 15.8405 0.118983 16.3449C-0.375622 16.8492 0.733904 19.3578 2.29792 20.7381C3.35397 21.6805 7.17714 23.9236 13.3263 25.4234C7.01672 25.1845 3.84858 24.4147 4.06246 25.2243C4.56527 26.3288 5.39533 27.2549 6.44191 27.8789C8.79789 29.0748 11.3902 29.741 14.0348 29.8299C12.9252 29.9494 9.02188 30.4007 8.98178 30.8519C8.94167 31.3032 9.27587 31.6616 9.79721 32.1792C33.4046 54.5968 49.7399 59.4944 49.7399 59.4944C44.5265 61.5252 37.8426 62.587 37.5887 63.317C37.3347 64.047 40.3424 65.9715 43.3368 66.8608C46.3296 67.8128 49.4814 68.1736 52.614 67.9226C53.6433 67.7235 56.5173 67.4713 64.03 62.6135C69.427 62.5586 74.7684 61.524 79.7905 59.5608C85.5575 57.2101 91.1043 54.3587 96.3664 51.0397C97.7032 50.8804 99.9891 51.6901 100.764 51.491C101.54 51.2919 101.299 51.0397 100.644 50.4292C100.221 49.9981 99.7752 49.5904 99.3073 49.2081C99.3073 49.2081 99.441 49.1152 99.4811 49.0754C101.327 49.764 103.308 50.0185 105.269 49.8186C106.606 49.6859 107.729 48.3852 107.515 48.3454C105.707 48.1323 103.919 47.7772 102.168 47.2835L102.382 47.1641C106.726 47.1641 108.945 46.1421 110.255 45.1732C111.566 44.2043 111.485 43.6999 111.245 43.6203C111.004 43.5406 109.52 44.0317 106.847 44.2706C108.825 43.1292 112.194 41.417 113.33 39.4261V39.3332Z"/></svg>`;

export const eagleLogo: Snippet = createRawSnippet(() => ({
  render: () => EAGLE_LOGO_SVG,
}));
