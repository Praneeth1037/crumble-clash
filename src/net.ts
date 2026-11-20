/** Browser side of an online room: one WebSocket, automatic reconnection with the seat token, and a snapshot buffer. */
import { ONLINE, type Ruleset } from '../shared/config';
import type { ClientMessage, ErrorCode, RoomView, ServerMessage } from '../shared/protocol';
import type { Look } from '../shared/rewards';
import type { GameEvent, Input, Snapshot } from '../shared/sim';

export type NetStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface Buffered { snap: Snapshot; at: number }

const tokenKey = (code: string) => `crumble-seat-${code}`;

/**
 * Where the room server lives. Empty means "the same host as this page" (npm run dev / npm start). A static build hosted
 * elsewhere (e.g. Vercel) sets VITE_ROOM_SERVER=https://your-room-server at build time.
 */
export const ROOM_SERVER = String(import.meta.env.VITE_ROOM_SERVER || '').trim().replace(/\/+$/, '');
const socketUrl = () => ROOM_SERVER
  ? ROOM_SERVER.replace(/^http/, 'ws') + '/ws'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
/** How long the first connection keeps retrying: a free host can take up to a minute to wake from sleep. */
const FIRST_CONNECT_SECONDS = 90;

/** Nudge a sleeping room server awake as soon as the page opens, so it is ready by the time someone creates a room. */
export function wakeRoomServer() {
  if (!ROOM_SERVER) return;
  fetch(ROOM_SERVER + '/api/health', { cache: 'no-store' }).catch(() => { /* waking up; the room connection retries */ });
}

export class Net {
  status: NetStatus = 'connecting'; room: RoomView | null = null; seat = -1; code = ''; token = '';
  error: { code: ErrorCode; message: string } | null = null;
  buffer: Buffered[] = [];
  onEvents: (events: GameEvent[]) => void = () => {};
  private ws: WebSocket | null = null; private listeners = new Set<() => void>(); private hello: ClientMessage;
  private leaving = false; private retryTimer = 0; private retryUntil = 0; private lastInput = '';

  /** True once the first connection has taken longer than a few seconds (a sleeping server is waking up). */
  slowStart = false;
  private firstUntil = performance.now() + FIRST_CONNECT_SECONDS * 1000;

  constructor(hello: ClientMessage) {
    this.hello = hello; this.open();
    window.setTimeout(() => { if (!this.code && this.status === 'connecting') { this.slowStart = true; this.emit(); } }, 4000);
  }

  static create(name: string, look: Look, ruleset: Ruleset) { return new Net({ type: 'create', name, look, ruleset }); }
  static join(code: string, name: string, look: Look) {
    const upper = code.toUpperCase();
    let token: string | undefined; try { token = sessionStorage.getItem(tokenKey(upper)) || undefined; } catch { /* storage blocked */ }
    return new Net({ type: 'join', code: upper, name, look, token });
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const fn of this.listeners) fn(); }

  private open() {
    const ws = new WebSocket(socketUrl()); this.ws = ws;
    ws.onopen = () => {
      // After a drop, reclaim the same seat with the token.
      const h = this.hello as { name: string; look: Look };
      const msg: ClientMessage = this.code && this.token ? { type: 'join', code: this.code, token: this.token, name: h.name, look: h.look } : this.hello;
      ws.send(JSON.stringify(msg));
    };
    ws.onmessage = e => { try { this.receive(JSON.parse(String(e.data)) as ServerMessage); } catch { /* ignore malformed */ } };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Never got in yet: the server may still be waking up, so keep trying for a while.
      if (!this.code && !this.leaving && !this.error && performance.now() < this.firstUntil) {
        this.status = 'connecting'; this.slowStart = true; this.emit();
        this.retryTimer = window.setTimeout(() => this.open(), 2500); return;
      }
      if (this.leaving || !this.code || !this.token || this.error?.code === 'full' || this.error?.code === 'not-found') { this.status = 'closed'; this.emit(); return; }
      // Unexpected drop: keep trying for as long as the server holds our seat.
      if (this.status !== 'reconnecting') this.retryUntil = performance.now() + (ONLINE.reconnectSeconds + 5) * 1000;
      this.status = performance.now() < this.retryUntil ? 'reconnecting' : 'closed'; this.emit();
      if (this.status === 'reconnecting') this.retryTimer = window.setTimeout(() => this.open(), 1500);
    };
  }

  private receive(msg: ServerMessage) {
    if (msg.type === 'welcome') {
      this.code = msg.code; this.seat = msg.seat; this.token = msg.token; this.status = 'open'; this.error = null;
      try { sessionStorage.setItem(tokenKey(msg.code), msg.token); } catch { /* storage blocked */ }
    } else if (msg.type === 'room') this.room = msg.room;
    else if (msg.type === 'error') this.error = { code: msg.code, message: msg.message };
    else if (msg.type === 'state') {
      // A new match (rematch) starts a fresh timeline.
      const last = this.buffer[this.buffer.length - 1];
      if (last && msg.snap.t < last.snap.t) this.buffer = [];
      this.buffer.push({ snap: msg.snap, at: performance.now() / 1000 });
      if (this.buffer.length > 30) this.buffer.splice(0, this.buffer.length - 30);
      if (msg.events.length) this.onEvents(msg.events);
      return; // snapshots are read by the render loop; no need to re-render React for each one
    }
    this.emit();
  }

  send(msg: ClientMessage) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  /** Inputs are sent when they change, plus a steady heartbeat so a lost packet never leaves a key stuck. */
  sendInput(input: Input, force = false) {
    const key = `${input.mx.toFixed(2)},${input.mz.toFixed(2)},${input.jump},${input.hold}`;
    if (!force && key === this.lastInput) return;
    this.lastInput = key; this.send({ type: 'input', input });
  }

  close() {
    this.leaving = true; clearTimeout(this.retryTimer);
    this.send({ type: 'leave' });
    try { if (this.code) sessionStorage.removeItem(tokenKey(this.code)); } catch { /* storage blocked */ }
    this.ws?.close(); this.ws = null; this.status = 'closed'; this.listeners.clear();
  }
}
