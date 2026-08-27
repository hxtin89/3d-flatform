// Four more full "screen" examples from the "Bento Grid — Recreation" Figma
// page, composed via MediaScreenExample.svelte the same way Screen.stories.ts
// composes Frame 1 via ScreenExample.svelte -- ScreenFrame for the shared
// shell (grey frame/notch/photo backdrop, eagle logo) plus the real
// MediaCard/MapPin/ChangelogRow/ChangelogRail pieces, so those seven
// components added alongside this file get exercised together in the actual
// layouts they were built for instead of only in their own isolated stories.
//
// Unlike Screen.stories.ts's Mobile/Desktop/responsiveness sweep, these four
// frames have no desktop counterpart in the Figma page and aren't meant to be
// resized -- see MediaScreenExample's own Props doc for why this takes a
// `frame` selector instead of {width, height}.
import type { Meta, StoryObj } from "@storybook/svelte";
import MediaScreenExample from "./screen-frame/MediaScreenExample.svelte";

const meta: Meta = {
  title: "Screens/Bento Grid — Media, Pins & Changelog",
  component: MediaScreenExample as any,
  parameters: { layout: "fullscreen" },
  argTypes: {
    frame: {
      control: "select",
      options: ["video", "pins", "changelog-open", "changelog-closed"],
    },
  },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

// Figma "Frame 3 Mobile - Video": the gold Media Card, PlayButton + Scrubber
// on its thumbnail, author/duration stacked right, habitat label lower-left.
export const Video: Story = {
  args: { frame: "video" },
};

// Figma "Frame 8 Mobile - Pins": one icon Map Pin, one photo Map Pin over the
// backdrop, habitat label top-right.
export const Pins: Story = {
  args: { frame: "pins" },
};

// Figma "Frame 6 Mobile - Changelog open": the Changelog Row column down the
// right side.
export const ChangelogOpen: Story = {
  args: { frame: "changelog-open" },
};

// Figma "Frame 5 Mobile - Changelog closed": the collapsed Changelog Rail.
export const ChangelogClosed: Story = {
  args: { frame: "changelog-closed" },
};
