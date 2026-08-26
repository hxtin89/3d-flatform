// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import MapPin from "./MapPin.svelte";
import { frogIcon, giftfroschImage } from "./screen-frame/species-icons";

const meta: Meta = {
  title: "MapPin",
  component: MapPin as any,
  argTypes: {
    variant: { control: "select", options: ["icon", "photo"] },
    accent: {
      control: "select",
      options: ["default", "blue", "green", "coral", "purple", "grey-light", "grey-dark", "gold", "forest-green"],
    },
  },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

// Figma component set "Map Pin", Content: Icon -- reuses the real frog
// line-art from the species row rather than a fabricated placeholder glyph.
export const Default: Story = {
  args: {
    variant: "icon",
    accent: "gold",
    icon: frogIcon,
    label: "Sira Giftfrosch habitat",
  },
};

// Content: Photo -- same real giftfrosch photo asset SpeciesWidget's
// selected state uses, at the disc's own 20%-alpha wash (see MapPin.svelte's
// `[data-variant="photo"]` rule).
export const Photo: Story = {
  args: {
    variant: "photo",
    accent: "gold",
    image: giftfroschImage,
    label: "Sira Giftfrosch habitat",
  },
};

// No icon/image slot content at all -- an empty disc, since Figma's real
// component only ever shows Icon or Photo, never neither, but a caller
// without an icon system wired in yet still needs somewhere to land.
export const Empty: Story = {
  args: { variant: "icon", accent: "grey-light", label: "Unmarked location" },
};

export const Clickable: Story = {
  args: { ...Default.args, onClick: () => alert("Pin clicked") },
};

export const ForestGreenAccent: Story = {
  args: { ...Default.args, accent: "forest-green" },
};
