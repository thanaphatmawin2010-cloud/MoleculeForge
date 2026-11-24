/**
 * 3D molecular viewer (Three.js). Atoms and bonds are GPU-instanced, so thousands of atoms
 * render at interactive frame rates; frames render on demand and continuously only while
 * something animates (halo pulse, vibration). Picking uses instance ids.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { cx } from "@/design-system/primitives";
import type { Molecule } from "@/ipc/schema";
import { CPK_FALLBACK } from "@/lib/chemistry";
import { covalentRadius, formulaOf } from "@/lib/molecule";
import { useApp } from "@/state/app";

export type RenderStyle = "ball-and-stick" | "spacefill" | "sticks";

export interface Viewer3DProps {
  molecule: Molecule;
  selectedAtoms?: number[];
  errorAtoms?: Set<number>;
  warningAtoms?: Set<number>;
  style?: RenderStyle;
  /** Normal-mode displacement vectors (Å, per atom) to animate, or null. */
  vibration?: number[][] | null;
  onAtomClick?: (index: number, event: MouseEvent) => void;
  onBackgroundClick?: (point: [number, number, number], event: MouseEvent) => void;
  className?: string;
  testId?: string;
  fitKey?: string;
}

const VDW: Record<string, number> = { H: 1.2, C: 1.7, N: 1.55, O: 1.52, F: 1.47, P: 1.8, S: 1.8, Cl: 1.75, Br: 1.85, I: 1.98 };

function cssColor(variable: string): THREE.Color {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  const color = new THREE.Color();
  color.setStyle(`hsl(${raw.split(" ").join(", ")})`);
  return color;
}

/** True when WebGL is served by a CPU rasteriser (SwiftShader, llvmpipe, softpipe). */
function softwareRenderer(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software/i.test(name);
  } catch {
    return false;
  }
}

export function Viewer3D({
  molecule,
  selectedAtoms = [],
  errorAtoms,
  warningAtoms,
  style = "ball-and-stick",
  vibration = null,
  onAtomClick,
  onBackgroundClick,
  className,
  testId = "viewer-3d",
  fitKey,
}: Viewer3DProps) {
  const { t } = useTranslation();
  const theme = useApp((s) => s.theme);
  const elements = useApp((s) => s.elements);
  const host = useRef<HTMLDivElement>(null);
  const [webglMissing, setWebglMissing] = useState(false);
  const three = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    atoms: THREE.InstancedMesh;
    bonds: THREE.InstancedMesh;
    halos: THREE.InstancedMesh;
    selection: THREE.InstancedMesh;
    requestRender: () => void;
    animating: { halos: boolean; vibration: boolean };
    dispose: () => void;
  } | null>(null);
  const latest = useRef({ molecule, onAtomClick, onBackgroundClick, vibration });
  latest.current = { molecule, onAtomClick, onBackgroundClick, vibration };

  const cpk = useMemo(() => {
    const map = new Map<string, string>();
    for (const el of elements) map.set(el.symbol, el.cpkColorHex);
    return (symbol: string) => map.get(symbol) ?? CPK_FALLBACK[symbol] ?? "#ff1493";
  }, [elements]);

  // ---- scene setup (once)
  useEffect(() => {
    const container = host.current!;
    let renderer: THREE.WebGLRenderer;
    const software = softwareRenderer();
    try {
      // Multisampling is nearly free on a GPU but costs several times the frame time when WebGL
      // falls back to a CPU rasteriser (no GPU driver, virtual machines).
      renderer = new THREE.WebGLRenderer({ antialias: !software, alpha: false, powerPreference: "high-performance" });
    } catch {
      container.dataset.webgl = "unavailable";
      setWebglMissing(true);
      return;
    }
    renderer.setPixelRatio(software ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    camera.position.set(0, 0, 12);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.8;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 6, 8);
    camera.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(-6, -2, -4);
    camera.add(rim);
    scene.add(camera);

    const make = (geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) => {
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    };
    const atoms = make(new THREE.SphereGeometry(1, 32, 20), new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.04 }), 64);
    const bonds = make(new THREE.CylinderGeometry(1, 1, 1, 18, 1, false), new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.03 }), 128);
    const halos = make(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false }), 16);
    const selection = make(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, depthWrite: false }), 16);

    let frame = 0;
    let dirty = true;
    const animating = { halos: false, vibration: false };
    const requestRender = () => {
      dirty = true;
    };
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      const moving = controls.update();
      if (animating.halos) {
        const s = 1 + 0.08 * Math.sin(time / 260);
        halos.scale.setScalar(1);
        (halos.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.14 * (0.5 + 0.5 * Math.sin(time / 260));
        halos.userData.pulse = s;
        dirty = true;
      }
      if (animating.vibration) {
        writeAtoms(time);
        dirty = true;
      }
      if (dirty || moving) {
        renderer.render(scene, camera);
        dirty = false;
      }
    };
    frame = requestAnimationFrame(tick);
    controls.addEventListener("change", requestRender);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      requestRender();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    // Picking
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downAt = { x: 0, y: 0 };
    const onDown = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4 || e.button !== 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(atoms, false)[0];
      if (hit && hit.instanceId !== undefined) {
        latest.current.onAtomClick?.(hit.instanceId, e);
      } else if (latest.current.onBackgroundClick) {
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), controls.target);
        const point = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(plane, point)) latest.current.onBackgroundClick([point.x, point.y, point.z], e);
      }
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    function writeAtoms(time: number) {
      const state = three.current;
      if (!state) return;
      const { molecule: mol, vibration: modes } = latest.current;
      const amp = modes ? Math.sin(time / 140) * 0.9 : 0;
      const m4 = new THREE.Matrix4();
      mol.atoms.forEach((a, i) => {
        const d = modes?.[i];
        const r = state.atoms.userData.radii?.[i] ?? 0.3;
        m4.makeScale(r, r, r).setPosition(a.x + (d ? d[0]! * amp : 0), a.y + (d ? d[1]! * amp : 0), a.z + (d ? d[2]! * amp : 0));
        state.atoms.setMatrixAt(i, m4);
      });
      state.atoms.instanceMatrix.needsUpdate = true;
    }

    three.current = {
      renderer, scene, camera, controls, atoms, bonds, halos, selection, requestRender, animating,
      dispose: () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointerup", onUp);
        controls.dispose();
        for (const mesh of [atoms, bonds, halos, selection]) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material).dispose();
        }
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
    return () => {
      three.current?.dispose();
      three.current = null;
    };
  }, []);

  // ---- theme
  useEffect(() => {
    const state = three.current;
    if (!state) return;
    state.scene.background = cssColor("--viewport-bg");
    (state.halos.material as THREE.MeshBasicMaterial).color = cssColor("--danger");
    (state.selection.material as THREE.MeshBasicMaterial).color = cssColor("--accent");
    state.requestRender();
  }, [theme]);

  // ---- geometry upload
  useEffect(() => {
    const state = three.current;
    if (!state) return;
    const atoms = molecule.atoms;
    const grow = (mesh: THREE.InstancedMesh, needed: number, key: "atoms" | "bonds" | "halos" | "selection") => {
      if (needed <= mesh.instanceMatrix.count) return mesh;
      const capacity = Math.max(needed, mesh.instanceMatrix.count * 2);
      const next = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
      next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      next.frustumCulled = false;
      next.userData = { ...mesh.userData };
      state.scene.remove(mesh);
      state.scene.add(next);
      state[key] = next;
      return next;
    };
    // Level of detail: typical molecules keep smooth spheres; large systems trade facets for
    // frame rate (about 7× fewer triangles above 1,500 atoms). Bond ends are hidden inside the
    // atom spheres, so the cheaper tiers drop the cylinder caps.
    const tier = atoms.length > 1500 ? 2 : atoms.length > 300 ? 1 : 0;
    const atomMesh = grow(state.atoms, atoms.length, "atoms");
    if (atomMesh.userData.tier !== tier) {
      atomMesh.geometry.dispose();
      atomMesh.geometry = new THREE.SphereGeometry(1, [32, 16, 10][tier], [20, 12, 7][tier]);
      atomMesh.userData.tier = tier;
    }
    if (state.bonds.userData.tier !== tier) {
      state.bonds.geometry.dispose();
      state.bonds.geometry = new THREE.CylinderGeometry(1, 1, 1, [18, 10, 6][tier], 1, tier > 0);
      state.bonds.userData.tier = tier;
    }
    const radii = atoms.map((a) =>
      style === "spacefill" ? VDW[a.el] ?? 1.9 : style === "sticks" ? 0.16 : Math.max(0.17, Math.min(0.42, covalentRadius(a.el) * 0.42)),
    );
    atomMesh.userData.radii = radii;
    const m4 = new THREE.Matrix4();
    const color = new THREE.Color();
    atoms.forEach((a, i) => {
      m4.makeScale(radii[i]!, radii[i]!, radii[i]!).setPosition(a.x, a.y, a.z);
      atomMesh.setMatrixAt(i, m4);
      atomMesh.setColorAt(i, color.set(cpk(a.el)).convertSRGBToLinear());
    });
    atomMesh.count = atoms.length;
    atomMesh.instanceMatrix.needsUpdate = true;
    if (atomMesh.instanceColor) atomMesh.instanceColor.needsUpdate = true;

    // bonds: two half-cylinders per bond line, offset lines for multiple bonds
    const segments: { from: THREE.Vector3; to: THREE.Vector3; el: string; radius: number }[] = [];
    if (style !== "spacefill") {
      const up = new THREE.Vector3();
      for (const b of molecule.bonds) {
        const pa = atoms[b.a];
        const pb = atoms[b.b];
        if (!pa || !pb) continue;
        const A = new THREE.Vector3(pa.x, pa.y, pa.z);
        const B = new THREE.Vector3(pb.x, pb.y, pb.z);
        const axis = B.clone().sub(A).normalize();
        up.set(0, 0, 1);
        if (Math.abs(axis.dot(up)) > 0.9) up.set(0, 1, 0);
        const perp = new THREE.Vector3().crossVectors(axis, up).normalize();
        const lines = b.order === "double" || b.order === "aromatic" ? 2 : b.order === "triple" ? 3 : 1;
        const radius = style === "sticks" ? 0.16 : lines === 1 ? 0.11 : 0.075;
        const spread = 0.17;
        for (let k = 0; k < lines; k++) {
          const offset = lines === 1 ? 0 : lines === 2 ? (k - 0.5) * spread * 1.4 : (k - 1) * spread;
          const shift = perp.clone().multiplyScalar(offset);
          const a2 = A.clone().add(shift);
          const b2 = B.clone().add(shift);
          const mid = a2.clone().add(b2).multiplyScalar(0.5);
          const r = b.order === "aromatic" && k === 1 ? radius * 0.6 : radius;
          segments.push({ from: a2, to: mid, el: pa.el, radius: r });
          segments.push({ from: mid, to: b2, el: pb.el, radius: r });
        }
      }
    }
    const bondMesh = grow(state.bonds, segments.length, "bonds");
    const yAxis = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    segments.forEach((s, i) => {
      const dir = s.to.clone().sub(s.from);
      const len = dir.length();
      q.setFromUnitVectors(yAxis, dir.normalize());
      m4.compose(s.from.clone().add(s.to).multiplyScalar(0.5), q, new THREE.Vector3(s.radius, len, s.radius));
      bondMesh.setMatrixAt(i, m4);
      bondMesh.setColorAt(i, color.set(cpk(s.el)).convertSRGBToLinear());
    });
    bondMesh.count = segments.length;
    bondMesh.instanceMatrix.needsUpdate = true;
    if (bondMesh.instanceColor) bondMesh.instanceColor.needsUpdate = true;
    state.requestRender();
  }, [molecule, style, cpk]);

  // ---- selection + issue halos
  useEffect(() => {
    const state = three.current;
    if (!state) return;
    const m4 = new THREE.Matrix4();
    const radii: number[] = state.atoms.userData.radii ?? [];
    const flagged = [...(errorAtoms ?? []), ...[...(warningAtoms ?? [])].filter((i) => !errorAtoms?.has(i))];
    const halos = flagged.filter((i) => molecule.atoms[i]);
    if (halos.length > state.halos.instanceMatrix.count) {
      const next = new THREE.InstancedMesh(state.halos.geometry, state.halos.material, halos.length * 2);
      state.scene.remove(state.halos);
      state.scene.add(next);
      next.frustumCulled = false;
      state.halos = next;
    }
    halos.forEach((i, k) => {
      const a = molecule.atoms[i]!;
      const r = (radii[i] ?? 0.3) * 1.9 + 0.25;
      m4.makeScale(r, r, r).setPosition(a.x, a.y, a.z);
      state.halos.setMatrixAt(k, m4);
    });
    state.halos.count = halos.length;
    state.halos.instanceMatrix.needsUpdate = true;
    state.animating.halos = halos.length > 0;
    const sel = selectedAtoms.filter((i) => molecule.atoms[i]);
    if (sel.length > state.selection.instanceMatrix.count) {
      const next = new THREE.InstancedMesh(state.selection.geometry, state.selection.material, sel.length * 2);
      state.scene.remove(state.selection);
      state.scene.add(next);
      next.frustumCulled = false;
      state.selection = next;
    }
    sel.forEach((i, k) => {
      const a = molecule.atoms[i]!;
      const r = (radii[i] ?? 0.3) * 1.45 + 0.12;
      m4.makeScale(r, r, r).setPosition(a.x, a.y, a.z);
      state.selection.setMatrixAt(k, m4);
    });
    state.selection.count = sel.length;
    state.selection.instanceMatrix.needsUpdate = true;
    state.requestRender();
  }, [molecule, selectedAtoms, errorAtoms, warningAtoms]);

  // ---- vibration animation toggle
  useEffect(() => {
    const state = three.current;
    if (!state) return;
    state.animating.vibration = Boolean(vibration);
    if (!vibration) {
      // restore rest positions
      const m4 = new THREE.Matrix4();
      const radii: number[] = state.atoms.userData.radii ?? [];
      molecule.atoms.forEach((a, i) => {
        const r = radii[i] ?? 0.3;
        m4.makeScale(r, r, r).setPosition(a.x, a.y, a.z);
        state.atoms.setMatrixAt(i, m4);
      });
      state.atoms.instanceMatrix.needsUpdate = true;
      state.requestRender();
    }
  }, [vibration, molecule]);

  // ---- camera fit when a new molecule (or atom count change from empty) arrives
  const fitSignature = fitKey ?? `${molecule.id}:${molecule.atoms.length > 0}`;
  useEffect(() => {
    const state = three.current;
    if (!state || molecule.atoms.length === 0) return;
    const box = new THREE.Box3();
    for (const a of molecule.atoms) box.expandByPoint(new THREE.Vector3(a.x, a.y, a.z));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1.5) + 1.2;
    const dist = radius / Math.sin((state.camera.fov * Math.PI) / 360);
    const dir = state.camera.position.clone().sub(state.controls.target).normalize();
    state.controls.target.copy(sphere.center);
    state.camera.position.copy(sphere.center.clone().add(dir.multiplyScalar(dist)));
    state.camera.near = Math.max(0.05, dist / 200);
    state.camera.far = dist * 20;
    state.camera.updateProjectionMatrix();
    state.requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignature]);

  useEffect(() => {
    const handler = () => {
      const state = three.current;
      if (!state || molecule.atoms.length === 0) return;
      const box = new THREE.Box3();
      for (const a of molecule.atoms) box.expandByPoint(new THREE.Vector3(a.x, a.y, a.z));
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const dist = (Math.max(sphere.radius, 1.5) + 1.2) / Math.sin((state.camera.fov * Math.PI) / 360);
      state.controls.target.copy(sphere.center);
      state.camera.position.copy(sphere.center.clone().add(new THREE.Vector3(0, 0, dist)));
      state.requestRender();
    };
    window.addEventListener("mf:fit3d", handler);
    return () => window.removeEventListener("mf:fit3d", handler);
  }, [molecule]);

  return (
    <div
      ref={host}
      className={cx("relative overflow-hidden bg-viewport", className)}
      data-testid={testId}
      data-atoms={molecule.atoms.length}
      role="img"
      aria-label={t("canvas.viewerLabel", { count: molecule.atoms.length, formula: molecule.formula || formulaOf(molecule) })}
    >
      {webglMissing && (
        <p className="absolute inset-0 grid place-items-center p-6 text-center text-xs leading-5 text-ink-3" data-testid="webgl-missing">
          {t("canvas.webglMissing")}
        </p>
      )}
    </div>
  );
}
