/**
 * Three.js view of a match: three floors of instanced hex tiles, the characters, power-ups and a camera per player.
 * It only draws what a Snapshot says; it never decides anything about the game.
 */
import * as THREE from 'three';
import { ARENA, PHYSICS } from '../shared/config';
import { hexToWorld, worldToHex } from '../shared/hex';
import { TRAILS, type Look } from '../shared/rewards';
import { CRACKING, HEX_LIST, MISSING, TILE_COUNT, decodeTile, floorY, tileIndex, type GameEvent, type PlayerView, type Snapshot } from '../shared/sim';
import { createCharacter, type Character } from './characters';

/** Clearly contrasting player marker colours, used everywhere a player is identified. */
export const SEAT_COLORS = ['#ff4d6d', '#3a86ff'];
const FLOOR_COLORS = ['#8be9c7', '#a9b8ff', '#ffd47a'];
const CRACK_COLOR = new THREE.Color('#ff5a36');
const WARN_COLOR = new THREE.Color('#ffe14d');
const CAMERA_OFFSET = new THREE.Vector3(0, 9.6, 9.4);
const CAMERA_FOV = 48;
/** Half the size of one floor in world units (x across, z deep), edge tiles included. */
const ARENA_HALF = (() => {
  let x = 0, z = 0;
  for (const h of HEX_LIST) { const w = hexToWorld(h.q, h.r); x = Math.max(x, Math.abs(w.x)); z = Math.max(z, Math.abs(w.z)); }
  return { x: x + ARENA.tileSize * .9, z: z + ARENA.tileSize };
})();
export interface Inset { top: number; bottom: number }

export interface ViewSpec { seat: number }

/** A hexagonal prism whose top sits at y = 0, coloured lighter on top and darker on the sides so edges read. */
function tileGeometry() {
  const g = new THREE.CylinderGeometry(ARENA.tileSize, ARENA.tileSize * .96, ARENA.tileThickness, 6, 1);
  g.rotateY(Math.PI / 6); g.translate(0, -ARENA.tileThickness / 2, 0);
  const pos = g.getAttribute('position'), normal = g.getAttribute('normal'), colors: number[] = [];
  for (let i = 0; i < pos.count; i++) { const ny = normal.getY(i); const v = ny > .5 ? 1 : ny < -.5 ? .35 : .62; colors.push(v, v, v); }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}
/** A jagged crack drawn on top of a crumbling tile; it grows as the tile's time runs out. */
function crackGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const arms = [[0, .78], [2.1, .7], [3.9, .82], [5.2, .55]];
  for (const [a, len] of arms) {
    const box = new THREE.BoxGeometry(len, .02, .06); box.translate(len / 2, 0, 0); box.rotateY(a); parts.push(box);
    const twig = new THREE.BoxGeometry(len * .45, .02, .045); twig.translate(len * .22, 0, 0); twig.rotateY(a + .7); twig.translate(Math.cos(-a) * len * .5, 0, Math.sin(-a) * len * .5); parts.push(twig);
  }
  const merged = mergeBoxes(parts); merged.translate(0, .012, 0); return merged;
}
function mergeBoxes(parts: THREE.BufferGeometry[]) {
  const positions: number[] = [], indices: number[] = []; let offset = 0;
  for (const p of parts) { const pos = p.getAttribute('position'); for (let i = 0; i < pos.count; i++) positions.push(pos.getX(i), pos.getY(i), pos.getZ(i)); const idx = p.getIndex()!; for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset); offset += pos.count; p.dispose(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(indices); g.computeVertexNormals(); return g;
}

interface Debris { mesh: THREE.Mesh; vx: number; vy: number; vz: number; spin: number; life: number }
interface TrailDot { mesh: THREE.Mesh; life: number }

export class ArenaScene {
  readonly renderer: THREE.WebGLRenderer; readonly scene = new THREE.Scene();
  private cameras: THREE.PerspectiveCamera[] = []; private camTargets: THREE.Vector3[] = [];
  private floorMeshes: THREE.InstancedMesh[] = []; private floorMats: THREE.MeshStandardMaterial[] = [];
  private crackMeshes: THREE.InstancedMesh[] = []; private crackMats: THREE.MeshBasicMaterial[] = [];
  private characters: Character[] = []; private shadows: THREE.Mesh[] = []; private markers: THREE.Mesh[] = []; private cooldowns: THREE.Mesh[] = [];
  private pickupMeshes = new Map<number, THREE.Group>();
  private debris: Debris[] = []; private trails: TrailDot[] = []; private trailTimers = [0, 0];
  private disposables: { dispose(): void }[] = [];
  private dummy = new THREE.Object3D(); private crackDummy = new THREE.Object3D(); private color = new THREE.Color(); private base: THREE.Color[] = [];
  private debrisGeo: THREE.BufferGeometry; private debrisMats: THREE.MeshStandardMaterial[];
  private trailGeo = new THREE.SphereGeometry(.07, 8, 6); private trailMats: (THREE.MeshBasicMaterial | null)[] = [];
  private time = 0; private width = 1; private height = 1;
  reduced: boolean;

  constructor(canvas: HTMLCanvasElement, private views: ViewSpec[], looks: Look[], reduced: boolean) {
    this.reduced = reduced;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.add(new THREE.HemisphereLight('#fff6ec', '#6c5ca8', 1.25));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(6, 14, 8); this.scene.add(sun);
    this.scene.fog = new THREE.Fog('#8fb3ff', 38, 90);

    const geo = tileGeometry(), crack = crackGeometry(); this.disposables.push(geo, crack);
    for (let f = 0; f < ARENA.floors; f++) {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .62, metalness: .02, transparent: true });
      const mesh = new THREE.InstancedMesh(geo, mat, TILE_COUNT); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      HEX_LIST.forEach((h, i) => { const tint = new THREE.Color(FLOOR_COLORS[f]).offsetHSL(0, 0, ((h.q - h.r) % 3 + 3) % 3 * .025 - .025); mesh.setColorAt(i, tint); });
      this.base.push(new THREE.Color(FLOOR_COLORS[f]));
      this.scene.add(mesh); this.floorMeshes.push(mesh); this.floorMats.push(mat); this.disposables.push(mat);
      const cmat = new THREE.MeshBasicMaterial({ color: '#3a1d1d', transparent: true });
      const cmesh = new THREE.InstancedMesh(crack, cmat, TILE_COUNT); cmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); cmesh.count = 0;
      this.scene.add(cmesh); this.crackMeshes.push(cmesh); this.crackMats.push(cmat); this.disposables.push(cmat);
    }
    this.debrisGeo = new THREE.CylinderGeometry(.32, .26, .3, 6); this.disposables.push(this.debrisGeo);
    this.debrisMats = FLOOR_COLORS.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: .7 })); this.disposables.push(...this.debrisMats, this.trailGeo);

    // Players: character, a soft shadow on the surface below (to judge landings), a coloured marker ring and a cooldown ring.
    const shadowGeo = new THREE.CircleGeometry(.5, 28); shadowGeo.rotateX(-Math.PI / 2);
    const markerGeo = new THREE.RingGeometry(.5, .62, 32); markerGeo.rotateX(-Math.PI / 2);
    const coolGeo = new THREE.RingGeometry(.68, .76, 32); coolGeo.rotateX(-Math.PI / 2);
    this.disposables.push(shadowGeo, markerGeo, coolGeo);
    looks.forEach((look, seat) => {
      const c = createCharacter(look); this.characters.push(c); this.scene.add(c.root);
      const shadowMat = new THREE.MeshBasicMaterial({ color: '#0b1030', transparent: true, opacity: .4, depthWrite: false });
      const shadow = new THREE.Mesh(shadowGeo, shadowMat); shadow.renderOrder = 2; this.scene.add(shadow); this.shadows.push(shadow);
      const markerMat = new THREE.MeshBasicMaterial({ color: SEAT_COLORS[seat], transparent: true, opacity: .95, depthWrite: false });
      const marker = new THREE.Mesh(markerGeo, markerMat); marker.renderOrder = 3; this.scene.add(marker); this.markers.push(marker);
      const coolMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false });
      const cool = new THREE.Mesh(coolGeo, coolMat); cool.renderOrder = 3; this.scene.add(cool); this.cooldowns.push(cool);
      this.disposables.push(shadowMat, markerMat, coolMat);
      const trail = TRAILS.find(t => t.id === look.trail)?.value;
      const trailMat = trail ? new THREE.MeshBasicMaterial({ color: trail, transparent: true, opacity: .85 }) : null;
      if (trailMat) this.disposables.push(trailMat);
      this.trailMats.push(trailMat);
    });
    this.addBackdrop();

    for (const v of views) {
      const cam = new THREE.PerspectiveCamera(CAMERA_FOV, 1, .1, 260);
      void v; this.cameras.push(cam); this.camTargets.push(new THREE.Vector3(0, floorY(0), 0));
    }
  }

  /** Soft clouds and a few distant planets, kept well outside and below the play area so they never hide anything. */
  private addBackdrop() {
    const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, transparent: true, opacity: .9 }), puff = new THREE.SphereGeometry(1, 16, 12);
    this.disposables.push(cloudMat, puff);
    const rand = mulberry(7);
    for (let i = 0; i < 16; i++) {
      const cloud = new THREE.Group(), angle = i / 16 * Math.PI * 2 + rand() * .3, dist = 40 + rand() * 22;
      cloud.position.set(Math.cos(angle) * dist, -24 - rand() * 12, Math.sin(angle) * dist - 10);
      for (let k = 0; k < 5; k++) { const m = new THREE.Mesh(puff, cloudMat); m.position.set((k - 2) * 1.6 + rand(), rand() * .8, rand() * 1.2); m.scale.setScalar(1.4 + rand() * 1.4); cloud.add(m); }
      this.scene.add(cloud);
    }
    const planetGeo = new THREE.SphereGeometry(1, 24, 16); this.disposables.push(planetGeo);
    for (const [x, y, z, r, c] of [[-34, 6, -50, 6, '#ffb3c7'], [40, 14, -60, 4, '#b8f2e6'], [22, -20, -40, 3, '#ffe29a']] as const) {
      const mat = new THREE.MeshStandardMaterial({ color: c, roughness: .9 }); this.disposables.push(mat);
      const m = new THREE.Mesh(planetGeo, mat); m.position.set(x, y, z); m.scale.setScalar(r); this.scene.add(m);
    }
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width); this.height = Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height, false);
  }

  /** Space (CSS px) the HUD covers at the top and bottom of each view, so tall views can frame the floor between them. */
  private insets: Inset[] = [];
  setInsets(insets: Inset[]) { this.insets = insets; }

  /**
   * Camera framing for one view: pull back until the whole floor fits the view's width and sits in the clear band
   * between the HUD at the top and the thumb controls at the bottom, so you can always read the whole structure.
   * Works the same for a phone held upright, one half of split screen, or a desktop window.
   */
  private frame(vp: { w: number; h: number }, k: number) {
    const tan = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)), baseDist = CAMERA_OFFSET.length();
    const inset = this.insets[k] ?? { top: 0, bottom: 0 };
    const top = Math.min(inset.top, vp.h * .35), bottom = Math.min(inset.bottom, vp.h * .4), band = Math.max(80, vp.h - top - bottom);
    const pitch = Math.atan2(CAMERA_OFFSET.y, CAMERA_OFFSET.z);
    // Pixels per world unit at the followed point: the floor's full width must fit, and its tilted depth must fit the band.
    const ppuWidth = vp.w * .5 * .96 / ARENA_HALF.x, ppuBand = band * .5 / (ARENA_HALF.z * Math.sin(pitch) + .9);
    const ppuBase = vp.h * .5 / (baseDist * tan), ppu = Math.min(ppuBase, ppuWidth, ppuBand);
    // Never pull back so far that the characters become specks; past that the camera follows within what's left.
    const dist = Math.min(baseDist * 3.2, vp.h * .5 / (ppu * tan));
    const real = vp.h * .5 / (dist * tan); // what we actually got after the cap
    const seeX = vp.w * .5 / real, seeZ = band * .5 / real / Math.sin(pitch);
    return {
      dist, shift: top + band / 2 - vp.h / 2,
      slackX: Math.max(0, Math.min(7.5, ARENA_HALF.x - seeX * .92)), slackZ: Math.max(0, Math.min(7, ARENA_HALF.z - seeZ * .9)),
    };
  }

  /** Screen rectangles for each view: side by side on wide screens, stacked on tall ones. */
  viewports() {
    const n = this.views.length, wide = this.width >= this.height;
    return this.views.map((_, i) => n === 1 ? { x: 0, y: 0, w: this.width, h: this.height }
      : wide ? { x: i * this.width / 2, y: 0, w: this.width / 2, h: this.height } : { x: 0, y: i * this.height / 2, w: this.width, h: this.height / 2 });
  }

  /** Visual reactions to game events: debris for collapsing tiles, squash on landings. */
  handle(events: GameEvent[]) {
    for (const e of events) {
      if (e.type === 'collapse') this.spawnDebris(e.floor, e.index);
      else if (e.type === 'land') this.characters[e.seat]?.land(e.hard);
      else if (e.type === 'round-start') { for (const d of this.debris) d.life = 0; }
    }
  }

  private spawnDebris(floor: number, index: number) {
    const h = HEX_LIST[index], w = hexToWorld(h.q, h.r), count = this.reduced ? 2 : 5;
    for (let k = 0; k < count && this.debris.length < 90; k++) {
      const mesh = new THREE.Mesh(this.debrisGeo, this.debrisMats[floor]), a = k / count * Math.PI * 2 + index;
      mesh.position.set(w.x + Math.cos(a) * .4, floorY(floor) - .2, w.z + Math.sin(a) * .4); mesh.scale.setScalar(.6 + (k % 3) * .2);
      this.scene.add(mesh);
      this.debris.push({ mesh, vx: Math.cos(a) * 1.2, vy: 1 + (k % 2), vz: Math.sin(a) * 1.2, spin: this.reduced ? 0 : (k % 2 ? 4 : -4), life: 1.1 });
    }
  }

  /** Draws one frame. `players` may be interpolated positions; tiles and pickups come from the snapshot. */
  render(snap: Snapshot, players: PlayerView[], dt: number) {
    this.time += dt; const t = this.time;
    // Tiles.
    for (let f = 0; f < ARENA.floors; f++) {
      const mesh = this.floorMeshes[f], cmesh = this.crackMeshes[f], codes = snap.tiles[f]; let cracks = 0;
      for (let i = 0; i < TILE_COUNT; i++) {
        const h = HEX_LIST[i], w = hexToWorld(h.q, h.r), tile = decodeTile(codes[i]);
        const d = this.dummy; d.position.set(w.x, floorY(f), w.z); d.rotation.set(0, 0, 0);
        let s: number = ARENA.tileDrawScale, sy = 1;
        this.color.set(FLOOR_COLORS[f]).offsetHSL(0, 0, ((h.q - h.r) % 3 + 3) % 3 * .025 - .025);
        if (tile.state === MISSING) { s = 0; sy = 0; }
        else if (tile.state === CRACKING) {
          // Danger reads three ways: colour heats up, the tile shrinks and sinks, and it shakes harder as time runs out.
          const p = 1 - tile.remaining, flash = .5 + .5 * Math.sin(t * (this.reduced ? 6 : 12 + 34 * p));
          s *= 1 - .2 * p; d.position.y -= .14 * p;
          if (!this.reduced) { d.position.x += Math.sin(t * 61 + i) * .045 * p; d.position.z += Math.cos(t * 53 + i * 1.7) * .045 * p; d.rotation.z = Math.sin(t * 37 + i) * .05 * p; }
          this.color.lerp(CRACK_COLOR, .35 + .55 * p).multiplyScalar(.85 + .3 * flash);
          const c = this.crackDummy; c.position.copy(d.position); c.rotation.set(0, i * 2.39, 0); c.scale.set(ARENA.tileDrawScale * (.45 + .55 * p), 1, ARENA.tileDrawScale * (.45 + .55 * p)); c.updateMatrix();
          cmesh.setMatrixAt(cracks++, c.matrix);
        } else if (tile.warn > 0) {
          // Collapse warning: a bright pulse and a little lift, well before the tile starts to crack.
          const on = Math.sin(t * (this.reduced ? 5 : 14)) > 0;
          this.color.lerp(WARN_COLOR, on ? .85 : .35); if (!this.reduced) d.position.y += .05 * (on ? 1 : 0);
        }
        d.scale.set(s, sy, s); d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix); mesh.setColorAt(i, this.color);
      }
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      cmesh.count = cracks; cmesh.instanceMatrix.needsUpdate = true;
    }
    this.updatePickups(snap);
    this.updatePlayers(players, dt);
    this.updateEffects(dt);

    // One camera per view, each following its player. Floors above the followed player fade out of the way.
    const ports = this.viewports(), r = this.renderer;
    r.setScissorTest(ports.length > 1);
    ports.forEach((vp, k) => {
      const seat = this.views[k].seat, p = players[seat], cam = this.cameras[k], target = this.camTargets[k];
      const fr = this.frame(vp, k);
      if (p) {
        const focusY = p.grounded ? floorY(p.floor) : Math.min(floorY(0), Math.max(floorY(ARENA.floors - 1) - 2, p.y));
        const goal = new THREE.Vector3(clampTo(p.x, fr.slackX), focusY, clampTo(p.z, fr.slackZ));
        target.lerp(goal, 1 - Math.exp(-dt * (p.alive ? 7 : 2)));
      }
      const scale = fr.dist / CAMERA_OFFSET.length();
      cam.position.copy(target).addScaledVector(CAMERA_OFFSET, scale); cam.lookAt(target.x, target.y + .4 / scale, target.z - 1.2 / scale);
      cam.aspect = vp.w / vp.h;
      // Move the picture down (or up) so the floor's centre lands in the middle of the clear band.
      if (Math.abs(fr.shift) > 1) cam.setViewOffset(vp.w, vp.h, 0, -fr.shift, vp.w, vp.h); else cam.clearViewOffset();
      cam.updateProjectionMatrix();
      const viewerY = p ? (p.grounded ? floorY(p.floor) : p.y) : floorY(0);
      for (let f = 0; f < ARENA.floors; f++) {
        const above = viewerY < floorY(f) - .6, mat = this.floorMats[f];
        mat.opacity = above ? .08 : 1; mat.depthWrite = !above; this.crackMats[f].opacity = above ? .05 : 1;
      }
      const y = this.height - vp.y - vp.h;
      r.setViewport(vp.x, y, vp.w, vp.h); r.setScissor(vp.x, y, vp.w, vp.h);
      r.render(this.scene, cam);
    });
  }

  private updatePlayers(players: PlayerView[], dt: number) {
    players.forEach((p, seat) => {
      const c = this.characters[seat]; if (!c) return;
      c.root.position.set(p.x, p.y, p.z); c.root.rotation.y = p.facing;
      c.animate(p.anim, Math.hypot(p.vx, p.vz), dt, this.time, this.reduced);
      // Shadow on the highest surface below the player: the best cue for where a jump or fall will land.
      const shadow = this.shadows[seat], marker = this.markers[seat], cool = this.cooldowns[seat];
      let surface: number | null = null;
      for (let f = 0; f < ARENA.floors; f++) if (floorY(f) <= p.y + .01 && this.solidUnder(f, p.x, p.z)) { surface = floorY(f); break; }
      const visible = p.alive && surface !== null;
      shadow.visible = visible; marker.visible = p.alive;
      if (visible) {
        const height = p.y - surface!;
        shadow.position.set(p.x, surface! + .015, p.z); shadow.scale.setScalar(Math.max(.45, 1 - height / 10));
        (shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(.18, .45 - height / 25);
      }
      marker.position.set(p.x, (p.grounded ? p.y : surface ?? p.y) + .02, p.z);
      (marker.material as THREE.MeshBasicMaterial).opacity = p.grounded ? .95 : .45;
      cool.visible = p.alive && p.jumpCd > 0; cool.position.set(p.x, p.y + .03, p.z);
      (cool.material as THREE.MeshBasicMaterial).opacity = .8 * p.jumpCd / PHYSICS.jumpCooldown;
      // Cosmetic trail while running on the ground.
      const trailMat = this.trailMats[seat];
      if (trailMat && p.alive && p.grounded && Math.hypot(p.vx, p.vz) > 1.5 && !this.reduced) {
        this.trailTimers[seat] -= dt;
        if (this.trailTimers[seat] <= 0 && this.trails.length < 80) {
          this.trailTimers[seat] = .05;
          const mesh = new THREE.Mesh(this.trailGeo, trailMat); mesh.position.set(p.x - Math.sin(p.facing) * .3, p.y + .15, p.z - Math.cos(p.facing) * .3);
          this.scene.add(mesh); this.trails.push({ mesh, life: .5 });
        }
      }
    });
  }

  private solidUnder(floor: number, x: number, z: number) {
    const tiles = this.lastTiles?.[floor]; if (!tiles) return true;
    const idx = tileIndex(worldToHex(x, z)); return idx !== undefined && tiles[idx] !== 255;
  }
  private lastTiles: number[][] | null = null;

  private updatePickups(snap: Snapshot) {
    this.lastTiles = snap.tiles;
    const live = new Set(snap.pickups.map(p => p.id));
    for (const [id, g] of this.pickupMeshes) if (!live.has(id)) { this.scene.remove(g); this.pickupMeshes.delete(id); }
    for (const pk of snap.pickups) {
      let g = this.pickupMeshes.get(pk.id);
      if (!g) { g = this.makePickup(pk.kind); this.pickupMeshes.set(pk.id, g); this.scene.add(g); }
      const h = HEX_LIST[pk.index], w = hexToWorld(h.q, h.r);
      g.position.set(w.x, floorY(pk.floor) + .75 + (this.reduced ? 0 : Math.sin(this.time * 3 + pk.id) * .1), w.z);
      g.rotation.y = this.reduced ? 0 : this.time * 1.6;
    }
  }

  private makePickup(kind: 'airhop' | 'feather') {
    const g = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: kind === 'airhop' ? '#4ff0ff' : '#ffffff', transparent: true, opacity: .55 });
    const ringGeo = new THREE.TorusGeometry(.42, .04, 8, 28); this.disposables.push(ringMat, ringGeo);
    const ring = new THREE.Mesh(ringGeo, ringMat); g.add(ring);
    if (kind === 'airhop') {
      const mat = new THREE.MeshStandardMaterial({ color: '#4ff0ff', emissive: '#1aa9c4', emissiveIntensity: .6 }), cone = new THREE.ConeGeometry(.2, .22, 4);
      this.disposables.push(mat, cone);
      for (const y of [-.1, .14]) { const m = new THREE.Mesh(cone, mat); m.position.y = y; g.add(m); }
    } else {
      const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#c9d6ff', emissiveIntensity: .5 }), vane = new THREE.SphereGeometry(.2, 12, 8), quill = new THREE.CylinderGeometry(.015, .015, .5, 6);
      this.disposables.push(mat, vane, quill);
      const v = new THREE.Mesh(vane, mat); v.scale.set(.45, 1.2, .12); v.rotation.z = .5; g.add(v);
      const q = new THREE.Mesh(quill, mat); q.rotation.z = .5; g.add(q);
    }
    return g;
  }

  private updateEffects(dt: number) {
    for (const d of this.debris) {
      d.life -= dt; d.vy -= 18 * dt; d.mesh.position.x += d.vx * dt; d.mesh.position.y += d.vy * dt; d.mesh.position.z += d.vz * dt;
      d.mesh.rotation.x += d.spin * dt; d.mesh.rotation.z += d.spin * .7 * dt; d.mesh.scale.multiplyScalar(1 - dt * .9);
      if (d.life <= 0) this.scene.remove(d.mesh);
    }
    this.debris = this.debris.filter(d => d.life > 0);
    for (const tr of this.trails) { tr.life -= dt; tr.mesh.scale.setScalar(Math.max(.01, tr.life * 2)); if (tr.life <= 0) this.scene.remove(tr.mesh); }
    this.trails = this.trails.filter(tr => tr.life > 0);
  }

  dispose() {
    for (const c of this.characters) c.dispose();
    for (const d of this.disposables) d.dispose();
    for (const m of this.floorMeshes) m.dispose();
    for (const m of this.crackMeshes) m.dispose();
    this.renderer.dispose();
  }
}

const clampTo = (v: number, m: number) => Math.max(-m, Math.min(m, v));
function mulberry(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
