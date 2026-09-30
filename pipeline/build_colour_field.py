#!/usr/bin/env python3
"""Build the colour fields that even out a survey's acquisition drift and match the point
cloud, the drone orthophotos and the basemap to one another at landscape scale.

Drone surveys flown on different days and under different skies leave the colour in blocks
and stripes: whole flight blocks brighter, bluer or greener than their neighbours, with
straight edges that cut through the forest. The satellite basemap is the one layer without
them (measured over peru-b2-globe during the exploration: the cloud's drift spans about
1.05 stops and correlates r = -0.10 with the satellite's, so it is acquisition, not
landscape). So the satellite is the reference, and each drone layer gets a gain texture:

    d      = log(layer) - log(basemap)              per cell, top down (the cloud: highest point)
    level  = median(d over the cloud)               one gain per channel, the cloud's own level
    field  = level - smooth(d)                      log gain per channel

The orthophoto is composited INTO the satellite's own tiles in the viewer, so it goes
through the basemap's grade (lift, desaturation, per-zoom gain) like the satellite does.
Its field therefore takes it to the raw satellite at the reference zoom instead (no level,
no desaturation): `ortho_gain = -offset - smooth(d - offset)`, with `offset` the ortho's
median brightness over the satellite (about 2.9 stops for secretForest) stored as three
numbers (`ortho.offsetStops`) and only the local part in the texture, where the soft knee
applies. The viewer scales
it by the tile zoom's colour ratio, and the grade then lands it where the cloud lands.

`smooth` is a masked MEDIAN over a footprint, not a Gaussian. A Gaussian field matches the
inside of each flight block but keeps the jump at a hard block border for any sigma (it
turns a step of height h into a +/- h/2 halo); a median keeps the border where the step is,
so the correction removes it, and it ignores clearings and bare ground smaller than about
half the footprint that the satellite shows and the drone did not see (or saw green). What
remains of those is limited by a soft knee (`--knee-stops`). The cloud uses a disc; the
orthophoto's flight lines run east-west, so its footprint is a long east-west bar that is
narrow north-south (`--ortho-footprint`), which follows the stripes instead of averaging
them away.

`level` is also the per-channel gain that lifts the basemap to the cloud's level, so the two
meet; the basemap is desaturated by `--basemap-saturation` first, because the satellite's
forest is greener than the cloud's and a gain alone would fix that hue by pushing bare soil
and roads orange. MapTiler's satellite changes colour between zoom levels, so the gain is
measured per zoom (`basemapGainByZoom`) by sampling tiles of every level over the survey.

Writes into `--out` (all files swapped in together at the end of a successful run):
  <dataset>.png                 cloud field, RGB, log2 gain as (code - 128) / 127 * stops, north first
  <dataset>.ortho-<i>.png       per ortho source: gain into raw satellite space, RGB as above
  <dataset>.ortho-<i>-feather.png  per ortho source: feather weight, greyscale 0..255
  <dataset>.json                placement of all of them in the tileset's ENU frame, the encoding,
                                the basemap gains, and per ortho source its base gain, per-zoom
                                trim and a 2-bit tile-kind grid (none / edge / full / full under
                                the ground patch) for the zooms the viewer composites at

The basemap and the orthos are read through the viewer's dev proxy, so `npm run dev` must be
running in viewer/ (port 5177 by default): that proxy is what makes the localhost MapTiler
key answer. The point tiles come straight from the published tileset.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import hashlib
import io
import json
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter, median_filter

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
LN2 = math.log(2)
WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563


# ---------------------------------------------------------------------------------------------
# I/O

def read_dotenv_value(path: str, name: str) -> str:
    """The value of `name` in a dotenv file, parsed the way dotenv does (quotes, comments)."""
    with open(path, encoding='utf-8') as f:
        for line in f:
            if not line.startswith(name + '='):
                continue
            raw = line.split('=', 1)[1].strip()
            if raw[:1] in ('"', "'"):
                end = raw.find(raw[0], 1)
                return raw[1:end] if end > 0 else raw[1:]
            return raw.split('#', 1)[0].strip()
    return ''


def fetch(url: str, cache_dir: str | None, headers: dict[str, str] | None = None,
          missing_ok: tuple[int, ...] = ()) -> bytes | None:
    """GET with a disk cache. Statuses in `missing_ok` return None (and are cached as such).
    Errors never carry the query string, which holds the API key."""
    path = None
    if cache_dir:
        name = url.split('?')[0].split('://', 1)[1].replace('/', '__').replace(':', '_')
        path = os.path.join(cache_dir, name)
        if os.path.exists(path):
            with open(path, 'rb') as f:
                data = f.read()
            return None if data == b'\0MISSING' else data
    request = urllib.request.Request(url, headers=headers or {})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
            break
        except urllib.error.HTTPError as e:
            if e.code in missing_ok:
                data = None
                break
            if attempt == 3:
                raise RuntimeError(f'fetch failed: {url.split("?")[0]}: HTTP {e.code}') from None
        except Exception as e:
            if attempt == 3:
                raise RuntimeError(f'fetch failed: {url.split("?")[0]}: {type(e).__name__}') from None
        time.sleep(1 + attempt)
    if path:
        with open(path, 'wb') as f:
            f.write(b'\0MISSING' if data is None else data)
    return data


def resolve(base: str, rel: str) -> str:
    out: list[str] = []
    for part in (os.path.dirname(base) + '/' + rel).split('/'):
        if part == '..':
            out.pop()
        elif part and part != '.':
            out.append(part)
    return '/'.join(out)


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    x = x.astype(np.float32) / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


# ---------------------------------------------------------------------------------------------
# Point cloud

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


def load_cloud(tileset_url: str, depth: int, cache: str | None):
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


def top_down(pos, rgb, x0, y0, cell, w, h):
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
    return srgb_to_linear(img.reshape(h, w, 3)), mask


# ---------------------------------------------------------------------------------------------
# Geodesy

def lonlat_to_ecef(lon_deg, lat_deg):
    e2 = WGS84_F * (2 - WGS84_F)
    lon, lat = np.radians(lon_deg), np.radians(lat_deg)
    n = WGS84_A / np.sqrt(1 - e2 * np.sin(lat) ** 2)
    return n * np.cos(lat) * np.cos(lon), n * np.cos(lat) * np.sin(lon), n * (1 - e2) * np.sin(lat)


def ecef_to_lonlat(x, y, z):
    e2 = WGS84_F * (2 - WGS84_F)
    b = WGS84_A * (1 - WGS84_F)
    ep2 = (WGS84_A ** 2 - b ** 2) / b ** 2
    p = np.hypot(x, y)
    th = np.arctan2(z * WGS84_A, p * b)
    lat = np.arctan2(z + ep2 * b * np.sin(th) ** 3, p - e2 * WGS84_A * np.cos(th) ** 3)
    return np.degrees(np.arctan2(y, x)), np.degrees(lat)


class Grid:
    """An ENU raster in the tileset's frame (3D Tiles matrix, column-major), row 0 = south."""

    def __init__(self, transform, x0: float, y0: float, cell: float, w: int, h: int):
        self.m = np.array(transform, np.float64).reshape(4, 4).T
        self.m_inv = np.linalg.inv(self.m)
        self.x0, self.y0, self.cell, self.w, self.h = x0, y0, cell, w, h

    def enu_of_lonlat(self, lon, lat):
        x, y, z = lonlat_to_ecef(lon, lat)
        v = np.stack([x, y, z, np.ones_like(x)], -1) @ self.m_inv.T
        return v[..., 0], v[..., 1]

    def lonlat_of_cells(self):
        xs = self.x0 + (np.arange(self.w) + 0.5) * self.cell
        ys = self.y0 + (np.arange(self.h) + 0.5) * self.cell
        xx, yy = np.meshgrid(xs, ys)
        v = np.stack([xx, yy, np.zeros_like(xx), np.ones_like(xx)], -1) @ self.m.T
        return ecef_to_lonlat(v[..., 0], v[..., 1], v[..., 2])


def mercator_tile_range(lon, lat, zoom):
    n = 2 ** zoom
    fx = (np.asarray(lon) + 180) / 360 * n
    r = np.radians(np.asarray(lat))
    fy = (1 - np.log(np.tan(r) + 1 / np.cos(r)) / math.pi) / 2 * n
    return int(np.floor(fx.min())), int(np.floor(fx.max())), int(np.floor(fy.min())), int(np.floor(fy.max()))


def tile_pixel_lonlat(zoom, tx, ty, size, pix):
    """Lon/lat of the centres of the pixels `pix` (in both axes) of an XYZ tile."""
    n = 2 ** zoom
    idx = (pix + 0.5) / size
    fx, fy = np.meshgrid(tx + idx, ty + idx)
    lon = fx / n * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * fy / n))))
    return lon, lat


class CellAccumulator:
    """Area average of imagery into grid cells, tile by tile, so memory stays at grid size."""

    def __init__(self, grid: Grid, channels: int):
        self.grid = grid
        self.sum = np.zeros((grid.h * grid.w, channels), np.float64)
        self.count = np.zeros(grid.h * grid.w, np.float64)

    def add_tile(self, zoom, tx, ty, pixels: np.ndarray, weight: np.ndarray | None = None):
        size = pixels.shape[0]
        # Sample at about the cell size or finer; every pixel only where tiles are coarse.
        mpp = 40075016.7 * math.cos(math.radians(13)) / (2 ** zoom * size)
        step = max(1, int(self.grid.cell / (2 * mpp)))
        pix = np.arange(step // 2, size, step)
        lon, lat = tile_pixel_lonlat(zoom, tx, ty, size, pix)
        ex, ey = self.grid.enu_of_lonlat(lon, lat)
        ix = np.floor((ex - self.grid.x0) / self.grid.cell).astype(np.int64)
        iy = np.floor((ey - self.grid.y0) / self.grid.cell).astype(np.int64)
        ok = (ix >= 0) & (ix < self.grid.w) & (iy >= 0) & (iy < self.grid.h)
        sub = pixels[np.ix_(pix, pix)]
        wts = np.ones(ix.shape, np.float64) if weight is None else weight[np.ix_(pix, pix)].astype(np.float64)
        ok &= wts > 0
        flat = (iy * self.grid.w + ix)[ok]
        vals = sub[ok].astype(np.float64)
        wv = wts[ok]
        self.count += np.bincount(flat, weights=wv, minlength=self.count.size)
        for c in range(self.sum.shape[1]):
            self.sum[:, c] += np.bincount(flat, weights=vals[:, c] * wv, minlength=self.count.size)

    def mean(self):
        m = self.sum / np.maximum(self.count, 1e-9)[:, None]
        return m.reshape(self.grid.h, self.grid.w, -1).astype(np.float32), self.count.reshape(self.grid.h, self.grid.w)


def decode_tile(data: bytes | None, rgba: bool):
    if not data or len(data) < 100:
        return None
    im = Image.open(io.BytesIO(data))
    if rgba:
        arr = np.asarray(im.convert('RGBA'))
        return srgb_to_linear(arr[..., :3]), (arr[..., 3] >= 128).astype(np.float32)
    return srgb_to_linear(np.asarray(im.convert('RGB'))), None


def sample_xyz(grid: Grid, template: str, zoom: int, tile_size: int, cache, headers, *, rgba=False,
               bounds=None, tiles=None, label=''):
    """Area-average an XYZ source into the grid. `bounds` [W,S,E,N] limits the tile range;
    `tiles` gives an explicit list instead. Missing tiles (HTTP 400/404) are skipped."""
    if tiles is None:
        if bounds is not None:
            lon = [bounds[0], bounds[2]]
            lat = [bounds[1], bounds[3]]
        else:
            lon, lat = grid.lonlat_of_cells()
            lon, lat = [lon.min(), lon.max()], [lat.min(), lat.max()]
        tx0, tx1, ty0, ty1 = mercator_tile_range(lon, lat, zoom)
        tiles = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
    acc = CellAccumulator(grid, 3)
    got = 0

    def job(xy):
        return xy, fetch(template.format(z=zoom, x=xy[0], y=xy[1]), cache, headers, missing_ok=(400, 404))

    with cf.ThreadPoolExecutor(12) as pool:
        for (x, y), data in pool.map(job, tiles):
            decoded = decode_tile(data, rgba)
            if decoded is None:
                continue
            rgb, alpha = decoded
            if alpha is not None and not alpha.any():
                continue
            acc.add_tile(zoom, x, y, rgb, alpha)
            got += 1
    print(f'  {label} z{zoom}: {got}/{len(tiles)} tiles', file=sys.stderr)
    return acc.mean()


# ---------------------------------------------------------------------------------------------
# Fields

def masked_gaussian_log(log_img, mask, sigma_px):
    w = gaussian_filter(mask.astype(np.float32), sigma_px)
    out = np.stack([gaussian_filter(np.where(mask, log_img[..., k], 0).astype(np.float32), sigma_px)
                    for k in range(log_img.shape[-1])], -1)
    return out / np.maximum(w, 1e-6)[..., None], w


def masked_median(d, mask, footprint, fill_sigma_px):
    """Median of d over `footprint`, counting only masked cells as well as a median filter
    can: unmasked cells are filled with a wide masked Gaussian of d first, which sits at the
    local level and so does not pull the median."""
    fill, _ = masked_gaussian_log(d, mask, fill_sigma_px)
    filled = np.where(mask[..., None], d, fill)
    return np.stack([median_filter(filled[..., k], footprint=footprint, mode='nearest')
                     for k in range(d.shape[-1])], -1)


def disc(radius_px: float):
    r = int(math.ceil(radius_px))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return (xx * xx + yy * yy) <= radius_px * radius_px


def bar(length_px: float, height_px: float):
    """An east-west bar: long in x (columns), short in y (rows)."""
    return np.ones((max(1, int(round(height_px)) | 1), max(1, int(round(length_px)) | 1)), bool)


def soft_knee(field_ln, knee_stops):
    k = knee_stops * LN2
    return k * np.tanh(field_ln / k)


def spread_to_outside(field, mask, fade_px):
    """Outside the mask take the nearest inside value (so bilinear sampling at the edge of the
    data does not pull toward zero), fading to no change over `fade_px` cells."""
    dist, (iy, ix) = distance_transform_edt(~mask, return_indices=True)
    spread = field[iy, ix]
    fade = np.clip(1 - (dist - 1) / max(fade_px, 1e-6), 0, 1)[..., None]
    return np.where(mask[..., None], field, spread * fade)


def seam_energy(r_ln, mask, sigma_px=2.0):
    """Mean gradient of a log-colour residual's luma after a small blur (2 texels, 32 m), in
    stops per texel, over the interior: canopy texture averages out at that scale, straight
    block borders stay as ridges, and landscape largely cancels in layer - basemap."""
    lum = (r_ln / LN2) @ LUMA
    lum = gaussian_filter(np.where(mask, lum, 0), sigma_px) / np.maximum(gaussian_filter(mask.astype(np.float32), sigma_px), 1e-6)
    gy, gx = np.gradient(lum)
    interior = mask & (distance_transform_edt(mask) > 3)
    return float(np.mean(np.hypot(gx, gy)[interior]))


def landscape_residual(r_ln, mask, sigma_px):
    lp, w = masked_gaussian_log(r_ln, mask, sigma_px)
    lum = (lp[mask & (w > 0.5)] / LN2) @ LUMA
    return {'median': round(float(np.median(np.abs(lum))), 3), 'p95': round(float(np.percentile(np.abs(lum), 95)), 3)}


def encode_field(stops, stops_range):
    """(code - 128) / 127 * range stops; code 128 is exactly no change."""
    clipped = int((np.abs(stops) > stops_range).any(-1).sum())
    code = np.clip(np.round(stops / stops_range * 127 + 128), 1, 255).astype(np.uint8)
    return code, clipped


PENDING: list[tuple[str, str]] = []


def write_png(path, array):
    """Write next to `path` and swap it in with commit_outputs(), so a run that stops halfway
    never leaves a PNG from one build beside a JSON from another."""
    buf = io.BytesIO()
    Image.fromarray(array).save(buf, format='PNG', optimize=True)
    data = buf.getvalue()
    with open(path + '.tmp', 'wb') as f:
        f.write(data)
    PENDING.append((path + '.tmp', path))
    return hashlib.sha1(data).hexdigest()[:12], len(data)


def write_json(path, meta):
    with open(path + '.tmp', 'w', encoding='utf-8', newline='\n') as f:
        json.dump(meta, f, indent=2)
        f.write('\n')
    PENDING.append((path + '.tmp', path))


def commit_outputs():
    for tmp, final in PENDING:
        os.replace(tmp, final)
    PENDING.clear()


def pack_kinds(kinds: np.ndarray) -> str:
    """2 bits per tile, row-major, 4 tiles per byte from the low bits up, base64."""
    flat = kinds.ravel().astype(np.uint8)
    flat = np.concatenate([flat, np.zeros((-len(flat)) % 4, np.uint8)])
    q = flat.reshape(-1, 4)
    packed = (q[:, 0] | (q[:, 1] << 2) | (q[:, 2] << 4) | (q[:, 3] << 6)).astype(np.uint8)
    return base64.b64encode(packed.tobytes()).decode('ascii')


def tile_kinds(grid, feather8, under8, bounds, zooms, erode_m=16.0):
    """Per XYZ zoom, a kind for every tile of the server's range for `bounds`:
    0 none (no feather anywhere in the tile, dilated a cell), 1 edge, 2 full (feather 1 over
    the whole tile dilated by `erode_m` and a cell), 3 full and under the survey's ground patch."""
    er = int(math.ceil(erode_m / grid.cell))
    levels = {}
    for z in zooms:
        tx0, tx1, ty0, ty1 = mercator_tile_range([bounds[0], bounds[2]], [bounds[1], bounds[3]], z)
        n = 2 ** z
        lon_e = np.arange(tx0, tx1 + 2) / n * 360 - 180
        lat_e = np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * np.arange(ty0, ty1 + 2) / n))))
        LON, LAT = np.meshgrid(lon_e, lat_e)
        EX, EY = grid.enu_of_lonlat(LON, LAT)
        CX = (EX - grid.x0) / grid.cell
        CY = (EY - grid.y0) / grid.cell
        H, W = ty1 - ty0 + 1, tx1 - tx0 + 1
        kinds = np.zeros((H, W), np.uint8)
        for j in range(H):
            for i in range(W):
                xs = CX[j:j + 2, i:i + 2]
                ys = CY[j:j + 2, i:i + 2]
                c0, c1 = int(np.floor(xs.min())), int(np.ceil(xs.max()))
                r0, r1 = int(np.floor(ys.min())), int(np.ceil(ys.max()))
                d0, d1 = max(c0 - 1, 0), min(c1 + 1, grid.w)
                e0, e1 = max(r0 - 1, 0), min(r1 + 1, grid.h)
                if d0 >= d1 or e0 >= e1:
                    continue
                if feather8[e0:e1, d0:d1].max() <= 0:
                    continue
                # "full" must hold over the whole tile plus the reach of the 16 m field texels
                # the viewer samples bilinearly, so the box is dilated, never eroded.
                i0, i1 = max(c0 - er - 1, 0), min(c1 + er + 1, grid.w)
                j0, j1 = max(r0 - er - 1, 0), min(r1 + er + 1, grid.h)
                if feather8[j0:j1, i0:i1].min() >= 0.999:
                    kinds[j, i] = 3 if under8[j0:j1, i0:i1].all() else 2
                else:
                    kinds[j, i] = 1
        levels[str(z)] = {'x0': tx0, 'y0': ty0, 'w': W, 'h': H, 'bits': pack_kinds(kinds),
                          'counts': [int((kinds == v).sum()) for v in range(4)]}
    return levels


def block_mean(img, mask, k):
    """Mean over k x k blocks of the masked cells; the block counts as covered if any cell is."""
    h, w = img.shape[0] // k * k, img.shape[1] // k * k
    m = mask[:h, :w].reshape(h // k, k, w // k, k).astype(np.float32)
    s = (img[:h, :w] * mask[:h, :w, None]).reshape(h // k, k, w // k, k, -1).sum((1, 3))
    c = m.sum((1, 3))
    return s / np.maximum(c, 1e-9)[..., None], c > 0


# ---------------------------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dataset', default='peru-b2-globe')
    ap.add_argument('--tiles-base', default='https://d3ikc68ccylu0h.cloudfront.net/pointcloud-tiles')
    ap.add_argument('--depth', type=int, default=2, help='subtree depth sampled per root tile')
    ap.add_argument('--cell', type=float, default=8.0, help='analysis grid in metres')
    ap.add_argument('--texel', type=float, default=16.0, help='output texel in metres (a whole multiple of --cell)')
    ap.add_argument('--method', choices=['median', 'gaussian'], default='median')
    ap.add_argument('--radius', type=float, default=120.0, help='median disc radius in metres (cloud)')
    ap.add_argument('--sigma', type=float, default=100.0, help='Gaussian sigma in metres (--method gaussian)')
    ap.add_argument('--knee-stops', type=float, default=1.25, help='soft limit on the gain, in stops')
    ap.add_argument('--encode-stops', type=float, default=3.0)
    ap.add_argument('--basemap', default='http://localhost:5177/maptiler/maps/satellite-v4/{z}/{x}/{y}.jpg')
    ap.add_argument('--basemap-tile', type=int, default=512)
    ap.add_argument('--basemap-zoom', type=int, default=15, help='zoom the spatial reference is taken at')
    ap.add_argument('--zoom-ladder', default='12-19', help='zooms whose colour is measured against --basemap-zoom')
    ap.add_argument('--ladder-tiles', type=int, default=24, help='tiles sampled per ladder zoom')
    ap.add_argument('--basemap-saturation', type=float, default=0.6,
                    help='saturation the basemap is matched at (1 = raw); see the module docstring')
    ap.add_argument('--ortho', action='append', default=[],
                    help='MapTiler tileset id of a drone ortho, repeatable; later ones draw on top')
    ap.add_argument('--ortho-zoom', type=int, default=15, help='zoom the ortho is analysed at (4.7 m pixels at 15)')
    ap.add_argument('--ortho-min-zoom', type=int, default=15, help='lowest basemap zoom the viewer composites the ortho into')
    ap.add_argument('--basemap-max-zoom', type=int, default=19, help='config design.basemapMaxZoom')
    ap.add_argument('--ortho-ladder-tiles', type=int, default=12, help='tiles sampled per zoom for the ortho trim')
    ap.add_argument('--ortho-footprint', default='480x32', help='median bar for the ortho, metres east-west x north-south')
    ap.add_argument('--ortho-feather', default='8,60', help='feather ramp inside the ortho edge, metres from,to')
    ap.add_argument('--env', default=os.path.join(os.path.dirname(__file__), '..', 'viewer', '.env'),
                    help='file holding VITE_MAPTILER_API_KEY_LOCAL (the key is never printed)')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'viewer', 'public', 'colour-field'))
    ap.add_argument('--preview', default=None, help='directory for before/after preview images')
    ap.add_argument('--cache', default=None, help='optional download cache directory')
    args = ap.parse_args()

    k = args.texel / args.cell
    if k < 1 or abs(k - round(k)) > 1e-9:
        sys.exit(f'--texel ({args.texel}) must be a whole multiple of --cell ({args.cell})')
    k = int(round(k))
    texel = k * args.cell
    key = read_dotenv_value(args.env, 'VITE_MAPTILER_API_KEY_LOCAL')
    if not key:
        sys.exit('no VITE_MAPTILER_API_KEY_LOCAL in ' + args.env)
    qkey = urllib.parse.quote(key, safe='')
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    headers = {'Origin': 'http://localhost:5177'}
    proxy_base = args.basemap.split('/maps/')[0]

    tileset = f'{args.tiles_base}/{args.dataset}/{args.dataset}-adaptive-point-hierarchy/tileset.json'
    print('point cloud', file=sys.stderr)
    pos, rgb, transform = load_cloud(tileset, args.depth, args.cache)
    cx0 = math.floor(pos[:, 0].min() / texel) * texel
    cy0 = math.floor(pos[:, 1].min() / texel) * texel
    cx1 = math.ceil(pos[:, 0].max() / texel) * texel
    cy1 = math.ceil(pos[:, 1].max() / texel) * texel

    # Ortho sources and the union extent everything is analysed on.
    orthos = []
    for oid in args.ortho:
        tj = json.loads(fetch(f'{proxy_base}/tiles/{oid}/tiles.json?key={qkey}', args.cache, headers))
        orthos.append({'id': oid, 'name': tj.get('name', oid), 'bounds': tj['bounds'],
                       'minzoom': tj['minzoom'], 'maxzoom': tj['maxzoom'], 'format': tj.get('format', 'webp')})
    x0, y0, x1, y1 = cx0, cy0, cx1, cy1
    probe = Grid(transform, 0, 0, 1, 1, 1)
    for o in orthos:
        w_, s_, e_, n_ = o['bounds']
        ex, ey = probe.enu_of_lonlat(np.array([w_, e_, w_, e_]), np.array([s_, s_, n_, n_]))
        x0, y0 = min(x0, math.floor(ex.min() / texel) * texel), min(y0, math.floor(ey.min() / texel) * texel)
        x1, y1 = max(x1, math.ceil(ex.max() / texel) * texel), max(y1, math.ceil(ey.max() / texel) * texel)
    w, h = int(round((x1 - x0) / args.cell)), int(round((y1 - y0) / args.cell))
    grid = Grid(transform, x0, y0, args.cell, w, h)
    cloud, cmask = top_down(pos, rgb, x0, y0, args.cell, w, h)
    del pos, rgb

    print('basemap', file=sys.stderr)
    template = args.basemap + ('&' if '?' in args.basemap else '?') + 'key=' + qkey
    basemap, bcount = sample_xyz(grid, template, args.basemap_zoom, args.basemap_tile, args.cache, headers,
                                 label='satellite')
    have_map = bcount > 0
    # The raw satellite is the ortho's target (see the docstring); the cloud's is desaturated.
    b16raw, _ = block_mean(basemap, have_map, k) if args.ortho else (None, None)
    luma = (basemap @ LUMA)[..., None]
    basemap = np.maximum(luma + (basemap - luma) * args.basemap_saturation, 0)
    del luma

    # --- the cloud field, at the output texel
    c16, m16 = block_mean(cloud, cmask & have_map, k)
    b16, _ = block_mean(basemap, have_map, k)
    d = np.log(c16 + 1e-3) - np.log(b16 + 1e-3)
    level = np.median(d[m16], 0)
    if args.method == 'median':
        smooth = masked_median(d, m16, disc(args.radius / texel), fill_sigma_px=2 * args.radius / texel)
    else:
        smooth, _ = masked_gaussian_log(d, m16, args.sigma / texel)
    field = soft_knee(level - smooth, args.knee_stops)
    field = spread_to_outside(field, m16, fade_px=3)
    stats = {
        'landscapeResidualStops': {'before': landscape_residual(d - level, m16, 100 / texel),
                                   'after': landscape_residual(d - level + field, m16, 100 / texel)},
        'seamStopsPerTexel': {'before': round(seam_energy(d - level, m16), 4),
                              'after': round(seam_energy(d - level + field, m16), 4)},
    }
    fl = (field[m16] / LN2) @ LUMA
    stats['fieldLumaStops'] = {'p1': round(float(np.percentile(fl, 1)), 2), 'p50': round(float(np.median(fl)), 2),
                               'p99': round(float(np.percentile(fl, 99)), 2)}
    print(f'cloud: {json.dumps(stats)}', file=sys.stderr)

    # crop the cloud field back to the cloud's own box
    ox0, oy0 = int(round((cx0 - x0) / texel)), int(round((cy0 - y0) / texel))
    tw, th = int(round((cx1 - cx0) / texel)), int(round((cy1 - cy0) / texel))
    cfield = field[oy0:oy0 + th, ox0:ox0 + tw] / LN2
    code, clipped = encode_field(cfield, args.encode_stops)
    code = code[::-1]  # north first, like an image
    png_hash, png_bytes = write_png(os.path.join(args.out, f'{args.dataset}.png'), code)
    for stale in (f'{args.dataset}.ortho.png',):  # the single-texture layout of the first build
        if os.path.exists(os.path.join(args.out, stale)):
            os.remove(os.path.join(args.out, stale))
    stats['clippedTexels'] = clipped

    # --- per-zoom basemap colour, measured against the reference zoom over the cloud
    gain = np.exp(level)
    by_zoom = {str(args.basemap_zoom): [round(float(g), 4) for g in gain]}
    lo, hi = (int(v) for v in args.zoom_ladder.split('-'))
    inside16 = m16 & (distance_transform_edt(m16) > 4)
    ref_mean = b16[inside16].mean(0)
    lon_c, lat_c = grid.lonlat_of_cells()
    lon_c, lat_c = lon_c[::k, ::k][:m16.shape[0], :m16.shape[1]][inside16], lat_c[::k, ::k][:m16.shape[0], :m16.shape[1]][inside16]
    for z in range(lo, hi + 1):
        if z == args.basemap_zoom:
            continue
        n = 2 ** z
        tx = np.floor((lon_c + 180) / 360 * n).astype(int)
        r = np.radians(lat_c)
        ty = np.floor((1 - np.log(np.tan(r) + 1 / np.cos(r)) / math.pi) / 2 * n).astype(int)
        cand = sorted(set(zip(tx.tolist(), ty.tolist())))
        stride = max(1, len(cand) // args.ladder_tiles)
        picked = cand[::stride][:args.ladder_tiles]
        zmap, zcount = sample_xyz(grid, template, z, args.basemap_tile, args.cache, headers, tiles=picked,
                                  label='ladder')
        zl = (zmap @ LUMA)[..., None]
        zmap = np.maximum(zl + (zmap - zl) * args.basemap_saturation, 0)
        z16, zm16 = block_mean(zmap, zcount > 0, k)
        both = inside16 & zm16
        if both.sum() < 50:
            continue
        ratio = b16[both].mean(0) / np.maximum(z16[both].mean(0), 1e-6)  # reference / this zoom
        by_zoom[str(z)] = [round(float(g), 4) for g in gain * ratio]
        print(f'  z{z} vs z{args.basemap_zoom}: {np.round(np.log2(1 / ratio), 3)} stops', file=sys.stderr)
    del ref_mean

    meta = {
        'dataset': args.dataset,
        'frame': 'tileset-enu',
        'rootTransform': [float(v) for v in transform],
        'origin': [cx0, cy0],
        'size': [tw * texel, th * texel],
        'texels': [tw, th],
        'rowOrder': 'north-first',
        'encoding': {'kind': 'log2-gain-rgb8', 'stops': args.encode_stops, 'zero': 128, 'scale': 127,
                     'meanCode': [round(float(code[..., c].mean()), 3) for c in range(3)]},
        'pngHash': png_hash,
        'basemapGain': by_zoom[str(args.basemap_zoom)],
        'basemapGainByZoom': by_zoom,
        'basemapSaturation': args.basemap_saturation,
        'made': {
            'date': time.strftime('%Y-%m-%d'), 'method': args.method,
            'radiusM': args.radius if args.method == 'median' else None,
            'sigmaM': args.sigma if args.method == 'gaussian' else None,
            'kneeStops': args.knee_stops, 'cellM': args.cell, 'texelM': texel, 'depth': args.depth,
            'basemap': args.basemap.split('?')[0].replace(proxy_base, 'maptiler'),
            'basemapZoom': args.basemap_zoom, 'pngBytes': png_bytes, **stats,
        },
    }

    # --- one ortho field per source: its own low-pass, into raw satellite space
    ortho_preview = None
    if orthos:
        print('orthos', file=sys.stderr)
        length_m, height_m = (float(v) for v in args.ortho_footprint.lower().split('x'))
        f0, f1 = (float(v) for v in args.ortho_feather.split(','))
        # Where the survey's ground patch covers the map (config groundPatch: 40 m blur, 0.65 cut)
        under8 = gaussian_filter(cmask.astype(np.float32), 40.0 / args.cell) > 0.65
        kind_zooms = list(range(args.ortho_min_zoom, args.basemap_max_zoom + 1))
        sources = []
        for i, o in enumerate(orthos):  # CLI order is priority: later ones draw on top
            ot = f'{proxy_base}/tiles/{o["id"]}/{{z}}/{{x}}/{{y}}.{o["format"]}?key={qkey}'
            z_s = min(max(args.ortho_zoom, o['minzoom']), o['maxzoom'])
            orgb, ocount = sample_xyz(grid, ot, z_s, 256, args.cache, headers, rgba=True, bounds=o['bounds'],
                                      label=o['name'][:24])
            cov = (ocount > 0) & have_map
            o16, om16 = block_mean(orgb, cov, k)
            od = np.log(o16 + 1e-3) - np.log(b16raw + 1e-3)
            olevel = np.median(od[om16], 0)
            osmooth = masked_median(od, om16, bar(length_m / texel, height_m / texel), fill_sigma_px=length_m / texel)
            # Only the local part goes through the knee and into the texture; the ortho's global
            # offset over the satellite (several stops) travels as three numbers.
            ofield = soft_knee(olevel - osmooth, args.knee_stops)
            ofield = spread_to_outside(ofield, om16, fade_px=3)
            inside_m = distance_transform_edt(cov) * args.cell
            feather8 = np.clip((inside_m - f0) / max(f1 - f0, 1e-6), 0, 1)
            feather8 = (feather8 * feather8 * (3 - 2 * feather8)).astype(np.float32)
            f16 = feather8[:om16.shape[0] * k, :om16.shape[1] * k].reshape(om16.shape[0], k, om16.shape[1], k).mean((1, 3))
            ostats = {
                'offsetStops': [round(float(v / LN2), 4) for v in olevel],
                'landscapeResidualStops': {'before': landscape_residual(od - olevel, om16, 100 / texel),
                                           'after': landscape_residual(od - olevel + ofield, om16, 100 / texel)},
                'seamStopsPerTexel': {'before': round(seam_energy(od - olevel, om16), 4),
                                      'after': round(seam_energy(od - olevel + ofield, om16), 4)},
            }
            print(f'  {o["name"][:24]}: {json.dumps(ostats)}', file=sys.stderr)

            # raw per-zoom trim over this source's own interior: the composite is written in the
            # tile zoom's raw satellite colour, which the shader's per-zoom gain then evens out.
            interior16 = om16 & (f16 >= 0.999)
            trim = {str(args.basemap_zoom): [1.0, 1.0, 1.0]}
            lon_c, lat_c = grid.lonlat_of_cells()
            sel = interior16.repeat(k, 0).repeat(k, 1)[:lon_c.shape[0], :lon_c.shape[1]]
            lon_i, lat_i = lon_c[sel], lat_c[sel]
            del lon_c, lat_c
            for z in kind_zooms:
                if z == args.basemap_zoom or len(lon_i) == 0:
                    continue
                nz = 2 ** z
                txs = np.floor((lon_i + 180) / 360 * nz).astype(int)
                r = np.radians(lat_i)
                tys = np.floor((1 - np.log(np.tan(r) + 1 / np.cos(r)) / math.pi) / 2 * nz).astype(int)
                cand = sorted(set(zip(txs.tolist(), tys.tolist())))
                stride = max(1, len(cand) // args.ortho_ladder_tiles)
                zraw, zcount = sample_xyz(grid, template, z, args.basemap_tile, args.cache, headers,
                                          tiles=cand[::stride][:args.ortho_ladder_tiles], label='ortho ladder')
                z16, zm16 = block_mean(zraw, zcount > 0, k)
                both = interior16 & zm16
                if both.sum() < 20:
                    continue
                trim[str(z)] = [round(float(v), 4) for v in z16[both].mean(0) / np.maximum(b16raw[both].mean(0), 1e-6)]

            ys, xs = np.nonzero(om16)
            bx0, bx1, by0, by1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
            gcode, gclipped = encode_field(ofield[by0:by1, bx0:bx1] / LN2, args.encode_stops)
            gcode = gcode[::-1]
            fcode = np.clip(np.round(f16[by0:by1, bx0:bx1] * 255), 0, 255).astype(np.uint8)[::-1]
            gname, fname = f'{args.dataset}.ortho-{i}.png', f'{args.dataset}.ortho-{i}-feather.png'
            ghash, gbytes = write_png(os.path.join(args.out, gname), gcode)
            fhash, fbytes = write_png(os.path.join(args.out, fname), fcode)
            ostats['clippedTexels'] = gclipped
            kinds = tile_kinds(grid, feather8, under8, o['bounds'], kind_zooms)
            print(f'  kinds (none/edge/full/under): ' + ', '.join(f'z{z} {v["counts"]}' for z, v in kinds.items()),
                  file=sys.stderr)
            sources.append({
                **o,
                'baseGain': [round(float(v), 5) for v in np.exp(-olevel)],
                'zoomTrim': trim,
                'field': {
                    'origin': [x0 + bx0 * texel, y0 + by0 * texel],
                    'size': [(bx1 - bx0) * texel, (by1 - by0) * texel],
                    'texels': [int(bx1 - bx0), int(by1 - by0)],
                    'rowOrder': 'north-first',
                    'encoding': {'kind': 'log2-gain-rgb8', 'stops': args.encode_stops, 'zero': 128, 'scale': 127,
                                 'meanCode': [round(float(gcode[..., c].mean()), 3) for c in range(3)]},
                    'gainPng': gname, 'gainHash': ghash, 'featherPng': fname, 'featherHash': fhash,
                    'featherMean': round(float(fcode.mean()), 3),
                },
                'kinds': kinds,
                'made': {'zoom': z_s, 'footprintM': [length_m, height_m], 'featherM': [f0, f1],
                         'bytes': gbytes + fbytes, **ostats},
            })
            if ortho_preview is None:
                ortho_preview = (od - olevel, ofield, om16)
        meta['ortho'] = {'version': 2, 'target': 'raw-basemap', 'kindZooms': [kind_zooms[0], kind_zooms[-1]],
                         'sources': sources}

    write_json(os.path.join(args.out, f'{args.dataset}.json'), meta)
    commit_outputs()
    print(f'wrote {tw}x{th} cloud field ({png_bytes} B), basemap gain {meta["basemapGain"]}', file=sys.stderr)

    if args.preview:
        od_p, of_p, om_p = ortho_preview if ortho_preview else (None, None, None)
        write_previews(args.preview, cloud, cmask, basemap, have_map, gain, d, field, m16, k, None, od_p, of_p, om_p)


def write_previews(out, cloud, cmask, basemap, have_map, gain, d, field, m16, k, orgb, od, ofield, om16):
    """Before/after drift maps and a top-down composite, for eyeballing a build."""
    os.makedirs(out, exist_ok=True)

    def enc(x):
        x = np.clip(x, 0, 1)
        return (np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055) * 255).astype(np.uint8)

    def drift(r, m):
        v = (r - np.median(r[m], 0)) / LN2
        lum = v @ LUMA
        vis = 0.5 + 0.9 * lum[..., None] + 2.0 * (v - lum[..., None])
        vis[~m] = 0
        return (np.clip(vis, 0, 1) * 255).astype(np.uint8)[::-1]

    Image.fromarray(np.concatenate([drift(d, m16), drift(d + field, m16)], 1)).save(os.path.join(out, 'cloud_drift_before_after.png'))

    def smoothed(r, m):
        lp, _ = masked_gaussian_log(r, m, 2.0)
        return lp

    Image.fromarray(np.concatenate([drift(smoothed(d, m16), m16), drift(smoothed(d + field, m16), m16)], 1)).save(
        os.path.join(out, 'cloud_drift_smoothed_before_after.png'))
    if od is not None:
        Image.fromarray(np.concatenate([drift(od, om16), drift(od + ofield, om16)], 1)).save(os.path.join(out, 'ortho_drift_before_after.png'))
        # (the drift maps are median-centred, so the global offset does not show in them)
    up = np.repeat(np.repeat(field, k, 0), k, 1)[:cloud.shape[0], :cloud.shape[1]]
    comp = enc(basemap * gain)
    matched = enc(cloud * np.exp(up[:cloud.shape[0], :cloud.shape[1]]))
    comp[cmask] = matched[cmask]
    Image.fromarray(comp[::-1]).save(os.path.join(out, 'topdown_matched.jpg'), quality=85)


if __name__ == '__main__':
    main()
