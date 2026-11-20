import { describe, expect, it } from 'vitest';
import { PHYSICS } from '../shared/config';
import type { ServerMessage } from '../shared/protocol';
import { defaultLook } from '../shared/rewards';
import { RoomHub, type Client } from '../server/rooms';

function setup(reconnectSeconds = 5) {
  let clock = 1_000_000;
  const hub = new RoomHub({ reconnectSeconds, now: () => clock, match: { countdown: 0.2, roundOverSeconds: 0.2, seed: 3 } });
  const make = () => {
    const inbox: ServerMessage[] = [];
    const client = hub.connect(m => inbox.push(m)) as Client & { inbox: ServerMessage[] };
    client.inbox = inbox; return client;
  };
  const last = (c: { inbox: ServerMessage[] }, type: ServerMessage['type']) => [...c.inbox].reverse().find(m => m.type === type) as any;
  const advance = (seconds: number) => { for (let i = 0; i < Math.round(seconds / PHYSICS.fixedStep); i++) { clock += PHYSICS.fixedStep * 1000; hub.tick(); } };
  const pair = () => {
    const host = make(), guest = make();
    hub.handle(host, { type: 'create', name: 'Ana', look: defaultLook(0), ruleset: 'classic' });
    const code = last(host, 'welcome').code;
    hub.handle(guest, { type: 'join', code, name: 'Ben', look: defaultLook(1) });
    return { host, guest, code, room: hub.rooms.get(code)! };
  };
  return { hub, make, last, advance, pair, tickClock: (ms: number) => { clock += ms; } };
}

describe('private rooms', () => {
  it('creates a short code, seats exactly two players and rejects a third', () => {
    const { make, last, pair, hub } = setup();
    const { host, guest, code } = pair();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect(last(host, 'welcome').seat).toBe(0); expect(last(guest, 'welcome').seat).toBe(1);
    const third = make(); hub.handle(third, { type: 'join', code, name: 'Cy', look: defaultLook(0) });
    expect(last(third, 'error').code).toBe('full');
    const lost = make(); hub.handle(lost, { type: 'join', code: 'ZZZZ', name: 'Di', look: defaultLook(0) });
    expect(last(lost, 'error').code).toBe('not-found');
  });

  it('starts only when both players are ready', () => {
    const { hub, last, pair } = setup();
    const { host, guest, room } = pair();
    hub.handle(host, { type: 'ready', ready: true });
    expect(room.status).toBe('lobby');
    expect(last(guest, 'room').room.seats[0].ready).toBe(true);
    hub.handle(guest, { type: 'ready', ready: true });
    expect(room.status).toBe('playing'); expect(last(guest, 'state')).toBeTruthy();
  });

  it('only accepts inputs: positions and outcomes come from the server', () => {
    const { hub, pair, advance } = setup();
    const { host, guest, room } = pair();
    hub.handle(host, { type: 'ready', ready: true }); hub.handle(guest, { type: 'ready', ready: true });
    advance(0.3);
    const before = { ...room.match!.players[1] };
    hub.handle(guest, { type: 'input', input: { mx: 50, mz: 0, jump: 0, hold: false, x: 999, y: 999, alive: true, wins: [3, 3] } as never });
    expect(room.match!.inputs[1].mx).toBeCloseTo(1, 6);
    advance(0.1);
    const after = room.match!.players[1];
    expect(after.x - before.x).toBeLessThan(PHYSICS.moveSpeed * 0.1 + 1e-6);
    expect(room.match!.wins).toEqual([0, 0]);
    hub.handle(guest, { type: 'nonsense' } as never);
  });

  it('pauses on a disconnect, resumes when the player returns with their token', () => {
    const { hub, make, last, pair, advance } = setup();
    const { host, guest, code, room } = pair();
    const token = last(guest, 'welcome').token;
    hub.handle(host, { type: 'ready', ready: true }); hub.handle(guest, { type: 'ready', ready: true });
    advance(0.5);
    hub.disconnect(guest);
    expect(room.status).toBe('paused'); expect(last(host, 'room').room.seats[1].connected).toBe(false);
    const t = room.match!.time; advance(1); expect(room.match!.time).toBe(t);   // frozen while paused
    const back = make(); hub.handle(back, { type: 'join', code, name: 'Ben', look: defaultLook(1), token });
    expect(last(back, 'welcome').seat).toBe(1); expect(room.status).toBe('playing');
  });

  it('ends the match clearly if the player does not return in time, with no bot stand-in', () => {
    const { hub, last, pair, advance } = setup(2);
    const { host, guest, room } = pair();
    hub.handle(host, { type: 'ready', ready: true }); hub.handle(guest, { type: 'ready', ready: true });
    advance(0.3); hub.disconnect(guest);
    advance(1); expect(last(host, 'room').room.reconnectLeft).toBeGreaterThan(0);
    advance(1.2);
    const view = last(host, 'room').room;
    expect(view.status).toBe('finished'); expect(view.ended).toBe('opponent-timeout');
    expect(room.match!.players[1]).toBeTruthy(); expect(view.seats[1]?.connected ?? false).toBe(false);
  });

  it('leaving on purpose ends the match for the other player', () => {
    const { hub, last, pair, advance } = setup();
    const { host, guest } = pair();
    hub.handle(host, { type: 'ready', ready: true }); hub.handle(guest, { type: 'ready', ready: true });
    advance(0.3); hub.handle(guest, { type: 'leave' });
    expect(last(host, 'room').room.ended).toBe('opponent-left');
  });

  it('plays a whole match to the end and supports a rematch', () => {
    const { hub, last, pair, advance } = setup();
    const { host, guest, room } = pair();
    hub.handle(host, { type: 'ready', ready: true }); hub.handle(guest, { type: 'ready', ready: true });
    // The guest runs straight off its side of the arena every round until the match is over.
    for (let i = 0; i < 60 && room.status === 'playing'; i++) {
      const me = room.match!.players[1];
      hub.handle(guest, { type: 'input', input: { mx: Math.sign(me.x) || 1, mz: 0, jump: 0, hold: false } });
      hub.handle(host, { type: 'input', input: { mx: i % 2 ? .5 : -.5, mz: i % 4 < 2 ? .6 : -.6, jump: i, hold: false } });
      advance(0.25);
    }
    expect(room.status).toBe('finished');
    const snap = last(host, 'state').snap;
    expect(snap.phase).toBe('matchOver'); expect(snap.matchWinner).toBe(0); expect(snap.wins[0]).toBe(3);
    hub.handle(host, { type: 'rematch' }); expect(room.status).toBe('finished');
    hub.handle(guest, { type: 'rematch' }); expect(room.status).toBe('playing'); expect(room.match!.wins).toEqual([0, 0]);
  });

  it('throttles floods and closes empty rooms', () => {
    const { hub, last, pair } = setup();
    const { host, guest, code } = pair();
    for (let i = 0; i < 400; i++) hub.handle(host, { type: 'ready', ready: false });
    expect(last(host, 'error')?.code).toBe('throttled');
    hub.handle(host, { type: 'leave' }); hub.handle(guest, { type: 'leave' });
    expect(hub.rooms.has(code)).toBe(false);
  });
});
