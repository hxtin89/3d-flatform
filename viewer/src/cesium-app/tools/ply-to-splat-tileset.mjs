#!/usr/bin/env node

/**
 * Convert an INRIA 3D Gaussian Splatting PLY file to the SPZ-backed glTF
 * structure consumed by CesiumJS 1.142's native GaussianSplat3DTileContent.
 *
 * Axis convention:
 * - INRIA PLY/SPZ data remains in its source Z-up coordinates.
 * - The glTF node has an Rx(-90 degrees) rotation, converting source Z-up to
 *   glTF Y-up.
 * - Cesium then applies its normal glTF Y-up -> tileset Z-up correction.
 *   Those rotations cancel, so the tileset bounding box and root transform are
 *   expressed in the original source coordinates.
 * - The tileset root transform defaults to column-major identity. --transform
 *   replaces it with the caller-provided placement matrix (typically ENU to
 *   ECEF). --translate is passed through splat-transform before SPZ packing.
 *
 * Cesium 1.142 has two non-obvious requirements that this writer preserves:
 * - The tileset's 3DTILES_content_gltf extension must require both Gaussian
 *   glTF extensions or the GLB is routed through Model3DTileContent.
 * - GltfSpzLoader reads bufferView 0, so the SPZ payload is placed there.
 */

import assert from "node:assert/strict";
import { readFile as readNodeFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MemoryFileSystem,
  MemoryReadFileSystem,
  Transform,
  UrlReadFileSystem,
  bakeTransform,
  createChunkDataPool,
  materializeToDataTable,
  processSource,
  readFile as readSplatFile,
  writeSpz,
} from "@playcanvas/splat-transform";
import { Vec3 } from "playcanvas";

const GAUSSIAN_EXTENSION = "KHR_gaussian_splatting";
const SPZ_EXTENSION = "KHR_gaussian_splatting_compression_spz_2";
const CONTENT_GLTF_EXTENSION = "3DTILES_content_gltf";

const COMPONENT_TYPE_UNSIGNED_BYTE = 5121;
const COMPONENT_TYPE_FLOAT = 5126;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const THREE_SIGMA = 3;
const TILESET_GEOMETRIC_ERROR = 1_000_000;
const SPZ_VERSION = 3;
const SH_REST_COUNTS = [0, 9, 24, 45];
const SH_COEFFICIENTS_PER_DEGREE = [0, 3, 5, 7];
const SQRT_HALF = Math.SQRT1_2;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const DEFAULT_SPLAT_ROOT = path.join(PROJECT_ROOT, "public", "splats");
const IDENTITY_TRANSFORM = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function usage() {
  return `Usage:
  node src/cesium-app/tools/ply-to-splat-tileset.mjs <input.ply|url> [outDir] [options]
  node src/cesium-app/tools/ply-to-splat-tileset.mjs --selftest

Options:
  --transform m0,...,m15  16 finite column-major root-transform values
  --translate x,y,z       Pass a source-space translation to splat-transform
  --max-sh 0|1|2|3        Maximum retained SH degree (default: 0)
  --selftest              Build and validate a 1000-splat RGB axis triad
  --help                  Show this help

When outDir is omitted, output is public/splats/<input-basename>/.`;
}

function fail(message) {
  throw new Error(`${message}\n\n${usage()}`);
}

function takeOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${option} requires a value`);
  }
  return value;
}

function parseFiniteList(value, count, option) {
  const values = value.split(",").map((part) => Number(part.trim()));
  if (values.length !== count || values.some((number) => !Number.isFinite(number))) {
    fail(`${option} requires exactly ${count} comma-separated finite numbers`);
  }
  return values;
}

function parseArgs(argv) {
  const positional = [];
  let transform = IDENTITY_TRANSFORM.slice();
  let translation;
  let maxSh = 0;
  let selftest = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--help":
      case "-h":
        return { help: true };
      case "--selftest":
        selftest = true;
        break;
      case "--transform": {
        const value = takeOptionValue(argv, index, argument);
        transform = parseFiniteList(value, 16, argument);
        index += 1;
        break;
      }
      case "--translate": {
        const value = takeOptionValue(argv, index, argument);
        translation = parseFiniteList(value, 3, argument);
        index += 1;
        break;
      }
      case "--max-sh": {
        const value = Number(takeOptionValue(argv, index, argument));
        if (!Number.isInteger(value) || value < 0 || value > 3) {
          fail("--max-sh must be an integer from 0 through 3");
        }
        maxSh = value;
        index += 1;
        break;
      }
      default:
        if (argument.startsWith("--")) {
          fail(`Unknown option: ${argument}`);
        }
        positional.push(argument);
        break;
    }
  }

  if (selftest) {
    if (positional.length > 1) {
      fail("--selftest accepts at most one positional output directory");
    }
    return {
      selftest: true,
      outDir: positional[0] ? path.resolve(positional[0]) : path.join(DEFAULT_SPLAT_ROOT, "selftest"),
      transform,
      translation,
      maxSh,
    };
  }

  if (positional.length < 1 || positional.length > 2) {
    fail("Expected an input PLY and, optionally, an output directory");
  }

  const input = positional[0];
  const defaultName = inputBasename(input);
  return {
    selftest: false,
    input,
    outDir: positional[1]
      ? path.resolve(positional[1])
      : path.join(DEFAULT_SPLAT_ROOT, defaultName),
    transform,
    translation,
    maxSh,
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function inputBasename(input) {
  let pathname = input;
  if (isHttpUrl(input)) {
    pathname = new URL(input).pathname;
  }
  const extension = path.extname(pathname);
  const basename = path.basename(pathname, extension);
  if (!basename) {
    fail(`Cannot derive an output name from input: ${input}`);
  }
  return basename;
}

async function makeReadRequest(input) {
  if (isHttpUrl(input)) {
    return {
      filename: input,
      fileSystem: new UrlReadFileSystem(),
    };
  }

  const bytes = await readNodeFile(path.resolve(input));
  const filename = "input.ply";
  const fileSystem = new MemoryReadFileSystem();
  fileSystem.set(filename, bytes);
  return { filename, fileSystem };
}

function requireColumn(dataTable, name) {
  const column = dataTable.getColumnByName(name);
  if (!column) {
    throw new Error(`Input is missing required INRIA PLY field '${name}'`);
  }
  return column.data;
}

/**
 * Compute an axis-aligned box containing each Gaussian's rotated 3-sigma
 * ellipsoid. For covariance R*diag(sigma^2)*R^T, an AABB half-extent along
 * output axis i is 3*sqrt(sum_j(R_ij^2*sigma_j^2)).
 */
function computeGaussianBounds(dataTable) {
  const x = requireColumn(dataTable, "x");
  const y = requireColumn(dataTable, "y");
  const z = requireColumn(dataTable, "z");
  const rotW = requireColumn(dataTable, "rot_0");
  const rotX = requireColumn(dataTable, "rot_1");
  const rotY = requireColumn(dataTable, "rot_2");
  const rotZ = requireColumn(dataTable, "rot_3");
  const logScaleX = requireColumn(dataTable, "scale_0");
  const logScaleY = requireColumn(dataTable, "scale_1");
  const logScaleZ = requireColumn(dataTable, "scale_2");

  if (dataTable.numRows === 0) {
    throw new Error("Input contains no Gaussian splats");
  }

  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const positionMinimum = [Infinity, Infinity, Infinity];
  const positionMaximum = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < dataTable.numRows; index += 1) {
    const px = x[index];
    const py = y[index];
    const pz = z[index];
    let qw = rotW[index];
    let qx = rotX[index];
    let qy = rotY[index];
    let qz = rotZ[index];
    const sx = Math.exp(logScaleX[index]);
    const sy = Math.exp(logScaleY[index]);
    const sz = Math.exp(logScaleZ[index]);

    const values = [px, py, pz, qw, qx, qy, qz, sx, sy, sz];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`Gaussian ${index} has a non-finite position, rotation, or scale`);
    }

    const quaternionLength = Math.hypot(qw, qx, qy, qz);
    if (quaternionLength === 0) {
      throw new Error(`Gaussian ${index} has a zero-length rotation quaternion`);
    }
    qw /= quaternionLength;
    qx /= quaternionLength;
    qy /= quaternionLength;
    qz /= quaternionLength;

    const xx = qx * qx;
    const yy = qy * qy;
    const zz = qz * qz;
    const xy = qx * qy;
    const xz = qx * qz;
    const yz = qy * qz;
    const wx = qw * qx;
    const wy = qw * qy;
    const wz = qw * qz;

    const m00 = 1 - 2 * (yy + zz);
    const m01 = 2 * (xy - wz);
    const m02 = 2 * (xz + wy);
    const m10 = 2 * (xy + wz);
    const m11 = 1 - 2 * (xx + zz);
    const m12 = 2 * (yz - wx);
    const m20 = 2 * (xz - wy);
    const m21 = 2 * (yz + wx);
    const m22 = 1 - 2 * (xx + yy);

    const sx2 = sx * sx;
    const sy2 = sy * sy;
    const sz2 = sz * sz;
    const extentX = THREE_SIGMA * Math.sqrt(m00 * m00 * sx2 + m01 * m01 * sy2 + m02 * m02 * sz2);
    const extentY = THREE_SIGMA * Math.sqrt(m10 * m10 * sx2 + m11 * m11 * sy2 + m12 * m12 * sz2);
    const extentZ = THREE_SIGMA * Math.sqrt(m20 * m20 * sx2 + m21 * m21 * sy2 + m22 * m22 * sz2);

    const positions = [px, py, pz];
    const extents = [extentX, extentY, extentZ];
    for (let axis = 0; axis < 3; axis += 1) {
      positionMinimum[axis] = Math.min(positionMinimum[axis], positions[axis]);
      positionMaximum[axis] = Math.max(positionMaximum[axis], positions[axis]);
      minimum[axis] = Math.min(minimum[axis], positions[axis] - extents[axis]);
      maximum[axis] = Math.max(maximum[axis], positions[axis] + extents[axis]);
    }
  }

  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  const halfSize = minimum.map((value, axis) => (maximum[axis] - value) / 2);
  return {
    minimum,
    maximum,
    positionMinimum,
    positionMaximum,
    box: [
      center[0], center[1], center[2],
      halfSize[0], 0, 0,
      0, halfSize[1], 0,
      0, 0, halfSize[2],
    ],
  };
}

function inferShDegree(dataTable) {
  let restCount = 0;
  while (dataTable.hasColumn(`f_rest_${restCount}`)) {
    restCount += 1;
  }
  const degree = SH_REST_COUNTS.indexOf(restCount);
  if (degree === -1) {
    throw new Error(`Unsupported spherical-harmonic field count: ${restCount}`);
  }
  return degree;
}

function makeAccessor(componentType, count, type, extras = {}) {
  return { componentType, count, type, ...extras };
}

function buildGltf(spzByteLength, count, shDegree, bounds) {
  const accessors = [];
  const attributes = {};

  const addAccessor = (semantic, accessor) => {
    attributes[semantic] = accessors.length;
    accessors.push(accessor);
  };

  addAccessor(
    "POSITION",
    makeAccessor(COMPONENT_TYPE_FLOAT, count, "VEC3", {
      min: bounds.positionMinimum,
      max: bounds.positionMaximum,
    }),
  );
  addAccessor(
    "COLOR_0",
    makeAccessor(COMPONENT_TYPE_UNSIGNED_BYTE, count, "VEC4", {
      normalized: true,
    }),
  );
  addAccessor(
    `${GAUSSIAN_EXTENSION}:ROTATION`,
    makeAccessor(COMPONENT_TYPE_FLOAT, count, "VEC4"),
  );
  addAccessor(
    `${GAUSSIAN_EXTENSION}:SCALE`,
    makeAccessor(COMPONENT_TYPE_FLOAT, count, "VEC3"),
  );

  for (let degree = 1; degree <= shDegree; degree += 1) {
    for (let coefficient = 0; coefficient < SH_COEFFICIENTS_PER_DEGREE[degree]; coefficient += 1) {
      addAccessor(
        `${GAUSSIAN_EXTENSION}:SH_DEGREE_${degree}_COEF_${coefficient}`,
        makeAccessor(COMPONENT_TYPE_FLOAT, count, "VEC3"),
      );
    }
  }

  return {
    asset: {
      version: "2.0",
      generator: "ply-to-splat-tileset.mjs",
    },
    extensionsUsed: [GAUSSIAN_EXTENSION, SPZ_EXTENSION],
    extensionsRequired: [GAUSSIAN_EXTENSION, SPZ_EXTENSION],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: "INRIA Z-up to glTF Y-up",
        mesh: 0,
        // Cesium's GaussianSplat3DTileContent reads `nodes[0].matrix` directly
        // (worldTransform, GaussianSplat3DTileContent.js:481) and crashes when
        // the node uses TRS instead — so express Rx(-90°) as an explicit
        // column-major matrix: (x, y, z) -> (x, z, -y).
        matrix: [
          1, 0, 0, 0,
          0, 0, -1, 0,
          0, 1, 0, 0,
          0, 0, 0, 1,
        ],
      },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes,
            mode: 0,
            extensions: {
              [GAUSSIAN_EXTENSION]: {
                kernel: "ellipse",
                colorSpace: "srgb_rec709_display",
                sortingMethod: "cameraDistance",
                projection: "perspective",
                extensions: {
                  [SPZ_EXTENSION]: {
                    bufferView: 0,
                  },
                },
              },
            },
          },
        ],
      },
    ],
    buffers: [{ byteLength: spzByteLength }],
    bufferViews: [
      {
        buffer: 0,
        byteOffset: 0,
        byteLength: spzByteLength,
      },
    ],
    accessors,
  };
}

function align4(value) {
  return (value + 3) & ~3;
}

function buildGlb(gltf, spzBytes) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = align4(jsonBytes.byteLength);
  const binaryLength = align4(spzBytes.byteLength);
  const totalLength = 12 + 8 + jsonLength + 8 + binaryLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);

  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);

  let offset = 12;
  view.setUint32(offset, jsonLength, true);
  view.setUint32(offset + 4, JSON_CHUNK_TYPE, true);
  offset += 8;
  glb.fill(0x20, offset, offset + jsonLength);
  glb.set(jsonBytes, offset);
  offset += jsonLength;

  view.setUint32(offset, binaryLength, true);
  view.setUint32(offset + 4, BIN_CHUNK_TYPE, true);
  offset += 8;
  glb.set(spzBytes, offset);

  return glb;
}

function buildTileset(transform, boundingBox) {
  const gltfExtensions = [GAUSSIAN_EXTENSION, SPZ_EXTENSION];
  return {
    asset: {
      version: "1.1",
      gltfUpAxis: "Y",
    },
    geometricError: TILESET_GEOMETRIC_ERROR,
    extensionsUsed: [CONTENT_GLTF_EXTENSION],
    extensionsRequired: [CONTENT_GLTF_EXTENSION],
    extensions: {
      [CONTENT_GLTF_EXTENSION]: {
        extensionsUsed: gltfExtensions,
        extensionsRequired: gltfExtensions,
      },
    },
    root: {
      boundingVolume: {
        box: boundingBox,
      },
      geometricError: 0,
      refine: "ADD",
      transform,
      content: {
        uri: "splats.glb",
      },
    },
  };
}

function parseGlb(glb) {
  const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  assert.ok(bytes.byteLength >= 28, "GLB is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), GLB_MAGIC, "Invalid GLB magic");
  assert.equal(view.getUint32(4, true), GLB_VERSION, "Invalid GLB version");
  assert.equal(view.getUint32(8, true), bytes.byteLength, "Invalid GLB byte length");

  const jsonLength = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), JSON_CHUNK_TYPE, "First GLB chunk is not JSON");
  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonLength;
  assert.ok(jsonEnd + 8 <= bytes.byteLength, "GLB JSON chunk overruns the file");
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(jsonStart, jsonEnd)).trim());

  const binaryLength = view.getUint32(jsonEnd, true);
  assert.equal(view.getUint32(jsonEnd + 4, true), BIN_CHUNK_TYPE, "Second GLB chunk is not BIN");
  const binaryStart = jsonEnd + 8;
  assert.ok(binaryStart + binaryLength <= bytes.byteLength, "GLB BIN chunk overruns the file");
  return {
    gltf,
    binary: bytes.subarray(binaryStart, binaryStart + binaryLength),
  };
}

function assertNativeCesiumStructure(gltf, expectedCount) {
  assert.deepEqual(gltf.extensionsUsed, [GAUSSIAN_EXTENSION, SPZ_EXTENSION]);
  assert.deepEqual(gltf.extensionsRequired, [GAUSSIAN_EXTENSION, SPZ_EXTENSION]);
  assert.equal(gltf.bufferViews[0].buffer, 0);
  assert.equal(gltf.bufferViews[0].byteOffset, 0);

  const primitive = gltf.meshes[0].primitives[0];
  assert.equal(primitive.mode, 0);
  assert.ok(primitive.attributes.POSITION !== undefined);
  assert.ok(primitive.attributes.COLOR_0 !== undefined);
  assert.ok(primitive.attributes[`${GAUSSIAN_EXTENSION}:ROTATION`] !== undefined);
  assert.ok(primitive.attributes[`${GAUSSIAN_EXTENSION}:SCALE`] !== undefined);
  assert.equal(gltf.accessors[primitive.attributes.POSITION].count, expectedCount);
  for (const accessor of gltf.accessors) {
    assert.equal(accessor.bufferView, undefined, "SPZ attribute accessors must not have bufferViews");
  }

  const spz = primitive.extensions
    ?.[GAUSSIAN_EXTENSION]
    ?.extensions
    ?.[SPZ_EXTENSION];
  assert.equal(spz?.bufferView, 0);
}

async function encodeSpz(dataTable) {
  const fileSystem = new MemoryFileSystem();
  const filename = "payload.spz";
  await writeSpz(
    {
      filename,
      dataTable,
      // Cesium 1.142's @spz-loader/core path expects the legacy gzip-backed
      // stream. splat-transform v4 emits the newer NGSP container.
      version: SPZ_VERSION,
    },
    fileSystem,
  );
  const bytes = fileSystem.results.get(filename);
  if (!bytes) {
    throw new Error("splat-transform did not produce an SPZ payload");
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error("Expected a gzip-backed SPZ v3 payload for Cesium 1.142");
  }
  return bytes;
}

async function convert(input, outDir, options) {
  const readRequest = await makeReadRequest(input);
  const sources = await readSplatFile({
    filename: readRequest.filename,
    inputFormat: "ply",
    fileSystem: readRequest.fileSystem,
    options: {},
  });

  if (sources.length !== 1) {
    await Promise.allSettled(sources.map((source) => source.close()));
    throw new Error(`Expected one PLY source, received ${sources.length}`);
  }

  let source = sources[0];
  try {
    const requiredLayers = ["position", "geometric", "color"];
    const missingLayers = requiredLayers.filter((layer) => !source.meta.availableLayers.has(layer));
    if (missingLayers.length > 0) {
      throw new Error(`PLY is not INRIA Gaussian data; missing layers: ${missingLayers.join(", ")}`);
    }

    const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize });
    const actions = [{ kind: "filterBands", value: options.maxSh }];
    if (options.translation) {
      actions.push({
        kind: "translate",
        value: new Vec3(...options.translation),
      });
    }

    source = await processSource(source, actions, pool, { sourceFormat: "ply" });
    source = bakeTransform(source, Transform.PLY);
    const dataTable = await materializeToDataTable(source, pool);
    const bounds = computeGaussianBounds(dataTable);
    const shDegree = inferShDegree(dataTable);
    const spzBytes = await encodeSpz(dataTable);
    const gltf = buildGltf(spzBytes.byteLength, dataTable.numRows, shDegree, bounds);
    const glb = buildGlb(gltf, spzBytes);
    const tileset = buildTileset(options.transform, bounds.box);

    const parsed = parseGlb(glb);
    assertNativeCesiumStructure(parsed.gltf, dataTable.numRows);
    assert.deepEqual(
      tileset.extensions[CONTENT_GLTF_EXTENSION].extensionsRequired,
      [GAUSSIAN_EXTENSION, SPZ_EXTENSION],
    );

    await mkdir(outDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(outDir, "splats.glb"), glb),
      writeFile(path.join(outDir, "tileset.json"), `${JSON.stringify(tileset, null, 2)}\n`),
    ]);

    return {
      count: dataTable.numRows,
      shDegree,
      spzByteLength: spzBytes.byteLength,
      glbByteLength: glb.byteLength,
      bounds,
      glb,
      tileset,
    };
  } finally {
    await source.close();
  }
}

function makeSyntheticPly(count = 1000) {
  const SH_C0 = 0.28209479177387814;
  const opacity = Math.log(0.98 / 0.02);
  const logScale = Math.log(0.025);
  const floatsPerRow = 14;
  const colors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const armCounts = [333, 333, count - 666];
  const rows = [];

  for (let axis = 0; axis < 3; axis += 1) {
    for (let index = 0; index < armCounts[axis]; index += 1) {
      const distance = (index / Math.max(1, armCounts[axis] - 1)) * 3;
      const position = [0, 0, 0];
      position[axis] = distance;
      const dc = colors[axis].map((channel) => (channel - 0.5) / SH_C0);
      rows.push([
        ...position,
        ...dc,
        opacity,
        logScale,
        logScale,
        logScale,
        1,
        0,
        0,
        0,
      ]);
    }
  }

  const header = [
    "ply",
    "format binary_little_endian 1.0",
    "comment synthetic RGB axis triad for ply-to-splat-tileset self-test",
    `element vertex ${count}`,
    "property float x",
    "property float y",
    "property float z",
    "property float f_dc_0",
    "property float f_dc_1",
    "property float f_dc_2",
    "property float opacity",
    "property float scale_0",
    "property float scale_1",
    "property float scale_2",
    "property float rot_0",
    "property float rot_1",
    "property float rot_2",
    "property float rot_3",
    "end_header",
  ];
  const headerBytes = new TextEncoder().encode(`${header.join("\n")}\n`);
  const result = new Uint8Array(headerBytes.byteLength + count * floatsPerRow * 4);
  result.set(headerBytes);
  const view = new DataView(result.buffer, result.byteOffset + headerBytes.byteLength);
  let byteOffset = 0;
  for (const row of rows) {
    assert.equal(row.length, floatsPerRow);
    for (const value of row) {
      view.setFloat32(byteOffset, value, true);
      byteOffset += 4;
    }
  }
  return result;
}

async function runSelftest(options) {
  await mkdir(options.outDir, { recursive: true });
  const input = path.join(options.outDir, "synthetic-axis-triad.ply");
  await writeFile(input, makeSyntheticPly());

  try {
    const result = await convert(input, options.outDir, options);
    assert.equal(result.count, 1000);
    assert.equal(result.shDegree, 0);
    assert.equal(result.tileset.asset.version, "1.1");
    assert.equal(result.tileset.root.content.uri, "splats.glb");
    assert.equal(result.tileset.root.geometricError, 0);
    for (const maximum of result.bounds.positionMaximum) {
      assert.ok(maximum > 2.99 && maximum <= 3.01, "Synthetic axis arm has the wrong extent");
    }

    const { gltf, binary } = parseGlb(result.glb);
    assertNativeCesiumStructure(gltf, 1000);
    const spzLength = gltf.bufferViews[0].byteLength;
    const spzBytes = binary.subarray(0, spzLength);
    // @spz-loader/core is Cesium's browser decoder, but its published ESM
    // bundle does not initialize under plain Node 22. Decode here with the
    // installed official SPZ backend used by splat-transform's writer.
    const { default: createSpzModule } = await import("@adobe/spz");
    const spzModule = await createSpzModule();
    const decoded = spzModule.loadSpzFromBuffer(spzBytes, {
      to: spzModule.CoordinateSystem.UNSPECIFIED,
    });
    assert.equal(decoded.numPoints, 1000, "Cesium's SPZ decoder returned the wrong point count");
    assert.equal(decoded.shDegree, 0, "Cesium's SPZ decoder returned the wrong SH degree");
    const decodedMaximum = [0, 0, 0];
    for (let index = 0; index < decoded.positions.length; index += 3) {
      decodedMaximum[0] = Math.max(decodedMaximum[0], decoded.positions[index]);
      decodedMaximum[1] = Math.max(decodedMaximum[1], decoded.positions[index + 1]);
      decodedMaximum[2] = Math.max(decodedMaximum[2], decoded.positions[index + 2]);
    }
    for (const maximum of decodedMaximum) {
      assert.ok(maximum > 2.99 && maximum <= 3.01, "Decoded SPZ axis arm has the wrong extent");
    }

    console.log(`Self-test passed: ${result.count} splats`);
    console.log(`  ${path.join(options.outDir, "tileset.json")}`);
    console.log(`  ${path.join(options.outDir, "splats.glb")} (${result.glbByteLength} bytes)`);
  } finally {
    await rm(input, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.selftest) {
    await runSelftest(options);
    return;
  }

  const result = await convert(options.input, options.outDir, options);
  console.log(`Converted ${result.count.toLocaleString()} splats (SH degree ${result.shDegree})`);
  console.log(`  ${path.join(options.outDir, "tileset.json")}`);
  console.log(`  ${path.join(options.outDir, "splats.glb")} (${result.glbByteLength.toLocaleString()} bytes)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
