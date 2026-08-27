<script lang="ts">
  // Extracted from SpeciesWidget.svelte's `species-widget__facts` block (Figma
  // component "Detail Info") -- markup, CSS and comments carried over as-is.
  // SpeciesWidget only ever showed this when `selected` was true; that gating
  // is the caller's concern now, not this component's -- it renders whenever
  // it has something to show.
  interface Props {
    /** e.g. "15-17mm" — selected only. */
    measurement?: string;
    /** e.g. "Schutzstatus: am Wenigsten bedroht" — selected only. */
    status?: string;
    /** e.g. "Nur die männlichen Frösche kümmern sich um den Nachwuchs" — selected only. */
    caption?: string;
  }

  let { measurement, status, caption }: Props = $props();
</script>

{#if measurement || status || caption}
  <div class="detail-info">
    {#if measurement || status}
      <div class="detail-info__row">
        {#if measurement}
          <div class="detail-info__fact detail-info__fact--stacked">
            <!-- Coiled tape measure, ported directly from Figma's own export of
                 "Group 2" (Frame 1 Desktop, 63.33x44.33) -- the previous version
                 was a hand-approximated flat ticked rectangle, which two
                 independent reviewers flagged as both the wrong shape and
                 roughly half size. -->
            <svg class="detail-info__fact-icon detail-info__fact-icon--tape" viewBox="0 0 65 46" fill="none" aria-hidden="true">
              <path d="M9.5 15.766C9.5 19.3008 15.1711 22.1667 22.1667 22.1667V15.766C22.1667 12.6177 22.1667 11.0436 20.908 10.0833C19.6493 9.12291 18.4015 9.48211 15.9059 10.2005C12.0799 11.3019 9.5 13.3817 9.5 15.766Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
              <path d="M44.3333 11.0833C44.3333 17.2045 34.409 22.1667 22.1667 22.1667C9.92436 22.1667 0 17.2045 0 11.0833C0 4.96217 9.92436 0 22.1667 0C34.409 0 44.3333 4.96217 44.3333 11.0833Z" stroke="currentColor" stroke-width="1.5" />
              <path d="M0 12.667V33.7782C0 39.6077 9.92436 44.3337 22.1667 44.3337H57C59.9855 44.3337 61.4783 44.3337 62.4058 43.4061C63.3333 42.4786 63.3333 40.9859 63.3333 38.0003V28.5003C63.3333 25.5148 63.3333 24.022 62.4058 23.0945C61.4783 22.167 59.9855 22.167 57 22.167H22.1667" stroke="currentColor" stroke-width="1.5" />
              <path d="M50.6665 44.3337V38.0003M37.9998 44.3337V38.0003M25.3332 44.3337V38.0003M12.6665 42.7503V36.417" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <!-- A measurement ("15-17mm") is a numeric reading, not a label sentence
                 like status/caption below it -- distinct modifier class so only this
                 one fact gets the mono "instrument reading" treatment (see its own
                 comment), not every fact row indiscriminately. -->
            <span class="detail-info__fact-text detail-info__fact-text--reading">{measurement}</span>
          </div>
        {/if}
        {#if status}
          <div class="detail-info__fact detail-info__fact--stacked detail-info__fact--status">
            <!-- Status rule, ported directly from Figma's export: a hairline
                 with a round dot at BOTH ends plus a downward triangle marker
                 (~88% along), not the bare tick-crossed line the previous
                 version drew with no dots at all. The dots sit at x=0/x=179
                 and the paths start at x=-2.67 in Figma's own 182-wide export
                 -- the viewBox origin shifts to -2.67 so the left dot doesn't
                 clip; the geometry itself is unchanged. -->
            <svg class="detail-info__fact-icon detail-info__fact-icon--range" viewBox="-2.67 0 182 22" fill="none" preserveAspectRatio="none" aria-hidden="true">
              <path d="M-2.66667 10C-2.66667 11.4728 -1.47276 12.6667 0 12.6667C1.47276 12.6667 2.66667 11.4728 2.66667 10C2.66667 8.52724 1.47276 7.33333 0 7.33333C-1.47276 7.33333 -2.66667 8.52724 -2.66667 10ZM176.333 10C176.333 11.4728 177.527 12.6667 179 12.6667C180.473 12.6667 181.667 11.4728 181.667 10C181.667 8.52724 180.473 7.33333 179 7.33333C177.527 7.33333 176.333 8.52724 176.333 10ZM0 10V10.5H179V10V9.5H0V10Z" fill="currentColor" />
              <path d="M156.5 16.333L154.113 21.333H159.887L157.5 16.333H156.5ZM157 2H156.5V16.833H157H157.5V2H157Z" fill="currentColor" />
            </svg>
            <span class="detail-info__fact-text">{status}</span>
          </div>
        {/if}
      </div>
    {/if}
    {#if caption}
      <div class="detail-info__fact detail-info__fact--inline">
        <!-- Info glyph, ported directly from Figma's export: a wider r=10
             circle and a shorter stem stopping at y=11.5 (leaving a visible
             gap above the dot) rather than the previous r=9 circle with a
             stem that ran straight into the dot. -->
        <svg class="detail-info__fact-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M12 16V11.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M12 8.01172V8.00172" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="detail-info__fact-text">{caption}</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  .detail-info {
    display: flex;
    flex-direction: column;
    gap: var(--stack-sm);
  }

  .detail-info__row {
    display: flex;
    gap: var(--inset-lg);
  }

  .detail-info__fact--stacked {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--stack-xs);
  }

  /* The status column is authored at a fixed 211px in Figma -- the same width in
     Frame 1 Mobile (25547:2462) and Frame 1 Desktop (25556:1317) -- and wraps
     after the colon: "Schutzstatus:" / "am Wenigsten bedroht". Left to size
     itself it comes out wider, fits "Schutzstatus: am Wenigsten" on the first
     line, and breaks in the middle of the phrase instead. */
  .detail-info__fact--status {
    width: 211px;
    flex-shrink: 0;
  }

  .detail-info__fact--inline {
    display: flex;
    align-items: flex-start;
    gap: var(--inline-sm);
  }

  .detail-info__fact-icon {
    width: var(--size-icon-lg);
    height: var(--size-icon-lg);
    flex-shrink: 0;
  }

  .detail-info__fact-icon--tape {
    /* Matches the real icon group's own 63.33x44.33 aspect ratio. */
    width: 44px;
    height: 30px;
  }

  .detail-info__fact-icon--range {
    /* Matches the real Line 11's 179px width -- scales with everything else via
       the shared --screen-frame-content-scale transform, same as font sizes. */
    width: 179px;
    height: 20px;
  }

  .detail-info__fact-text {
    font: var(--text-body);
    /* `font` can't carry letter-spacing -- see --text-body-tracking's own comment. */
    letter-spacing: var(--text-body-tracking);
    /* Honour the authored newlines in `status`/`caption` (see
       recreation-content.ts) while still wrapping normally on top of them. */
    white-space: pre-line;
  }

  /* Same non-Figma-bound craft addition as BentoWidget's weather value (see its own
     comment): a measurement is a number, not prose, so it gets the tight mono face
     that reads as a scientific readout instead of the same Sora body copy status/caption
     use right next to it -- without this the whole species card was "one generic-looking
     bold sans at every size" even on the one fact that's actually data, not a sentence. */
  .detail-info__fact-text--reading {
    font-family: var(--family-mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    /* One line, always. This sits in a flex column beside the much longer
       status column, so it shrinks below its own content and breaks after the
       hyphen -- "15-" / "17mm" -- which Figma never does. Its real text node is
       87px wide in BOTH Frame 1 Mobile (25547:2460) and Frame 1 Desktop
       (25556:1315), i.e. authored as a single unbroken reading. */
    white-space: nowrap;
  }
</style>
