// Real content from the "Bento Grid — Recreation" Figma page (Frame 1,
// 1080x1920 mobile; Frame 1 Desktop for the weather cluster's real desktop
// position). Single source so BentoGrid.stories.ts, the full-screen
// Screen.stories.ts examples, and the viewer app's live demo all render the
// same real data instead of three hand-copied arrays drifting apart.
//
// Species widgets use SpeciesWidget (not BentoWidget) via `kind: "species"` --
// Vogel/Morphofalter are the unselected state (icon slot, left empty -- no
// icon system wired in yet), Giftfrosch is the selected state (measurement/
// status/caption facts + image slot, also left empty -- no photo asset
// pipeline yet). Content verified directly off the real Figma text nodes.
//
// Not reproduced: the bird/frog/butterfly line-art icons and the frog's real
// photo (no icon system / image assets wired into @wi/ui yet).
import type { BentoGridItem } from "../BentoGrid.svelte";

export const WEATHER_CLUSTER: BentoGridItem[] = [
  // Figma: "S1: WeatherBar (Widget)" @ (660,71) 255x180
  { id: "weatherBar", x: 0, y: 0, width: 255, height: 180, title: "Leicht bewölkt", description: "Nordwest Wind", accent: "grey-light", cornerOverrides: { topLeft: "fill-left", topRight: "convex", bottomRight: "fill-left", bottomLeft: "none" } },
  // Figma: "S1: Weather29 (Widget)" @ (660,251) 180x180
  { id: "weather29", x: 0, y: 180, width: 180, height: 180, value: "29°", description: "Celsius", accent: "gold", cornerOverrides: { topLeft: "fill-top", topRight: "none", bottomRight: "fill-left", bottomLeft: "convex" } },
  // Figma: "S1: Weather83 (Widget)" @ (840,251) 180x180
  { id: "weather83", x: 180, y: 180, width: 180, height: 180, value: "83%", description: "Luftfeuchtigkeit", accent: "forest-green", cornerOverrides: { topLeft: "fill-left", topRight: "convex", bottomRight: "fill-top", bottomLeft: "none" } },
];

export const SPECIES_ROW: BentoGridItem[] = [
  // Figma: "S1: Vogel (Widget)" @ (60,1560) 300x300 -- normalized against the row's own origin (60,1290)
  { id: "vogel", x: 0, y: 270, width: 300, height: 300, kind: "species", title: "SCHNURRVOGEL", description: "pipra fasciicauda", accent: "grey-light", cornerOverrides: { topLeft: "fill-top", topRight: "none", bottomRight: "none", bottomLeft: "convex" } },
  // Figma: "S1: Giftfrosch (Widget)" @ (360,1290) 360x570 -- selected state, with the real
  // measurement/status/caption facts read off the actual Figma text nodes (25556:1315/1317/1314).
  {
    id: "giftfrosch",
    x: 300,
    y: 0,
    width: 360,
    height: 570,
    kind: "species",
    title: "SIRA GIFTFROSCH",
    description: "ranitomeya sirensis",
    selected: true,
    measurement: "15-17mm",
    status: "Schutzstatus: am Wenigsten bedroht",
    caption: "Nur die männlichen Frösche kümmern sich um den Nachwuchs",
    accent: "grey-dark",
    cornerOverrides: { topLeft: "convex", topRight: "convex", bottomRight: "fill-left", bottomLeft: "none" },
  },
  // Figma: "S1: Morphofalter (Widget)" @ (720,1560) 300x300
  { id: "morphofalter", x: 660, y: 270, width: 300, height: 300, kind: "species", title: "BLAUER MORPHOFALTER", description: "morpho deidamia", accent: "grey-light", cornerOverrides: { topLeft: "none", topRight: "convex", bottomRight: "convex", bottomLeft: "none" } },
];
