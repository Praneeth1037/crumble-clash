/**
 * Crumble Clash rules. Deterministic, fixed-step and free of any DOM or network code: local play runs it in the
 * browser, online play runs the very same code on the server, and the tests drive it directly.
 */
import { ARENA, CRUMBLE, MATCH, PARTY, PHYSICS, type Ruleset } from './config';
import { DIRECTIONS, hexDistance, hexToWorld, hexesInRadius, ringOf, worldToHex, type Hex } from './hex';

export const SOLID = 0, CRACKING = 1, MISSING = 2;
export type TileState = typeof SOLID | typeof CRACKING | typeof MISSING;
export interface Tile { q: number; r: number; ring: number; state: TileState; timer: number; warn: number }
export type PickupKind = 'airhop' | 'feather';
export interface Pickup { id: number; floor: number; index: number; kind: PickupKind }
export type Anim = 'idle' | 'run' | 'jump' | 'fall' | 'win' | 'lose' | 'out';
export type Phase = 'countdown' | 'playing' | 'roundOver' | 'matchOver';

/** What a player asks for. Online clients send exactly this; nothing about positions or outcomes is trusted. */
export interface Input { mx: number; mz: number; /** cumulative count of jump presses */ jump: number; /** jump button held */ hold: boolean }

export interface Player {
  seat: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  grounded: boolean; floor: number; jumpCd: number; jumpBuffer: number; lastJump: number;
  alive: boolean; eliminatedAt: number; airHops: number; feather: number; featherActive: boolean;
  facing: number; anim: Anim; fallStartY: number;
}

export type GameEvent =
  | { type: 'countdown'; n: number } | { type: 'go' }
  | { type: 'crack'; floor: number; index: number; seat: number } | { type: 'collapse'; floor: number; index: number }
  | { type: 'jump'; seat: number } | { type: 'airhop'; seat: number } | { type: 'land'; seat: number; floor: number; hard: boolean }
  | { type: 'fall'; seat: number } | { type: 'eliminated'; seat: number }
  | { type: 'round-start'; round: number } | { type: 'round-over'; winner: number | null; wins: number[] }
  | { type: 'match-over'; winner: number } | { type: 'warn'; ring: number }
  | { type: 'pickup-spawn'; kind: PickupKind } | { type: 'pickup'; seat: number; kind: PickupKind } | { type: 'bump' };

export interface MatchOptions { ruleset?: Ruleset; seed?: number; crumbleDelay?: number; roundTimeLimit?: number; countdown?: number; roundOverSeconds?: number }

const HEXES = hexesInRadius(ARENA.rings);
const INDEX = new Map(HEXES.map((h, i) => [`${h.q},${h.r}`, i]));
const MIRROR = HEXES.map(h => INDEX.get(`${-h.q},${-h.r}`)!);
export const TILE_COUNT = HEXES.length;
export const tileIndex = (h: Hex) => INDEX.get(`${h.q},${h.r}`);
export const floorY = (floor: number) => (ARENA.floors - 1 - floor) * ARENA.floorGap;
export const eliminationY = () => floorY(ARENA.floors - 1) - ARENA.eliminationDepth;
export const spawnHex = (side: number): Hex => side ? { q: -ARENA.spawn.q, r: -ARENA.spawn.r } : { q: ARENA.spawn.q, r: ARENA.spawn.r };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Reads a stick or keys: never longer than 1, so diagonals are no faster; tiny drift is ignored. */
export function normalizeMove(mx: number, mz: number) {
  mx = Number.isFinite(mx) ? mx : 0; mz = Number.isFinite(mz) ? mz : 0;
  const len = Math.hypot(mx, mz);
  if (len < 0.12) return { x: 0, z: 0, len: 0 };
  // A unit direction plus a strength of at most 1: half-pushed sticks walk, full pushes run, diagonals are never faster.
  return { x: mx / len, z: mz / len, len: Math.min(1, len) };
}

export class Match {
  readonly ruleset: Ruleset;
  readonly crumbleDelay: number; readonly roundTimeLimit: number; readonly countdownSeconds: number; readonly roundOverSeconds: number;
  seed: number; time = 0; phase: Phase = 'countdown'; phaseTimer = 0; round = 0; wins = [0, 0]; draws = 0;
  roundWinner: number | null = null; matchWinner: number | null = null; roundTime = 0;
  floors: Tile[][] = []; players: Player[] = []; pickups: Pickup[] = []; events: GameEvent[] = [];
  inputs: Input[] = [{ mx: 0, mz: 0, jump: 0, hold: false }, { mx: 0, mz: 0, jump: 0, hold: false }];
  private lastCount = 0; private collapseRing = 0; private nextCollapseAt = 0; private nextPickupAt = 0; private nextId = 1;
  private roundEndAt = Infinity; roundsWon = [0, 0];

  constructor(options: MatchOptions = {}) {
    this.ruleset = options.ruleset === 'party' ? 'party' : 'classic';
    this.seed = (options.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0 || 1;
    this.crumbleDelay = options.crumbleDelay ?? CRUMBLE.delay;
    this.roundTimeLimit = options.roundTimeLimit ?? MATCH.roundTimeLimit;
    this.countdownSeconds = options.countdown ?? MATCH.countdown;
    this.roundOverSeconds = options.roundOverSeconds ?? MATCH.roundOverSeconds;
    this.startRound();
  }

  random() { this.seed ^= this.seed << 13; this.seed ^= this.seed >>> 17; this.seed ^= this.seed << 5; return (this.seed >>> 0) / 4294967296; }

  /** Accepts a player's input. Out-of-range values are clamped; the jump counter may only move forward. */
  setInput(seat: number, input: Partial<Input>) {
    const cur = this.inputs[seat]; if (!cur) return;
    const m = normalizeMove(Number(input.mx), Number(input.mz));
    const jump = Number.isFinite(input.jump) ? Math.floor(Number(input.jump)) : cur.jump;
    this.inputs[seat] = { mx: m.x * m.len, mz: m.z * m.len, jump: jump >= cur.jump ? jump : cur.jump, hold: !!input.hold };
  }

  rematch() { this.wins = [0, 0]; this.roundsWon = [0, 0]; this.draws = 0; this.round = 0; this.matchWinner = null; this.startRound(); }

  startRound() {
    this.round++; this.phase = 'countdown'; this.phaseTimer = this.countdownSeconds; this.lastCount = Math.ceil(this.countdownSeconds) + 1;
    this.roundTime = 0; this.roundWinner = null; this.roundEndAt = Infinity; this.pickups = [];
    this.collapseRing = ARENA.rings; this.nextCollapseAt = this.roundTimeLimit; this.nextPickupAt = PARTY.firstSpawn;
    this.floors = this.generateArena();
    // Starting sides alternate every round.
    const flip = (this.round - 1) % 2;
    this.players = [0, 1].map(seat => this.spawn(seat, seat ^ flip));
    for (const input of this.inputs) { input.mx = 0; input.mz = 0; input.hold = false; }
    this.events.push({ type: 'round-start', round: this.round });
  }

  private spawn(seat: number, side: number): Player {
    const h = spawnHex(side), w = hexToWorld(h.q, h.r), y = floorY(0);
    return { seat, x: w.x, y, z: w.z, vx: 0, vy: 0, vz: 0, grounded: true, floor: 0, jumpCd: 0, jumpBuffer: 0, lastJump: this.inputs[seat].jump,
      alive: true, eliminatedAt: -1, airHops: 0, feather: 0, featherActive: false, facing: side ? -Math.PI / 2 : Math.PI / 2, anim: 'idle', fallStartY: y };
  }

  /** Three floors, each mirror-symmetric through the centre and fully connected, with the spawn area intact. */
  generateArena(): Tile[][] {
    const floors: Tile[][] = [];
    for (let f = 0; f < ARENA.floors; f++) {
      const tiles: Tile[] = HEXES.map(h => ({ q: h.q, r: h.r, ring: ringOf(h), state: SOLID, timer: 0, warn: 0 }));
      const keep = new Set<number>();
      if (f === 0) for (const side of [0, 1]) { const s = spawnHex(side); keep.add(tileIndex(s)!); for (const d of DIRECTIONS) { const n = tileIndex({ q: s.q + d.q, r: s.r + d.r }); if (n !== undefined) keep.add(n); } }
      const centre = ARENA.centreHoleRings[f] || 0;
      for (const t of tiles) if (t.ring < centre) t.state = MISSING;
      let placed = 0;
      for (let attempt = 0; attempt < 300 && placed < (ARENA.holePairs[f] || 0); attempt++) {
        const i = Math.floor(this.random() * tiles.length), m = MIRROR[i];
        if (i === m || keep.has(i) || keep.has(m) || tiles[i].state === MISSING) continue;
        tiles[i].state = MISSING; tiles[m].state = MISSING;
        if (connected(tiles)) placed++; else { tiles[i].state = SOLID; tiles[m].state = SOLID; }
      }
      floors.push(tiles);
    }
    return floors;
  }

  tileAt(floor: number, x: number, z: number): Tile | null {
    const i = tileIndex(worldToHex(x, z));
    return i === undefined ? null : this.floors[floor]?.[i] ?? null;
  }

  step(dt: number = PHYSICS.fixedStep) {
    this.time += dt;
    if (this.phase === 'matchOver') { for (const p of this.players) this.stepPlayer(p, dt, false); return; }
    if (this.phase === 'countdown') {
      this.phaseTimer -= dt;
      const n = Math.ceil(this.phaseTimer);
      if (n < this.lastCount && n > 0) { this.lastCount = n; this.events.push({ type: 'countdown', n }); }
      if (this.phaseTimer <= 0) { this.phase = 'playing'; this.events.push({ type: 'go' }); }
      for (const p of this.players) this.animate(p);
      return;
    }
    const playing = this.phase === 'playing';
    if (playing) { this.roundTime += dt; this.stepCollapse(); if (this.ruleset === 'party') this.stepPickups(); }
    for (const p of this.players) this.stepPlayer(p, dt, playing);
    this.bump();
    // The floor freezes once a round is decided, so the winner can celebrate without falling.
    if (playing) this.stepTiles(dt);
    if (playing) this.checkRoundEnd();
    else if (this.phase === 'roundOver') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        if (this.matchWinner !== null) { this.phase = 'matchOver'; this.events.push({ type: 'match-over', winner: this.matchWinner }); }
        else this.startRound();
      }
    }
  }

  private stepPlayer(p: Player, dt: number, control: boolean) {
    const input = this.inputs[p.seat];
    p.jumpCd = Math.max(0, p.jumpCd - dt); p.jumpBuffer = Math.max(0, p.jumpBuffer - dt); p.featherActive = false;
    let pressed = false;
    if (input.jump > p.lastJump) { p.lastJump = input.jump; if (control && p.alive) { p.jumpBuffer = PHYSICS.jumpBuffer; pressed = true; } }
    const move = control && p.alive ? normalizeMove(input.mx, input.mz) : { x: 0, z: 0, len: 0 };

    // Standing support: the tile under your centre must still be there.
    if (p.grounded) {
      const tile = this.tileAt(p.floor, p.x, p.z);
      if (!tile || tile.state === MISSING) { p.grounded = false; p.floor = -1; p.fallStartY = p.y; this.events.push({ type: 'fall', seat: p.seat }); }
    }
    // Responsive running: quick acceleration toward the stick direction and a firm stop on the ground.
    const tx = move.x * move.len * PHYSICS.moveSpeed, tz = move.z * move.len * PHYSICS.moveSpeed;
    const rate = (move.len > 0 ? (p.grounded ? PHYSICS.groundAccel : PHYSICS.airAccel) : (p.grounded ? PHYSICS.groundBrake : PHYSICS.airBrake)) * dt;
    const dx = tx - p.vx, dz = tz - p.vz, dl = Math.hypot(dx, dz);
    if (dl <= rate) { p.vx = tx; p.vz = tz; } else { p.vx += dx / dl * rate; p.vz += dz / dl * rate; }

    if (p.grounded && p.jumpBuffer > 0 && p.jumpCd <= 0) {
      p.vy = PHYSICS.jumpSpeed; p.grounded = false; p.floor = -1; p.jumpCd = PHYSICS.jumpCooldown; p.jumpBuffer = 0; p.fallStartY = p.y;
      this.events.push({ type: 'jump', seat: p.seat });
    } else if (!p.grounded && pressed && p.airHops > 0 && this.ruleset === 'party') {
      p.vy = PARTY.airHopSpeed; p.airHops--; p.jumpBuffer = 0; p.fallStartY = Math.max(p.fallStartY, p.y);
      this.events.push({ type: 'airhop', seat: p.seat });
    }

    if (!p.grounded) {
      // Feather Fall slows a descent while Jump is held: it eases you down to a gentle fall speed and holds you
      // there. It does nothing on the way up, so it can never lift you or let you hover.
      if (control && input.hold && p.vy <= 0 && p.feather > 0 && p.alive) {
        p.feather = Math.max(0, p.feather - dt); p.featherActive = true;
        const cap = -PARTY.featherMaxFall;
        p.vy = p.vy < cap ? p.vy + (cap - p.vy) * Math.min(1, 12 * dt) : Math.max(p.vy - PHYSICS.gravity * PARTY.featherGravityScale * dt, cap);
      } else p.vy = Math.max(p.vy - PHYSICS.gravity * dt, -PHYSICS.maxFallSpeed);
    }
    const prevY = p.y;
    p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt;

    if (p.grounded) p.y = floorY(p.floor);
    else if (p.vy <= 0 && p.alive) {
      // Landing checks every floor surface crossed during this step, top first, so a fast fall can never pass
      // through an intact floor. Only tiles that are actually there (solid or cracking) catch you.
      for (let f = 0; f < ARENA.floors; f++) {
        const surface = floorY(f);
        if (prevY < surface || p.y > surface) continue;
        const tile = this.tileAt(f, p.x, p.z);
        if (!tile || tile.state === MISSING) continue;
        const drop = p.fallStartY - surface;
        p.y = surface; p.vy = 0; p.grounded = true; p.floor = f; p.fallStartY = surface;
        this.events.push({ type: 'land', seat: p.seat, floor: f, hard: drop > 2 });
        break;
      }
    }
    if (p.grounded && p.alive) {
      const tile = this.tileAt(p.floor, p.x, p.z);
      // First contact starts the countdown. Standing on, or returning to, a cracking tile never resets it.
      if (tile && tile.state === SOLID) {
        tile.state = CRACKING; tile.timer = this.crumbleDelay;
        this.events.push({ type: 'crack', floor: p.floor, index: tileIndex(tile)!, seat: p.seat });
      }
      if (this.ruleset === 'party' && tile) this.collect(p, p.floor, tileIndex(tile)!);
    }
    if (p.alive && p.y < eliminationY()) {
      p.alive = false; p.eliminatedAt = this.time; p.vx *= .3; p.vz *= .3;
      this.events.push({ type: 'eliminated', seat: p.seat });
    }
    if (Math.hypot(p.vx, p.vz) > .4) p.facing = Math.atan2(p.vx, p.vz);
    this.animate(p);
  }

  private animate(p: Player) {
    if (!p.alive) p.anim = 'out';
    else if ((this.phase === 'roundOver' || this.phase === 'matchOver') && this.roundWinner !== null) p.anim = p.seat === this.roundWinner ? 'win' : 'lose';
    else if (!p.grounded) p.anim = p.vy > 0 ? 'jump' : 'fall';
    else p.anim = Math.hypot(p.vx, p.vz) > .5 ? 'run' : 'idle';
  }

  /** Players are solid to each other: identical bodies, pushed apart equally. Shoving someone off an edge is fair play. */
  private bump() {
    const [a, b] = this.players;
    if (!a.alive || !b.alive || Math.abs(a.y - b.y) > 1.1) return;
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = PHYSICS.playerRadius * 2;
    if (d >= min) return;
    const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0, push = (min - d) / 2;
    a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
    const closing = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
    if (closing < 0) { a.vx += nx * closing / 2; a.vz += nz * closing / 2; b.vx -= nx * closing / 2; b.vz -= nz * closing / 2; if (closing < -2) this.events.push({ type: 'bump' }); }
  }

  private stepTiles(dt: number) {
    this.floors.forEach((tiles, f) => tiles.forEach((t, i) => {
      if (t.warn > 0) { t.warn = Math.max(0, t.warn - dt); if (t.warn === 0 && t.state === SOLID) { t.state = CRACKING; t.timer = this.crumbleDelay; } }
      if (t.state === CRACKING) {
        t.timer -= dt;
        if (t.timer <= 1e-9) {
          t.state = MISSING; t.timer = 0; this.events.push({ type: 'collapse', floor: f, index: i });
          this.pickups = this.pickups.filter(pk => !(pk.floor === f && pk.index === i));
        }
      }
    }));
  }

  /** Anti-stalling: once the time limit passes, rings collapse from the outside in, each with a warning first. */
  private stepCollapse() {
    if (this.roundTime < this.nextCollapseAt || this.collapseRing < 0) return;
    for (const tiles of this.floors) for (const t of tiles) if (t.ring === this.collapseRing && t.state === SOLID) t.warn = MATCH.collapseWarning;
    this.events.push({ type: 'warn', ring: this.collapseRing });
    this.collapseRing--; this.nextCollapseAt += MATCH.collapseInterval;
  }

  /** Party power-ups arrive as mirrored pairs on the same floor, away from both players, on well-supported tiles. */
  private stepPickups() {
    if (this.roundTime < this.nextPickupAt) return;
    this.nextPickupAt += PARTY.spawnInterval;
    if (this.pickups.length > PARTY.maxPickups - 2) return;
    const candidates: { floor: number; index: number }[] = [];
    this.floors.forEach((tiles, f) => tiles.forEach((t, i) => {
      const m = tiles[MIRROR[i]];
      if (t.state !== SOLID || m.state !== SOLID || t.warn || m.warn || this.pickups.some(pk => pk.floor === f && (pk.index === i || pk.index === MIRROR[i]))) return;
      const supported = (tile: Tile) => DIRECTIONS.filter(d => { const n = tileIndex({ q: tile.q + d.q, r: tile.r + d.r }); return n !== undefined && tiles[n].state === SOLID; }).length >= 3;
      if (!supported(t) || !supported(m)) return;
      for (const p of this.players) { if (!p.alive) continue; const h = worldToHex(p.x, p.z); if (hexDistance(h, t) < 2 || hexDistance(h, m) < 2) return; }
      candidates.push({ floor: f, index: i });
    }));
    if (!candidates.length) return;
    const pick = candidates[Math.floor(this.random() * candidates.length)], kind: PickupKind = this.random() < .5 ? 'airhop' : 'feather';
    for (const index of new Set([pick.index, MIRROR[pick.index]])) this.pickups.push({ id: this.nextId++, floor: pick.floor, index, kind });
    this.events.push({ type: 'pickup-spawn', kind });
  }

  private collect(p: Player, floor: number, index: number) {
    const found = this.pickups.find(pk => pk.floor === floor && pk.index === index);
    if (!found) return;
    this.pickups = this.pickups.filter(pk => pk !== found);
    if (found.kind === 'airhop') p.airHops = Math.min(PARTY.airHopMax, p.airHops + 1);
    else p.feather = Math.min(PARTY.featherMax, p.feather + PARTY.featherPerPickup);
    this.events.push({ type: 'pickup', seat: p.seat, kind: found.kind });
  }

  private checkRoundEnd() {
    const out = this.players.filter(p => !p.alive);
    if (!out.length) return;
    if (this.roundEndAt === Infinity) this.roundEndAt = Math.min(...out.map(p => p.eliminatedAt)) + MATCH.drawWindow;
    if (this.time + 1e-9 < this.roundEndAt && out.length < 2) return;
    // Both out within the draw window is a draw; otherwise the survivor takes the round.
    const winner = out.length === 2 ? null : 1 - out[0].seat;
    this.roundWinner = winner; this.phase = 'roundOver'; this.phaseTimer = this.roundOverSeconds;
    if (winner === null) this.draws++; else { this.wins[winner]++; this.roundsWon[winner]++; if (this.wins[winner] >= MATCH.roundsToWin) this.matchWinner = winner; }
    for (const p of this.players) this.animate(p);
    this.events.push({ type: 'round-over', winner, wins: [...this.wins] });
  }

  drainEvents() { return this.events.splice(0); }

  snapshot(): Snapshot {
    const timeLeft = Math.max(0, this.roundTimeLimit - this.roundTime);
    return {
      t: r3(this.time), phase: this.phase, phaseTimer: r3(this.phaseTimer), round: this.round, wins: [...this.wins], draws: this.draws,
      roundWinner: this.roundWinner, matchWinner: this.matchWinner, roundTime: r3(this.roundTime), timeLeft: r3(timeLeft), ruleset: this.ruleset,
      crumbleDelay: this.crumbleDelay,
      tiles: this.floors.map(tiles => tiles.map(encodeTile, this)),
      players: this.players.map(p => ({ seat: p.seat, x: r3(p.x), y: r3(p.y), z: r3(p.z), vx: r3(p.vx), vy: r3(p.vy), vz: r3(p.vz), grounded: p.grounded, floor: p.floor,
        alive: p.alive, jumpCd: r3(p.jumpCd), airHops: p.airHops, feather: r3(p.feather), featherActive: p.featherActive, facing: r3(p.facing), anim: p.anim })),
      pickups: this.pickups.map(pk => ({ ...pk })),
    };
  }
}

function encodeTile(this: Match, t: Tile) {
  if (t.state === MISSING) return 255;
  if (t.state === CRACKING) return 1 + Math.round(clamp(t.timer / this.crumbleDelay, 0, 1) * 98);
  return t.warn > 0 ? 100 + Math.ceil(t.warn * 20) : 0;
}

/** Turns a snapshot tile code back into a state, the crack time remaining (as a fraction) and the warning time. */
export function decodeTile(code: number) {
  if (code === 255) return { state: MISSING as TileState, remaining: 0, warn: 0 };
  if (code >= 1 && code <= 99) return { state: CRACKING as TileState, remaining: (code - 1) / 98, warn: 0 };
  return { state: SOLID as TileState, remaining: 1, warn: code >= 100 ? (code - 100) / 20 : 0 };
}

function connected(tiles: Tile[]) {
  const open = tiles.map((t, i) => t.state !== MISSING ? i : -1).filter(i => i >= 0);
  if (!open.length) return false;
  const seen = new Set([open[0]]), queue = [open[0]];
  while (queue.length) {
    const t = tiles[queue.pop()!];
    for (const d of DIRECTIONS) { const n = tileIndex({ q: t.q + d.q, r: t.r + d.r }); if (n !== undefined && !seen.has(n) && tiles[n].state !== MISSING) { seen.add(n); queue.push(n); } }
  }
  return seen.size === open.length;
}
export const isConnected = connected;
export const HEX_LIST = HEXES;
export const mirrorIndex = (i: number) => MIRROR[i];

export interface PlayerView { seat: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean; floor: number; alive: boolean; jumpCd: number; airHops: number; feather: number; featherActive: boolean; facing: number; anim: Anim }
export interface Snapshot {
  t: number; phase: Phase; phaseTimer: number; round: number; wins: number[]; draws: number; roundWinner: number | null; matchWinner: number | null;
  roundTime: number; timeLeft: number; ruleset: Ruleset; crumbleDelay: number; tiles: number[][]; players: PlayerView[]; pickups: Pickup[];
}
