# Overview tuning: mật độ ổn định theo camera và 3–5M visible points

## Tóm tắt

Khi zoom gần, Cesium refine nhiều điểm hơn nên point cloud trở nên quá dày. Overview sẽ dùng point nhỏ khi gần và point lớn khi xa để giảm chồng lấn, kèm slider điều chỉnh toàn bộ point-size profile.

## Thay đổi chính

- Tách helper `applyOverviewRuntimeTuning(...)`; không thay đổi semantics chung của `applyPreset`.
- Riêng Overview:
  - Cache `512MB`, overflow `256MB`.
  - Không dùng `PointCloudShading.attenuation` vì chiều mặc định của Cesium ngược yêu cầu.
  - Dùng `Cesium3DTileStyle.pointSize` theo camera range.
- Tính `cameraRangeRatio = orbitRange / tilesetRadius`:
  - Near `≤0.75`: `1px`
  - Medium `0.75–2.5`: `2px`
  - Far `>2.5`: `3px`
  - Hysteresis 10% để tránh nhấp nháy quanh ngưỡng.
- Chỉ recreate style khi band hoặc slider thực sự thay đổi:

```ts
if (nextBand !== currentBand || nextScale !== currentScale) {
  tileset.style = createOverviewPointSizeStyle(baseSizePx * nextScale);
}
```

- Thêm slider “Point size scale”:
  - `0.5×–2×`, step `0.25×`, mặc định `1×`
  - Kết quả clamp trong `1–6px`
  - Chỉ hoạt động trong Overview
  - Giữ giá trị khi chuyển mode rồi quay lại
- SSE: thử `96 → 80 → 64`; chọn **SSE cao nhất vẫn đạt visual chấp nhận được và khoảng 3–5M visible points**.
- Report thêm:
  - `pointSizePx`
  - `pointSizeBand`
  - `pointSizeScale`
  - `cameraRangeRatio`

## Luồng cập nhật

- Tính lại band sau load, zoom, fly-home và camera restore.
- Pan không đổi point size khi `orbitRange` không đổi.
- Không recreate style mỗi frame nếu camera vẫn trong cùng band.
- Khi rời Overview, reset runtime band/style; Explore và Detail giữ nguyên rendering hiện tại.

## Kiểm thử

- Zoom gần: point giảm về 1px, giảm overlap dù số visible points tăng.
- Zoom xa: point tăng lên 2–3px để tránh cloud trông quá thưa.
- Không flicker khi camera dao động gần ngưỡng.
- Slider cập nhật point size mà không reload tileset hoặc reset camera.
- Chuyển Overview ↔ Explore/Detail không làm style Overview rò sang mode khác.
- Cache 512MB giảm request khi quay lại vùng đã xem so với baseline 256MB.
- Kiểm tra SSE 96, 80, 64 tại ba góc camera; chọn SSE cao nhất đạt visual và 3–5M visible points.
- Build TypeScript thành công và regression đầy đủ ba mode.
- Chạy GitNexus `detect_changes()` trước commit.

## Giả định

- Camera-adaptive point size và slider chỉ áp dụng cho Overview.
- Không rebuild Overview p02.
- Slider điều chỉnh scale của profile, không đặt fixed point size.
- Logic được cô lập vì `applyPreset` có blast radius CRITICAL với cả ba mode.
