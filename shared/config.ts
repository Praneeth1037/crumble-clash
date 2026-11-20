/**
 * Gameplay tuning for Crumble Clash. Everything that changes how the game plays lives here, in world units
 * (one hex tile is about 1.7 units across) and seconds. The simulation, the online server and the tests all read
 * these values, so local and online matches always follow the same rules.
 */

export const PHYSICS = {
  /** Simulation rate. The game always advances in steps of exactly this size, whatever the display refresh rate. */
  fixedStep: 1 / 60,
  /** Top running speed. Diagonal input is normalised, so no direction is faster than this. */
  moveSpeed: 4.6,
  /** How quickly you reach top speed on the ground and in the air (units per second squared). */
  groundAccel: 42,
  airAccel: 18,
  /** How quickly you stop on the ground when you let go: high, so there is very little sliding. */
  groundBrake: 34,
  airBrake: 4,
  gravity: 22,
  maxFallSpeed: 22,
  /** Upward speed of a jump: about 1.2 units high and 0.65 s in the air, enough to clear one or two missing tiles. */
  jumpSpeed: 7.2,
  /** Minimum time between ground jumps, shown as a ring under each player. */
  jumpCooldown: 0.35,
  /** A jump pressed this long before landing still happens on touchdown. */
  jumpBuffer: 0.12,
  /** Body radius for player-to-player bumping. Standing support uses the centre point, matching the tile you see. */
  playerRadius: 0.36,
} as const;

export const ARENA = {
  floors: 3,
  /** Hex tiles per side, counted in rings around the centre tile: 5 rings make 91 tiles per floor. */
  rings: 5,
  /** Centre-to-corner size of a tile's footprint. Collision uses exactly this hexagon. */
  tileSize: 1,
  /** Tiles are drawn slightly smaller than their footprint so the seams read; the seam is never a hole. */
  tileDrawScale: 0.95,
  tileThickness: 0.45,
  /** Vertical distance between floors. The top floor is floor 0. */
  floorGap: 5,
  /** Falling this far below the last floor eliminates you. */
  eliminationDepth: 6,
  /** Starting tile for the first seat, in axial coordinates; the other seat starts at the mirror image. */
  spawn: { q: -4, r: 0 },
  /** Random mirrored holes punched into each floor at the start of a round (pairs of tiles). */
  holePairs: [3, 5, 6],
  /** Tiles closer to the centre than this many rings are left out of that floor (2 = a 7-tile hole in the middle floor). */
  centreHoleRings: [0, 2, 0],
} as const;

export const CRUMBLE = {
  /** Seconds from the first touch until a tile disappears. Touching it again never resets this. */
  delay: 0.7,
} as const;

export const MATCH = {
  /** First to this many round wins takes the match (best of five). */
  roundsToWin: 3,
  countdown: 3,
  /** Pause between rounds while the winner is announced. */
  roundOverSeconds: 2.6,
  /** Two eliminations closer together than this count as simultaneous: the round is a draw. */
  drawWindow: 0.15,
  /** After this long, the outer ring of every floor starts to collapse, then the next ring in, and so on. */
  roundTimeLimit: 60,
  /** Warning time before a collapsing ring starts to crack. */
  collapseWarning: 2,
  /** Time between successive rings collapsing. */
  collapseInterval: 4,
} as const;

export const PARTY = {
  /** First power-up pair appears this long into a round, then one pair per interval. */
  firstSpawn: 6,
  spawnInterval: 9,
  maxPickups: 4,
  /** Air Hop: an extra jump in mid-air. You can carry this many. */
  airHopMax: 2,
  airHopSpeed: 6.6,
  /** Feather Fall: hold Jump while falling to drift down slowly. Fuel is in seconds of use. */
  featherPerPickup: 1.5,
  featherMax: 2.5,
  featherGravityScale: 0.3,
  /** Feather Fall caps your descent speed. It never lets you rise or hover. */
  featherMaxFall: 2.6,
} as const;

export type Ruleset = 'classic' | 'party';

export const ONLINE = {
  /** Server snapshots per second. Clients draw smoothly between them. */
  snapshotRate: 30,
  /** Clients draw this far behind the newest snapshot so there is always a pair to blend between. */
  interpolationDelay: 0.08,
  /** A disconnected player has this long to come back before the match ends. */
  reconnectSeconds: 30,
  /** Rooms with nobody connected are closed after this long. */
  idleRoomSeconds: 300,
  maxRooms: 200,
  /** Messages per second a single connection may send before it is throttled. */
  maxMessagesPerSecond: 120,
} as const;
