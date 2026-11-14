// User-supplied 3D artwork model (.glb). Display only: placement checks keep using the artwork's outer box
// (width × depth on the floor), which is conservative for any shape inside it.
//
// The model is kept as its original parts and materials (colour, metalness, roughness, textures), normalised to a
// unit box (x, z ∈ [-0.5, 0.5], y ∈ [0, 1]) so both renderers can stretch it to the artwork's W × H × D. Parts are
// plain arrays + images, because the Matterport bundle builds its scene with its own three.js instance.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Vec2 } from "@artfit/geometry";

type RGB = [number, number, number];
export interface ModelPartMaterial {
  color: RGB; metalness: number; roughness: number; opacity: number; doubleSided: boolean;
  emissive: RGB;
  map: TexImageSource | null; normalMap: TexImageSource | null; ormMap: TexImageSource | null; emissiveMap: TexImageSource | null;
}
export interface ModelPart { positions: Float32Array; normals: Float32Array; uvs: Float32Array | null; index: Uint32Array | null; material: ModelPartMaterial }

export interface ArtworkModel {
  id: string;
  fileName: string;
  title: string;
  /** Attribution from the file's asset metadata (e.g. Sketchfab CC-BY credit), if present. */
  credit: { author: string | null; license: string | null; source: string | null } | null;
  parts: ModelPart[];
  rawSize: { x: number; y: number; z: number }; // outer size in file units (glTF says meters)
  triangles: number;
}

const MAX_BYTES = 60 * 1024 * 1024;
let seq = 0;

const rgb = (c?: THREE.Color | null): RGB => (c ? [c.r, c.g, c.b] : [1, 1, 1]);

export async function loadArtworkModel(file: File): Promise<ArtworkModel> {
  if (!/\.glb$/i.test(file.name)) throw new Error("Use a .glb file (binary glTF).");
  if (file.size > MAX_BYTES) throw new Error(`The file is ${(file.size / 1048576).toFixed(0)} MB; the limit is 60 MB.`);
  const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), "");
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const found: { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld); // also transforms normals
    // Multi-material meshes: split by group so each part keeps its own material.
    if (mats.length > 1 && geo.groups.length) {
      for (const g of geo.groups) {
        const sub = geo.index ? geo.clone() : geo.toNonIndexed();
        if (sub.index) sub.setIndex(Array.from(sub.index.array.slice(g.start, g.start + g.count)));
        found.push({ geo: sub, mat: mats[g.materialIndex ?? 0] ?? mats[0] });
      }
      geo.dispose();
    } else found.push({ geo, mat: mats[0] });
  });
  if (!found.length) throw new Error("The file has no mesh to show.");

  const bb = new THREE.Box3();
  for (const f of found) { f.geo.computeBoundingBox(); bb.union(f.geo.boundingBox!); }
  const size = new THREE.Vector3(); bb.getSize(size);
  if (!(size.x > 0 && size.y > 0 && size.z > 0)) throw new Error("The model has no volume.");
  const mid = new THREE.Vector3(); bb.getCenter(mid);

  let triangles = 0;
  const parts: ModelPart[] = found.map(({ geo, mat }) => {
    geo.translate(-mid.x, -bb.min.y, -mid.z);
    geo.scale(1 / size.x, 1 / size.y, 1 / size.z); // normals are re-normalised by three.js
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const idx = geo.index ? new Uint32Array(geo.index.array) : null;
    triangles += (idx ? idx.length : geo.attributes.position.count) / 3;
    const img = (t?: THREE.Texture | null) => (t?.image ?? null) as TexImageSource | null;
    const part: ModelPart = {
      positions: new Float32Array(geo.attributes.position.array),
      normals: new Float32Array(geo.attributes.normal.array),
      uvs: geo.attributes.uv ? new Float32Array(geo.attributes.uv.array) : null,
      index: idx,
      material: {
        color: rgb(mat?.color), metalness: mat?.metalness ?? 0, roughness: mat?.roughness ?? 1,
        opacity: mat?.transparent ? mat.opacity : 1, doubleSided: mat?.side === THREE.DoubleSide,
        emissive: rgb(mat?.emissive ?? new THREE.Color(0, 0, 0)),
        map: img(mat?.map), normalMap: img(mat?.normalMap), ormMap: img(mat?.metalnessMap ?? mat?.roughnessMap), emissiveMap: img(mat?.emissiveMap),
      },
    };
    geo.dispose();
    return part;
  });

  const extras = (gltf.asset as any)?.extras ?? {};
  return {
    id: `model-${++seq}`,
    fileName: file.name,
    title: typeof extras.title === "string" && extras.title.trim() ? extras.title.trim() : file.name.replace(/\.glb$/i, ""),
    credit: extras.author || extras.license ? { author: extras.author ?? null, license: extras.license ?? null, source: extras.source ?? null } : null,
    parts,
    rawSize: { x: size.x, y: size.y, z: size.z },
    triangles: Math.round(triangles),
  };
}

/**
 * Builds the model with any three.js instance (the app's or the Matterport bundle's). Original materials are used
 * unless the user picked a finish (override). envMap gives metals their reflections; without one, metals would
 * render as flat black.
 */
export function buildModelGroup(T: any, parts: ModelPart[], opts: { override?: { hex: string; roughness: number } | null; conflict?: boolean; envMap?: any; envIntensity?: number }) {
  const group = new T.Group();
  const srgb = (tex: any) => { if ("colorSpace" in tex && T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace; else if (T.sRGBEncoding) tex.encoding = T.sRGBEncoding; };
  const texture = (image: TexImageSource | null, color: boolean) => {
    if (!image) return null;
    const t = new T.Texture(image);
    t.flipY = false; // glTF UV convention
    if (color) srgb(t);
    t.needsUpdate = true;
    return t;
  };
  for (const p of parts) {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(p.positions, 3));
    g.setAttribute("normal", new T.BufferAttribute(p.normals, 3));
    if (p.uvs) g.setAttribute("uv", new T.BufferAttribute(p.uvs, 2));
    if (p.index) g.setIndex(new T.BufferAttribute(p.index, 1));
    const m = p.material, o = opts.override;
    const ormMap = o ? null : texture(m.ormMap, false);
    const mat = new T.MeshStandardMaterial({
      color: o ? new T.Color(o.hex) : new T.Color(m.color[0], m.color[1], m.color[2]),
      metalness: o ? 0 : m.metalness, roughness: o ? o.roughness : m.roughness,
      map: o ? null : texture(m.map, true), normalMap: o ? null : texture(m.normalMap, false),
      metalnessMap: ormMap, roughnessMap: ormMap,
      emissive: o ? new T.Color(0, 0, 0) : new T.Color(m.emissive[0], m.emissive[1], m.emissive[2]),
      emissiveMap: o ? null : texture(m.emissiveMap, true),
      envMap: opts.envMap ?? null, envMapIntensity: opts.envIntensity ?? 1,
      side: m.doubleSided ? T.DoubleSide : T.FrontSide,
      transparent: !!opts.conflict || m.opacity < 1, opacity: opts.conflict ? 0.55 : m.opacity,
    });
    if (opts.conflict) mat.emissive = new T.Color(0.45, 0.04, 0.02);
    const mesh = new T.Mesh(g, mat);
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}

export function disposeGroup(group: any) {
  group?.traverse?.((o: any) => {
    o.geometry?.dispose?.();
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      for (const k of ["map", "normalMap", "metalnessMap", "roughnessMap", "emissiveMap"]) m[k]?.dispose?.();
      m.dispose?.();
    }
  });
}

/**
 * A small neutral "photo studio" (grey room with soft light panels) prefiltered for image-based lighting.
 * Built with whichever three.js instance and renderer will use it.
 */
export function makeStudioEnvironment(T: any, renderer: any) {
  const scene = new T.Scene();
  const room = new T.Mesh(new T.BoxGeometry(10, 6, 10), new T.MeshBasicMaterial({ color: new T.Color(0.32, 0.32, 0.33), side: T.BackSide }));
  room.position.y = 2;
  scene.add(room);
  const panel = (w: number, h: number, x: number, y: number, z: number, intensity: number, rx = 0, ry = 0) => {
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(intensity, intensity, intensity), side: T.DoubleSide }));
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0);
    scene.add(m);
  };
  panel(6, 3, 0, 4.9, 0, 7, Math.PI / 2);           // ceiling softbox
  panel(3, 2.5, -4.9, 2.5, -1, 4, 0, Math.PI / 2);   // key, left
  panel(2.5, 2, 4.9, 2, 1.5, 2.2, 0, -Math.PI / 2);  // fill, right
  panel(4, 1.2, 0, 1.5, -4.9, 1.6);                  // rim, back
  const floor = new T.Mesh(new T.PlaneGeometry(10, 10), new T.MeshBasicMaterial({ color: new T.Color(0.18, 0.18, 0.18) }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.99;
  scene.add(floor);
  const pmrem = new T.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.03).texture;
  pmrem.dispose();
  scene.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  return tex;
}

/**
 * Two sizings for an imported model. glTF units are meters, but many exported models are normalised (Sketchfab,
 * for example), so the file's size is the default only when its height is within 0.5×–2× of the artwork's current
 * height; otherwise the model keeps its proportions at the current height. The other option is offered to the user.
 */
export function importDimensions(m: ArtworkModel, currentHeightM: number) {
  const { x, y, z } = m.rawSize;
  const r2 = (v: number) => Math.max(0.05, Math.round(v * 100) / 100);
  const file = { widthM: r2(x), depthM: r2(z), heightM: r2(y) };
  const k = currentHeightM / y;
  const scaled = { widthM: r2(x * k), depthM: r2(z * k), heightM: r2(currentHeightM) };
  const plausible = y >= currentHeightM * 0.5 && y <= currentHeightM * 2;
  return { file, scaled, useFile: plausible };
}

/** Model proportions at a given height (for "match the model's proportions"). */
export function proportionalDims(m: ArtworkModel, heightM: number) {
  const r2 = (v: number) => Math.max(0.05, Math.round(v * 100) / 100);
  return { widthM: r2((m.rawSize.x / m.rawSize.y) * heightM), depthM: r2((m.rawSize.z / m.rawSize.y) * heightM), heightM: r2(heightM) };
}

/** True when width/depth/height stretch the model more than 10 % away from its own proportions. */
export function isStretched(m: ArtworkModel, d: { widthM: number; depthM: number; heightM: number }) {
  const p = proportionalDims(m, d.heightM);
  return Math.abs(d.widthM / p.widthM - 1) > 0.1 || Math.abs(d.depthM / p.depthM - 1) > 0.1;
}

/** Pose of the artwork's outer box from its 4 floor corners (rectCorners order): centre, width, depth, yaw for three.js. */
export function boxPose(corners: Vec2[]) {
  const [c0, c1, c2] = corners;
  const cx = corners.reduce((t, p) => t + p.x, 0) / corners.length;
  const cz = corners.reduce((t, p) => t + p.z, 0) / corners.length;
  const w = Math.hypot(c1.x - c0.x, c1.z - c0.z);
  const d = Math.hypot(c2.x - c1.x, c2.z - c1.z);
  // three.js rotation.y = θ maps local +x to (cos θ, -sin θ); local +x is the width edge c0 → c1.
  const yaw = Math.atan2(-(c1.z - c0.z), c1.x - c0.x);
  return { cx, cz, w, d, yaw };
}

/** Front photo of the artwork, applied to the box's front face (local +z, W × H). Display only. */
export interface ArtworkPhoto { id: string; fileName: string; canvas: HTMLCanvasElement; aspect: number; thumbUrl: string }

let photoSeq = 0;
export async function loadArtworkPhoto(file: File): Promise<ArtworkPhoto> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) throw new Error("Use a JPG, PNG or WebP photo.");
  if (file.size > 30 * 1024 * 1024) throw new Error("The photo is larger than 30 MB.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // Draw through a canvas: applies the photo's EXIF orientation and caps the texture size.
    const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const t = document.createElement("canvas");
    const tk = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
    t.width = Math.round(canvas.width * tk); t.height = Math.round(canvas.height * tk);
    t.getContext("2d")!.drawImage(canvas, 0, 0, t.width, t.height);
    return { id: `photo-${++photoSeq}`, fileName: file.name, canvas, aspect: canvas.width / canvas.height, thumbUrl: t.toDataURL("image/jpeg", 0.75) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Texture for the front face, cropped to cover a face of the given aspect (centre crop, no stretching). */
export function photoTexture(T: any, photo: { canvas: HTMLCanvasElement; aspect: number }, faceAspect: number) {
  const t = new T.Texture(photo.canvas);
  if ("colorSpace" in t && T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace; else if (T.sRGBEncoding) t.encoding = T.sRGBEncoding;
  if (photo.aspect > faceAspect) { t.repeat.set(faceAspect / photo.aspect, 1); t.offset.set((1 - t.repeat.x) / 2, 0); }
  else { t.repeat.set(1, photo.aspect / faceAspect); t.offset.set(0, (1 - t.repeat.y) / 2); }
  t.needsUpdate = true;
  return t;
}
