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
  /** Group show: all works (colour = artist) and the walkable route; replaces the single-artwork drawing. */
  group?: {
    works: { corners: Vec2[]; heightM: number; colorHex: string; issue: boolean; label: string; viewPoint: Vec2 | null; selected: boolean;
      model?: { id: string; parts: ModelPart[] } | null; photo?: { id: string; canvas: HTMLCanvasElement; aspect: number } | null }[];
    route: Vec2[]; entrance: Vec2 | null;
  } | null;
  /** Front photo for the box's front face (local +z, W × H). */
  photo?: { id: string; canvas: HTMLCanvasElement; aspect: number } | null;
}


/** Without an environment map, swap the model's PBR materials for unlit matcap ones. Never add lights: lights in the
 * Matterport scene make Showcase recompile every scan material and freeze the page. */
function toMatcap(THREE: any, group: any) {
  const matcap = makeMatcap(THREE, "gloss");
  group.traverse((o: any) => {
    if (!o.isMesh) return;
    const old = o.material;
    o.material = new THREE.MeshMatcapMaterial({ matcap, color: old.color, map: old.map ?? null, side: old.side, transparent: old.transparent, opacity: old.opacity });
    old.dispose?.();
  });
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
    groupModels: new Map<string, any>(), // per work slot + model id, reused across edits
    onInit(this: any) {
      const THREE = this.context.three;
      this.group = new THREE.Group();
      this.group.name = "artfit-artwork";
      this.outputs.objectRoot = this.group;
      this.rebuild();
    },
    onInputsUpdated(this: any) { this.rebuild(); },
    onDestroy(this: any) { this.clear(); for (const g of this.groupModels.values()) disposeGroup(g); this.groupModels.clear(); disposeGroup(this.modelGroup); this.modelGroup = null; this.env?.dispose?.(); this.env = null; },
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
      if (spec.group) {
        // Text tag that always faces the camera and stays readable over the scan.
        const tag = (text: string, at: Vec2, y: number, opts: { dark?: boolean; bad?: boolean } = {}) => {
          const c = document.createElement("canvas");
          const ctx = c.getContext("2d")!;
          ctx.font = "600 36px Helvetica Neue, Helvetica, Arial, sans-serif";
          const w = Math.ceil(ctx.measureText(text).width) + 36;
          c.width = w; c.height = 60;
          ctx.font = "600 36px Helvetica Neue, Helvetica, Arial, sans-serif";
          ctx.fillStyle = opts.dark ? "#090a09" : "rgba(255,255,255,0.94)"; ctx.fillRect(0, 0, w, 60);
          ctx.strokeStyle = opts.bad ? "#d93025" : "#090a09"; ctx.lineWidth = 4; ctx.strokeRect(2, 2, w - 4, 56);
          ctx.fillStyle = opts.dark ? "#6bdcc5" : opts.bad ? "#d93025" : "#090a09"; ctx.textBaseline = "middle"; ctx.fillText(text, 18, 32);
          const tex = new THREE.CanvasTexture(c);
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
          sp.scale.set((w / 60) * 0.32, 0.32, 1);
          sp.position.set(at.x, y, at.z);
          sp.renderOrder = 10;
          return sp;
        };
        const ensureEnv = () => {
          if (!this.envTried) { this.envTried = true; try { this.env = this.context?.renderer ? makeStudioEnvironment(THREE, this.context.renderer) : null; } catch { this.env = null; } }
          return this.env;
        };
        const usedKeys = new Set<string>();
        for (const [wi, w] of spec.group.works.entries()) {
          const [c0, c1, c2] = w.corners;
          const cxw = w.corners.reduce((t, p) => t + p.x, 0) / w.corners.length, czw = w.corners.reduce((t, p) => t + p.z, 0) / w.corners.length;
          const yaw = Math.atan2(-(c1.z - c0.z), c1.x - c0.x), ww = Math.hypot(c1.x - c0.x, c1.z - c0.z), dd = Math.hypot(c2.x - c1.x, c2.z - c1.z);
          if (w.model) {
            // The work's own .glb (original materials), stretched to its real size.
            const key = `${wi}|${w.model.id}|${w.issue}`;
            usedKeys.add(key);
            let mg = this.groupModels.get(key);
            if (!mg) {
              mg = buildModelGroup(THREE, w.model.parts, { conflict: w.issue, envMap: ensureEnv() });
              if (!this.env) toMatcap(THREE, mg);
              mg.userData.cachedModel = true;
              this.groupModels.set(key, mg);
            }
            mg.scale.set(ww, w.heightM, dd); mg.rotation.set(0, yaw, 0); mg.position.set(cxw, y0, czw);
            this.group.add(mg);
            this.group.add(line(w.corners, w.selected ? 0x6bdcc5 : 0x111111, 0.025));
            this.group.add(tag(w.label, { x: cxw, z: czw }, y0 + w.heightM + 0.3, { dark: w.selected, bad: w.issue }));
            if (w.viewPoint) {
              const ring = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.22, 32), new THREE.MeshBasicMaterial({ color: 0x1f7a68, side: THREE.DoubleSide, depthWrite: false, transparent: true, opacity: 0.95 }));
              ring.rotation.x = -Math.PI / 2; ring.position.set(w.viewPoint.x, y0 + 0.03, w.viewPoint.z); ring.renderOrder = 4;
              this.group.add(ring);
            }
            continue;
          }
          if (w.photo && !w.issue) {
            const face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: photoTexture(THREE, w.photo, Math.round((ww / w.heightM) * 100) / 100) }));
            face.scale.set(ww, w.heightM, 1); face.position.set(0, w.heightM / 2, dd / 2 + 0.004);
            const holder = new THREE.Group(); holder.position.set(cxw, y0, czw); holder.rotation.y = yaw; holder.add(face);
            this.group.add(holder);
          }
          const geo = new THREE.ExtrudeGeometry(shape(w.corners), { depth: w.heightM, bevelEnabled: false });
          const body = new THREE.Mesh(geo, new THREE.MeshMatcapMaterial({ matcap: makeMatcap(THREE, "soft"), color: new THREE.Color(w.issue ? "#d93025" : w.colorHex), transparent: true, opacity: w.issue ? 0.6 : 0.9 }));
          body.rotation.x = -Math.PI / 2; body.position.y = y0;
          const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: w.selected ? 0x6bdcc5 : w.issue ? 0xd93025 : 0xffffff }));
          edges.rotation.x = -Math.PI / 2; edges.position.y = y0;
          this.group.add(body, edges);
          const c = { x: w.corners.reduce((t, p) => t + p.x, 0) / w.corners.length, z: w.corners.reduce((t, p) => t + p.z, 0) / w.corners.length };
          this.group.add(tag(w.label, c, y0 + w.heightM + 0.3, { dark: w.selected, bad: w.issue }));
          if (w.viewPoint) {
            // Standing spot: a ring on the floor.
            const ring = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.22, 32), new THREE.MeshBasicMaterial({ color: 0x1f7a68, side: THREE.DoubleSide, depthWrite: false, transparent: true, opacity: 0.95 }));
            ring.rotation.x = -Math.PI / 2; ring.position.set(w.viewPoint.x, y0 + 0.03, w.viewPoint.z); ring.renderOrder = 4;
            this.group.add(ring);
          }
        }
        const route = spec.group.route;
        if (route.length > 1) {
          // Route as a flat 18 cm ribbon on the floor (GL lines are 1 px), with chevrons pointing the walking direction.
          const pos: number[] = [];
          const half = 0.09;
          for (let k = 0; k < route.length - 1; k++) {
            const a = route[k], b = route[k + 1];
            const L = Math.hypot(b.x - a.x, b.z - a.z);
            if (L < 1e-6) continue;
            const nx = -(b.z - a.z) / L * half, nz = (b.x - a.x) / L * half;
            const y = y0 + 0.035;
            pos.push(a.x + nx, y, a.z + nz, a.x - nx, y, a.z - nz, b.x + nx, y, b.z + nz, b.x + nx, y, b.z + nz, a.x - nx, y, a.z - nz, b.x - nx, y, b.z - nz);
            for (let s = 0.6; s < L - 0.2; s += 1.2) {
              const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L, px = a.x + ux * s, pz = a.z + uz * s;
              const tip = { x: px + ux * 0.16, z: pz + uz * 0.16 }, l = { x: px - ux * 0.06 + nx * 1.6, z: pz - uz * 0.06 + nz * 1.6 }, r = { x: px - ux * 0.06 - nx * 1.6, z: pz - uz * 0.06 - nz * 1.6 };
              pos.push(l.x, y + 0.002, l.z, tip.x, y + 0.002, tip.z, r.x, y + 0.002, r.z);
            }
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
          const ribbon = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x1f7a68, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
          ribbon.renderOrder = 5;
          this.group.add(ribbon);
        }
        if (spec.group.entrance) this.group.add(tag("Entrance", spec.group.entrance, y0 + 0.5));
        for (const [k, g] of this.groupModels) if (!usedKeys.has(k)) { disposeGroup(g); this.groupModels.delete(k); }
        return;
      }
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
          if (!this.env) toMatcap(THREE, this.modelGroup); // no renderer for IBL: unlit, and no lights added
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
