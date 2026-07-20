# Adaptive Point Hierarchy V1 — 4 kế hoạch bàn giao

## Quy tắc chung

- Tên kiến trúc: **Adaptive Point Hierarchy (APH)**.
- APH là mode/output mới, không thay đổi `?lod=spatial-lod`.
- Không đưa RGB classification v1/v2 trở lại.
- Giữ nguyên thay đổi chưa commit của người dùng; không stage hoặc commit.
- Trước khi sửa symbol hiện có, chạy GitNexus impact và cảnh báo nếu HIGH/CRITICAL.
- Mỗi task phải chạy test riêng và `git diff --check`.

---

# Plan 1 — APH Pipeline Foundation

**Ước lượng:** 150k–300k token  
**Phụ thuộc:** Không có.

## Mục tiêu

Tạo foundation cho builder APH nhưng chưa đọc/partition point và chưa xây quadtree.

## Thực hiện

- Tạo builder `pipeline/build_adaptive_point_hierarchy.py`.
- Tạo wrapper `pipeline/adaptive-point-hierarchy.sh`.
- Thêm npm script:

```text
pipeline:adaptive-point-hierarchy
```

- Public command:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:adaptive-point-hierarchy -- 2404PeruB2 --pilot auto
```

- Implement CLI contract:

```text
--internal-target-points 75000
--acceptable-min-points 40000
--leaf-max-points 110000
--hard-max-points 150000
--max-depth 11
--error-scale 2.0
--microcell-grid 16
--vrv-mode both
--pilot auto
--z0-id <id>            repeatable
--resume
--overwrite
--allow-low-disk
```

- Validate threshold ordering, names, mutually exclusive `--resume/--overwrite`, repeated z0 IDs và output containment.
- Preflight COPC sources, source fingerprints, CRS, RGB availability, ENU frame, exact 2 km z0 grid origin và disk requirement với 20% margin.
- Tạo output skeleton:

```text
<logical>-adaptive-point-hierarchy/
  z0/
  points/z0/
  points/adaptive/
  .adaptive-point-hierarchy-state.json
  adaptive-point-hierarchy-report.json
```

- State phải atomic-write và chứa schema version, phase, profile hash, source order/fingerprints, transform, grid origin, CLI profile, requested pilot selection và completed artifacts.
- `--pilot auto` chỉ được ghi là selection request; Task 2 mới resolve dense/sparse từ exact point counts.
- Report skeleton dùng status `initialized`.
- Không publish placeholder `tileset.json`.
- Không refactor hoặc sửa `partition_points` của Spatial LOD.

## Nghiệm thu

- CLI tạo skeleton và thoát thành công.
- Resume cùng profile thành công.
- Resume fail khi source order/fingerprint, transform, grid origin hoặc thresholds thay đổi.
- Overwrite chỉ xảy ra sau khi preflight thành công.
- Test CLI validation, atomic state, resume mismatch, disk preflight và path safety.
- Spatial LOD tests hiện tại vẫn pass.

---

# Plan 2 — Residual Adaptive Quadtree

**Ước lượng:** 300k–500k token  
**Phụ thuộc:** Plan 1 hoàn tất.

## Mục tiêu

Tạo toàn bộ PNTS content, residual adaptive quadtree, representative sampling và exact point accounting; chưa sinh tileset JSON.

## Thực hiện

- Giữ exact z0 2 km, ENU frame, source order và global ordinal contract.
- Global ordinal tăng cho mọi source point; node bị bỏ qua bằng hierarchy count vẫn phải advance ordinal.
- Với valid point thuộc selected z0:

```text
ordinal % 1000 == 0 → z0 p001
còn lại             → đúng một APH content
```

- P001 không được đưa vào adaptive fragments.
- Resolve pilot:
  - dense = non-empty z0 có nhiều point nhất;
  - sparse = z0 gần percentile 25% nhất;
  - tie-break bằng tile ID;
  - explicit `--z0-id` bỏ qua auto-selection.
- Quadtree dùng nominal center cố định:

```text
east  = x >= centerX
north = y >= centerY
q0 = west/south
q1 = east/south
q2 = west/north
q3 = east/north
```

- Node policy:

```text
count <= 110k:
  emit toàn bộ thành leaf

count > 110k và depth < 11:
  emit 75k representatives
  split remainder vào children

depth == 11 và count <= 150k:
  emit toàn bộ

depth == 11 và count > 150k:
  fail
```

- Không sibling merge.
- Leaf dưới 40k hợp lệ với `underfilledReason: sparseSpatialBranch`.
- Sampling dùng nominal-bounds microcell 16×16:
  - mỗi occupied microcell tối thiểu một point;
  - quota còn lại proportional theo count;
  - largest-remainder, tie-break theo microcell index;
  - chọn min-hash theo source fingerprint + global ordinal.
- Dùng disk-backed fixed-record fragments; không load toàn bộ z0 vào RAM.
- Mỗi PNTS có temporary `.ord.u64` sidecar.
- Dùng disk-backed ordinal ownership map để phát hiện duplicate.
- Ghi atomically:
  - `points/z0/<z0-id>.pnts`;
  - `points/adaptive/<z0-id>/d<depth>_q<base4-path>.pnts`.
- Ghi per-z0 hidden node manifest cho Task 3, gồm node ID, parent, children, depth, nominal bounds, content bounds, point count, PNTS URI và sampling statistics.
- Checkpoint theo source chunk và completed z0; resume phải rebuild ownership từ sidecars.

## Accounting bắt buộc

```text
sourcePointsVisited
invalidPoints
outsideSelectedZ0
eligibleSelectedZ0
p001Points
adaptivePoints
duplicates
omittedEligiblePoints
```

Invariant:

```text
eligibleSelectedZ0 = p001Points + adaptivePoints
duplicates = 0
omittedEligiblePoints = 0
```

## Nghiệm thu

- Routing center-line deterministic.
- Build lặp lại tạo cùng node IDs, counts và hashes.
- P001 và adaptive ordinals disjoint.
- Mỗi adaptive ordinal có đúng một owner.
- `p95 <= 110k`, `max <= 150k`, ngoại trừ p001 compatibility content.
- Test pilot selection, routing, quota, hashing, sparse leaf, max depth, accounting và resume.

---

# Plan 3 — Tileset Metadata and Semantics

**Ước lượng:** 250k–400k token  
**Phụ thuộc:** Plan 2 hoàn tất.

## Mục tiêu

Chuyển node manifests và PNTS thành APH 3D Tiles hierarchy hợp lệ, gồm bounds, geometric error và hai VRV variants.

## Thực hiện

- Sinh:

```text
tileset.json
tileset-no-vrv.json
tileset-frontier-tight.json
z0/<z0-id>/tileset.json
adaptive-point-hierarchy-report.json
```

- Entry root là synthetic container duy nhất mang ENU→ECEF transform.
- Mỗi z0 là external subtree.
- Z0 p001 và toàn bộ adaptive nodes dùng `refine: "ADD"`.
- Duy trì riêng:

```text
nominalBounds
contentBounds
subtreeBounds
```

- PNTS/RTC center dùng content bounds.
- Tile bounding volume dùng subtree bounds.
- Parent subtree bounds phải chứa parent content và toàn bộ child subtree bounds.
- Geometric error dựa trên representation spacing:

```text
areaXY = max(tightWidth × tightHeight, epsilon)
spacing = sqrt(areaXY / contentPointCount)
rawError = spacing × 2.0
```

- Leaf error bằng 0.
- Internal error:

```text
max(rawError, maxChildError × 1.05, maxChildError + 0.01)
```

- Z0 p001 áp dụng cùng spacing rule.
- Chỉ synthetic entry root dùng diagonal bootstrap error.
- `none`: không có adaptive VRV.
- `frontier-tight`: gắn một lần tại adaptive depth 5:

```text
widthX  = max(100 m, 1.5 × subtreeWidthX)
widthY  = max(100 m, 1.5 × subtreeWidthY)
heightZ = max(200 m, 2.0 × subtreeHeightZ)
```

- Hai variants dùng chung PNTS.
- Trước benchmark, `tileset.json` giống `tileset-no-vrv.json`; report ghi `canonicalVrv: none` và `selectionStatus: pendingBenchmark`.
- Publish entry root cuối cùng.
- Chỉ xóa hidden manifests, audit sidecars và state sau khi validation và publish hoàn tất.

## Report

Ghi profile, source fingerprints, accounting, per-depth tiles/points/bytes, point-count percentiles, sampling coverage, bounds, raw/final errors, VRV policy và canonical selection status.

## Nghiệm thu

- Tất cả URI relative, không escape output root và file tồn tại.
- JSON/PNTS headers hợp lệ.
- Parent error strictly greater child error.
- Bounding volumes chứa đúng content/subtrees.
- Root transform và RTC reconstruction không tạo offset.
- Hai VRV variants chỉ khác metadata VRV.
- Accounting giữ nguyên chính xác từ Task 2.
- Test bounds union, error correction, ADD semantics, external z0 documents, VRV và atomic publish.

---

# Plan 4 — Viewer, Telemetry and Benchmark

**Ước lượng:** 200k–400k token  
**Phụ thuộc:** Plan 3 hoàn tất.

## Mục tiêu

Thêm APH vào viewer như mode độc lập, cung cấp telemetry, A/B benchmark và automated tests.

## Public interface

```text
?lod=adaptive-point-hierarchy
?lod=adaptive-point-hierarchy&aphVrv=none
?lod=adaptive-point-hierarchy&aphVrv=frontier-tight
```

Tên public:

```text
UI label: Adaptive Point Hierarchy
Asset flag: adaptivePointHierarchy
Report object: adaptivePointHierarchy
Code prefix: aph / AdaptivePointHierarchy
```

## Thực hiện

- Tạo module runtime APH riêng; không đổi parser/controller của Spatial LOD.
- Thêm:
  - `AdaptivePointHierarchyTileId`;
  - `AdaptivePointHierarchyDepthStats`;
  - `AdaptivePointHierarchyController`;
  - APH dataset/entry resolver;
  - depth/path parser.
- SSE ladder:

```text
4, 8, 12, 16, 24, 32, 48, 64
```

- Initial SSE:

```text
<=250 m: 4
<=500 m: 8
<=1000 m: 12
<=2000 m: 16
farther: 32
```

- Settled baseline 16; pressure coarsens tối đa 64.
- Giữ point/memory pressure thresholds hiện tại, nhưng không dùng Spatial LOD ladder 64–2048.
- `detailEligible`:

```text
cameraRange <= 250 m
OR camera intersects loaded frontier-tight VRV
```

- Active depth chỉ dùng telemetry, không được điều khiển eligibility.
- Metrics tối thiểu:

```text
aphActiveDepths
aphSelectedPointsByDepth
aphDetailEligible
aphDetailFirstRequestDelayMs
aphVrvMode
aphPointReconciliationDelta
```

- UI hiển thị “Active Adaptive Depths”.
- Preset Overview/Explore/Detail không thay APH dataset/runtime.
- Thêm Vitest dev dependency và viewer `npm test`.

## Benchmark

- Dense và sparse pilot chạy độc lập.
- So sánh fixed Spatial LOD, APH none và APH frontier-tight.
- Mỗi variant chạy ba cold-cache runs, dùng median.
- Scenario: center 250 m, travel 25%→75% z0 X, settle 15 giây, small close orbit.
- `aphVisual=1`: fixed background, tắt imagery/atmosphere, `preserveDrawingBuffer`, capture tại 10/15 giây, central 80% ROI.
- Gate cho cả dense và sparse:
  - peak memory giảm ≥15%;
  - PNTS bytes giảm ≥15%;
  - first-visible không chậm hơn 10%;
  - frame EMA và settle không tệ hơn 10%;
  - coverage ≥98% baseline;
  - holes ≤ baseline +2 percentage points;
  - temporal delta ≤ baseline ×1.10;
  - reconciliation chính xác;
  - không offset, permanent holes hoặc severe popping.
- Chọn `frontier-tight` nếu local bytes giảm ≥10%, detail delay ≤+10% và coverage không giảm quá 2%; nếu không, giữ `none`.
- Sau benchmark, atomically cập nhật generated `tileset.json` và report canonical selection; không promote hoặc xóa Spatial LOD.
- Full dataset build/global benchmark không thuộc task này trừ khi được yêu cầu riêng.

## Nghiệm thu

- APH parser/controller/eligibility/telemetry tests pass.
- Spatial LOD regression tests pass.
- Viewer production build và `git diff --check` pass.
- Benchmark tạo machine-readable report và screenshots.
- Tạo skill riêng `.agents/skills/adaptive-point-hierarchy/SKILL.md`, đồng thời chỉ thêm liên kết phân biệt trong Spatial LOD skill.
