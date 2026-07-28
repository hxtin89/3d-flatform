# Adaptive Point Hierarchy V1

## Tóm tắt

- Tên chính thức của kiến trúc mới là **Adaptive Point Hierarchy (APH)**.
- `spatial-lod` tiếp tục chỉ cây fixed grid `p001/p02/p10/p50/p100` hiện tại.
- APH giữ exact z0 grid 2 km làm spatial root, nhưng refinement bên dưới dựa trên point count, representation spacing và runtime budget.
- Triển khai dưới dạng mode/output riêng để A/B và rollback an toàn.
- Không đưa RGB classification v1/v2 trở lại.

Kiến trúc:

```text
Entry root — synthetic container
└── external z0 subtree
    └── z0 root — ADD
        ├── p001 residual content
        └── Adaptive Point Hierarchy — ADD
            └── point-count-triggered, fixed-center-cut XY quadtree
```

## Interfaces và naming contract

Chuẩn hóa toàn bộ tên mới:

```text
Mode:          adaptive-point-hierarchy
Query:         ?lod=adaptive-point-hierarchy
Output:        <logical>-adaptive-point-hierarchy
Builder:       build_adaptive_point_hierarchy.py
Wrapper:       adaptive-point-hierarchy.sh
Report:        adaptive-point-hierarchy-report.json
State:         .adaptive-point-hierarchy-state.json
Asset flag:    adaptivePointHierarchy: true
Generator:     SBB Adaptive Point Hierarchy V1
UI label:      Adaptive Point Hierarchy
Code prefix:   aph / AdaptivePointHierarchy
```

Command:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:adaptive-point-hierarchy -- 2404PeruB2 --pilot auto

POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:adaptive-point-hierarchy -- 2404PeruB2 --resume
```

CLI defaults:

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
--z0-id <id>             repeatable
--resume
--overwrite
--allow-low-disk
```

Output:

```text
<logical>-adaptive-point-hierarchy/
  tileset.json
  tileset-frontier-tight.json
  tileset-no-vrv.json
  adaptive-point-hierarchy-report.json
  z0/<z0-id>/tileset.json
  points/z0/<z0-id>.pnts
  points/adaptive/<z0-id>/d<depth>_q<base4-path>.pnts
```

Viewer variants:

```text
?lod=adaptive-point-hierarchy
?lod=adaptive-point-hierarchy&aphVrv=frontier-tight
?lod=adaptive-point-hierarchy&aphVrv=none
```

## Pipeline implementation

### Exact z0 và residual ownership

- Giữ nguyên grid origin, cell 2 km, tile IDs, ENU frame và source traversal order của Spatial LOD hiện tại.
- Global ordinal vẫn tăng cho invalid point, outside-pilot point và skipped COPC node.
- Point hợp lệ trong selected z0 được sở hữu đúng một lần:

```text
ordinal % 1000 == 0 → z0 p001
còn lại             → đúng một APH content
```

- z0 dùng `ADD`; p001 luôn tiếp tục render khi refinement sâu hơn.
- P001 bị loại khỏi adaptive fragments, nên không duplicate.
- Entry root là node duy nhất mang ENU→ECEF transform.

Accounting report:

```json
{
  "sourcePointsVisited": 3419134134,
  "invalidPoints": 0,
  "outsideSelectedZ0": 0,
  "eligibleSelectedZ0": 0,
  "p001Points": 0,
  "adaptivePoints": 0,
  "duplicates": 0,
  "omittedEligiblePoints": 0
}
```

Validation bắt buộc:

```text
p001 ordinals ∩ adaptive ordinals = ∅
p001 ordinals ∪ adaptive ordinals = all valid eligible selected-z0 ordinals
eligibleSelectedZ0 = p001Points + adaptivePoints
duplicates = 0
omittedEligiblePoints = 0
```

- Trong build, mỗi PNTS có temporary `.ord.u64` sidecar.
- Dùng disk-backed ordinal ownership map để phát hiện duplicate và omitted chính xác.
- Resume rebuild ownership từ completed sidecars.
- Xóa audit sidecars sau khi validation hoàn tất.

### Adaptive quadtree

APH là “adaptive by split decision, fixed by spatial cut”.

Quadrant routing:

```text
east  = x >= nominalCenterX
north = y >= nominalCenterY

q0 = west + south
q1 = east + south
q2 = west + north
q3 = east + north
```

- Point đúng center line luôn đi east/north.
- Không dùng median hoặc tight bounds làm split plane.
- Empty quadrant bị omit.
- Base-4 path luôn ổn định giữa các build.

Node rules:

```text
count <= 110k:
    emit toàn bộ thành leaf

count > 110k và depth < 11:
    emit 75k representatives tại node
    route toàn bộ remainder vào q0–q3

depth == 11 và count <= 150k:
    emit toàn bộ thành max-depth leaf

depth == 11 và count > 150k:
    fail hardMax validation
```

- Không merge sibling trong V1.
- Leaf dưới 40k được giữ với `underfilledReason: sparseSpatialBranch`.
- 75k là internal representative target, không phải hard target cho mọi content.
- Report phải có p50, p95, max và fraction content trong band 40k–110k.
- Gate cấu trúc: `p95 <=110k`, `max <=150k`, ngoại trừ z0 p001 compatibility content.

### Representative sampling

- Microcells được tính từ nominal node bounds.
- Mỗi node dùng grid 16×16.
- Mỗi occupied microcell nhận tối thiểu một point.
- Quota còn lại phân bổ proportional theo microcell point count bằng largest-remainder method; tie-break theo microcell index.
- Trong mỗi microcell, chọn stable hashes nhỏ nhất.
- Hash dựa trên source fingerprint và global ordinal.
- Chosen representatives thuộc current node; remainder mới được chuyển xuống children.
- Report coverage sampling: occupied cells, represented cells, min/max retention ratio và actual quota.

### Bounds và PNTS

Mỗi node giữ riêng:

```text
nominalBounds — spatial addressing
contentBounds — point thực trong node PNTS
subtreeBounds — union(contentBounds, child subtreeBounds...)
```

- Tile `boundingVolume` dùng `subtreeBounds`.
- PNTS RTC center dùng center của `contentBounds`.
- Parent subtree bounds phải chứa content và toàn bộ child subtree bounds.
- Không dùng raw COPC cube bounds làm final tile bounds.

### Spacing-based geometric error

Không derive representation error từ nominal cell width hoặc depth.

```text
areaXY           = max(tightWidth × tightHeight, epsilon)
estimatedSpacing = sqrt(areaXY / contentPointCount)
rawError         = estimatedSpacing × errorScale
errorScale       = 2.0
```

Bottom-up correction:

```text
leaf finalError = 0

internal finalError = max(
    rawError,
    maxChildError × 1.05,
    maxChildError + 0.01
)
```

- z0 p001 cũng dùng spacing-based error.
- Validator chỉ yêu cầu parent error strictly greater child error.
- Chỉ synthetic entry root không có representation dùng diagonal bootstrap error để buộc Cesium tải external z0 documents.
- Report nominal cell size, estimated spacing, raw error và final error riêng.

### VRV variants

Pilot sinh hai metadata variants dùng chung PNTS:

`none`:

- Không gắn adaptive VRV.

`frontier-tight`:

- Gắn VRV một lần tại adaptive depth 5.
- Volume derive từ subtree bounds:

```text
fullWidthX  = max(100 m, 1.5 × subtreeWidthX)
fullWidthY  = max(100 m, 1.5 × subtreeWidthY)
fullHeightZ = max(200 m, 2.0 × subtreeHeightZ)
```

- Center dùng subtree center.
- Descendants không lặp VRV.

Chọn `frontier-tight` nếu:

- Local-travel PNTS bytes giảm ít nhất 10% so với `none`.
- Close-detail delay không tăng quá 10%.
- Pixel coverage không giảm quá 2%.

Nếu không đạt cả ba, canonical `tileset.json` dùng `none`.

### Atomicity và resume

- Builder APH mới không sửa `partition_points` của Spatial LOD hiện tại.
- State lưu profile hash, source fingerprints, selected z0, fragments, completed nodes và audit sidecars.
- Resume fail nếu source order/fingerprint, exact z0 contract, sampling policy hoặc thresholds thay đổi.
- Fragment, PNTS, ordinal sidecar và JSON đều atomic-write.
- Entry `tileset.json` publish cuối cùng.
- Disk preflight tính fragments, PNTS, ordinal audit và 20% safety margin.
- `--resume` và `--overwrite` mutually exclusive.

## Viewer implementation

### APH runtime riêng

- Thêm `adaptive-point-hierarchy` vào LOD mode union và dataset resolver.
- Thêm `AdaptivePointHierarchyController`; không gọi runtime mới là Spatial LOD.
- Area tiếp tục chỉ dùng metadata/camera, không thay dataset.
- Preset Overview/Explore/Detail không điều khiển APH.
- APH dùng point target và memory thresholds hiện tại nhưng có SSE policy riêng.

APH SSE ladder:

```text
4, 8, 12, 16, 24, 32, 48, 64
```

Seed:

```text
range <= 250 m:   SSE 4
range <= 500 m:   SSE 8
range <= 1000 m:  SSE 12
range <= 2000 m:  SSE 16
farther:          SSE 32
```

- Settled baseline là SSE 16.
- Pressure coarsens tối đa tới SSE 64.
- Không dùng ladder 64–2048 của Spatial LOD cũ.

### Detail eligibility

```text
detailEligible =
    cameraRange <= 250 m
    OR camera intersects a loaded frontier-tight VRV
```

- Active adaptive depth chỉ là telemetry.
- Không dùng active depth làm controller input.
- Với `none`, eligibility chỉ dựa trên camera range.

### UI, types và metrics

Dùng naming APH nhất quán:

```text
AdaptivePointHierarchyTileId
AdaptivePointHierarchyDepthStats
AdaptivePointHierarchyController
aphActiveDepths
aphSelectedPointsByDepth
aphDetailEligible
aphDetailFirstRequestDelayMs
aphVrvMode
aphPointReconciliationDelta
```

- UI hiển thị “Active Adaptive Depths”.
- Report runtime dùng object `adaptivePointHierarchy`, không dùng `spatialLod`.
- Common A/B metrics vẫn gồm selected points, frame EMA, effective SSE, memory, queues và transferred bytes.
- Spatial LOD parser/telemetry hiện tại giữ nguyên để regression.
- Thêm Vitest devDependency và `npm test`.

## Pilot và acceptance gates

### Pilot selection

- Pilot output riêng `<logical>-adaptive-point-hierarchy-pilot`.
- Dense z0: non-empty z0 có full-point count lớn nhất.
- Sparse z0: z0 gần percentile 25% nhất; tie-break bằng tile ID.
- Benchmark dense và sparse độc lập.
- Không dùng dense→sparse travel hoặc global overview làm pilot gate.

Mỗi z0 chạy:

1. Cold load tại center, range 250 m.
2. Local travel từ 25% tới 75% nominal X trong cùng z0.
3. Settle 15 giây.
4. Close-detail orbit nhỏ quanh target.

Mỗi variant chạy ba lần cold-cache; so median.

### Visual benchmark

Thêm `aphVisual=1`:

- Tắt globe imagery/atmosphere không cần thiết.
- Dùng background cố định.
- Enable `preserveDrawingBuffer` chỉ trong benchmark.
- Capture PNG sau settle 10 giây và 15 giây.
- Đo central 80% ROI:
  - Non-background coverage.
  - Hole ratio trong foreground envelope.
  - Temporal pixel delta.

Visual gates:

```text
APH coverage >= 98% Spatial LOD baseline
APH hole ratio <= baseline + 2 percentage points
APH temporal delta <= baseline × 1.10
```

### Balanced Gate

Cả dense và sparse phải đạt:

- Peak tileset memory giảm ít nhất 15%.
- PNTS transferred bytes giảm ít nhất 15%.
- First-visible không chậm hơn quá 10%.
- Settled frame EMA không tệ hơn quá 10%.
- Local-travel settle time không tệ hơn quá 10%.
- Point reconciliation chính xác.
- Visual gates pass.
- Không có transform offset, permanent hole hoặc severe popping.

Request count là diagnostic, không phải hard gate.

Sau pilot pass:

- Full-build toàn bộ z0 với resume.
- Chạy thêm global cold load, dense→sparse travel và ít nhất ba close-detail regions.
- Chỉ coi APH là candidate thay thế sau khi full gate pass.
- Spatial LOD hiện tại luôn được giữ làm fallback trong V1.

## Tests, documentation và assumptions

- Python tests: exact z0/p001, ordinal ownership, center-line routing, deterministic sampling, quota allocation, sparse/max-depth behavior, bounds, spacing error, VRV và resume mismatch.
- Viewer tests: APH URL/mode, SSE policy, detail eligibility, depth parsing, telemetry, visual benchmark capture và Spatial LOD regression.
- Validation: pipeline tests, APH structural validator, viewer tests, production build và `git diff --check`.
- Tạo skill/documentation riêng `adaptive-point-hierarchy`; Spatial LOD skill chỉ thêm liên kết phân biệt hai kiến trúc.
- Không stage, commit, promote hoặc xóa output cũ nếu chưa được yêu cầu riêng.
- Không có RGB classification v1/v2 trong builder, viewer, report hoặc UI của APH.
