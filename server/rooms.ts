/**
 * Private two-player rooms. The server owns the match: it runs the shared simulation, applies only validated inputs,
 * and decides tile timers, falls, scores, power-ups and outcomes. Transport-free, so tests can drive it directly.
 */
import { randomBytes } from 'node:crypto';
import { ONLINE, PHYSICS, type Ruleset } from '../shared/config';
import { cleanLook, type Look } from '../shared/rewards';
import { Match, type GameEvent, type MatchOptions } from '../shared/sim';
import { ROOM_CODE, cleanName, type ClientMessage, type ErrorCode, type RoomView, type ServerMessage } from '../shared/protocol';

export interface Client { send(message: ServerMessage): void; room?: Room; seat?: number; budget: number; budgetAt: number }

interface Seat { name: string; look: Look; token: string; client: Client | null; ready: boolean; rematch: boolean; leftAt: number }

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface HubOptions { match?: MatchOptions; reconnectSeconds?: number; now?: () => number }

export class Room {
  seats: (Seat | null)[] = [null, null];
  status: RoomView['status'] = 'lobby';
  match: Match | null = null;
  ended: RoomView['ended'];
  pausedSeat = -1; pauseDeadline = 0; emptySince: number;
  private pending: GameEvent[] = []; private sinceBroadcast = 0;
  constructor(public code: string, public ruleset: Ruleset, private hub: RoomHub) { this.emptySince = hub.now(); }

  view(): RoomView {
    return {
      code: this.code, ruleset: this.ruleset, status: this.status, ended: this.ended,
      seats: this.seats.map(s => s && { name: s.name, look: s.look, connected: !!s.client, ready: s.ready, rematch: s.rematch }),
      reconnectLeft: this.status === 'paused' ? Math.max(0, Math.ceil((this.pauseDeadline - this.hub.now()) / 1000)) : undefined,
    };
  }
  broadcast(message: ServerMessage) { for (const s of this.seats) s?.client?.send(message); }
  sync() { this.broadcast({ type: 'room', room: this.view() }); }

  startMatch() {
    this.match = new Match({ ...this.hub.options.match, ruleset: this.ruleset });
    this.status = 'playing'; this.ended = undefined; this.pending = [];
    for (const s of this.seats) if (s) { s.ready = false; s.rematch = false; }
    this.sync(); this.sendState();
  }

  sendState() {
    if (!this.match) return;
    this.broadcast({ type: 'state', snap: this.match.snapshot(), events: this.pending.splice(0) });
  }

  tick(dt: number) {
    if (this.status === 'paused') {
      if (this.hub.now() >= this.pauseDeadline) this.finishEarly('opponent-timeout');
      return;
    }
    if (this.status !== 'playing' || !this.match) return;
    this.match.step(dt);
    this.pending.push(...this.match.drainEvents());
    this.sinceBroadcast += dt;
    if (this.sinceBroadcast >= 1 / ONLINE.snapshotRate - 1e-9) { this.sinceBroadcast = 0; this.sendState(); }
    if (this.match.phase === 'matchOver') { this.sendState(); this.status = 'finished'; this.sync(); }
  }

  /** A match that cannot continue ends clearly. No one is ever swapped for a bot. */
  finishEarly(reason: NonNullable<RoomView['ended']>) {
    this.status = 'finished'; this.ended = reason; this.pausedSeat = -1;
    for (const s of this.seats) if (s) { s.ready = false; s.rematch = false; }
    this.sync();
  }
}

export class RoomHub {
  rooms = new Map<string, Room>();
  readonly options: HubOptions; readonly reconnectMs: number;
  now: () => number;
  constructor(options: HubOptions = {}) {
    this.options = options; this.now = options.now ?? Date.now;
    this.reconnectMs = (options.reconnectSeconds ?? ONLINE.reconnectSeconds) * 1000;
  }

  connect(send: (m: ServerMessage) => void): Client { return { send, budget: ONLINE.maxMessagesPerSecond, budgetAt: this.now() }; }

  private error(client: Client, code: ErrorCode, message: string) { client.send({ type: 'error', code, message }); }

  private newCode() {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(4), code = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('no room codes left');
  }

  handle(client: Client, raw: unknown) {
    // Simple flood control: a steady budget of messages per second per connection.
    const now = this.now();
    client.budget = Math.min(ONLINE.maxMessagesPerSecond, client.budget + (now - client.budgetAt) / 1000 * ONLINE.maxMessagesPerSecond); client.budgetAt = now;
    const msg = raw as ClientMessage;
    // Leaving is always honoured, even for a connection that is being throttled.
    if (client.budget < 1 && msg?.type !== 'leave') return this.error(client, 'throttled', 'Slow down a little.');
    client.budget--;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return this.error(client, 'bad-request', 'That message was not understood.');
    switch (msg.type) {
      case 'create': return this.create(client, msg);
      case 'join': return this.join(client, msg);
      case 'leave': return this.leave(client);
    }
    const room = client.room, seat = client.seat ?? -1, me = room?.seats[seat];
    if (!room || !me || me.client !== client) return this.error(client, 'not-in-room', 'Join a room first.');
    if (msg.type === 'input') {
      if (room.status === 'playing' && room.match && msg.input && typeof msg.input === 'object') room.match.setInput(seat, msg.input);
    } else if (msg.type === 'ready') {
      if (room.status !== 'lobby') return;
      me.ready = !!msg.ready; room.sync();
      if (room.seats.every(s => s?.client && s.ready)) room.startMatch();
    } else if (msg.type === 'ruleset') {
      if (room.status !== 'lobby' && room.status !== 'finished') return;
      if (seat !== 0) return this.error(client, 'bad-request', 'Only the host picks the rules.');
      room.ruleset = msg.ruleset === 'party' ? 'party' : 'classic';
      for (const s of room.seats) if (s) { s.ready = false; s.rematch = false; }
      room.sync();
    } else if (msg.type === 'rematch') {
      if (room.status !== 'finished') return;
      me.rematch = true; room.sync();
      if (room.seats.every(s => s?.client && s.rematch)) room.startMatch();
    } else this.error(client, 'bad-request', 'That message was not understood.');
  }

  private create(client: Client, msg: Extract<ClientMessage, { type: 'create' }>) {
    this.leave(client);
    if (this.rooms.size >= ONLINE.maxRooms) return this.error(client, 'too-many-rooms', 'The server is busy. Try again in a minute.');
    const room = new Room(this.newCode(), msg.ruleset === 'party' ? 'party' : 'classic', this);
    this.rooms.set(room.code, room);
    this.seat(client, room, 0, msg.name, msg.look);
  }

  private join(client: Client, msg: Extract<ClientMessage, { type: 'join' }>) {
    const code = String(msg.code || '').toUpperCase().trim();
    const room = ROOM_CODE.test(code) ? this.rooms.get(code) : undefined;
    if (!room) return this.error(client, 'not-found', `There is no room ${code || 'with that code'}. Check the code with your friend.`);
    // Coming back with your seat's token reclaims that seat, mid-match included.
    const back = typeof msg.token === 'string' ? room.seats.findIndex(s => s && s.token === msg.token) : -1;
    if (back >= 0) {
      if (client.room !== room) this.leave(client);
      const seat = room.seats[back]!;
      seat.client?.send({ type: 'error', code: 'bad-request', message: 'You opened this room somewhere else.' });
      seat.client = client; client.room = room; client.seat = back; seat.leftAt = 0;
      client.send({ type: 'welcome', code: room.code, seat: back, token: seat.token });
      if (room.status === 'paused' && room.pausedSeat === back) { room.status = 'playing'; room.pausedSeat = -1; }
      room.sync(); room.sendState(); return;
    }
    const free = room.seats.findIndex(s => s === null);
    if (free < 0) return this.error(client, 'full', `Room ${code} already has two players.`);
    this.leave(client);
    this.seat(client, room, free, msg.name, msg.look);
  }

  private seat(client: Client, room: Room, index: number, name: unknown, look: unknown) {
    const token = randomBytes(12).toString('hex');
    room.seats[index] = { name: cleanName(name, `Player ${index + 1}`), look: cleanLook(look, index), token, client, ready: false, rematch: false, leftAt: 0 };
    client.room = room; client.seat = index;
    client.send({ type: 'welcome', code: room.code, seat: index, token });
    room.sync();
  }

  /** Leaving on purpose frees the seat at once. A match in progress ends and the other player is told why. */
  leave(client: Client) {
    const room = client.room, seat = client.seat ?? -1;
    client.room = undefined; client.seat = undefined;
    if (!room || room.seats[seat]?.client !== client) return;
    room.seats[seat] = null;
    if (room.status === 'playing' || room.status === 'paused') room.finishEarly('opponent-left');
    else if (room.status === 'lobby') for (const s of room.seats) if (s) s.ready = false;
    room.sync(); this.cleanup(room);
  }

  /** A dropped connection pauses a running match and holds the seat for the reconnect window. */
  disconnect(client: Client) {
    const room = client.room, seat = client.seat ?? -1, me = room?.seats[seat];
    if (!room || !me || me.client !== client) return;
    me.client = null; me.leftAt = this.now(); me.ready = false;
    if (room.status === 'playing') { room.status = 'paused'; room.pausedSeat = seat; room.pauseDeadline = this.now() + this.reconnectMs; }
    room.sync(); this.cleanup(room);
  }

  private cleanup(room: Room) {
    if (room.seats.some(s => s?.client)) return;
    if (room.seats.every(s => s === null)) { this.rooms.delete(room.code); return; }
    room.emptySince = this.now();
  }

  /** Advances every running match by one fixed step and expires abandoned rooms and seats. */
  tick(dt: number = PHYSICS.fixedStep) {
    const now = this.now();
    for (const room of this.rooms.values()) {
      const before = room.status;
      room.tick(dt);
      if (room.status === 'paused' && before === 'paused' && Math.floor(now / 1000) !== Math.floor((now - dt * 1000) / 1000)) room.sync();
      // Lobby seats left empty past the reconnect window are freed so a friend can take them.
      if (room.status !== 'paused') room.seats.forEach((s, i) => { if (s && !s.client && now - s.leftAt > this.reconnectMs) { room.seats[i] = null; room.sync(); } });
      if (room.seats.every(s => !s?.client) && now - room.emptySince > ONLINE.idleRoomSeconds * 1000) this.rooms.delete(room.code);
      if (room.seats.every(s => s === null)) this.rooms.delete(room.code);
    }
  }
}
