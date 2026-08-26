// See BentoWidget.stories.ts -- Storybook 8's Svelte typings don't yet infer
// $props()-declared (Svelte 5 runes) component props, so left untyped here.
import type { Meta, StoryObj } from "@storybook/svelte";
import ChangelogRow from "./ChangelogRow.svelte";
import { giftfroschImage } from "./screen-frame/species-icons";

const meta: Meta = {
  title: "ChangelogRow",
  component: ChangelogRow as any,
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

// Plain background-image case -- the common path where the caller only has
// a URL, no snippet.
export const Default: Story = {
  args: {
    imageSrc:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='180'%3E%3Crect width='400' height='180' fill='%23888'/%3E%3C/svg%3E",
    label: "Update vom 12. März",
  },
};

// `image` snippet takes priority over `imageSrc` (see ChangelogRow.svelte's
// Props doc) -- reuses the real giftfrosch photo asset rather than a
// fabricated placeholder.
export const WithImageSnippet: Story = {
  args: { image: giftfroschImage, label: "Sira Giftfrosch update" },
};

export const NoImage: Story = {
  args: { label: "Update ohne Bild" },
};

export const TallerCard: Story = {
  args: { ...Default.args, height: 320 },
};

export const Clickable: Story = {
  args: { ...Default.args, onClick: () => alert("Row clicked") },
};
