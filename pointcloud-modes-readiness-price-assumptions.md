# Point Cloud: Three Modes, Readiness, and Cost Assumptions

## Large Point Cloud Performance Pipeline

This pipeline is designed for large LAS datasets where processing a whole-file COPC or rendering the entire scene is too resource-intensive. Dataset names such as `2404PeruB2` are examples only; the workflow can be applied to any large dataset that follows the same conventions.

The target flow is:

```text
raw LAS ~90 GB (~4 hours on a local Mac M2 with 16 GB RAM)
  -> prepared LAZ (30 minutes)
  -> chunked LAZ (30 minutes)
  -> per-chunk COPC (60 minutes)
  -> full chunked COPC 3D Tiles (40 minutes)
  -> logical modes:
       Overview = all areas, approximately p02 (60 minutes), ~1 GB
       Explore  = selected area, approximately p10 (45 minutes), ~5 GB
       Detail   = selected area, full reference (30 minutes), ~50 GB
       Context  = optional p001 overview around the Explore/Detail focus area
```

This document summarizes the measurements for the **2404PeruB2** dataset collected on **June 29, 2026**. Detailed figures are available in `local-storage/reports/web/readiness-report.json`.

## Executive summary

Current status: **Ready for a pilot, with conditions that still need monitoring**.

- **Overview** and **Explore** are suitable for a staged pilot.
- **Detail** works after the CloudFront data path issue was fixed.
- The viewer should start in Overview. Users can switch to Explore when they need a closer inspection.
- Context should be disabled by default to reduce data transfer and maintain stable performance.
- Before committing to an SLA, the Explore loading time should be investigated and Detail should be tested across more areas.

## How do the three modes work?

| Mode | What does the user see? | Data density | When should it be used? |
|---|---|---:|---|
| **Overview** | The entire site | Approximately 2% | Initial view, overall context, and fast navigation |
| **Explore** | One selected area | Approximately 10% | Inspecting shapes and colors in more detail |
| **Detail** | One selected area | 100% | Highest-detail inspection |

Typical user flow:

```text
Open dataset -> Overview -> select an area -> Explore -> Detail only when needed
```

Explore and Detail load only the selected area instead of loading the entire dataset at high density. This reduces network, RAM, and GPU usage.

## Simplified readiness report

| Mode | Measurement | Interaction FPS | First visible content | Data per session | Assessment |
|---|---:|---:|---:|---:|---|
| **Overview** | 419 tiles and approximately 6.17 million visible points | 55 FPS | 0.66 seconds | 0.172 GB | Pilot-ready |
| **Explore** | 223 tiles and approximately 5.47 million visible points | 43 FPS | 2.64 seconds | 0.087 GB | Ready, but slow background loading needs monitoring |
| **Detail** | 21 tiles and approximately 1.63 million visible points | Not measured | 10.13 seconds | 0.024 GB | Working, but more testing is required |

Remaining conditions:

- Explore took approximately **63.45 seconds** to complete the recorded loading activity, although the first visible content appeared after 2.64 seconds.
- Detail was measured from only one camera position in `area-020`. Other areas or camera positions may load significantly more data.
- Detail was measured with SSE 64, while SSE 256 is the recommended safer production setting.
- Actual cost will vary with the selected area, camera position, session duration, and cache state.

## Pricing assumptions

The estimate uses Amazon CloudFront Pay-as-you-go pricing for Vietnam, checked on **June 29, 2026**:

- The first 1 TB of data transfer and the first 10,000,000 HTTP/HTTPS requests per month are free.
- HTTPS requests after the Free Tier cost $0.012 per 10,000 requests.
- Data transfer after the Free Tier is tiered from $0.12/GB, then $0.10/GB, $0.095/GB, and $0.09/GB at the volumes used below.
- One user represents one measured session.
- Prices exclude S3 storage and GET requests, WAF, CloudFront Functions, Lambda@Edge, Origin Shield, logging, taxes, and support.
- The Free Tier is assumed to be unused by other workloads in the AWS account.

Pricing source: <https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/>

All estimates below are in **USD per month**.

### Common scenario: each user opens Overview and one Explore area

| Monthly users | Estimated cost |
|---:|---:|
| 10,000 | **$199.70** |
| 100,000 | **$2,867.75** |
| 1,000,000 | **$26,479.47** |

### Usage scenario comparison

| Behavior per user | 10,000 users | 100,000 users | 1,000,000 users |
|---|---:|---:|---:|
| Overview only | $89.37 | $1,938.21 | $18,052.40 |
| One Explore area only | $0.00 | $971.21 | $9,179.24 |
| Overview and one Explore area | $199.70 | $2,867.75 | $26,479.47 |
| Overview, Explore, and Detail | $229.66 | $3,118.40 | $28,741.11 |

## Additional limitations

- Each user opens each mode included in a scenario only once.
- All requests are assumed to use HTTPS and to be billed under the regional pricing group that includes Vietnam.
- CloudFront-to-viewer charges apply whether the data is served from the edge cache or the origin.
- Reliable cache-hit data is not yet available, so origin load and S3 GET costs cannot be estimated accurately.

These figures are appropriate for initial pilot budgeting, but they should not be treated as a fixed quotation. Real usage data should be collected and the assumptions should be updated based on actual sessions, selected areas, and user behavior.
