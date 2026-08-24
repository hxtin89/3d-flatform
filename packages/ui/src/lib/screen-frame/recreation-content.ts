// Real content from the "Bento Grid — Recreation" Figma page (Frame 1,
// 1080x1920 mobile; Frame 1 Desktop for the weather cluster's real desktop
// position). Single source so BentoGrid.stories.ts, the full-screen
// Screen.stories.ts examples, and the viewer app's live demo all render the
// same real data instead of three hand-copied arrays drifting apart.
//
// Species widgets use SpeciesWidget (not BentoWidget) via `kind: "species"`,
// and are click-to-expand/collapse -- selecting one animates it from
// `height` (collapsed, 300 -- Figma's real Vogel/Morphofalter size) up to
// `expandedHeight` (570 -- Figma's real Giftfrosch size), and animates
// whichever was previously selected back down, since only one is ever
// selected at a time (see BentoGrid.svelte). Giftfrosch starts selected
// (selected: true) to match Figma's own static default arrangement, but any
// of the three can become the selected one interactively -- their `y` is
// all authored at the shared COLLAPSED position (270) so the math generalizes
// regardless of which one is currently expanded (see BentoGridItem's
// `expandedHeight` doc for exactly how the grow-up math works).
//
// cornerOverrides below are pinned only where solveDocking's plain-T-junction
// default ('convex') diverges from Figma's real authored Corner atoms
// (confirmed against Figma's own component instances, Giftfrosch-selected
// arrangement): Vogel's top-left is a Fill-Top bulge (not a plain round),
// Giftfrosch's bottom-right is a Fill-Left bulge toward Morphofalter, and
// Morphofalter's left-side corners (touching Giftfrosch) are flush/sharp
// ('none'), not rounded. These three are pinned; every other corner in this
// row keeps solveDocking's solved default since Figma's static file only
// ever shows ONE arrangement (Giftfrosch selected) and those corners were
// not independently verified for the other two expand states. BentoGrid
// itself only keeps these three overrides live while Giftfrosch is still
// the selected item -- selecting Vogel or Morphofalter drops all of them
// back to solveDocking's solved default, since that's an arrangement this
// pinning was never verified against (see BentoGrid.svelte's effectiveItems).
//
// Selected-state measurement/status/caption content verified directly off
// the real Figma text nodes. Vogel/Morphofalter's `image` is Figma's own
// real illustration for that card (see species-icons.ts/
// species-illustrations.ts), not a fabricated stand-in, so the row no
// longer mixes Giftfrosch's finished photo with a generic placeholder icon
// on the other two. Giftfrosch's own `icon` (frogIcon) stays a plain
// line-art fallback -- Figma's static file only ever shows Giftfrosch
// expanded, so there's no real "collapsed Giftfrosch" artwork to pull in.
import type { BentoGridItem } from "../BentoGrid.svelte";
import { frogIcon, giftfroschImage, birdImage, butterflyImage } from "./species-icons";
import { weatherBarIcon } from "./weather-icons";

export const WEATHER_CLUSTER: BentoGridItem[] = [
  // Figma: "S1: WeatherBar (Widget)" @ (660,71) 255x180 -- pairs its two text
  // lines with real "32/Partly-cloudy"/"32/Wind" icon instances (verified
  // sitting inside this widget's own bounds in both Frame 1 and Frame 1
  // Desktop). Weather29/Weather83 below have no icon instance anywhere in
  // Figma, so they stay bare numbers rather than getting a fabricated glyph.
  { id: "weatherBar", x: 0, y: 0, width: 255, height: 180, title: "Leicht bewölkt", description: "Nordwest Wind", accent: "grey-light", icon: weatherBarIcon, cornerOverrides: { topLeft: "fill-left", topRight: "convex", bottomRight: "fill-left", bottomLeft: "none" } },
  // Figma: "S1: Weather29 (Widget)" @ (660,251) 180x180
  { id: "weather29", x: 0, y: 180, width: 180, height: 180, value: "29°", description: "Celsius", accent: "gold", cornerOverrides: { topLeft: "fill-top", topRight: "none", bottomRight: "fill-left", bottomLeft: "convex" } },
  // Figma: "S1: Weather83 (Widget)" @ (840,251) 180x180
  { id: "weather83", x: 180, y: 180, width: 180, height: 180, value: "83%", description: "Luftfeuchtigkeit", accent: "forest-green", cornerOverrides: { topLeft: "fill-left", topRight: "convex", bottomRight: "fill-top", bottomLeft: "none" } },
];

const SPECIES_COLLAPSED_HEIGHT = 300;
const SPECIES_EXPANDED_HEIGHT = 570;

export const SPECIES_ROW: BentoGridItem[] = [
  // Figma: "S1: Vogel (Widget)" @ (60,1560) 300x300 -- normalized against the row's own origin (60,1290)
  { id: "vogel", x: 0, y: 270, width: 300, height: SPECIES_COLLAPSED_HEIGHT, expandedHeight: SPECIES_EXPANDED_HEIGHT, kind: "species", selectable: true, title: "SCHNURRVOGEL", description: "pipra fasciicauda", accent: "grey-light", image: birdImage, cornerOverrides: { topLeft: "fill-top" } },
  // Figma: "S1: Giftfrosch (Widget)" @ (360,1290) 360x570 (selected/expanded) -- measurement/
  // status/caption facts read off the actual Figma text nodes (25556:1315/1317/1314).
  {
    id: "giftfrosch",
    x: 300,
    y: 270,
    width: 360,
    height: SPECIES_COLLAPSED_HEIGHT,
    expandedHeight: SPECIES_EXPANDED_HEIGHT,
    kind: "species",
    selectable: true,
    selected: true,
    title: "SIRA GIFTFROSCH",
    description: "ranitomeya sirensis",
    measurement: "15-17mm",
    status: "Schutzstatus: am Wenigsten bedroht",
    caption: "Nur die männlichen Frösche kümmern sich um den Nachwuchs",
    accent: "grey-dark",
    icon: frogIcon,
    image: giftfroschImage,
    cornerOverrides: { bottomRight: "fill-left" },
  },
  // Figma: "S1: Morphofalter (Widget)" @ (720,1560) 300x300
  { id: "morphofalter", x: 660, y: 270, width: 300, height: SPECIES_COLLAPSED_HEIGHT, expandedHeight: SPECIES_EXPANDED_HEIGHT, kind: "species", selectable: true, title: "BLAUER MORPHOFALTER", description: "morpho deidamia", accent: "grey-light", image: butterflyImage, cornerOverrides: { topLeft: "none", bottomLeft: "none" } },
];
