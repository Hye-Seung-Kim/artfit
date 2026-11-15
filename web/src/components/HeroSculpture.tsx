// Landing figure: a real sculpture standing in a cut-away gallery corner, at true scale (1 unit = 1 m) next to a
// 1.75 m visitor. The room stays put; drag turns the sculpture like a turntable, the cursor shifts the view a little,
// a click changes the finish. The mint ring is its viewing room and breathes until the first touch.
// Model: "Finite Flame" by John Briscella (Sketchfab), CC BY 4.0 — the credit stays visible.
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, useGLTF } from "@react-three/drei";
import { makeStudioEnvironment } from "../viewer/artworkModel";

const MODEL_URL = "/hero/finite-flame.glb";
const PERSON_URL = "/hero/person-1.75m.glb";
const FINISHES = [
  { name: "Gloss black", color: "#050505", metalness: 1, roughness: 0.12 },
  { name: "Plaster white", color: "#efede8", metalness: 0, roughness: 0.75 },
  { name: "Bronze", color: "#8a5a2b", metalness: 1, roughness: 0.32 },
] as const;
const HEIGHT = 2;            // sculpture height, metres
const ROOM = { x0: -2.1, z0: -2.1, size: 5.0, h: 3.4, t: 0.14 }; // corner at (x0, z0); walls along -x and -z sides
const CAM = new THREE.Vector3(5.4, 3.3, 5.6), TARGET = new THREE.Vector3(-0.05, 1.05, 0);

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function Studio() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const env = makeStudioEnvironment(THREE, gl);
    scene.environment = env;
    return () => { scene.environment = null; env.dispose(); };
  }, [gl, scene]);
  return null;
}

/** Wall segment as a solid box with a dark cut line on top, like a section model. */
function Wall({ x, z, w, d, h, y = 0 }: { x: number; z: number; w: number; d: number; h: number; y?: number }) {
  return <group position={[x, y, z]}>
    <mesh position-y={h / 2} castShadow receiveShadow><boxGeometry args={[w, h, d]} /><meshStandardMaterial color="#f3f3f0" roughness={0.95} metalness={0} /></mesh>
    <mesh position-y={h + 0.006}><boxGeometry args={[w, 0.012, d]} /><meshBasicMaterial color="#111" /></mesh>
  </group>;
}

function Room() {
  const { x0, z0, size, h, t } = ROOM;
  const x1 = x0 + size, z1 = z0 + size;
  const door = { from: 0.7, to: 1.8, h: 2.4 }; // opening in the left wall (along z), metres from the corner
  return <group>
    <mesh rotation-x={-Math.PI / 2} position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]} receiveShadow>
      <planeGeometry args={[size, size]} /><meshStandardMaterial color="#e7e7e3" roughness={0.9} metalness={0} />
    </mesh>
    {/* back wall (along x) */}
    <Wall x={(x0 + x1) / 2 - t / 2} z={z0 - t / 2} w={size + t} d={t} h={h} />
    {/* left wall (along z) with a doorway */}
    <Wall x={x0 - t / 2} z={z0 + door.from / 2} w={t} d={door.from} h={h} />
    <Wall x={x0 - t / 2} z={z0 + door.from + (door.to - door.from) / 2} w={t} d={door.to - door.from} h={h - door.h} y={door.h} />
    <Wall x={x0 - t / 2} z={z0 + door.to + (size - door.to) / 2} w={t} d={size - door.to} h={h} />
  </group>;
}

/** A 1.75 m visitor for scale (model in metres, feet at y = 0, facing +z), turned toward the sculpture. */
function Visitor({ x, z }: { x: number; z: number }) {
  const { scene } = useGLTF(PERSON_URL, false);
  const person = useMemo(() => {
    const o = scene.clone(true);
    o.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.material = new THREE.MeshStandardMaterial({ color: "#9fa29c", roughness: 0.85, metalness: 0 }); } });
    return o;
  }, [scene]);
  return <primitive object={person} position={[x, 0, z]} rotation-y={Math.atan2(-x, -z)} />;
}

function Scene({ finish, onPick, touched, spin, drag }: { finish: number; onPick: () => void; touched: boolean; spin: boolean; drag: React.MutableRefObject<{ v: number; active: boolean }> }) {
  const { scene } = useGLTF(MODEL_URL, false);
  const turn = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const still = useMemo(reducedMotion, []);
  const { camera } = useThree();
  // Fit once: centred on the floor, HEIGHT tall. One shared material so the finish can change.
  const { object, radius, material } = useMemo(() => {
    const object = scene.clone(true);
    const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    object.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = material; m.castShadow = true; } });
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const k = HEIGHT / size.y;
    object.scale.setScalar(k);
    object.position.set(-mid.x * k, -box.min.y * k, -mid.z * k);
    return { object, radius: (Math.max(size.x, size.z) * k) / 2, material };
  }, [scene]);
  useEffect(() => {
    const f = FINISHES[finish];
    material.color.set(f.color); material.metalness = f.metalness; material.roughness = f.roughness; material.needsUpdate = true;
  }, [finish, material]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    // Turntable: drag velocity with friction, otherwise a slow idle spin.
    if (turn.current) {
      const g = drag.current;
      if (!g.active) g.v *= Math.exp(-d * 3);
      turn.current.rotation.y += g.v * d + (spin && !still && Math.abs(g.v) < 0.05 ? 0.25 * d : 0);
    }
    // Cursor parallax on the camera, eased.
    // Narrow (phone) frames step the camera back so the whole room fits.
    const fit = Math.max(1, 1.25 / (state.size.width / Math.max(1, state.size.height)));
    const base = CAM.clone().sub(TARGET).multiplyScalar(fit).add(TARGET);
    const want = still ? base : base.add(new THREE.Vector3(state.pointer.x * 0.8, state.pointer.y * 0.5, -state.pointer.x * 0.8));
    camera.position.lerp(want, still ? 1 : 1 - Math.exp(-d * 3));
    camera.lookAt(TARGET);
    // Viewing-room ring breathes until the first touch, then settles.
    if (ring.current) {
      const s = still || touched ? 1 : 1 + Math.sin(state.clock.elapsedTime * 1.6) * 0.06;
      ring.current.scale.setScalar(ring.current.scale.x + (s - ring.current.scale.x) * Math.min(1, d * 6));
    }
  });

  const outer = radius + 0.9;
  return (
    <group>
      <Room />
      <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.004}>
        <ringGeometry args={[radius + 0.1, outer, 96]} />
        <meshBasicMaterial color="#6bdcc5" transparent opacity={0.7} />
      </mesh>
      <group ref={turn}>
        <primitive object={object}
          onClick={(e: any) => { if (e.delta > 6) return; e.stopPropagation(); onPick(); }}
          onPointerOver={() => { document.body.style.cursor = "pointer"; }}
          onPointerOut={() => { document.body.style.cursor = ""; }} />
      </group>
      <Visitor x={outer + 0.35} z={-0.35} />
      <ContactShadows position-y={0.002} opacity={0.4} scale={7} blur={2.2} far={2.5} />
    </group>
  );
}

export default function HeroSculpture() {
  const [finish, setFinish] = useState(0);
  const [touched, setTouched] = useState(false);
  const [ready, setReady] = useState(false);
  const still = useMemo(reducedMotion, []);
  const drag = useRef({ v: 0, active: false });
  const idle = useRef<ReturnType<typeof setTimeout>>();
  const [spin, setSpin] = useState(!still);
  useEffect(() => () => { clearTimeout(idle.current); document.body.style.cursor = ""; }, []);

  // Horizontal drag anywhere on the figure turns the sculpture; vertical drags still scroll the page on touch.
  const onPointerDown = (e: React.PointerEvent) => {
    const x0 = e.clientX; let last = e.clientX, t = performance.now();
    drag.current.active = true; setTouched(true); setSpin(false); clearTimeout(idle.current);
    const move = (ev: PointerEvent) => {
      const now = performance.now(), dx = ev.clientX - last;
      drag.current.v = (dx * 0.012) / Math.max(0.008, (now - t) / 1000);
      last = ev.clientX; t = now;
      if (Math.abs(ev.clientX - x0) > 3) document.body.style.cursor = "grabbing";
    };
    const up = () => {
      drag.current.active = false; document.body.style.cursor = "";
      if (performance.now() - t > 80) drag.current.v = 0; // released after stopping: no fling
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
      if (!still) idle.current = setTimeout(() => setSpin(true), 4000);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
  };

  return (
    <figure className={"hero-sculpture" + (ready ? " ready" : "")} role="group" onPointerDown={onPointerDown}
      aria-label={`A sculpture in a gallery corner next to a 1.75 m visitor, ${FINISHES[finish].name.toLowerCase()} finish. Drag to turn it; click it to change the finish.`}>
      <Canvas shadows dpr={[1, 2]} camera={{ position: CAM.toArray(), fov: 30 }}
        onCreated={({ camera }) => { camera.lookAt(TARGET); setReady(true); }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}>
        <Studio />
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 7, 3]} intensity={1.3} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004}
          shadow-camera-left={-5} shadow-camera-right={5} shadow-camera-top={5} shadow-camera-bottom={-5} />
        <Suspense fallback={null}>
          <Scene finish={finish} touched={touched} spin={spin} drag={drag} onPick={() => { setTouched(true); setFinish((f) => (f + 1) % FINISHES.length); }} />
        </Suspense>
      </Canvas>
      <span className={"hero-hint" + (touched ? " gone" : "")} aria-hidden="true">Drag to turn · click to change finish</span>
      <figcaption className="hero-credit">
        <a href="https://sketchfab.com/3d-models/finite-flame-4906cc06402547959d19e8ef37c16464" target="_blank" rel="noreferrer">“Finite Flame”</a> by John Briscella · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>
      </figcaption>
    </figure>
  );
}

useGLTF.preload(MODEL_URL, false);
useGLTF.preload(PERSON_URL, false);
