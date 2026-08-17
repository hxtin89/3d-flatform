# Adaptive Point Hierarchy V1 — task 2

## Quy tắc chung

- Tên kiến trúc: **Adaptive Point Hierarchy (APH)**.
- APH là mode/output mới, không thay đổi `?lod=spatial-lod`.
- Không đưa RGB classification v1/v2 trở lại.
- Giữ nguyên thay đổi chưa commit của người dùng; không stage hoặc commit.
- Trước khi sửa symbol hiện có, chạy GitNexus impact và cảnh báo nếu HIGH/CRITICAL.
- Mỗi task phải chạy test riêng và `git diff --check`.

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