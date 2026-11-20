import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ARENA, MATCH, ONLINE, PARTY, PHYSICS, type Ruleset } from '../shared/config';
import type { RoomView } from '../shared/protocol';
import { AVATARS, coinsFor, type Look } from '../shared/rewards';
import { Match, type GameEvent, type PlayerView, type Snapshot } from '../shared/sim';
import { Controller, Keyboard, LOCAL_BINDINGS, ONLINE_BINDING } from './input';
import type { Net } from './net';
import { ArenaScene, SEAT_COLORS } from './scene';
import type { Sound } from './sound';

export interface GameProps {
  mode: 'local' | 'online'; looks: [Look, Look]; names: [string, string]; ruleset: Ruleset;
  net?: Net; seat?: number; room?: RoomView | null;
  sound: Sound; reduced: boolean; touch: boolean;
  onExit(): void; onMatchOver(coins: number): void;
}
interface Banner { text: string; sub?: string; until: number; tone?: 'go' | 'win' | 'draw' | 'warn' }

declare global { interface Window { __crumble?: { snapshot(): Snapshot | null; seat: number; mode: string } } }

const FLOOR_NAMES = ['Top', 'Middle', 'Bottom'];

export function Game(props: GameProps) {
  const { mode, looks, names, ruleset, net, sound, reduced, touch } = props;
  const seat = mode === 'online' ? props.seat ?? 0 : 0;
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const controllers = useRef<Controller[]>([]), matchRef = useRef<Match | null>(null), pausedRef = useRef(false);
  const [hud, setHud] = useState<Snapshot | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [flash, setFlash] = useState<number[]>([]);
  const [paused, setPaused] = useState(false), [confirmLeave, setConfirmLeave] = useState(false);
  const [wide, setWide] = useState(true), [coins, setCoins] = useState<number | null>(null);
  const callbacks = useRef(props); callbacks.current = props;

  useEffect(() => {
    const el = canvas.current!, box = wrap.current!;
    const ctrls = mode === 'local' ? [new Controller(LOCAL_BINDINGS[0]), new Controller(LOCAL_BINDINGS[1])] : [new Controller(ONLINE_BINDING)];
    controllers.current = ctrls;
    const keyboard = new Keyboard(ctrls, () => {
      if (mode === 'local') { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); }
      else setConfirmLeave(v => !v);
    });
    const scene = new ArenaScene(el, mode === 'local' ? [{ seat: 0 }, { seat: 1 }] : [{ seat }], looks, reduced);
    const fit = () => { const r = box.getBoundingClientRect(); scene.resize(r.width, r.height); setWide(r.width >= r.height); };
    const ro = new ResizeObserver(fit); ro.observe(box); fit();
    window.addEventListener('resize', fit);

    const match = mode === 'local' ? new Match({ ruleset }) : null; matchRef.current = match;
    let latest: Snapshot | null = match?.snapshot() ?? null, hudAt = 0, raf = 0, last = performance.now(), carry = 0, inputAt = 0, awarded = -1, matchCount = 0;
    window.__crumble = { snapshot: () => latest, seat, mode };

    const onEvents = (events: GameEvent[]) => {
      scene.handle(events);
      const now = performance.now();
      for (const e of events) {
        switch (e.type) {
          case 'countdown': sound.play('count'); break;
          case 'go': sound.play('go'); setBanner({ text: 'GO!', until: now + 700, tone: 'go' }); break;
          case 'jump': sound.play('jump', e.seat ? 1.12 : 1); break;
          case 'airhop': sound.play('airhop'); break;
          case 'land': sound.play(e.hard ? 'landHard' : 'land'); break;
          case 'crack': sound.play('crack', .9 + (e.index % 5) * .05); break;
          case 'collapse': sound.play('collapse', .8 + (e.floor * .15)); break;
          case 'eliminated': sound.play('eliminated'); setFlash(f => [...f, e.seat]); setTimeout(() => setFlash(f => f.filter(s => s !== e.seat)), 650); break;
          case 'pickup': sound.play('pickup'); break;
          case 'pickup-spawn': sound.play('spawn'); break;
          case 'bump': sound.play('bump'); break;
          case 'warn': sound.play('warn'); if (e.ring === ARENA.rings) setBanner({ text: 'THE EDGES ARE FALLING', sub: 'Rings collapse from the outside in', until: now + 1800, tone: 'warn' }); break;
          case 'round-over': {
            const who = e.winner === null ? null : nameOf(e.winner);
            sound.play(e.winner === null ? 'draw' : 'roundWin');
            setBanner(e.winner === null ? { text: 'DRAW', sub: 'Both fell together — no point', until: now + MATCH.roundOverSeconds * 1000, tone: 'draw' }
              : { text: `${who} WINS THE ROUND`, sub: `${e.wins[0]} – ${e.wins[1]}`, until: now + MATCH.roundOverSeconds * 1000, tone: 'win' });
            break;
          }
          case 'match-over': {
            sound.play('matchWin'); matchCount++;
            if (awarded !== matchCount) {
              awarded = matchCount;
              // Coins: online, your own result; locally, the shared device earns the base plus every round played.
              const snap = latest, wins = snap?.wins ?? [0, 0];
              const earned = mode === 'online' ? coinsFor(e.winner === seat, wins[seat]) : coinsFor(false, wins[0] + wins[1]);
              setCoins(earned); callbacks.current.onMatchOver(earned);
            }
            break;
          }
          case 'round-start': if (e.round === 1) setCoins(null); break;
        }
      }
    };
    const nameOf = (s: number) => (callbacks.current.names[s] || `Player ${s + 1}`).toUpperCase();
    if (net) net.onEvents = onEvents;

    const frame = (nowMs: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(.1, (nowMs - last) / 1000); last = nowMs;
      let players: PlayerView[] = [];
      if (match) {
        if (!pausedRef.current) {
          carry += dt;
          while (carry >= PHYSICS.fixedStep) {
            ctrls.forEach((c, i) => match.setInput(i, c.read(keyboard.keys)));
            match.step(); carry -= PHYSICS.fixedStep;
            const ev = match.drainEvents(); if (ev.length) onEvents(ev);
          }
        }
        latest = match.snapshot(); players = latest.players;
      } else if (net) {
        const input = ctrls[0].read(keyboard.keys);
        net.sendInput(input, nowMs - inputAt > 250); if (nowMs - inputAt > 250) inputAt = nowMs;
        const blended = interpolate(net.buffer, nowMs / 1000);
        if (blended) { latest = blended.snap; players = blended.players; }
      }
      if (latest) scene.render(latest, players.length ? players : latest.players, dt);
      if (nowMs - hudAt > 80 && latest) { hudAt = nowMs; setHud(latest); }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf); keyboard.dispose(); ro.disconnect(); window.removeEventListener('resize', fit);
      scene.dispose(); if (net) net.onEvents = () => {}; delete window.__crumble;
    };
    // The scene is rebuilt only when the mode, seat or looks change.
  }, [mode, seat, net, ruleset, reduced, JSON.stringify(looks)]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!banner) return; const id = setTimeout(() => setBanner(null), Math.max(0, banner.until - performance.now())); return () => clearTimeout(id); }, [banner]);

  const room = props.room, online = mode === 'online';
  const views = online ? [seat] : [0, 1];
  const phase = hud?.phase;
  const counting = phase === 'countdown' && hud ? Math.ceil(hud.phaseTimer) : 0;
  const results = phase === 'matchOver' && hud;
  const rematch = () => { sound.play('click'); if (online) net?.send({ type: 'rematch' }); else { matchRef.current?.rematch(); setCoins(null); } };
  const iAskedRematch = online && room?.seats[seat]?.rematch;

  return (
    <div className={`game ${online ? 'online' : 'local'} ${wide ? 'wide' : 'tall'}`} ref={wrap}>
      <canvas ref={canvas} className="arena" aria-label="Crumble Clash arena" />
      {!online && <div className="divider" aria-hidden="true" />}
      <div className={`views views-${views.length}`}>
        {views.map(s => (
          <div className="view" key={s}>
            {hud && <PlayerCard snap={hud} seat={s} name={names[s]} look={looks[s]} ruleset={ruleset} keys={online ? 'WASD / arrows · Space' : s ? '← ↑ → ↓ · Space' : 'W A S D · Q'} />}
            {flash.includes(s) && <div className={`out-flash ${reduced ? 'calm' : ''}`}><span>OUT!</span></div>}
            {touch && <TouchPad controller={() => controllers.current[online ? 0 : s]} side={online ? 'single' : s ? 'right' : 'left'} />}
          </div>
        ))}
      </div>
      {hud && <Scoreboard snap={hud} names={names} />}
      {online && hud && <OpponentCard snap={hud} seat={1 - seat} name={names[1 - seat]} connected={room?.seats[1 - seat]?.connected ?? false} />}
      {counting > 0 && <div className="countdown" key={counting}>{counting}</div>}
      {banner && !counting && <div className={`banner ${banner.tone ?? ''}`} role="status"><b>{banner.text}</b>{banner.sub && <span>{banner.sub}</span>}</div>}
      <div className="game-actions">
        {online ? <button className="chip" onClick={() => setConfirmLeave(true)}>Leave</button>
          : <button className="chip" onClick={() => { pausedRef.current = true; setPaused(true); }} aria-label="Pause">Ⅱ Pause</button>}
      </div>

      {paused && !online && (
        <div className="overlay"><div className="panel">
          <h2>Paused</h2><p>Press Esc or P to carry on.</p>
          <button className="primary" onClick={() => { pausedRef.current = false; setPaused(false); }}>Resume</button>
          <button className="ghost" onClick={props.onExit}>Quit to home</button>
        </div></div>
      )}
      {confirmLeave && online && (
        <div className="overlay"><div className="panel">
          <h2>Leave the match?</h2><p>The match keeps running until you leave. Leaving ends it for your friend too.</p>
          <button className="primary" onClick={() => setConfirmLeave(false)}>Keep playing</button>
          <button className="ghost" onClick={props.onExit}>Leave room</button>
        </div></div>
      )}
      {online && room?.status === 'paused' && (
        <div className="overlay soft"><div className="panel">
          <h2>{room.seats[1 - seat]?.connected === false ? 'Your friend lost connection' : 'Reconnecting…'}</h2>
          <p>The match is paused. Waiting up to <b>{room.reconnectLeft ?? ONLINE.reconnectSeconds}s</b> for them to come back.</p>
        </div></div>
      )}
      {online && room?.status === 'finished' && room.ended && (
        <div className="overlay"><div className="panel">
          <h2>Match ended</h2>
          <p>{room.ended === 'opponent-left' ? 'Your friend left the room.' : 'Your friend did not reconnect in time.'} No coins are awarded for an unfinished match.</p>
          <button className="primary" onClick={props.onExit}>Back to home</button>
        </div></div>
      )}
      {results && !(online && room?.ended) && (
        <div className="overlay"><div className="panel results">
          <span className="eyebrow">MATCH OVER</span>
          <h2 style={{ color: SEAT_COLORS[hud.matchWinner ?? 0] }}>{(names[hud.matchWinner ?? 0] || 'Player').toUpperCase()} WINS!</h2>
          <div className="final-score"><span style={{ color: SEAT_COLORS[0] }}>{names[0]}</span><b>{hud.wins[0]} – {hud.wins[1]}</b><span style={{ color: SEAT_COLORS[1] }}>{names[1]}</span></div>
          {hud.draws > 0 && <p className="muted">{hud.draws} drawn round{hud.draws > 1 ? 's' : ''}</p>}
          {coins !== null && <p className="coins-earned">+{coins} coins</p>}
          <button className="primary" onClick={rematch} disabled={!!iAskedRematch}>{iAskedRematch ? 'Waiting for your friend…' : 'Rematch'}</button>
          {online && room?.seats[1 - seat]?.rematch && !iAskedRematch && <p className="muted">Your friend wants a rematch!</p>}
          <button className="ghost" onClick={props.onExit}>Home</button>
        </div></div>
      )}
    </div>
  );
}

/** Online: draw slightly in the past and blend between the two snapshots around that moment. */
function interpolate(buffer: { snap: Snapshot; at: number }[], now: number) {
  if (!buffer.length) return null;
  const newest = buffer[buffer.length - 1], renderT = newest.snap.t + (now - newest.at) - ONLINE.interpolationDelay;
  let a = buffer[0], b = newest;
  for (let i = buffer.length - 1; i > 0; i--) if (buffer[i - 1].snap.t <= renderT) { a = buffer[i - 1]; b = buffer[i]; break; }
  const span = b.snap.t - a.snap.t, k = span > 0 ? Math.max(0, Math.min(1, (renderT - a.snap.t) / span)) : 1;
  const players = b.snap.players.map((p, i) => {
    const q = a.snap.players[i]; if (!q || a.snap.round !== b.snap.round) return p;
    const jump = Math.hypot(p.x - q.x, p.z - q.z) > 3; // a respawn between rounds: snap, don't slide
    const mix = (x: number, y: number) => jump ? y : x + (y - x) * k;
    let dFacing = p.facing - q.facing; dFacing = Math.atan2(Math.sin(dFacing), Math.cos(dFacing));
    return { ...p, x: mix(q.x, p.x), y: mix(q.y, p.y), z: mix(q.z, p.z), facing: jump ? p.facing : q.facing + dFacing * k };
  });
  return { snap: b.snap, players };
}

function Scoreboard({ snap, names }: { snap: Snapshot; names: string[] }) {
  const pips = (seat: number) => Array.from({ length: MATCH.roundsToWin }, (_, i) => <i key={i} className={i < snap.wins[seat] ? 'on' : ''} style={{ ['--c' as string]: SEAT_COLORS[seat] }} />);
  const collapsing = snap.timeLeft <= 0 && snap.phase === 'playing';
  const mm = Math.floor(snap.timeLeft / 60), ss = Math.floor(snap.timeLeft % 60).toString().padStart(2, '0');
  return (
    <div className="scoreboard" aria-label={`Round ${snap.round}. ${names[0]} ${snap.wins[0]}, ${names[1]} ${snap.wins[1]}.`}>
      <div className="pips">{pips(0)}</div>
      <div className="round"><span>ROUND {snap.round}</span><b className={collapsing ? 'danger' : snap.timeLeft < 10 ? 'soon' : ''}>{collapsing ? 'COLLAPSE!' : `${mm}:${ss}`}</b><small>{snap.ruleset === 'party' ? 'PARTY' : 'CLASSIC'} · BEST OF 5</small></div>
      <div className="pips">{pips(1)}</div>
    </div>
  );
}

function FloorMeter({ floor, alive }: { floor: number; alive: boolean }) {
  return <span className="floors" aria-label={alive ? (floor >= 0 ? `${FLOOR_NAMES[floor]} floor` : 'In the air') : 'Out'}>{[0, 1, 2].map(f => <i key={f} className={floor === f ? 'on' : ''} />)}</span>;
}

function PlayerCard({ snap, seat, name, look, ruleset, keys }: { snap: Snapshot; seat: number; name: string; look: Look; ruleset: Ruleset; keys: string }) {
  const p = snap.players[seat], cd = p.jumpCd / PHYSICS.jumpCooldown, avatar = AVATARS.find(a => a.id === look.avatar);
  return (
    <div className="pcard" style={{ ['--seat' as string]: SEAT_COLORS[seat] }}>
      <div className="pname"><b>{name}</b><small>{avatar?.name}</small></div>
      <div className="prow">
        <FloorMeter floor={p.floor} alive={p.alive} />
        <span className="floor-label">{!p.alive ? 'OUT' : p.floor >= 0 ? `${FLOOR_NAMES[p.floor]} floor` : p.vy > 0 ? 'Jumping' : 'Falling…'}</span>
        <svg className="jump-ring" viewBox="0 0 36 36" aria-label={cd > 0 ? 'Jump recharging' : 'Jump ready'}>
          <circle cx="18" cy="18" r="15" className="track" /><circle cx="18" cy="18" r="15" className="fill" style={{ strokeDashoffset: 94.2 * cd }} />
          <text x="18" y="22">⤒</text>
        </svg>
      </div>
      {ruleset === 'party' && (
        <div className="powers">
          <span className={`power ${p.airHops ? 'on' : ''}`} title="Air Hop: press Jump in mid-air">⇈ Air Hop <b>×{p.airHops}</b></span>
          <span className={`power ${p.feather > 0 ? 'on' : ''} ${p.featherActive ? 'active' : ''}`} title="Feather Fall: hold Jump while falling">🪶 Feather <i style={{ width: `${p.feather / PARTY.featherMax * 100}%` }} /></span>
        </div>
      )}
      <small className="keys">{keys}</small>
    </div>
  );
}

function OpponentCard({ snap, seat, name, connected }: { snap: Snapshot; seat: number; name: string; connected: boolean }) {
  const p = snap.players[seat];
  return (
    <div className="opponent" style={{ ['--seat' as string]: SEAT_COLORS[seat] }}>
      <b>{name}</b>
      <FloorMeter floor={p.floor} alive={p.alive} />
      <span>{!connected ? 'Disconnected' : !p.alive ? 'Out' : p.floor >= 0 ? `${FLOOR_NAMES[p.floor]} floor` : 'Falling'}</span>
    </div>
  );
}

/** A floating thumbstick (appears where you touch) plus a jump button you can tap or hold. */
function TouchPad({ controller, side }: { controller: () => Controller | undefined; side: 'single' | 'left' | 'right' }) {
  const [knob, setKnob] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const stickId = useRef<number | null>(null);
  const R = 46;
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== stickId.current || !knob) return;
    let dx = e.clientX - knob.x, dy = e.clientY - knob.y; const d = Math.hypot(dx, dy);
    if (d > R) { dx = dx / d * R; dy = dy / d * R; }
    setKnob({ ...knob, dx, dy }); const c = controller(); if (c) c.stick = { x: dx / R, z: dy / R };
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => { if (e.pointerId !== stickId.current) return; stickId.current = null; setKnob(null); const c = controller(); if (c) c.stick = { x: 0, z: 0 }; };
  return (
    <div className={`touchpad ${side}`}>
      <div className="stick-zone"
        onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); stickId.current = e.pointerId; setKnob({ x: e.clientX, y: e.clientY, dx: 0, dy: 0 }); }}
        onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        {knob ? <div className="stick" style={{ left: knob.x, top: knob.y }}><i style={{ transform: `translate(${knob.dx}px, ${knob.dy}px)` }} /></div>
          : <div className="stick-hint">Drag to move</div>}
      </div>
      <button className="jump-btn" aria-label="Jump"
        onPointerDown={e => { e.preventDefault(); const c = controller(); if (c) { c.pressJump(); c.touchHold = true; } }}
        onPointerUp={() => { const c = controller(); if (c) c.touchHold = false; }}
        onPointerCancel={() => { const c = controller(); if (c) c.touchHold = false; }}
        onPointerLeave={() => { const c = controller(); if (c) c.touchHold = false; }}>JUMP</button>
    </div>
  );
}
