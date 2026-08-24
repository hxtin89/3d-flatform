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
