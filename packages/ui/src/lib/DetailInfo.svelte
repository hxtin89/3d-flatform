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
            <!-- Tape measure, sized/proportioned to match the real Figma icon group
                 (63.33x44.33, read directly off "Group 2" in Frame 1 Desktop). -->
            <svg class="detail-info__fact-icon detail-info__fact-icon--tape" viewBox="0 0 64 44" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="60" height="26" rx="13" stroke="currentColor" stroke-width="2" />
              <path d="M14 2v10M24 2v6M34 2v10M44 2v6M54 2v10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              <path d="M20 28c0 8 6 14 14 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              <rect x="30" y="34" width="14" height="8" rx="2" stroke="currentColor" stroke-width="2" />
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
            <!-- Range indicator: a plain hairline with rounded end-caps and one tick
                 mark, matching the real "Line 11" + "Arrow 2" pair (179px wide, tick
                 ~88% along) rather than a two-dot slider. -->
            <svg class="detail-info__fact-icon detail-info__fact-icon--range" viewBox="0 0 180 20" preserveAspectRatio="none" aria-hidden="true">
              <line x1="2" y1="10" x2="178" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              <line x1="157" y1="1" x2="157" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
            <span class="detail-info__fact-text">{status}</span>
          </div>
        {/if}
      </div>
    {/if}
    {#if caption}
      <div class="detail-info__fact detail-info__fact--inline">
        <svg class="detail-info__fact-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" />
          <line x1="12" y1="11" x2="12" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          <circle cx="12" cy="8" r="1" fill="currentColor" />
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
