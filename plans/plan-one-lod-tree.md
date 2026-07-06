# Plan — One LOD Tree External Tileset Chain

The one-lod-tree dataset uses a standards-compliant external tileset chain. It
does not inline Overview, Explore, and Detail into one large JSON file and it
does not modify any existing `tileset.json` or PNTS file.

## Generated chain

`npm run pipeline:area:one-lod-tree -- <dataset>` builds every manifest area in
one validated batch. Passing an optional `<area>` keeps the targeted four-file
build for debugging.

```text
<logical>/<logical>-one-lod-tree/tileset-one-lod-tree.json
  -> <overview>/chunks/<chunk>/tileset-one-lod-tree.json
       -> <explore>/areas/<area>/chunks/<chunk>/tileset-one-lod-tree.json
            -> <detail>/areas/<area>/chunks/<chunk>/tileset-one-lod-tree.json
```

- The all-area entry is based on the Overview root and points every chunk to its
  generated Overview sidecar. A targeted build rewrites only its selected chunk.
- The Overview sidecar preserves its packed root and p02 children, then adds a
  leaf reference to Explore.
- The Explore sidecar preserves the real p10 tree and adds a leaf reference to
  Detail. It does not invent a `root_packed.pnts` when the source has none.
- The Detail sidecar references the selected full-density chunk's existing PNTS
  files without copying or regenerating them.
- A tile whose `content.uri` points to JSON never contains `children`; those
  children live inside the referenced external tileset.
- Overview-to-Explore and Explore-to-Detail leaves include stage-specific
  `viewerRequestVolume` boxes. Their XY footprint stays within the source chunk;
  vertical ranges default to `2.5x` and `0.75x` the chunk half-diagonal.
- Only the entry root contains the shared ENU-to-ECEF transform.

The legacy `<logical>-one-lod-tree/tileset.json` may remain on disk for
comparison, but the viewer never loads it.

## Viewer mode

Open:

```text
http://localhost:5173/?dataset=peru-b2-globe&lod=one-lod-tree
```

The viewer loads the sidecar entry once. Overview, Explore, and Detail only
change the active tileset's render budget and SSE (`256`, `192`, and `128`); they
do not swap datasets. Area selection, current-view detection, Context, Detail
SSE override, and progressive Overview SSE are disabled in this mode.

Manual mode and `?lod=auto` keep their existing behavior.

## Validation

- Unit tests verify targeted and all-area output, request-volume gates, URI
  resolution, external-leaf structure, transforms, geometric-error
  monotonicity, source immutability, bbox failures, and idempotent rebuilds.
- Viewer tests verify custom entry filenames and one-lod preset SSE mapping.
- Browser validation confirms external requests progress Overview -> Explore ->
  Detail and never request the legacy inlined `tileset.json`.
