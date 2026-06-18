# WI x SBB Workflow + Architecture

## Product Workflow

```mermaid
flowchart TD
  A["User enters donor journey"] --> B["Donation flow"]
  B --> C["Donation completed"]
  C --> D["Generate personalized share link"]
  D --> E["User opens personalized experience"]
  E --> F["Load 3D globe / point cloud scene"]
  F --> G["Cinematic fly-to donation shape"]
  G --> H["Show emotional data-driven experience"]
  H --> I["Overlay UI: species, viewpoints, story widgets"]
  I --> J["Share / revisit experience"]
```

## Point Cloud Workflow

```mermaid
flowchart TD
  A["Drone flights"] --> B["Raw / preprocessed point cloud data"]
  B --> C["Large dataset: terabytes"]
  C --> D["Pre-tiling via Python scripts"]
  D --> E["Inspect and select area in CloudCompare"]
  E --> F["Focus area: Mango / protected region"]
  F --> G["Convert selected tiles to COPC / 3D Tiles"]
  G --> H{"Rendering engine decision"}

  H --> I["CesiumJS + Cesium ion"]
  H --> J["Potree / Three.js custom viewer"]

  I --> K["Upload / position / host assets"]
  K --> L["Tune LOD, screen-space error, point density"]
  L --> M["Browser-based 3D point cloud experience"]

  J --> N["Custom tiling / viewer logic"]
  N --> O["More control, more engineering risk"]
  O --> M
```

## Target Architecture

```mermaid
flowchart LR
  subgraph Client["Frontend / Browser"]
    UI["UI overlays and widgets"]
    Anim["Lightweight animations: SVG / controlled Rive usage"]
    Viewer["3D Viewer: CesiumJS preferred candidate"]
    Perf["Performance detector + quality presets"]
  end

  subgraph Rendering["3D Data / Rendering Layer"]
    Cesium["Cesium ion or self-hosted Cesium assets"]
    Tiles["COPC / 3D Tiles / tiled point cloud"]
    Globe["Globe, terrain, camera, LOD"]
  end

  subgraph Backend["Backend / CMS"]
    API["Product API"]
    CMS["CMS: Directus or alternative"]
    DB["MariaDB"]
    Cron["Cron jobs / data ingestion"]
  end

  subgraph External["External Data Sources"]
    WI["Wilderness internal data"]
    Pixio["Pix-IO images"]
    GBIF["GBIF"]
    INat["iNaturalist"]
    EBird["eBird"]
  end

  User["User"] --> Client
  UI --> API
  Viewer --> Cesium
  Perf --> Viewer

  Cesium --> Tiles
  Cesium --> Globe

  API --> CMS
  CMS --> DB
  Cron --> DB

  WI --> Cron
  Pixio --> Cron
  GBIF --> Cron
  INat --> Cron
  EBird --> Cron
```

## Decision Architecture

```mermaid
flowchart TD
  A["Engine decision"] --> B{"Cesium pricing / license acceptable?"}
  B -->|Yes| C["Use CesiumJS + Cesium ion or self-hosted assets"]
  B -->|No| D["Evaluate Potree / Three.js fallback"]

  C --> E{"Hosting decision"}
  E --> F["Cesium ion"]
  E --> G["Self-hosted 3D Tiles / COPC"]

  D --> H["Custom viewer"]
  H --> I["Handle tiling, terrain, map scale, LOD manually"]

  F --> J["Build v1.0 experience"]
  G --> J
  I --> K["Higher implementation risk before v1.0"]
```

## Short Architecture Summary

```text
Donation journey
-> personalized link
-> browser loads Cesium-based 3D scene
-> point cloud / 3D tiles streamed with LOD
-> UI overlays add story, species, viewpoints
-> backend serves structured content from CMS / MariaDB
-> external biodiversity data is synced locally via cron jobs
```

## Key Notes

- The current critical path is choosing and proving the 3D engine, not UI animation.
- The architecture is currently leaning toward Cesium, tiled point cloud assets, and a separate CMS/backend.
- Potree/Three.js remains a fallback or comparison path, but it carries higher custom-engineering risk.
- WebGL2 is considered sufficient for v1.0; WebGPU is not ready for production use in this context.
- Quality presets should be planned early: Best, Medium, Low, with sensible defaults for desktop and mobile.
- A small preloader or performance probe can help select the initial LOD and quality settings.
- External data sources such as GBIF, iNaturalist, and eBird should be synced into local storage instead of queried live during the user experience.
