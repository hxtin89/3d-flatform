// Storybook 8's Svelte typings don't yet infer $props()-declared (Svelte 5 runes)
// component props correctly, so Meta/StoryObj are left untyped here rather than
// fighting a type system that doesn't understand this component's real prop shape.
import type { Meta, StoryObj } from "@storybook/svelte";
import BentoWidget from "./BentoWidget.svelte";
import { silhouette } from "./geometry/silhouette";

const meta: Meta = {
  title: "BentoWidget",
  component: BentoWidget as any,
  argTypes: {
    state: { control: "select", options: ["default", "selected"] },
    accent: {
      control: "select",
      options: ["default", "blue", "green", "coral", "purple", "grey-light", "grey-dark", "gold", "forest-green"],
    },
  },
};
export default meta;

type Story = StoryObj & { args: Record<string, unknown> };

const width = 320;
const heightCollapsed = 220;
const corners = ["convex", "convex", "convex", "convex"] as const;

export const Default: Story = {
  args: {
    path: silhouette(width, heightCollapsed, [...corners], 60),
    width,
    height: heightCollapsed,
    corners: [...corners],
    title: "Widget Title",
    value: "29°",
    description: "Description",
    accent: "default",
    state: "default",
  },
};

export const Selected: Story = {
  args: { ...Default.args, state: "selected" },
};

export const Expanded: Story = {
  args: {
    ...Default.args,
    // +90px (78px panel + 12px spacing), per the Figma-documented growth choreography
    height: heightCollapsed + 90,
    path: silhouette(width, heightCollapsed + 90, [...corners], 60),
    expanded: true,
  },
};

export const NoValue: Story = {
  args: { ...Default.args, value: undefined, title: "SCHNURRVOGEL", description: "pipra fasciicauda" },
};

export const ConcaveBottomRight: Story = {
  args: {
    ...Default.args,
    corners: ["convex", "convex", "concave", "convex"],
    path: silhouette(width, heightCollapsed, ["convex", "convex", "concave", "convex"], 60),
    title: "Concave",
    description: "Reflex point rounding",
  },
};

export const FillLeftTopLeft: Story = {
  args: {
    ...Default.args,
    corners: ["fill-left", "convex", "convex", "convex"],
    path: silhouette(width, heightCollapsed, ["fill-left", "convex", "convex", "convex"], 60),
    title: "Fill-Left",
    description: "Reaches left past the corner",
  },
};

export const FillTopTopLeft: Story = {
  args: {
    ...Default.args,
    corners: ["fill-top", "convex", "convex", "convex"],
    path: silhouette(width, heightCollapsed, ["fill-top", "convex", "convex", "convex"], 60),
    title: "Fill-Top",
    description: "Reaches up past the corner",
  },
};
