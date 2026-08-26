// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import MediaCard from "./MediaCard.svelte";
import { giftfroschImage } from "./screen-frame/species-icons";

const meta: Meta = {
  title: "MediaCard",
  component: MediaCard as any,
  argTypes: {
    accent: {
      control: "select",
      options: ["default", "blue", "green", "coral", "purple", "grey-light", "grey-dark", "gold", "forest-green"],
    },
    progress: { control: { type: "range", min: 0, max: 1, step: 0.01 } },
  },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

// Figma's real Media Card instance is gold, this component's own default
// accent (see MediaCard.svelte's Props doc) -- `image` reuses the real
// giftfrosch photo asset rather than a fabricated thumbnail.
export const Default: Story = {
  args: {
    image: giftfroschImage,
    author: "Sira Giftfrosch",
    duration: "2:14",
    progress: 152 / 516,
    accent: "gold",
  },
};

export const NoProgress: Story = {
  args: { ...Default.args, progress: 0 },
};

export const NearlyFinished: Story = {
  args: { ...Default.args, progress: 0.92 },
};

// `imageSrc` path instead of the `image` snippet -- the common case where
// the caller only has a URL (see MediaCard.svelte's own precedence doc).
export const ImageSrcOnly: Story = {
  args: {
    imageSrc:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'%3E%3Crect width='300' height='200' fill='%23555'/%3E%3C/svg%3E",
    author: "Nordwest Wind",
    duration: "0:47",
    progress: 0.3,
    accent: "gold",
  },
};

export const NoThumbnail: Story = {
  args: { author: "Leicht bewölkt", duration: "1:03", progress: 0.1, accent: "grey-dark" },
};

export const ForestGreenAccent: Story = {
  args: { ...Default.args, accent: "forest-green" },
};
