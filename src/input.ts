/** Keyboard and touch input, turned into the same Input the simulation and the server accept. */
import type { Input } from '../shared/sim';

export interface Binding { up: string[]; down: string[]; left: string[]; right: string[]; jump: string[] }
export const LOCAL_BINDINGS: [Binding, Binding] = [
  { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], jump: ['KeyQ'] },
  { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['Space'] },
];
export const ONLINE_BINDING: Binding = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], jump: ['Space', 'KeyQ'] };
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** One controller per player: keys and/or a touch stick feed it; it reports a camera-aligned Input. */
export class Controller {
  stick = { x: 0, z: 0 }; touchHold = false; jumps = 0;
  constructor(public binding: Binding | null) {}
  pressJump() { this.jumps++; }
  read(keys: Set<string>): Input {
    const b = this.binding, has = (codes: string[] | undefined) => !!codes?.some(c => keys.has(c));
    let mx = (has(b?.right) ? 1 : 0) - (has(b?.left) ? 1 : 0), mz = (has(b?.down) ? 1 : 0) - (has(b?.up) ? 1 : 0);
    if (!mx && !mz) { mx = this.stick.x; mz = this.stick.z; }
    // The camera looks along -z with no yaw, so screen up is world -z and screen right is world +x.
    return { mx, mz, jump: this.jumps, hold: has(b?.jump) || this.touchHold };
  }
}

/** Tracks held keys for the game screen; clears everything when the window loses focus so nobody runs on alone. */
export class Keyboard {
  keys = new Set<string>();
  private off: (() => void)[] = [];
  constructor(private controllers: Controller[], private onEscape?: () => void) {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.code === 'Escape' || e.code === 'KeyP') { if (!e.repeat) this.onEscape?.(); return; }
      if (!e.repeat) for (const c of this.controllers) if (c.binding?.jump.includes(e.code)) c.pressJump();
      this.keys.add(e.code);
    };
    const up = (e: KeyboardEvent) => { this.keys.delete(e.code); if (GAME_KEYS.has(e.code)) e.preventDefault(); };
    const clear = () => { this.keys.clear(); for (const c of this.controllers) { c.stick = { x: 0, z: 0 }; c.touchHold = false; } };
    const visibility = () => { if (document.hidden) clear(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', visibility);
    this.off.push(() => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', visibility); });
  }
  dispose() { for (const f of this.off) f(); this.keys.clear(); }
}
