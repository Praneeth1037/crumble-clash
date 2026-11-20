/** Pointy-top hexagon grid in axial coordinates (q, r). World x/z are the ground plane; y is up. */
import { ARENA } from './config';

export interface Hex { q: number; r: number }
const SQRT3 = Math.sqrt(3);

export const DIRECTIONS: Hex[] = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];

export function hexToWorld(q: number, r: number, size: number = ARENA.tileSize) {
  return { x: size * SQRT3 * (q + r / 2), z: size * 1.5 * r };
}

/** The tile whose hexagon contains a ground point. Tiles tile the plane exactly, so this is the tile you see. */
export function worldToHex(x: number, z: number, size: number = ARENA.tileSize): Hex {
  const fq = (SQRT3 / 3 * x - z / 3) / size, fr = (2 / 3 * z) / size;
  let rq = Math.round(fq), rr = Math.round(fr);
  const rs = Math.round(-fq - fr);
  const dq = Math.abs(rq - fq), dr = Math.abs(rr - fr), ds = Math.abs(rs + fq + fr);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return { q: rq + 0, r: rr + 0 };
}

export const hexDistance = (a: Hex, b: Hex) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
export const ringOf = (h: Hex) => hexDistance(h, { q: 0, r: 0 });

/** Every tile within `rings` of the centre, in a stable order (the same order on server and client). */
export function hexesInRadius(rings: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -rings; q <= rings; q++) for (let r = Math.max(-rings, -q - rings); r <= Math.min(rings, -q + rings); r++) out.push({ q, r });
  return out;
}

/** Corners of a tile's hexagon, for drawing and for checking that collision matches the visible shape. */
export function hexCorners(q: number, r: number, size: number = ARENA.tileSize) {
  const c = hexToWorld(q, r, size);
  return Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 180 * (60 * i - 30); return { x: c.x + size * Math.cos(a), z: c.z + size * Math.sin(a) }; });
}
