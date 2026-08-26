// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import DetailInfo from "./DetailInfo.svelte";

const meta: Meta = {
  title: "DetailInfo",
  component: DetailInfo as any,
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

// Real "S1: Giftfrosch (Widget)" selected-state content -- same three facts
// SpeciesWidget.stories.ts's Selected story passes, read off the actual
// Figma text nodes (see recreation-content.ts and this component's own
// extraction comment).
export const Default: Story = {
  args: {
    measurement: "15-17mm",
    status: "Schutzstatus: am Wenigsten bedroht",
    caption: "Nur die männlichen Frösche kümmern sich um den Nachwuchs",
  },
};

// Only the stacked row (measurement + status), no inline caption below it.
export const NoCaption: Story = {
  args: {
    measurement: "15-17mm",
    status: "Schutzstatus: am Wenigsten bedroht",
  },
};

// Only the inline caption, no stacked row above it at all.
export const CaptionOnly: Story = {
  args: {
    caption: "Nur die männlichen Frösche kümmern sich um den Nachwuchs",
  },
};

// Measurement without status -- the stacked row still renders, just missing
// its second column.
export const MeasurementOnly: Story = {
  args: { measurement: "15-17mm" },
};

// Nothing passed at all -- the component's own `{#if measurement || status
// || caption}` guard means this renders nothing, not an empty shell.
export const Empty: Story = {
  args: {},
};
