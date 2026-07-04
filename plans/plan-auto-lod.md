# Auto LOD với `area-manifest-auto-lod.json`

## Phần 1 — Kiến trúc (read-only)

### Goal

Dùng lại ba dataset đã build:

- Xa: `2404PeruB2-overview-p02`
- Vừa: `2404PeruB2-explore-p10`
- Gần: `2404PeruB2-detail-p100`

Viewer tự chuyển density theo camera qua một logical dataset:

```text
?dataset=peru-b2-globe&lod=auto
```

Không rebuild PNTS. Chỉ tạo metadata mới:

```text
local-storage/tilesets/peru-b2-globe/area-manifest-auto-lod.json
```

### Constraints

- Giữ nguyên `area-manifest.json` cho manual mode.
- Không sửa hoặc copy các PNTS/tileset hiện có.
- Không ghép p02 → p10 → p100 bằng external-tileset hierarchy vì external tileset tile không được có `children` theo [3D Tiles specification](https://github.com/CesiumGS/3d-tiles/tree/main/specification).
- Manual mode hiện tại phải hoạt động như trước.
- Trước khi implementation sửa symbol, phải chạy GitNexus impact analysis; các luồng viewer chính hiện có blast radius HIGH/CRITICAL.

### Design decisions

`area-manifest-auto-lod.json` là contract riêng, self-contained:

```json
{
  "version": 1,
  "dataset": "peru-b2-globe",
  "mode": "auto-lod",
  "coordinateMode": "globe",
  "defaultLevel": "p02",
  "rootTransform": [],
  "levels": {
    "p02": {
      "scope": "global",
      "preset": "low",
      "dataset": "peru-b2-globe/2404PeruB2-overview-p02",
      "status": "ready"
    },
    "p10": {
      "scope": "area",
      "preset": "medium"
    },
    "p100": {
      "scope": "area",
      "preset": "high"
    }
  },
  "thresholds": {
    "p10EnterRatio": 2.5,
    "p10ExitRatio": 3.0,
    "p100EnterRatio": 0.75,
    "p100ExitRatio": 0.9,
    "settleMs": 750,
    "visibleTimeoutMs": 10000,
    "retryMs": 30000
  },
  "areas": []
}
```

Mỗi area chứa `areaId`, `sourceChunkId`, `bbox`, `pointCount`, cùng dataset/status riêng cho p10 và p100.

Quy tắc chuyển LOD:

- Không xác định được area → p02.
- Vào p10 khi range ratio ≤ 2.5; trở lại p02 khi ≥ 3.0.
- Vào p100 khi ≤ 0.75; trở lại p10 khi ≥ 0.9.
- Camera ổn định 750 ms trước khi chuyển.
- Dataset mới chỉ thay dataset cũ sau khi phát sinh `tileVisible`.
- Load lỗi hoặc quá 10 giây: giữ LOD cũ; retry sau 30 giây.
- p10 không sẵn sàng → dùng p02.
- p100 không sẵn sàng → dùng p10.
- Khi đã ở p100, camera vẫn được zoom tiếp; không có level mới.
- Giữ p02 ẩn làm navigation anchor khi đang hiển thị p10/p100.

### Dependency graph

```text
Ba dataset hiện có
        ↓
area-manifest.json + kiểm tra tileset.json thực tế
        ↓
area-manifest-auto-lod.json
        ↓
fetchAutoLodManifest()
        ↓
AutoLodController
        ↓
camera + area + hysteresis
        ↓
p02 ⇄ p10(area) ⇄ p100(area)
```

### Risks

- Chuyển LOD liên tục gần ngưỡng: xử lý bằng hysteresis và settle time.
- Nháy hoặc màn hình trống: dùng staged/double-buffer swap.
- Request cũ hoàn thành muộn: dùng generation token để loại bỏ kết quả stale.
- Tăng memory: chỉ giữ navigation p02 và một focus layer; trim tile cache khi ẩn.
- Manifest lệch với filesystem: generator tính lại `status` từ sự tồn tại của `tileset.json`.
- Nếu auto manifest thiếu hoặc invalid, hiển thị lỗi rõ ràng và hướng dẫn command tạo lại; không âm thầm chuyển sang dataset khác.

## Phần 2 — Execution

### Các bước thực hiện

1. Chạy GitNexus impact cho từng symbol chuẩn bị sửa và dừng cảnh báo nếu risk HIGH/CRITICAL chưa được xác nhận.
2. Tạo generator riêng cho `area-manifest-auto-lod.json`; không sửa generator legacy.
3. Generator đọc `area-manifest.json`, kiểm tra p02/p10/p100 trên filesystem, validate schema rồi ghi file atomically.
4. Thêm types và `fetchAutoLodManifest()`; không thay đổi `resolveDataset()`.
5. Tạo `AutoLodController` dạng state machine độc lập, dễ unit test.
6. Tích hợp opt-in `lod=auto` vào bootstrap và camera update loop.
7. Thực hiện staged swap, timeout, retry, stale-request protection và fallback LOD.
8. Nới minimum camera distance riêng cho auto mode để tiếp tục zoom ở p100.
9. Cập nhật UI/report telemetry; manual controls bị disable trong auto mode.
10. Cập nhật tài liệu build manifest và URL chạy viewer.

Command tạo manifest:

```bash
POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:area:auto-lod:manifest -- 2404PeruB2
```

### File cần sửa

Tạo mới:

- `pipeline/area_auto_lod_manifest.py`
- `pipeline/area-auto-lod-manifest.sh`
- `pipeline/tests/test_area_auto_lod_manifest.py`
- `viewer/src/auto-lod-controller.ts`
- `viewer/src/auto-lod-controller.test.ts`

Chỉnh sửa:

- `package.json`
- `viewer/src/manifest.ts`
- `viewer/src/main.ts`
- `viewer/src/viewer.ts`
- `viewer/src/ui.ts`
- `viewer/src/report.ts`
- `viewer/index.html`
- `viewer/package.json`
- `viewer/package-lock.json`
- `README.md`

Không sửa:

- `pipeline/area_manifest.py`
- `viewer/src/presets.ts`
- Ba dataset PNTS hiện có
- `area-manifest.json`

### Test cần chạy

```bash
python3 pipeline/tests/test_area_auto_lod_manifest.py

POINTCLOUD_PUBLIC_ROOT=peru-b2-globe \
npm run pipeline:area:auto-lod:manifest -- 2404PeruB2

cd viewer
npm test -- --run
npm run build

git diff --check
```

Test cases:

- Manifest có đủ 72 area và đường dẫn p02/p10/p100 hợp lệ.
- Reject duplicate `areaId`/`sourceChunkId`, bbox sai và threshold sai thứ tự.
- Dataset thiếu được đánh `not_built`, không làm generator thất bại.
- p02 → p10 → p100 và chiều ngược lại đúng ngưỡng hysteresis.
- Camera dao động quanh threshold không gây load loop.
- Load timeout/error giữ nguyên dataset đang hiển thị.
- Chuyển area khi request cũ đang chạy không hiển thị sai area.
- p100 vẫn cho phép zoom sâu hơn.
- URL không có `lod=auto` giữ nguyên manual behavior.
- Trước commit chạy `gitnexus_detect_changes(scope="all")`.

### Tiêu chí hoàn thành

- `area-manifest-auto-lod.json` được tạo thành công, self-contained và có 72 area.
- Không rebuild hay chỉnh sửa PNTS.
- `?dataset=peru-b2-globe&lod=auto` tự chuyển p02/p10/p100 theo camera.
- Không có frame trống khi đổi LOD.
- Dataset lỗi hoặc thiếu có fallback xác định.
- Camera tiếp tục zoom sau khi đạt p100.
- Manual mode và `area-manifest.json` không bị ảnh hưởng.
- Unit tests, viewer build, manifest validation và GitNexus change detection đều pass.
