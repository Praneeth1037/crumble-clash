/**
 * Cosmetic rewards. Coins are earned only from completed matches and buy colours and trails.
 * Cosmetics never change movement, hit size or survival.
 */

export const COINS = {
  completedMatch: 15,
  matchWin: 20,
  perRoundWon: 5,
} as const;

export interface Avatar { id: string; name: string; tagline: string; color: string; accent: string }

/** Four original characters, each a distinct silhouette built from simple shapes. */
export const AVATARS: Avatar[] = [
  { id: 'bramble', name: 'Bramble', tagline: 'A round berry with a leafy sprout.', color: '#ff5d8f', accent: '#5bd17a' },
  { id: 'zip', name: 'Zip', tagline: 'A tall capsule with a bobbing antenna.', color: '#2ec8d8', accent: '#ffe066' },
  { id: 'nugget', name: 'Nugget', tagline: 'A sturdy cube with a visor.', color: '#ffa53c', accent: '#2b3a67' },
  { id: 'comet', name: 'Comet', tagline: 'A spinning top with a swirl tail.', color: '#9b6bff', accent: '#ffd1f0' },
];

export interface Cosmetic { id: string; name: string; cost: number; value: string }

/** Body colours. 'default' uses the character's own colour. */
export const COLORS: Cosmetic[] = [
  { id: 'default', name: 'Classic', cost: 0, value: '' },
  { id: 'mint', name: 'Mint', cost: 30, value: '#6ff2c2' },
  { id: 'sunset', name: 'Sunset', cost: 45, value: '#ff7a45' },
  { id: 'sky', name: 'Sky', cost: 45, value: '#6fb6ff' },
  { id: 'gold', name: 'Gold', cost: 90, value: '#ffd34d' },
  { id: 'midnight', name: 'Midnight', cost: 120, value: '#3a3f8f' },
];

/** Particle trails left while running. */
export const TRAILS: Cosmetic[] = [
  { id: 'none', name: 'None', cost: 0, value: '' },
  { id: 'sparkle', name: 'Sparkle', cost: 40, value: '#fff6a8' },
  { id: 'bubbles', name: 'Bubbles', cost: 60, value: '#9fe8ff' },
  { id: 'hearts', name: 'Petals', cost: 80, value: '#ff9ec4' },
  { id: 'embers', name: 'Embers', cost: 110, value: '#ff8a3d' },
];

export interface Look { avatar: string; color: string; trail: string }
export const defaultLook = (seat: number): Look => ({ avatar: seat ? 'zip' : 'bramble', color: 'default', trail: 'none' });

/** Accepts only known ids, so a look received over the network can never be anything unexpected. */
export function cleanLook(raw: unknown, seat: number): Look {
  const fallback = defaultLook(seat), value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    avatar: AVATARS.some(a => a.id === value.avatar) ? String(value.avatar) : fallback.avatar,
    color: COLORS.some(c => c.id === value.color) ? String(value.color) : fallback.color,
    trail: TRAILS.some(t => t.id === value.trail) ? String(value.trail) : fallback.trail,
  };
}

export function coinsFor(wonMatch: boolean, roundsWon: number) {
  return COINS.completedMatch + (wonMatch ? COINS.matchWin : 0) + roundsWon * COINS.perRoundWon;
}
