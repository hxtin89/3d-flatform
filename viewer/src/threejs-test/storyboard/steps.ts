// The storyboard as data: one row per beat, in the board's own order.
//
// Deliberately not a state machine, a registry, or a route per step. The whole
// sequence is linear and the current position is one integer -- anything more
// would be scaffolding for a requirement nobody has yet.
//
// ORDER follows the 18-step storyboard, not the order the Figma frames happen to
// sit on the canvas. Frames that map to a beat carry its number in
// `storyboardStep`; frames that map nowhere in the numbered sequence -- the
// changelog screens, which the board itself files under the not-yet-defined
// post-18 phase -- belong at the end.
//
// `screen` names an entry in screens.ts and renders through ScreenFrame's stage
// at literal Figma coordinates. `content: 'habitat'` is the one exception: that
// screen's parts are DOCKED, because their positions are relationships (the
// label clamping clear of the species row, the weather cluster owning the notch)
// rather than authored coordinates.

/** How this beat's UI is drawn. */
export type StepContent = 'stage' | 'habitat' | 'none';

/** Named entries in EXPERIENCE_CONFIG.storyboard.poses. */
export type PoseName = 'overview' | 'parcel' | 'orbit' | 'canopy';

export interface Step {
  /** Stable handle, used for the debug readout and later for `?step=`. */
  id: string;
  /** Which storyboard beat this is. Null where the frame maps to no numbered step. */
  storyboardStep: number | null;
  /** The Figma frame this was built from, so a divergence can be traced. */
  figmaFrame?: string;
  content: StepContent;
  /** Key into SCREENS, for `content: 'stage'`. */
  screen?: string;
  /**
   * Where the camera flies when this beat opens. Omitted means "stay put" --
   * used where consecutive beats share a vantage and only the overlay changes,
   * so the scene does not lurch for a caption swap.
   */
  pose?: PoseName;
}

export const STEPS: Step[] = [
  {
    id: 'enter',
    storyboardStep: 1,
    figmaFrame: 'Frame 9  Mobile - EnterTheWild · 19.5:9',
    content: 'stage',
    screen: 'enter',
    pose: 'overview',
  },
  {
    id: 'loading',
    storyboardStep: 2,
    figmaFrame: 'Frame 10  Mobile - Loading · 19.5:9',
    content: 'stage',
    screen: 'loading',
    // No pose: the loading beat holds the vantage the entrance left us at.
  },
  {
    id: 'arrival',
    storyboardStep: 9,
    figmaFrame: 'Frame 7  Mobile - Introduction · 19.5:9',
    content: 'stage',
    screen: 'arrival',
    pose: 'parcel',
  },
  {
    id: 'parcel-text',
    storyboardStep: 11,
    figmaFrame: 'Frame 11  Mobile - Text · 19.5:9',
    content: 'stage',
    screen: 'parcel-text',
    pose: 'canopy',
  },
  {
    // Camera-only. Renders the frame and nothing else -- the case that breaks if
    // the shell ever remounts ScreenFrame or leaves a previous step's dock rects
    // behind.
    id: 'orbit',
    storyboardStep: 12,
    content: 'none',
    pose: 'orbit',
  },
  {
    id: 'realtime',
    storyboardStep: 13,
    figmaFrame: 'Frame 7  Mobile - Introduction · 19.5:9',
    content: 'stage',
    screen: 'realtime',
    // Same frame as `arrival`, one line richer. Deliberately no pose: the two are
    // one screen in Figma, so moving the camera between them would invent a cut
    // the design does not have.
  },
  {
    id: 'habitat',
    storyboardStep: 14,
    figmaFrame: 'Frame 1 Mobile - selected · 19.5:9',
    content: 'habitat',
    pose: 'parcel',
  },
];
