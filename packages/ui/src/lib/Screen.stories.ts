// The first full "screen" examples: Frame 1 (mobile, 1080x1920) and Frame 1
// Desktop (1920x1080) from the "Bento Grid — Recreation" Figma page, composed
// from real @wi/ui pieces via ScreenExample.svelte -- ScreenFrame (the grey
// frame/notch/docking backdrop, ported from the viewer app's already
// Figma-verified engine) plus the real BentoGrid/LabelLine content in
// screen-frame/recreation-content.ts (shared with BentoGrid.stories.ts, not
// re-copied).
//
// "Mobile" vs "Desktop" is a fixed pixel size baked into ScreenExample's own
// wrapper div, not Storybook's viewport toolbar -- that toolbar's viewport is
// a sticky global (it doesn't reset per-story), so relying on it made
// "Desktop" silently render at whatever mobile size a previous story left
// the toolbar on. A real .svelte wrapper is also the only way to give
// ScreenFrame's weather/species/label snippet props actual component content,
// since this repo has no @storybook/addon-svelte-csf for real story templates.
import type { Meta, StoryObj } from "@storybook/svelte";
import ScreenExample from "./screen-frame/ScreenExample.svelte";

const meta: Meta = {
  title: "Screens/Bento Grid — Recreation",
  component: ScreenExample as any,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

export const Mobile: Story = {
  args: { width: 390, height: 844 },
};

export const Desktop: Story = {
  args: { width: 1280, height: 720 },
};

// Responsiveness sweep -- Mobile/Desktop above only ever verified two exact
// sizes. These cover the range a real browser window gets resized through:
// very narrow, very wide, near-square (where ScreenFrame's species/label
// docks have to fall back from the tall-frame arrangement to the wide-frame
// one -- see dock.ts's fitsPortraitArrangement), and two in-between sizes.
export const NarrowPortrait: Story = {
  args: { width: 320, height: 844 },
};

export const WideLandscape: Story = {
  args: { width: 1920, height: 1080 },
};

export const NearSquare: Story = {
  args: { width: 900, height: 900 },
};

export const MediumPortrait: Story = {
  args: { width: 600, height: 900 },
};

export const MediumLandscape: Story = {
  args: { width: 1500, height: 850 },
};

// The band that used to strand the species row floating bottom-center with a
// symmetric gap on each side (measured 47px/side at 600x900, 97px at 700x900,
// 197px at 900x900): tall enough for the frame's height to be the binding
// dimension, so the window kept getting wider while the fixed-size row did
// not. 600x900 now fills the window's width; 700x900/800x900 are just past
// the fill crossover and hug the window's bottom-left corner instead -- see
// ScreenFrame.svelte's layout() for where that crossover comes from.
export const FillCrossoverBelow: Story = {
  args: { width: 700, height: 900 },
};

export const FillCrossoverNearSquare: Story = {
  args: { width: 800, height: 900 },
};

// The two extremes -- neither is a realistic window, both are where a scale
// picked against the wrong axis used to overflow or clip.
export const ExtremeWideShort: Story = {
  args: { width: 2200, height: 500 },
};

export const ExtremeNarrowTall: Story = {
  args: { width: 300, height: 1400 },
};
