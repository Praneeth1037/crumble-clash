/**
 * End-to-end check in a real browser (installed Chrome via Playwright). Starts its own server with short
 * countdowns and a 3 s reconnect window, then plays: local split-screen, touch controls, and a complete online
 * match between two separate browser sessions, including a full room, a rematch and a disconnect.
 *
 *   npm run test:browser            (screenshots go to test-output/)
 */
import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHYSICS } from '../shared/config';
import type { Snapshot } from '../shared/sim';
import { startServer } from '../server/index';

const out = resolve(process.argv[2] || 'test-output'); mkdirSync(out, { recursive: true });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (ok: unknown, what: string) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures++; };
const snap = (p: Page) => p.evaluate(() => window.__crumble?.snapshot() ?? null) as Promise<Snapshot | null>;
async function until(p: Page, test: (s: Snapshot) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await snap(p); if (s && test(s)) return s; await wait(50); }
  return null;
}

const server = await startServer({ port: 0, host: '127.0.0.1', hub: { reconnectSeconds: 3, match: { countdown: 1, roundOverSeconds: 0.8 } } });
const url = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({ channel: 'chrome' });
const errors: string[] = [];
const watch = (p: Page, who: string) => {
  p.on('pageerror', e => errors.push(`${who}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`${who}: ${m.text()}`); });
};

try {
  // ---------- Local: two players on one keyboard ----------
  {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } }); watch(p, 'local');
    await p.goto(url); await p.getByRole('button', { name: /Play Local/ }).click();
    const start = await until(p, s => s.phase === 'playing', 6000);
    check(start, 'local match counts down 3-2-1 and starts');
    await p.keyboard.down('KeyD'); await p.keyboard.down('ArrowLeft'); await wait(350);
    const moved = (await snap(p))!;
    check(moved.players[0].x > start!.players[0].x + .5 && moved.players[1].x < start!.players[1].x - .5, 'both players move at the same time (D and ←)');
    await p.keyboard.press('KeyQ'); await p.keyboard.press('Space'); await wait(60);
    const air = (await snap(p))!;
    check(air.players.every(q => !q.grounded && q.vy > 0), 'both players jump at the same time (Q and Space)');
    await p.keyboard.up('KeyD'); await p.keyboard.up('ArrowLeft');
    check(air.tiles.flat().some(c => c >= 1 && c <= 99), 'tiles under the players are cracking');
    await p.screenshot({ path: `${out}/local-split.png` });
    // Diagonal: W + D must not exceed top speed.
    await p.keyboard.down('KeyW'); await p.keyboard.down('KeyD'); await wait(300);
    const diag = (await snap(p))!; const v = Math.hypot(diag.players[0].vx, diag.players[0].vz);
    check(v <= PHYSICS.moveSpeed + 1e-3, `diagonal movement is not faster (${v.toFixed(2)} ≤ ${PHYSICS.moveSpeed})`);
    await p.keyboard.up('KeyW'); await p.keyboard.up('KeyD');
    // Page must not scroll on game keys; pause freezes the match.
    check(await p.evaluate(() => window.scrollY === 0), 'arrow keys and Space do not scroll the page');
    await p.keyboard.press('Escape'); const frozen = (await snap(p))!.t; await wait(400);
    check((await snap(p))!.t === frozen && await p.getByText('Paused').isVisible(), 'Esc pauses a local match');
    await p.getByRole('button', { name: 'Resume' }).click(); await wait(200);
    check((await snap(p))!.t > frozen, 'Resume carries on');
    // Losing focus releases held keys.
    await p.keyboard.down('KeyA'); await wait(100); await p.evaluate(() => window.dispatchEvent(new Event('blur'))); await wait(250);
    const afterBlur = (await snap(p))!; check(Math.abs(afterBlur.players[0].vx) < .5 || !afterBlur.players[0].grounded, 'a held key is released when the window loses focus');
    await p.keyboard.up('KeyA');
    await p.close();
  }

  // ---------- Touch: on-screen thumbsticks and jump buttons ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage(); watch(p, 'touch');
    await p.goto(url); await p.getByRole('button', { name: /Play Local/ }).tap();
    const start = await until(p, s => s.phase === 'playing', 6000);
    check(await p.locator('.touchpad').count() === 2, 'touch screens get a thumbstick and jump button for each local player');
    const zone = (await p.locator('.stick-zone').first().boundingBox())!;
    await p.mouse.move(zone.x + 60, zone.y + zone.height - 70); await p.mouse.down();
    await p.mouse.move(zone.x + 120, zone.y + zone.height - 70, { steps: 4 }); await wait(350);
    const s1 = (await snap(p))!; await p.mouse.up();
    check(s1.players[0].x > start!.players[0].x + .4, 'dragging the thumbstick moves the player');
    await p.locator('.jump-btn').nth(1).tap(); await wait(60);
    const s2 = (await snap(p))!; check(!s2.players[1].grounded && s2.players[1].vy > 0, 'tapping JUMP jumps');
    await p.screenshot({ path: `${out}/touch-local.png` });
    await ctx.close();
  }

  // ---------- Online: two separate browser sessions ----------
  {
    const hostCtx = await browser.newContext({ viewport: { width: 1180, height: 720 } });
    const guestCtx = await browser.newContext({ viewport: { width: 900, height: 420 }, hasTouch: true, isMobile: true });
    const host = await hostCtx.newPage(), guest = await guestCtx.newPage(); watch(host, 'host'); watch(guest, 'guest');
    await host.goto(url); await host.getByLabel('Player 1 name').fill('Ana');
    await host.getByRole('button', { name: 'Create Private Room' }).click();
    await host.locator('.code').waitFor(); const code = (await host.locator('.code').textContent())!.trim();
    check(/^[A-HJ-NP-Z2-9]{4}$/.test(code), `room created with code ${code}`);
    const invite = await host.getByLabel('Invite link').inputValue();
    check(invite.endsWith(`?room=${code}`), 'invite link carries the room code');
    await guest.goto(invite); await guest.getByLabel('Player 1 name').fill('Ben');
    check(await guest.getByLabel('Room code').inputValue() === code, 'opening the invite link fills in the code');
    await guest.getByRole('button', { name: 'Join Private Room' }).tap();
    await guest.getByText('Ben (you)').waitFor();
    await host.getByText('Ben').first().waitFor();
    check(await host.getByText('Not ready').count() === 2, 'lobby shows both players, not ready');
    // A third person is turned away.
    const third = await browser.newPage(); watch(third, 'third');
    await third.goto(url); await third.getByLabel('Room code').fill(code); await third.getByRole('button', { name: 'Join Private Room' }).click();
    await third.getByText('That room is full').waitFor({ timeout: 5000 }).catch(() => {});
    check(await third.getByText('That room is full').isVisible(), 'a third player cannot join a full room');
    await third.close();
    await host.getByRole('button', { name: "I'm ready" }).click(); await wait(200);
    check(await guest.getByText('Ready ✓').count() >= 1 && !(await snap(guest)), 'one ready player does not start the match');
    await guest.getByRole('button', { name: "I'm ready" }).tap();
    check(await until(host, s => s.phase === 'playing', 8000) && await until(guest, s => s.phase === 'playing', 8000), 'both ready: the match starts for both');
    check(await guest.locator('.touchpad').count() === 1, 'the phone player gets one thumbstick and a jump button');

    // Play it out: the guest (on the phone) runs off its own edge each round; the host keeps moving to stay alive.
    let hostKey = '', stickDir = 0, roundStart = Date.now(), lastRound = 0;
    const zone = (await guest.locator('.stick-zone').boundingBox())!, cx = zone.x + 80, cy = zone.y + zone.height - 80;
    const end = Date.now() + 60000; let final: Snapshot | null = null;
    while (Date.now() < end) {
      const h = await snap(host), g = await snap(guest);
      if (!h || !g) { await wait(50); continue; }
      if (h.phase === 'matchOver') { final = h; break; }
      if (h.round !== lastRound) { lastRound = h.round; roundStart = Date.now(); }
      const me = g.players[1], dir = g.phase === 'playing' && me.alive ? (me.x >= 0 ? 1 : -1) : 0;
      if (dir !== stickDir) {
        if (stickDir) await guest.mouse.up();
        if (dir) { await guest.mouse.move(cx, cy); await guest.mouse.down(); await guest.mouse.move(cx + dir * 50, cy, { steps: 2 }); }
        stickDir = dir;
      }
      const hp = h.players[0], t = Date.now() - roundStart;
      const want = h.phase !== 'playing' ? '' : t < 1700 ? (hp.x < 0 ? 'KeyD' : 'KeyA') : (t < 2600 ? 'KeyW' : 'KeyS');
      if (want !== hostKey) { if (hostKey) await host.keyboard.up(hostKey); if (want) await host.keyboard.down(want); hostKey = want; }
      await wait(60);
    }
    if (hostKey) await host.keyboard.up(hostKey); if (stickDir) await guest.mouse.up();
    check(final && final.matchWinner === 0 && final.wins[0] === 3, `an online match plays to a result (${final?.wins.join('–')})`);
    const gFinal = await until(guest, s => s.phase === 'matchOver', 3000);
    check(gFinal && gFinal.wins.join() === final?.wins.join(), 'both players see the same final score');
    // Online, each side reads the result from their own point of view.
    await host.getByText('YOU WIN!').waitFor({ timeout: 4000 }).catch(() => {});
    await guest.getByText('FRIEND WINS!').waitFor({ timeout: 4000 }).catch(() => {});
    check(await host.getByText('YOU WIN!').isVisible() && await guest.getByText('FRIEND WINS!').isVisible(), 'results screen on both sides (YOU WIN! / FRIEND WINS!)');
    check(await host.locator('.coins-earned').isVisible(), 'coins are awarded for a completed match');
    await host.screenshot({ path: `${out}/online-results-host.png` }); await guest.screenshot({ path: `${out}/online-results-guest.png` });
    const coins = await host.evaluate(() => JSON.parse(localStorage.getItem('crumble-clash-v1') || '{}').coins);
    check(coins > 0, `coins saved locally (${coins})`);

    // Rematch needs both.
    await host.getByRole('button', { name: 'Rematch' }).click();
    await guest.getByText('Your friend wants a rematch!').waitFor({ timeout: 3000 }).catch(() => {});
    check(await guest.getByText('Your friend wants a rematch!').isVisible(), 'the other player sees the rematch request');
    await guest.getByRole('button', { name: 'Rematch' }).tap();
    check(await until(host, s => s.round === 1 && s.wins[0] === 0 && s.phase !== 'matchOver', 5000), 'rematch starts a fresh match');
    await until(host, s => s.phase === 'playing', 4000);
    await host.screenshot({ path: `${out}/online-play-host.png` }); await guest.screenshot({ path: `${out}/online-play-guest.png` });

    // Disconnect: the host is told, the match pauses, and it ends when the reconnect window runs out.
    await guestCtx.close();
    await host.getByText('Your friend lost connection').waitFor({ timeout: 4000 }).catch(() => {});
    check(await host.getByText('Your friend lost connection').isVisible(), 'a disconnect pauses the match with a clear message');
    await wait(300); // let the display finish the last ~80 ms of buffered snapshots
    const pausedT = (await snap(host))!.t; await wait(500);
    check((await snap(host))!.t === pausedT, 'the match is frozen while waiting');
    await host.getByText('Match ended').waitFor({ timeout: 6000 }).catch(() => {});
    check(await host.getByText('did not reconnect in time').isVisible(), 'after the reconnect window the match ends (no bot replacement)');
    await host.screenshot({ path: `${out}/online-disconnect.png` });
    await hostCtx.close();
  }
  check(errors.length === 0, `no console or page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close(); await server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'All browser checks passed.');
process.exit(failures ? 1 : 0);
