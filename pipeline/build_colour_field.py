#!/usr/bin/env python3
"""Build the colour field that evens out a point cloud's acquisition drift.

Drone surveys flown on different days and under different skies leave the point colour
in blocks and stripes: whole flight blocks brighter, bluer or greener than their
neighbours, with straight edges that cut through the forest. Measured on peru-b2-globe
the landscape-scale drift spans 1.05 stops, and it has almost nothing in common with the
satellite basemap underneath (r = -0.10), so it is acquisition, not landscape.

The fix is a low-frequency colour transfer to the basemap, the one layer without flight
blocks. Everything is taken top down, as the highest point per cell, and low-passed in
log light with a Gaussian of `--sigma` metres:

    field    = (basemap low-pass + level) - cloud low-pass      (log gain per channel)
    level    = median(cloud low-pass - basemap low-pass)        (one gain per channel)

Each point keeps its own texture and contrast below that scale and takes the basemap's
variation above it. The cloud's own median level stays where it is, and `level` is also
the per-channel gain that lifts the basemap to that level, so the two meet.

The basemap is desaturated by `--basemap-saturation` before any of this. The satellite's
forest is greener than the cloud's, so a gain alone has to fix the hue with red ×5 against
green ×3 — which turns bare soil and roads saturated orange. Measured on peru-b2-globe the
forest mismatch hardly moves with the saturation (0.182 stops at 0.5, 0.187 at 1), while
the soil's red/green ratio (99th percentile) falls from 2.14 at 1 to 1.23 at 0.6, where
the gain is almost neutral (×3.55 3.52 3.06). The viewer applies the same factor.

Writes `<out>/<dataset>.png` (RGB, log2 gain per channel, `encodeStops` stops either way
mapped onto 0..255, 127.5 = no change) and `<out>/<dataset>.json` (the ENU placement of
the texture, the encoding, the basemap gain, and how it was made).

The basemap is read through the viewer's dev proxy, so `npm run dev` must be running in
viewer/ (port 5177 by default) — that proxy is what makes the localhost MapTiler key
answer. The point tiles come straight from the published tileset.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import json
import math
import os
import struct
import sys
import time
import urllib.request

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    x = x / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def fetch(url: str, cache_dir: str | None, headers: dict[str, str] | None = None) -> bytes:
    path = None
    if cache_dir:
        path = os.path.join(cache_dir, url.split('?')[0].split('://', 1)[1].replace('/', '__').replace(':', '_'))
        if os.path.exists(path):
            with open(path, 'rb') as f:
                return f.read()
    request = urllib.request.Request(url, headers=headers or {})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
            break
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt)
    if path:
        with open(path, 'wb') as f:
            f.write(data)
    return data


def resolve(base: str, rel: str) -> str:
    out: list[str] = []
    for part in (os.path.dirname(base) + '/' + rel).split('/'):
        if part == '..':
            out.pop()
        elif part and part != '.':
            out.append(part)
    return '/'.join(out)


def parse_pnts(buf: bytes) -> tuple[np.ndarray, np.ndarray]:
    magic, _version, _length, ft_json, ft_bin, _bt_json, _bt_bin = struct.unpack('<4sIIIIII', buf[:28])
    if magic != b'pnts':
        raise ValueError('not a pnts tile')
    table = json.loads(buf[28:28 + ft_json])
    body = buf[28 + ft_json:28 + ft_json + ft_bin]
    n = table['POINTS_LENGTH']
    if 'POSITION' in table:
        pos = np.frombuffer(body, np.float32, n * 3, table['POSITION']['byteOffset']).reshape(n, 3).copy()
    else:
        q = np.frombuffer(body, np.uint16, n * 3, table['POSITION_QUANTIZED']['byteOffset']).reshape(n, 3)
        pos = (np.array(table['QUANTIZED_VOLUME_OFFSET']) + q / 65535.0
               * np.array(table['QUANTIZED_VOLUME_SCALE'])).astype(np.float32)
    # Survey-local metres: float32 keeps centimetres, far below the analysis cell.
    if 'RTC_CENTER' in table:
        pos += np.array(table['RTC_CENTER'], np.float32)
    rgb = np.frombuffer(body, np.uint8, n * 3, table['RGB']['byteOffset']).reshape(n, 3).copy()
    return pos, rgb


def load_cloud(tileset_url: str, depth: int, cache: str | None) -> tuple[np.ndarray, np.ndarray, list]:
    """The coarse levels of every root subtree: an even sample of the whole survey."""
    base = tileset_url.rsplit('/', 1)[0] + '/'
    root = json.loads(fetch(tileset_url, cache))
    transform = root['root'].get('transform')
    jobs: list[str] = []
    for child in root['root']['children']:
        sub_uri = child['content']['uri']
        sub = json.loads(fetch(base + sub_uri, cache))

        def walk(node: dict, d: int) -> None:
            uri = node.get('content', {}).get('uri')
            if uri and d <= depth:
                jobs.append(resolve(sub_uri, uri))
            if d < depth:
                for grandchild in node.get('children', []):
                    walk(grandchild, d + 1)

        walk(sub['root'], 0)
    # Parsed as they arrive, so the raw tile bytes never all sit in memory at once.
    with cf.ThreadPoolExecutor(16) as pool:
        positions, colours = zip(*pool.map(lambda rel: parse_pnts(fetch(base + rel, cache)), jobs))
    print(f'  {len(jobs)} tiles, {sum(len(p) for p in positions):,} points', file=sys.stderr)
    return np.concatenate(positions), np.concatenate(colours), transform


def top_down(pos: np.ndarray, rgb: np.ndarray, x0: float, y0: float, cell: float, w: int, h: int):
    """Highest point per cell, row 0 = south. Returns linear RGB and a coverage mask."""
    # int32 cell indices and a per-cell maximum rather than a sort of every point: the
    # sample is ~10 M points and this runs on machines that are short of memory.
    ix = ((pos[:, 0] - x0) / cell).astype(np.int32)
    iy = ((pos[:, 1] - y0) / cell).astype(np.int32)
    flat = np.where((ix >= 0) & (ix < w) & (iy >= 0) & (iy < h), iy * w + ix, -1).astype(np.int32)
    del ix, iy
    keep = flat >= 0
    flat, z, c = flat[keep], pos[keep, 2], rgb[keep]
    top = np.full(h * w, -np.inf, np.float32)
    np.maximum.at(top, flat, z)
    highest = z >= top[flat]
    img = np.zeros((h * w, 3), np.uint8)
    img[flat[highest]] = c[highest]
    mask = np.isfinite(top).reshape(h, w)
    return srgb_to_linear(img.reshape(h, w, 3).astype(np.float32)), mask


def ecef_to_lonlat(x, y, z):
    a = 6378137.0
    f = 1 / 298.257223563
    e2 = f * (2 - f)
    b = a * (1 - f)
    ep2 = (a * a - b * b) / (b * b)
    p = np.hypot(x, y)
    th = np.arctan2(z * a, p * b)
    lat = np.arctan2(z + ep2 * b * np.sin(th) ** 3, p - e2 * a * np.cos(th) ** 3)
    return np.degrees(np.arctan2(y, x)), np.degrees(lat)


def load_basemap(template: str, tile_size: int, zoom: int, transform, x0, y0, cell, w, h, cache, headers):
    """Resample XYZ imagery into the same ENU grid, nearest texel of a zoom finer than the cell."""
    m = np.array(transform, np.float64).reshape(4, 4).T  # 3D Tiles matrices are column-major
    xs = x0 + (np.arange(w) + 0.5) * cell
    ys = y0 + (np.arange(h) + 0.5) * cell
    xx, yy = np.meshgrid(xs, ys)
    ecef = np.stack([xx, yy, np.zeros_like(xx), np.ones_like(xx)], -1) @ m.T
    lon, lat = ecef_to_lonlat(ecef[..., 0], ecef[..., 1], ecef[..., 2])
    n = 2 ** zoom
    fx = (lon + 180) / 360 * n
    r = np.radians(lat)
    fy = (1 - np.log(np.tan(r) + 1 / np.cos(r)) / math.pi) / 2 * n
    tx0, tx1, ty0, ty1 = int(fx.min()), int(fx.max()), int(fy.min()), int(fy.max())
    coords = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]

    def tile(xy):
        data = fetch(template.format(z=zoom, x=xy[0], y=xy[1]), cache, headers)
        return np.array(Image.open(io.BytesIO(data)).convert('RGB'))

    with cf.ThreadPoolExecutor(12) as pool:
        tiles = list(pool.map(tile, coords))
    print(f'  {len(coords)} basemap tiles at z{zoom}', file=sys.stderr)
    mosaic = np.zeros(((ty1 - ty0 + 1) * tile_size, (tx1 - tx0 + 1) * tile_size, 3), np.uint8)
    for (x, y), im in zip(coords, tiles):
        mosaic[(y - ty0) * tile_size:(y - ty0 + 1) * tile_size, (x - tx0) * tile_size:(x - tx0 + 1) * tile_size] = im
    px = ((fx - tx0) * tile_size).astype(np.int64).clip(0, mosaic.shape[1] - 1)
    py = ((fy - ty0) * tile_size).astype(np.int64).clip(0, mosaic.shape[0] - 1)
    return srgb_to_linear(mosaic[py, px].astype(np.float32))


def low_pass(linear: np.ndarray, mask: np.ndarray, sigma_px: float):
    """Masked Gaussian mean of log light, and the mask weight it was built from."""
    log = np.log(linear + 1e-3)
    weight = gaussian_filter(mask.astype(np.float32), sigma_px)
    out = np.stack([gaussian_filter(np.where(mask, log[..., k], 0).astype(np.float32), sigma_px) for k in range(3)], -1)
    return out / np.maximum(weight, 1e-6)[..., None], weight


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dataset', default='peru-b2-globe')
    ap.add_argument('--tiles-base', default='https://d3ikc68ccylu0h.cloudfront.net/pointcloud-tiles')
    ap.add_argument('--depth', type=int, default=2, help='subtree depth sampled per root tile')
    ap.add_argument('--cell', type=float, default=8.0, help='analysis grid in metres')
    ap.add_argument('--texel', type=float, default=16.0, help='output texture texel in metres')
    ap.add_argument('--sigma', type=float, default=100.0, help='low-pass Gaussian sigma in metres')
    ap.add_argument('--encode-stops', type=float, default=3.0)
    ap.add_argument('--basemap', default='http://localhost:5177/maptiler/maps/satellite-v4/{z}/{x}/{y}.jpg')
    ap.add_argument('--basemap-tile', type=int, default=512)
    ap.add_argument('--basemap-zoom', type=int, default=15)
    ap.add_argument('--basemap-saturation', type=float, default=0.6,
                    help='saturation the basemap is matched at (1 = raw); see the module docstring')
    ap.add_argument('--env', default=os.path.join(os.path.dirname(__file__), '..', 'viewer', '.env'),
                    help='file holding VITE_MAPTILER_API_KEY_LOCAL (the key is never printed)')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'viewer', 'public', 'colour-field'))
    ap.add_argument('--cache', default=None, help='optional download cache directory')
    args = ap.parse_args()

    key = ''
    with open(args.env, encoding='utf-8') as f:
        for line in f:
            if line.startswith('VITE_MAPTILER_API_KEY_LOCAL='):
                key = line.split('=', 1)[1].strip().strip('"')
    if not key:
        sys.exit('no VITE_MAPTILER_API_KEY_LOCAL in ' + args.env)
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    tileset = f'{args.tiles_base}/{args.dataset}/{args.dataset}-adaptive-point-hierarchy/tileset.json'
    print('point cloud', file=sys.stderr)
    pos, rgb, transform = load_cloud(tileset, args.depth, args.cache)
    x0, y0 = math.floor(pos[:, 0].min() / args.texel) * args.texel, math.floor(pos[:, 1].min() / args.texel) * args.texel
    x1, y1 = math.ceil(pos[:, 0].max() / args.texel) * args.texel, math.ceil(pos[:, 1].max() / args.texel) * args.texel
    w, h = int(round((x1 - x0) / args.cell)), int(round((y1 - y0) / args.cell))
    cloud, mask = top_down(pos, rgb, x0, y0, args.cell, w, h)
    del pos, rgb

    print('basemap', file=sys.stderr)
    template = args.basemap + ('&' if '?' in args.basemap else '?') + 'key=' + key
    basemap = load_basemap(template, args.basemap_tile, args.basemap_zoom, transform, x0, y0, args.cell, w, h,
                           args.cache, {'Origin': 'http://localhost:5177'})

    luma = (basemap @ LUMA)[..., None]
    basemap = np.maximum(luma + (basemap - luma) * args.basemap_saturation, 0)
    del luma

    sigma_px = args.sigma / args.cell
    cloud_lp, weight = low_pass(cloud, mask, sigma_px)
    map_lp, _ = low_pass(basemap, np.ones_like(mask), sigma_px)
    inside = mask & (weight > 0.5)
    level = np.median((cloud_lp - map_lp)[inside], 0)
    field = (map_lp + level) - cloud_lp
    # Fade to no change where the cloud thins out, so the gain never jumps at the edge of
    # the data: the fringe points take a blend, the empty river and the outside take 1.
    fade = np.clip((weight - 0.15) / 0.35, 0, 1)[..., None]
    field = np.where(np.isfinite(field), field, 0) * fade
    stops = field / np.log(2)
    before = ((cloud_lp - map_lp - level)[inside] @ LUMA) / np.log(2)
    print(f'landscape-scale mismatch before: median {np.median(np.abs(before)):.3f} stops, '
          f'95 % {np.percentile(np.abs(before), 95):.3f} stops', file=sys.stderr)
    print(f'field luma gain 5/50/95 %: {np.round(np.percentile(stops[inside] @ LUMA, [5, 50, 95]), 2)} stops',
          file=sys.stderr)

    # Down to the output texel by area average; the field is smooth well below it.
    k = int(round(args.texel / args.cell))
    th, tw = h // k, w // k
    coarse = stops[:th * k, :tw * k].reshape(th, k, tw, k, 3).mean((1, 3))
    clipped = np.abs(coarse) > args.encode_stops
    code = np.clip(np.round((coarse / args.encode_stops) * 127.5 + 127.5), 0, 255).astype(np.uint8)
    # PNG rows run top down, the ENU grid bottom up: flip so row 0 is north, like an image.
    Image.fromarray(code[::-1]).save(os.path.join(args.out, f'{args.dataset}.png'), optimize=True)
    gain = np.exp(level)
    meta = {
        'dataset': args.dataset,
        'frame': 'tileset-enu',
        'origin': [x0, y0],
        'size': [tw * args.texel, th * args.texel],
        'texels': [tw, th],
        'rowOrder': 'north-first',
        'encoding': {'kind': 'log2-gain-rgb8', 'stops': args.encode_stops, 'zero': 127.5},
        'basemapGain': [round(float(g), 4) for g in gain],
        'basemapSaturation': args.basemap_saturation,
        'made': {
            'date': time.strftime('%Y-%m-%d'), 'sigmaM': args.sigma, 'cellM': args.cell, 'texelM': args.texel,
            'depth': args.depth, 'basemap': args.basemap.split('?')[0].replace('http://localhost:5177/maptiler', 'maptiler'),
            'basemapZoom': args.basemap_zoom, 'clippedTexels': int(clipped.any(-1).sum()),
            'mismatchBeforeStops': {'median': round(float(np.median(np.abs(before))), 3),
                                    'p95': round(float(np.percentile(np.abs(before), 95)), 3)},
        },
    }
    with open(os.path.join(args.out, f'{args.dataset}.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(meta, f, indent=2)
        f.write('\n')
    print(f'wrote {tw}x{th} field, basemap gain {meta["basemapGain"]}', file=sys.stderr)


if __name__ == '__main__':
    main()
