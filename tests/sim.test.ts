import { describe, expect, it } from 'vitest';
import { ARENA, MATCH, PARTY, PHYSICS } from '../shared/config';
import { hexCorners, hexToWorld, worldToHex } from '../shared/hex';
import { CRACKING, HEX_LIST, MISSING, Match, SOLID, TILE_COUNT, eliminationY, floorY, isConnected, mirrorIndex, normalizeMove, spawnHex, tileIndex, type Player } from '../shared/sim';

const dt = PHYSICS.fixedStep;
/** A match that is already in play, with no countdown. */
function playing(options: ConstructorParameters<typeof Match>[0] = {}) {
  const m = new Match({ seed: 7, countdown: 0.001, ...options });
  m.step(); m.drainEvents(); expect(m.phase).toBe('playing');
  return m;
}
function place(p: Player, m: Match, floor: number, q: number, r: number) {
  const w = hexToWorld(q, r); Object.assign(p, { x: w.x, z: w.z, y: floorY(floor), vx: 0, vy: 0, vz: 0, grounded: true, floor, fallStartY: floorY(floor) });
  // Make sure that tile exists for the test.
  const t = m.floors[floor][tileIndex({ q, r })!]; t.state = SOLID; t.timer = 0; t.warn = 0;
}
const tile = (m: Match, floor: number, q: number, r: number) => m.floors[floor][tileIndex({ q, r })!];
const run = (m: Match, seconds: number) => { for (let i = 0; i < Math.round(seconds / dt); i++) m.step(); };
/** Keeps the second player safely parked on a fresh tile so it never interferes. */
function park(m: Match, seat = 1) { const p = m.players[seat]; place(p, m, 2, seat ? 4 : -4, seat ? -4 : 4); }
/** Runs while holding both players safely in place (their tiles are restored each step), so the round never ends. */
const runParked = (m: Match, seconds: number) => { for (let i = 0; i < Math.round(seconds / dt); i++) { park(m, 0); park(m, 1); m.step(); } };

describe('tile lifecycle', () => {
  it('cracks on first contact and disappears exactly after the crumble delay', () => {
    const m = playing(), p = m.players[0]; park(m);
    place(p, m, 0, 0, 0); m.step();
    const t = tile(m, 0, 0, 0);
    expect(t.state).toBe(CRACKING);
    expect(m.drainEvents().filter(e => e.type === 'crack' && e.seat === 0)).toHaveLength(1);
    const steps = Math.round(m.crumbleDelay / dt);
    for (let i = 0; i < steps - 2; i++) m.step();
    expect(t.state).toBe(CRACKING);
    m.step(); m.step();
    expect(t.state).toBe(MISSING);
  });

  it('touching a cracking tile again never resets its timer', () => {
    const m = playing(), p = m.players[0]; park(m);
    place(p, m, 0, 0, 0); place(p, m, 0, 1, 0); place(p, m, 0, 0, 0); m.step();
    const t = tile(m, 0, 0, 0); run(m, 0.3);
    const remaining = t.timer;
    const w = hexToWorld(1, 0); Object.assign(p, { x: w.x, z: w.z }); m.step();   // step off onto the next tile
    const back = hexToWorld(0, 0); Object.assign(p, { x: back.x, z: back.z }); m.drainEvents(); m.step(); // and back again
    expect(t.timer).toBeCloseTo(remaining - 2 * dt, 6);
    expect(m.drainEvents().some(e => e.type === 'crack' && e.floor === 0 && e.index === tileIndex({ q: 0, r: 0 }))).toBe(false);
  });

  it('a player standing still drops through when the tile goes', () => {
    const m = playing(), p = m.players[0]; park(m);
    place(p, m, 0, 0, 0); run(m, m.crumbleDelay + 0.1);
    expect(p.grounded).toBe(false);
    expect(p.y).toBeLessThan(floorY(0));
  });

  it('jumping over a tile does not activate it', () => {
    const m = playing(), p = m.players[0]; park(m);
    for (let q = -3; q <= 3; q++) place(p, m, 0, q, 0);
    place(p, m, 0, -3, 0); p.vx = PHYSICS.moveSpeed;   // running at full speed, taking off from the tile's centre
    m.setInput(0, { mx: 1, mz: 0, jump: 1, hold: false });
    m.step(); expect(p.grounded).toBe(false);
    const takeoff = worldToHex(p.x, p.z), over = { q: takeoff.q + 1, r: 0 };
    while (!p.grounded) m.step();
    const landed = worldToHex(p.x, p.z);
    expect(landed.q).toBeGreaterThan(over.q);     // the jump cleared at least one whole tile
    expect(tile(m, 0, over.q, 0).state).toBe(SOLID);
    expect(tile(m, 0, landed.q, landed.r).state).toBe(CRACKING);
  });
});

describe('falling and landing', () => {
  it('falls through a gap onto the floor below', () => {
    const m = playing(), p = m.players[0]; park(m);
    place(p, m, 0, 0, 0); tile(m, 1, 1, 0).state = SOLID;
    place(p, m, 0, 1, 0); tile(m, 0, 1, 0).state = MISSING;
    tile(m, 1, 1, 0).state = SOLID;
    run(m, 1.2);
    expect(p.grounded).toBe(true); expect(p.floor).toBe(1); expect(p.y).toBe(floorY(1));
    expect(m.drainEvents().some(e => e.type === 'land' && e.seat === 0 && e.floor === 1 && e.hard)).toBe(true);
  });

  it('a missing tile has no collision anywhere inside its hexagon', () => {
    const m = playing(), p = m.players[0]; park(m);
    place(p, m, 1, 2, 0); tile(m, 1, 2, 0).state = MISSING; tile(m, 2, 2, 0).state = SOLID;
    // Start just above the middle floor over the hole, near a corner of the hexagon.
    const c = hexCorners(2, 0)[0], w = hexToWorld(2, 0);
    Object.assign(p, { x: w.x + (c.x - w.x) * .9, z: w.z + (c.z - w.z) * .9, y: floorY(1) + .5, grounded: false, floor: -1, vy: 0 });
    run(m, 0.9);   // long enough to fall a whole floor, shorter than the crumble delay of the tile it lands on
    expect(p.floor).toBe(2);
  });

  it('a very fast fall cannot pass through an intact floor', () => {
    const m = playing(), p = m.players[0]; park(m);
    place(p, m, 1, 0, 1);
    Object.assign(p, { y: floorY(0) + 3, vy: -PHYSICS.maxFallSpeed, grounded: false, floor: -1 });
    tile(m, 0, 0, 1).state = MISSING; tile(m, 1, 0, 1).state = SOLID;
    m.step(0.4);                                   // one huge step that crosses floor 1 entirely
    expect(p.floor).toBe(1); expect(p.y).toBe(floorY(1));
  });

  it('a cracking tile still catches you; only missing tiles let you through', () => {
    const m = playing(), p = m.players[0]; park(m);
    place(p, m, 1, -1, 1); tile(m, 1, -1, 1).state = CRACKING; tile(m, 1, -1, 1).timer = 0.5;
    Object.assign(p, { y: floorY(1) + 1, vy: 0, grounded: false, floor: -1 });
    run(m, 0.5);
    expect(p.floor).toBe(1);
  });

  it('falling below the last floor eliminates the player', () => {
    const m = playing(), p = m.players[0]; park(m);
    Object.assign(p, { x: 40, z: 40, y: floorY(2) + 1, grounded: false, floor: -1 });
    run(m, 2);
    expect(p.alive).toBe(false); expect(p.y).toBeLessThan(eliminationY());
  });
});

describe('movement', () => {
  it('diagonal input is normalised: no direction is faster', () => {
    expect(Math.hypot(normalizeMove(1, 1).x, normalizeMove(1, 1).z)).toBeCloseTo(1, 6);
    expect(normalizeMove(0.05, 0.05).len).toBe(0);
    expect(normalizeMove(0.3, 0).len).toBeCloseTo(0.3, 6);
    const speed = (mx: number, mz: number) => {
      const m = playing(), p = m.players[0]; park(m);
      for (const t of m.floors[0]) t.state = SOLID;
      place(p, m, 0, 0, 0); m.setInput(0, { mx, mz, jump: 0, hold: false }); run(m, 0.3);
      expect(p.grounded).toBe(true);
      return Math.hypot(p.vx, p.vz);
    };
    expect(speed(1, 1)).toBeCloseTo(PHYSICS.moveSpeed, 3);
    expect(speed(1, 0)).toBeCloseTo(PHYSICS.moveSpeed, 3);
    expect(speed(-Math.SQRT1_2, Math.SQRT1_2)).toBeCloseTo(speed(0, -1), 3);
  });

  it('reaches top speed quickly and stops with very little slide', () => {
    const m = playing(), p = m.players[0]; park(m);
    for (const t of m.floors[0]) t.state = SOLID;
    place(p, m, 0, -2, 0); m.setInput(0, { mx: 1, mz: 0, jump: 0, hold: false });
    run(m, 0.12); expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(PHYSICS.moveSpeed, 3);
    const x = p.x; m.setInput(0, { mx: 0, mz: 0, jump: 0, hold: false }); run(m, 0.5);
    expect(p.vx).toBe(0); expect(p.x - x).toBeLessThan(0.4);
  });

  it('jumps only when grounded, with a cooldown', () => {
    const m = playing(), p = m.players[0]; park(m);
    place(p, m, 0, 0, 0);
    m.setInput(0, { mx: 0, mz: 0, jump: 1, hold: false }); m.step();
    expect(p.vy).toBeGreaterThan(0);
    m.setInput(0, { mx: 0, mz: 0, jump: 2, hold: false }); m.step();
    expect(m.drainEvents().filter(e => e.type === 'jump')).toHaveLength(1); // a mid-air press is not a jump in Classic
    place(p, m, 0, 2, -1); p.jumpCd = PHYSICS.jumpCooldown;
    m.setInput(0, { mx: 0, mz: 0, jump: 3, hold: false }); m.step();
    expect(p.grounded).toBe(true);                // still cooling down; the press is buffered briefly, then dropped
    run(m, PHYSICS.jumpBuffer + .05); expect(p.grounded).toBe(true);
  });

  it('players bump each other equally', () => {
    const m = playing(), [a, b] = m.players;
    place(a, m, 0, 0, 0); place(b, m, 0, 0, 0); b.x += 0.2;
    m.step();
    expect(b.x - a.x).toBeCloseTo(PHYSICS.playerRadius * 2, 3);
  });

  it('clamps hostile input and never lets the jump counter go backwards', () => {
    const m = playing();
    m.setInput(0, { mx: 900, mz: -900, jump: 5, hold: true });
    expect(Math.hypot(m.inputs[0].mx, m.inputs[0].mz)).toBeCloseTo(1, 6);
    m.setInput(0, { mx: NaN, mz: Infinity, jump: 2, hold: false });
    expect(m.inputs[0].jump).toBe(5); expect(m.inputs[0].mx).toBe(0);
  });
});

describe('collision matches the visible tiles', () => {
  it('every point inside a drawn hexagon belongs to that tile', () => {
    for (const h of HEX_LIST.slice(0, 40)) {
      const c = hexToWorld(h.q, h.r);
      for (const corner of hexCorners(h.q, h.r)) for (const f of [0, .5, .97]) {
        expect(worldToHex(c.x + (corner.x - c.x) * f, c.z + (corner.z - c.z) * f)).toEqual(h);
      }
    }
  });
});

describe('arena', () => {
  it('is mirror-symmetric, connected, and keeps the spawns and their neighbours intact', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const m = new Match({ seed });
      m.floors.forEach((tiles, f) => {
        expect(isConnected(tiles)).toBe(true);
        tiles.forEach((t, i) => expect(t.state).toBe(tiles[mirrorIndex(i)].state));
        expect(tiles.filter(t => t.state === MISSING).length).toBe(ARENA.holePairs[f] * 2 + (f === 1 ? 7 : 0));
      });
      for (const side of [0, 1]) { const s = spawnHex(side); expect(m.floors[0][tileIndex(s)!].state).toBe(SOLID); }
      expect(m.players[0].grounded && m.players[1].grounded).toBe(true);
      expect(m.players[0].x).toBeCloseTo(-m.players[1].x, 6);
    }
    expect(TILE_COUNT).toBe(91);
  });

  it('alternates starting sides each round', () => {
    const m = playing({ roundOverSeconds: 0.05 });
    const firstX = m.players[0].x;
    m.players[1].alive = false; m.players[1].eliminatedAt = m.time; run(m, 0.5);
    expect(m.round).toBe(2); expect(m.players[0].x).toBeCloseTo(-firstX, 6);
  });

  it('after the time limit, rings collapse from the outside in, each with a warning', () => {
    const m = playing({ roundTimeLimit: 0.5 });
    runParked(m, 0.6);
    expect(m.drainEvents().some(e => e.type === 'warn' && e.ring === ARENA.rings)).toBe(true);
    const outer = m.floors[0].filter(t => t.ring === ARENA.rings && t.state !== MISSING);
    expect(outer.every(t => t.warn > 0 && t.state === SOLID)).toBe(true);
    runParked(m, MATCH.collapseWarning + m.crumbleDelay + 0.1);
    expect(m.floors[0].filter(t => t.ring === ARENA.rings).every(t => t.state === MISSING)).toBe(true);
    expect(m.floors[0].some(t => t.ring === ARENA.rings - 1 && t.warn > 0)).toBe(false);
    runParked(m, 0.5 + MATCH.collapseInterval - m.roundTime + 0.05);   // the next ring in gets its warning one interval later
    expect(m.floors[0].some(t => t.ring === ARENA.rings - 1 && t.warn > 0)).toBe(true);
  });
});

describe('rounds and match', () => {
  const eliminate = (m: Match, seat: number) => { const p = m.players[seat]; p.alive = false; p.eliminatedAt = m.time; };

  it('the survivor wins the round', () => {
    const m = playing(); eliminate(m, 1); run(m, 0.3);
    expect(m.phase).toBe('roundOver'); expect(m.roundWinner).toBe(0); expect(m.wins).toEqual([1, 0]);
  });

  it('simultaneous elimination is a draw', () => {
    const m = playing(); eliminate(m, 0); m.step(); eliminate(m, 1); run(m, 0.3);
    expect(m.roundWinner).toBeNull(); expect(m.wins).toEqual([0, 0]); expect(m.draws).toBe(1);
  });

  it('eliminations further apart than the draw window are not a draw', () => {
    const m = playing(); eliminate(m, 0); run(m, MATCH.drawWindow + .05);
    expect(m.phase).toBe('roundOver'); expect(m.roundWinner).toBe(1);
  });

  it('best of five: first to three wins the match, and rematch starts fresh', () => {
    const m = playing({ roundOverSeconds: 0.05 });
    for (const loser of [1, 0, 1, 1]) {
      if (m.phase === 'matchOver') break;
      while (m.phase !== 'playing') m.step();
      eliminate(m, loser); run(m, 0.3);
    }
    expect(m.wins).toEqual([3, 1]); expect(m.matchWinner).toBe(0);
    run(m, 0.2); expect(m.phase).toBe('matchOver');
    expect(m.drainEvents().some(e => e.type === 'match-over' && e.winner === 0)).toBe(true);
    m.rematch(); expect(m.wins).toEqual([0, 0]); expect(m.round).toBe(1); expect(m.phase).toBe('countdown'); expect(m.matchWinner).toBeNull();
  });
});

describe('party power-ups', () => {
  it('classic never spawns power-ups', () => {
    const m = playing(); runParked(m, PARTY.firstSpawn + 1);
    expect(m.pickups).toHaveLength(0);
  });

  it('spawn as mirrored pairs on solid, well-supported tiles away from both players', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const m = playing({ ruleset: 'party', seed });
      runParked(m, PARTY.firstSpawn + 0.05);
      expect(m.pickups.length).toBeGreaterThan(0);
      const [a, b] = m.pickups;
      expect(a.kind).toBe(b?.kind ?? a.kind);
      if (b) expect(b.index).toBe(mirrorIndex(a.index));
      for (const pk of m.pickups) expect(m.floors[pk.floor][pk.index].state).not.toBe(MISSING);
    }
  });

  it('Air Hop gives one extra jump in the air, then is used up', () => {
    const m = playing({ ruleset: 'party' }), p = m.players[0]; park(m);
    place(p, m, 0, 0, 0); p.airHops = 1;
    m.setInput(0, { mx: 0, mz: 0, jump: 1, hold: false }); m.step(); run(m, .3);
    m.setInput(0, { mx: 0, mz: 0, jump: 2, hold: false }); m.step();
    expect(p.vy).toBeGreaterThan(PARTY.airHopSpeed - 1); expect(p.airHops).toBe(0);
    m.setInput(0, { mx: 0, mz: 0, jump: 3, hold: false }); m.step();
    expect(m.drainEvents().filter(e => e.type === 'airhop')).toHaveLength(1);
  });

  it('Feather Fall slows a descent but can never lift you or hold you in place', () => {
    const m = playing({ ruleset: 'party' }), p = m.players[0]; park(m);
    Object.assign(p, { x: 40, z: 40, y: floorY(0) + 20, vy: -10, grounded: false, floor: -1, feather: PARTY.featherMax });
    m.setInput(0, { mx: 0, mz: 0, jump: 0, hold: true });
    let lastY = p.y;
    for (let i = 0; i < 60; i++) { park(m); m.step(); expect(p.y).toBeLessThan(lastY); lastY = p.y; }
    expect(p.vy).toBeCloseTo(-PARTY.featherMaxFall, 2);
    expect(p.feather).toBeLessThan(PARTY.featherMax);
    for (let i = 0; i < Math.round((PARTY.featherMax + .2) / dt); i++) { park(m); m.step(); }
    expect(p.feather).toBe(0); expect(p.vy).toBeLessThan(-PARTY.featherMaxFall);
  });

  it('collecting a power-up from its tile', () => {
    const m = playing({ ruleset: 'party' }), p = m.players[0]; park(m);
    place(p, m, 0, 1, 1); m.pickups.push({ id: 99, floor: 0, index: tileIndex({ q: 1, r: 1 })!, kind: 'feather' });
    m.step();
    expect(p.feather).toBe(PARTY.featherPerPickup); expect(m.pickups).toHaveLength(0);
  });
});
