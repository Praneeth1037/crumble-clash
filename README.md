# Crumble Clash

Two players, three floating floors of hexagonal tiles. Every tile you stand on cracks and disappears 0.7 s later. Keep moving, jump the gaps, cut off your opponent's escape routes. Fall past the bottom floor and you're out. Best of five rounds.

Built with React + TypeScript + Vite and Three.js, like the other games in this repo. Online play uses a small Node server with WebSockets (the `ws` package that `fox-tug` and `lingo-duel` already use).

## Run it

```bash
cd crumble-clash
npm install
npm run dev          # game + online rooms on http://localhost:5190 (also printed: your LAN address)
```

That one command serves the client (through Vite, with hot reload) **and** runs the online room server on the same port. Local play also works with the plain client (`npm run client`), no server needed.

Production:

```bash
npm run build        # type-checks, then builds dist/
npm start            # serves dist/ and the rooms on PORT (default 5190)
```

Tests:

```bash
npm test             # simulation and room-server tests (vitest)
npm run test:browser # end-to-end in installed Chrome: local, touch, and a full two-browser online match
```

## Live

* **Play:** https://crumble-clash.vercel.app (Vercel serves the game page)
* **Room server:** https://crumble-clash.onrender.com (Render runs the online rooms; it also serves the game itself)

Vercel can't keep WebSockets open, so the page is built with `VITE_ROOM_SERVER` pointing at the Render server:

```bash
vercel deploy --prod --build-env VITE_ROOM_SERVER=https://crumble-clash.onrender.com
```

The Render service follows `render.yaml` and redeploys on every push to `main`. On the free plan it sleeps after about 15 idle minutes. The page wakes it as soon as someone opens the site, and shows "Waking up the online server…" until it answers (up to a minute).

## Controls

| | Move | Jump |
|---|---|---|
| Player 1 (local) | W A S D | Q |
| Player 2 (local) | Arrow keys | Space |
| Online | WASD or arrows | Space |
| Phone / tablet, upright | Drag on the left | JUMP button, bottom right |
| Phone / tablet, sideways | Drag on the right | JUMP button, bottom left |

* The ring under your feet (and the ring in your card) shows when your next jump is ready.
* **Esc** or **P** pauses a local match. Online, Esc opens "Leave the match?".
* **Party rules:** *Air Hop* = press Jump in mid-air (carry up to 2). *Feather Fall* = hold Jump while falling to drift down slowly. It never lifts you.

## Modes

* **Play Local**: split screen, one camera per player, so you can both see yourselves on different floors.
* **Create Private Room**: you get a 4-letter code and an invite link (`/?room=CODE`). Both players press *I'm ready* to start. The host picks Classic or Party.
* **Join Private Room**: type the code, or open the invite link.

The server owns online matches. Clients send only their stick direction and jump presses. The server runs the same simulation as local play and decides tile timers, falls, power-ups, scores and results. A third player is turned away from a full room. If someone drops, the match pauses and their seat is held for 30 s (they rejoin automatically, even after a page refresh). If they don't come back, the match ends with a clear message. Nobody is ever replaced by a bot.

## Tuning: where the numbers live

* **`shared/config.ts`**: everything that changes how it plays.
  * `PHYSICS`: speed, acceleration, braking, gravity, jump height, jump cooldown, jump buffer, fixed step.
  * `ARENA`: rings per floor, tile size, floor gap, spawn tile, holes per floor.
  * `CRUMBLE.delay`: time from first touch until a tile is gone (0.7 s).
  * `MATCH`: rounds to win, countdown, draw window, round time limit, collapse warning and interval.
  * `PARTY`: power-up timing, Air Hop and Feather Fall strength.
  * `ONLINE`: snapshot rate, interpolation delay, reconnect window, room limits, message rate limit.
* **`shared/rewards.ts`**: coins per match, win and round; the characters; colour and trail costs.

## How it is put together

```
shared/   config.ts, rewards.ts, hex.ts (grid maths), sim.ts (all game rules), protocol.ts (online messages)
server/   rooms.ts (authoritative private rooms), index.ts (HTTP + WebSocket + fixed-step loop)
src/      App.tsx (home, lobby, locker), Game.tsx (loop, HUD, touch), scene.ts (Three.js), characters.ts, sound.ts, input.ts, net.ts
tests/    sim.test.ts, rooms.test.ts (vitest), browser.ts (Playwright)
```

* **Fixed-step simulation:** the game always advances in steps of exactly 1/60 s, independent of frame rate, in the browser and on the server.
* **Collision matches what you see:** standing support is the hexagon under your centre, which is exactly each tile's footprint. Missing tiles have no collision at all. Landing checks every floor crossed during a step, so even a very fast fall can't pass through an intact floor.
* **Arenas:** each round's floors are mirror-symmetric through the centre (so both starts are equal), fully connected, and keep both spawn tiles and their neighbours intact. Starting sides alternate every round.
* **Anti-stalling:** after 60 s the outer ring of every floor flashes yellow for 2 s and then collapses, then the next ring in every 4 s.
* **Rewards:** coins come only from completed matches, are saved in `localStorage`, and buy colours and trails. Cosmetics never change hit size, speed or survival.

## Known limitations

* **Online movement has no client-side prediction.** You see your own character through the same smoothing as your opponent (about 80 ms behind the server) plus your network delay. It feels tight on the same Wi-Fi or a nearby server, and noticeably softer on high-latency connections.
* **"Simultaneous" means within 0.15 s.** Two eliminations closer together than `MATCH.drawWindow` are a draw, not only those in the exact same simulation step.
* **One server instance.** Rooms live in memory, so a restart drops current rooms. Static hosts (like Vercel) can serve local play, but online rooms need a Node host that keeps WebSockets open.
* **Coins are stored per browser** and are not protected against someone editing their own `localStorage`. They are cosmetic only, by design.
* **Local touch play** puts both thumbsticks on one screen, which works on tablets but is cramped on phones. Phones are best for online play.
* **No gamepad support yet.**
