// Matterport Bundle SDK scene component: draws the ArtFit artwork pose, its clearance buffer and conflict
// regions INSIDE the scan, in the same Showcase coordinates the solver uses (x, z floor plane; y up; meters).
// Uses the three.js instance supplied by the bundle (this.context.three), never our own copy.
// Display only: verdicts come from the shared geometry package, not from this file.
import { pointInPolygon, type Vec2 } from "@artfit/geometry";
import { buildHumanFigure, figurePlacement, makeMatcap } from "./humanFigure";
import { buildModelGroup, disposeGroup, makeStudioEnvironment, photoTexture, type ModelPart } from "./artworkModel";

export interface ArtworkSceneSpec {
  artwork: Vec2[];      // 4 corners
  heightM: number;
  floorY: number;
  buffer: Vec2[];       // round clearance buffer outline
  red: Vec2[][];        // conflict regions
  green: Vec2[][];      // passing clearance regions
  conflict: boolean;
  limiter: { a: Vec2; b: Vec2 } | null;
  showFigure: boolean;
  floor?: Vec2[];        // traced region, used to stand the reference figure on the floor
  /** ArtFit edit state: artwork bottom above the floor. Floor overlays, obstacles and figure stay on the floor. */
  baseElevationM?: number;
  colorHex?: string;
  material?: "matte" | "satin" | "gloss";
  /** User-supplied model as unit-sized raw geometry; drawn instead of the box, stretched to the box. */
  model?: { id: string; parts: ModelPart[]; override: { hex: string; roughness: number } | null } | null;
  /** Front photo for the box's front face (local +z, W × H). */
  photo?: { id: string; canvas: HTMLCanvasElement; aspect: number } | null;
}

export const ARTWORK_COMPONENT = "artfit.artwork";

export function artworkComponentFactory() {
  return {
    inputs: { spec: null as ArtworkSceneSpec | null },
    // outputs.objectRoot is reserved by the SDK: assign it in onInit, never declare it here.
    group: null as any,
    // Geometry for the imported model, built once per model with the bundle's three.js and reused across edits.
    modelGroup: null as any,
    modelKey: null as string | null,
    env: null as any,
    envTried: false,
    onInit(this: any) {
      const THREE = this.context.three;
      this.group = new THREE.Group();
      this.group.name = "artfit-artwork";
      this.outputs.objectRoot = this.group;
      this.rebuild();
    },
    onInputsUpdated(this: any) { this.rebuild(); },
    onDestroy(this: any) { this.clear(); disposeGroup(this.modelGroup); this.modelGroup = null; this.env?.dispose?.(); this.env = null; },
    clear(this: any) {
      if (!this.group) return;
      for (const child of [...this.group.children]) {
        this.group.remove(child);
        if (child.userData?.cachedModel) continue; // reused across edits; disposed when the model changes
        child.traverse?.((o: any) => { o.geometry?.dispose?.(); (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => { m?.map?.dispose?.(); m?.dispose?.(); }); });
      }
    },
    rebuild(this: any) {
      const THREE = this.context?.three;
      const spec: ArtworkSceneSpec | null = this.inputs.spec;
      if (!THREE || !this.group) return;
      this.clear();
      if (!spec || spec.artwork.length < 3) return;
      const y0 = spec.floorY;
      // Shapes are built in (x, -z) and rotated -90° about X so they land on the (x, z) floor plane.
      const shape = (poly: Vec2[]) => new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x, -p.z)));
      const flat = (poly: Vec2[], color: number, opacity: number, lift: number) => {
        const m = new THREE.Mesh(new THREE.ShapeGeometry(shape(poly)), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
        m.rotation.x = -Math.PI / 2; m.position.y = y0 + lift; m.renderOrder = 2;
        return m;
      };
      const line = (pts: Vec2[], color: number, lift: number, closed = true) => {
        const arr = (closed ? [...pts, pts[0]] : pts).map((p) => new THREE.Vector3(p.x, y0 + lift, p.z));
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arr), new THREE.LineBasicMaterial({ color }));
        l.renderOrder = 3;
        return l;
      };
      for (const g of spec.green) this.group.add(flat(g, 0x3fa66a, 0.35, 0.01));
      for (const r of spec.red) this.group.add(flat(r, 0xd93025, 0.6, 0.015));
      this.group.add(line(spec.buffer, spec.red.length ? 0xd93025 : 0x2e7d4f, 0.02));
      // Artwork body: finish color with unlit matcap shading (no lights added to the scan), lifted by baseElevationM.
      const lift = Math.max(0, spec.baseElevationM ?? 0);
      const color = new THREE.Color(spec.colorHex ?? "#171717");
      const variant = spec.material === "gloss" ? "gloss" : spec.material === "satin" ? "satin" : "soft";
      if (spec.model) {
        // Original materials with image-based lighting from the scan's own renderer (falls back to unlit if absent).
        if (!this.envTried) {
          this.envTried = true;
          const renderer = this.context?.renderer;
          try { this.env = renderer ? makeStudioEnvironment(THREE, renderer) : null; } catch { this.env = null; }
        }
        const key = `${spec.model.id}|${spec.model.override ? spec.model.override.hex + spec.model.override.roughness : ""}|${spec.conflict}`;
        if (this.modelKey !== key) {
          disposeGroup(this.modelGroup);
          this.modelGroup = buildModelGroup(THREE, spec.model.parts, { override: spec.model.override, conflict: spec.conflict, envMap: this.env });
          if (!this.env) {
            // No renderer for IBL: add a simple light rig to the model group so it is not black.
            this.modelGroup.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
            const key2 = new THREE.DirectionalLight(0xffffff, 2); key2.position.set(2, 4, 3); this.modelGroup.add(key2);
          }
          this.modelGroup.userData.cachedModel = true;
          this.modelKey = key;
        }
        const [c0, c1, c2] = spec.artwork;
        const cx = spec.artwork.reduce((t, p) => t + p.x, 0) / spec.artwork.length;
        const cz = spec.artwork.reduce((t, p) => t + p.z, 0) / spec.artwork.length;
        const body = this.modelGroup;
        body.scale.set(Math.hypot(c1.x - c0.x, c1.z - c0.z), spec.heightM, Math.hypot(c2.x - c1.x, c2.z - c1.z));
        body.rotation.set(0, Math.atan2(-(c1.z - c0.z), c1.x - c0.x), 0);
        body.position.set(cx, y0 + lift, cz);
        this.group.add(body);
        if (lift === 0) this.group.add(line(spec.artwork, 0x111111, 0.025)); // outer box used by the plan check
      } else {
        const geo = new THREE.ExtrudeGeometry(shape(spec.artwork), { depth: spec.heightM, bevelEnabled: false });
        const body = new THREE.Mesh(geo, new THREE.MeshMatcapMaterial({ matcap: makeMatcap(THREE, variant), color, transparent: true, opacity: spec.conflict ? 0.55 : 0.88 }));
        body.rotation.x = -Math.PI / 2; body.position.y = y0 + lift;
        const lum = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: spec.conflict ? 0xd93025 : lum > 0.5 ? 0x111111 : 0xffffff }));
        edges.rotation.x = -Math.PI / 2; edges.position.y = y0 + lift;
        this.group.add(body, edges);
        if (spec.photo && !spec.conflict) {
          const [c0, c1, c2] = spec.artwork;
          const w = Math.hypot(c1.x - c0.x, c1.z - c0.z), d = Math.hypot(c2.x - c1.x, c2.z - c1.z);
          const tex = photoTexture(THREE, spec.photo, Math.round((w / spec.heightM) * 100) / 100);
          // Unlit, like the rest of the overlay, so the photo reads true against the scan.
          const face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex }));
          face.scale.set(w, spec.heightM, 1);
          face.position.set(0, spec.heightM / 2, d / 2 + 0.004);
          const holder = new THREE.Group();
          holder.position.set(spec.artwork.reduce((t, p) => t + p.x, 0) / 4, y0 + lift, spec.artwork.reduce((t, p) => t + p.z, 0) / 4);
          holder.rotation.y = Math.atan2(-(c1.z - c0.z), c1.x - c0.x);
          holder.add(face);
          this.group.add(holder);
        }
      }
      if (lift > 0) {
        // floor projection (used by the plan check) and vertical guides
        this.group.add(line(spec.artwork, 0x111111, 0.025));
        for (const p of spec.artwork) {
          const g = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, y0 + 0.025, p.z), new THREE.Vector3(p.x, y0 + lift, p.z)]), new THREE.LineBasicMaterial({ color: 0x666666 }));
          this.group.add(g);
        }
      }
      if (spec.limiter) this.group.add(line([spec.limiter.a, spec.limiter.b], 0x111111, 0.05, false));
      if (spec.showFigure) {
        // 1.70 m reference figure standing just outside the clearance buffer, facing the artwork
        const c = { x: spec.artwork.reduce((t, p) => t + p.x, 0) / spec.artwork.length, z: spec.artwork.reduce((t, p) => t + p.z, 0) / spec.artwork.length };
        const at = figurePlacement(c, spec.buffer, spec.floor ?? null, pointInPolygon);
        const fig = buildHumanFigure(THREE);
        fig.position.set(at.x, y0, at.z);
        fig.rotation.y = at.yaw;
        this.group.add(fig);
      }
    },
  };
}
