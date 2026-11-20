/** Local cosmetic progress and settings, kept in localStorage. Nothing here affects gameplay. */
import { COLORS, TRAILS, cleanLook, defaultLook, type Look } from '../shared/rewards';

export interface Profile {
  coins: number; owned: string[]; looks: [Look, Look]; names: [string, string];
  volume: number; muted: boolean; reducedMotion: boolean; ruleset: 'classic' | 'party'; matches: number;
}
const KEY = 'crumble-clash-v1';
const prefersReduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function loadProfile(): Profile {
  const base: Profile = { coins: 0, owned: ['default', 'none'], looks: [defaultLook(0), defaultLook(1)], names: ['Player 1', 'Player 2'], volume: 0.7, muted: false, reducedMotion: prefersReduced(), ruleset: 'classic', matches: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return base;
    const owned = Array.isArray(raw.owned) ? raw.owned.filter((id: unknown) => [...COLORS, ...TRAILS].some(c => c.id === id)) : [];
    return {
      coins: Number.isFinite(raw.coins) ? Math.max(0, Math.floor(raw.coins)) : 0,
      owned: [...new Set(['default', 'none', ...owned])],
      looks: [0, 1].map(i => cleanLook(raw.looks?.[i], i)) as [Look, Look],
      names: [0, 1].map(i => typeof raw.names?.[i] === 'string' ? raw.names[i].slice(0, 14) : base.names[i]) as [string, string],
      volume: Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : base.volume,
      muted: !!raw.muted, reducedMotion: typeof raw.reducedMotion === 'boolean' ? raw.reducedMotion : base.reducedMotion,
      ruleset: raw.ruleset === 'party' ? 'party' : 'classic', matches: Number.isFinite(raw.matches) ? raw.matches : 0,
    };
  } catch { return base; }
}

export function saveProfile(profile: Profile) {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* private mode: progress lasts for this visit only */ }
}

/** Equipped cosmetics must be owned; anything else falls back to the free option. */
export function ownedLook(profile: Profile, look: Look): Look {
  return { avatar: look.avatar, color: profile.owned.includes(look.color) ? look.color : 'default', trail: profile.owned.includes(look.trail) ? look.trail : 'none' };
}
