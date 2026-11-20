/** Messages between the browser and the Crumble Clash room server (JSON over a WebSocket at /ws). */
import type { Ruleset } from './config';
import type { Look } from './rewards';
import type { GameEvent, Input, Snapshot } from './sim';

export type ClientMessage =
  | { type: 'create'; name: string; look: Look; ruleset: Ruleset }
  | { type: 'join'; code: string; name: string; look: Look; token?: string }
  | { type: 'ready'; ready: boolean }
  | { type: 'ruleset'; ruleset: Ruleset }
  | { type: 'input'; input: Input }
  | { type: 'rematch' }
  | { type: 'leave' };

export interface SeatView { name: string; look: Look; connected: boolean; ready: boolean; rematch: boolean }
export type RoomStatus = 'lobby' | 'playing' | 'paused' | 'finished';
export interface RoomView {
  code: string; ruleset: Ruleset; status: RoomStatus; seats: (SeatView | null)[];
  /** While paused for a disconnect: seconds left for the missing player to return. */
  reconnectLeft?: number;
  /** Why a match ended early, if it did. */
  ended?: 'opponent-left' | 'opponent-timeout';
}

export type ErrorCode = 'full' | 'not-found' | 'bad-request' | 'too-many-rooms' | 'not-in-room' | 'throttled';

export type ServerMessage =
  | { type: 'welcome'; code: string; seat: number; token: string }
  | { type: 'room'; room: RoomView }
  | { type: 'state'; snap: Snapshot; events: GameEvent[] }
  | { type: 'error'; code: ErrorCode; message: string };

export const ROOM_CODE = /^[A-HJ-NP-Z2-9]{4}$/;
export const cleanName = (name: unknown, fallback: string) =>
  (typeof name === 'string' ? name.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) : '') || fallback;
