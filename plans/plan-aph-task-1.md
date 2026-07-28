# Adaptive Point Hierarchy V1 — ke hoach 1

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
