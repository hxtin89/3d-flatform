import type { Meta, StoryObj } from "@storybook/svelte";
import Subtitle from "./Subtitle.svelte";

const meta = {
  title: "Components/Subtitle",
  component: Subtitle,
  parameters: { layout: "padded", backgrounds: { default: "subtle" } },
} satisfies Meta<Subtitle>;
export default meta;

type Story = StoryObj<typeof meta>;

const COPY =
  "Im Secret Forest ist es gerade 4:50. Nur noch eine Stunde, dann beginnt der Dawn Chorus. " +
  "Halte Ausschau nach dem Sira Giftfrosch am Ufer, dort wo der Nebel am längsten über dem Wasser steht.";

export const Default: Story = { args: { text: COPY, maxWidth: 1010 } };

/** Same copy, narrower cap: more lines, and the seams re-solve from the new widths. */
export const NarrowColumn: Story = { args: { text: COPY, maxWidth: 560 } };

/** Newlines are hard breaks, so copy can force a line where the design needs one. */
export const AuthoredBreaks: Story = {
  args: { text: "Im Secret Forest ist es gerade 4:50.\nNur noch eine Stunde, dann beginnt der Dawn Chorus.", maxWidth: 1010 },
};

/** Right-anchored: the flush edge flips, and the end caps drop (see stackCorners). */
export const RightAligned: Story = { args: { text: COPY, maxWidth: 760, align: "right" } };

/** One word wider than the cap overruns rather than being split mid-word. */
export const OverlongWord: Story = {
  args: { text: "Kurz. Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz. Ende.", maxWidth: 420 },
};
