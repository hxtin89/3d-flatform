// The storyboard as data: one row per beat, in order.
//
// Deliberately not a state machine, a registry, or a route per step. The whole
// sequence is linear and the current position is one integer -- anything more
// would be scaffolding for a requirement nobody has yet. Back-navigation and
// deep links are the obvious next additions; a `?step=N` read once at boot is
// the entire feature when someone actually needs to demo step 12 without
// watching 1 through 11 first.
//
// `content` names which composition the shell renders inside the ONE ScreenFrame
// it owns. A beat with no content is a camera-only moment -- the storyboard has
// nine of those (steps 3-8, 10, 12, 18), where the flight carries the beat and
// no UI is on screen at all.

/** Which composition the shell puts inside the frame for this beat. */
export type StepContent = 'habitat' | 'text' | 'none';

export interface Step {
  /** Stable handle, used for the debug readout and later for `?step=`. */
  id: string;
  /** Which storyboard beat this is, for tracing back to the board and to Figma. */
  storyboardStep: number;
  /** The Figma frame this was built from, so a divergence can be traced. */
  figmaFrame?: string;
  content: StepContent;
  /** Copy for the `text` composition. */
  caption?: string;
}

export const STEPS: Step[] = [
  {
    id: 'habitat',
    storyboardStep: 14,
    figmaFrame: 'Frame 1 Mobile - selected · 19.5:9',
    content: 'habitat',
  },
  {
    id: 'parcel-confirmed',
    storyboardStep: 11,
    figmaFrame: 'Frame 11  Mobile - Text · 19.5:9',
    content: 'text',
    caption: 'Das sind die 52m², welche mit deiner Spende geschützt wurden.',
  },
  {
    // A camera-only beat. It renders the frame and nothing else, which is the
    // case that breaks if the shell ever remounts ScreenFrame per step or leaves
    // a previous step's dock rects behind.
    id: 'orbit',
    storyboardStep: 12,
    content: 'none',
    caption: '52m² voll Leben.',
  },
];
