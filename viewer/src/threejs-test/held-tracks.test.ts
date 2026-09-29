import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'

import { EXPERIENCE_CONFIG } from './config.ts'
import { bakeHeldTracks, HELD_TRACK_TOLERANCE as TOLERANCE } from './held-tracks.ts'

function rig(): THREE.Object3D {
  const root = new THREE.Object3D()
  const bone = new THREE.Bone()
  bone.name = 'bone'
  root.add(bone)
  return root
}

const vector = (name: string, values: number[]) =>
  new THREE.VectorKeyframeTrack(name, values.map((_, index) => index).filter((index) => index % 3 === 0).map((index) => index / 3), values)

test('a vector track held in every clip is baked into the bone and dropped; a moving one is kept', () => {
  const root = rig()
  const a = new THREE.AnimationClip('a', 2, [
    vector('bone.position', [1, 2, 3, 1, 2, 3.00002]),
    vector('bone.scale', [1, 1, 1, 1, 1.5, 1]),
  ])
  const b = new THREE.AnimationClip('b', 5, [
    vector('bone.position', [1, 2, 3, 1.00001, 2, 3]),
    vector('bone.scale', [1, 1, 1, 1, 1, 1]),
  ])
  const [bakedA, bakedB] = bakeHeldTracks(root, [a, b], TOLERANCE)
  assert.deepEqual(bakedA.tracks.map((track) => track.name), ['bone.scale'])
  assert.deepEqual(bakedB.tracks.map((track) => track.name), ['bone.scale'])
  assert.deepEqual(root.getObjectByName('bone')!.position.toArray(), [1, 2, 3])
  // The loop period must not shrink to the remaining tracks' span.
  assert.equal(bakedA.duration, 2)
  assert.equal(bakedB.duration, 5)
})

test('a rotation stored as q in one clip and -q in the other counts as held', () => {
  const root = rig()
  const q = [0, 0.6, 0, 0.8]
  const minus = q.map((value) => -value)
  const a = new THREE.AnimationClip('a', 1, [new THREE.QuaternionKeyframeTrack('bone.quaternion', [0, 1], [...q, ...q])])
  const b = new THREE.AnimationClip('b', 1, [new THREE.QuaternionKeyframeTrack('bone.quaternion', [0, 1], [...minus, ...q])])
  const [bakedA] = bakeHeldTracks(root, [a, b], TOLERANCE)
  assert.equal(bakedA.tracks.length, 0)
  // Keyframe values are stored as float32.
  assert.deepEqual(root.getObjectByName('bone')!.quaternion.toArray(), Array.from(new Float32Array(q)))
})

test('a track missing from a clip, or held at different values, is kept', () => {
  const root = rig()
  const a = new THREE.AnimationClip('a', 1, [
    vector('bone.position', [1, 2, 3, 1, 2, 3]),
    vector('bone.scale', [1, 1, 1, 1, 1, 1]),
  ])
  const b = new THREE.AnimationClip('b', 1, [vector('bone.position', [4, 2, 3, 4, 2, 3])])
  const [bakedA, bakedB] = bakeHeldTracks(root, [a, b], TOLERANCE)
  assert.equal(bakedA.tracks.length, 2)
  assert.equal(bakedB.tracks.length, 1)
  assert.deepEqual(root.getObjectByName('bone')!.position.toArray(), [0, 0, 0])
})

test('cubic-spline tracks, whose keys carry tangents around the value, are left alone', () => {
  const root = rig()
  // What GLTFLoader builds from a CUBICSPLINE sampler: [in-tangent, value, out-tangent] a key.
  const position = [0, 0, 0, 1, 2, 3, 0, 0, 0]
  const rotation = [0, 0, 0, 0, 0, 0.6, 0, 0.8, 0, 0, 0, 0]
  const clip = (name: string) => new THREE.AnimationClip(name, 1, [
    new THREE.VectorKeyframeTrack('bone.position', [0, 1], [...position, ...position]),
    new THREE.QuaternionKeyframeTrack('bone.quaternion', [0, 1], [...rotation, ...rotation]),
  ])
  const [bakedA, bakedB] = bakeHeldTracks(root, [clip('a'), clip('b')], TOLERANCE)
  assert.equal(bakedA.tracks.length, 2)
  assert.equal(bakedB.tracks.length, 2)
  const bone = root.getObjectByName('bone')!
  assert.deepEqual(bone.position.toArray(), [0, 0, 0])
  assert.deepEqual(bone.quaternion.toArray(), [0, 0, 0, 1])
})

// ---------------------------------------------------------------- the real parrot

const GLTF_PATH = new URL('../../public/assets/models/parrot/Scarlet_macaw-limit-animations.gltf', import.meta.url)

interface ParrotAsset {
  build(): THREE.Object3D
  clips: Record<string, THREE.AnimationClip>
}

/** The parrot's node tree and clips straight from the glTF: the same TRS, hierarchy and
 *  keyframes GLTFLoader builds, without its DOM-bound loading. */
function loadParrot(): ParrotAsset {
  const gltf = JSON.parse(readFileSync(GLTF_PATH, 'utf8'))
  const bytes = Buffer.from(gltf.buffers[0].uri.split(',')[1], 'base64')
  const accessor = (index: number): Float32Array => {
    const info = gltf.accessors[index]
    const view = gltf.bufferViews[info.bufferView]
    const components = ({ SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[info.type]
    const offset = bytes.byteOffset + (view.byteOffset ?? 0) + (info.byteOffset ?? 0)
    return new Float32Array(bytes.buffer.slice(offset, offset + info.count * components * 4))
  }
  const nodeName = (index: number) => `node${index}`
  const build = (): THREE.Object3D => {
    const objects = gltf.nodes.map((node: any, index: number) => {
      const object = new THREE.Bone()
      object.name = nodeName(index)
      if (node.translation) object.position.fromArray(node.translation)
      if (node.rotation) object.quaternion.fromArray(node.rotation)
      if (node.scale) object.scale.fromArray(node.scale)
      return object
    })
    gltf.nodes.forEach((node: any, index: number) => {
      for (const child of node.children ?? []) objects[index].add(objects[child])
    })
    const scene = new THREE.Object3D()
    for (const index of gltf.scenes[gltf.scene ?? 0].nodes) scene.add(objects[index])
    return scene
  }
  const property: Record<string, string> = { translation: 'position', rotation: 'quaternion', scale: 'scale' }
  const clips: Record<string, THREE.AnimationClip> = {}
  for (const animation of gltf.animations) {
    const tracks = animation.channels.map((channel: any) => {
      const sampler = animation.samplers[channel.sampler]
      const name = `${nodeName(channel.target.node)}.${property[channel.target.path]}`
      const times = accessor(sampler.input)
      const values = accessor(sampler.output)
      return channel.target.path === 'rotation'
        ? new THREE.QuaternionKeyframeTrack(name, times, values)
        : new THREE.VectorKeyframeTrack(name, times, values)
    })
    clips[animation.name] = new THREE.AnimationClip(animation.name, -1, tracks)
  }
  return { build, clips }
}

/** field-model-layer.ts's per-bird animation setup and pass weights, on any rig and clips. */
function flyPass(root: THREE.Object3D, flightClip: THREE.AnimationClip, glideClip: THREE.AnimationClip, index: number) {
  const mixer = new THREE.AnimationMixer(root)
  const flight = mixer.clipAction(flightClip)
  flight.setLoop(THREE.LoopRepeat, Infinity)
  flight.setEffectiveTimeScale(EXPERIENCE_CONFIG.parrots.animationSpeed * (0.92 + (index % 5) * 0.035))
  flight.setEffectiveWeight(0.78)
  flight.play()
  flight.time = (index * 0.37) % Math.max(0.1, flightClip.duration)
  const glide = mixer.clipAction(glideClip)
  glide.setLoop(THREE.LoopRepeat, Infinity)
  glide.setEffectiveTimeScale(0.62)
  glide.setEffectiveWeight(0.22)
  glide.play()
  glide.time = (index * 0.53) % Math.max(0.1, glideClip.duration)
  const smooth = (edge0: number, edge1: number, value: number) => {
    const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
  }
  return (progress: number, seconds: number) => {
    const glideWeight = 0.12 + smooth(0.2, 0.72, Math.sin(progress * Math.PI) ** 2) * 0.34
    flight.setEffectiveWeight(1 - glideWeight)
    glide.setEffectiveWeight(glideWeight)
    mixer.update(seconds)
    root.updateMatrixWorld(true)
  }
}

test('the parrot sheds most of its tracks, and a whole pass poses every bone as before', () => {
  const { build, clips } = loadParrot()
  const flightClip = clips.Flight
  const glideClip = clips.Glide
  assert.ok(flightClip && glideClip)

  const baked = build()
  const [flightBaked, glideBaked] = bakeHeldTracks(baked, [flightClip, glideClip], TOLERANCE)
  // 108 of 141 today (33 kept). Only "most" is pinned, so a re-export that holds a few
  // more or fewer still passes; the pose check below is what must hold.
  assert.ok(flightBaked.tracks.length < flightClip.tracks.length / 2, `${flightBaked.tracks.length} of ${flightClip.tracks.length} kept`)
  assert.equal(glideBaked.tracks.length, flightBaked.tracks.length)
  assert.equal(flightBaked.duration, flightClip.duration)
  assert.equal(glideBaked.duration, glideClip.duration)

  // Every bird's own speeds and start times, over one 18 s pass at 60 frames a second.
  const frames = Math.round(EXPERIENCE_CONFIG.parrots.flightDurationMs / 1000 * 60)
  let worst = 0
  for (let index = 0; index < EXPERIENCE_CONFIG.parrots.strongCount; index++) {
    const full = build()
    const pruned = baked.clone(true)
    const fullBones: THREE.Object3D[] = []
    const prunedBones: THREE.Object3D[] = []
    full.traverse((object) => fullBones.push(object))
    pruned.traverse((object) => prunedBones.push(object))
    const stepFull = flyPass(full, flightClip, glideClip, index)
    const stepPruned = flyPass(pruned, flightBaked, glideBaked, index)
    for (let frame = 0; frame < frames; frame++) {
      stepFull(frame / frames, 1 / 60)
      stepPruned(frame / frames, 1 / 60)
      for (let bone = 0; bone < fullBones.length; bone++) {
        const a = fullBones[bone].matrixWorld.elements
        const b = prunedBones[bone].matrixWorld.elements
        for (let element = 0; element < 16; element++) worst = Math.max(worst, Math.abs(a[element] - b[element]))
      }
    }
  }
  // Model units: a parrot is about 190 of them across and drawn at 0.25-0.31 scale, so
  // 1e-3 is a third of a millimetre on the bird (today's worst is 3e-5).
  assert.ok(worst < 1e-3, `largest bone matrix difference ${worst}`)
})
