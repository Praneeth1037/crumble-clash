import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CRUMBLE, MATCH, PARTY, type Ruleset } from '../shared/config';
import { ROOM_CODE } from '../shared/protocol';
import { AVATARS, COLORS, TRAILS, type Cosmetic, type Look } from '../shared/rewards';
import { Game } from './Game';
import { Net, ROOM_SERVER, wakeRoomServer } from './net';
import { SEAT_COLORS } from './scene';
import { Sound } from './sound';
import { loadProfile, ownedLook, saveProfile, type Profile } from './storage';

type Screen = 'home' | 'local' | 'online';
const isTouch = () => typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);

export function App() {
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const sound = useMemo(() => new Sound(), []);
  const [screen, setScreen] = useState<Screen>('home');
  const [net, setNet] = useState<Net | null>(null);
  const [howTo, setHowTo] = useState(false), [locker, setLocker] = useState<0 | 1 | null>(null);
  const invite = useMemo(() => { const c = new URLSearchParams(location.search).get('room')?.toUpperCase() || ''; return ROOM_CODE.test(c) ? c : ''; }, []);
  const [joinCode, setJoinCode] = useState(invite);
  const [touch] = useState(isTouch);

  useEffect(() => { saveProfile(profile); sound.set(profile.volume, profile.muted); }, [profile, sound]);
  useEffect(() => () => sound.dispose(), [sound]);
  useEffect(wakeRoomServer, []);
  const update = (patch: Partial<Profile>) => setProfile(p => ({ ...p, ...patch }));
  const click = () => { sound.unlock(); sound.play('click'); };

  const looks: [Look, Look] = [ownedLook(profile, profile.looks[0]), ownedLook(profile, profile.looks[1])];
  const goHome = () => { net?.close(); setNet(null); setScreen('home'); if (location.search) history.replaceState(null, '', location.pathname); };
  const host = () => { click(); const n = Net.create(profile.names[0], looks[0], profile.ruleset); setNet(n); setScreen('online'); };
  const join = (code = joinCode) => { click(); const n = Net.join(code.trim(), profile.names[0], looks[0]); setNet(n); setScreen('online'); };
  const earn = (coins: number) => setProfile(p => ({ ...p, coins: p.coins + coins, matches: p.matches + 1 }));

  if (screen === 'local') return <Game mode="local" looks={looks} names={profile.names} ruleset={profile.ruleset} sound={sound} reduced={profile.reducedMotion} touch={touch} onExit={goHome} onMatchOver={earn} />;
  if (screen === 'online' && net) return <Online net={net} sound={sound} profile={profile} touch={touch} onExit={goHome} onMatchOver={earn} />;

  const next = [...COLORS, ...TRAILS].filter(c => !profile.owned.includes(c.id)).sort((a, b) => a.cost - b.cost)[0];
  return (
    <main className="home">
      <div className="sky" aria-hidden="true"><i /><i /><i /><i /></div>
      <header className="home-top">
        <h1>Crumble<span>Clash</span></h1>
        <div className="wallet" aria-label={`${profile.coins} coins`}>🪙 {profile.coins}</div>
      </header>
      <p className="tagline">Every tile you touch starts to crack. Keep moving, jump the gaps, cut off your friend — last one standing wins.</p>

      <section className="home-grid">
        <div className="card play">
          <h2>Play</h2>
          <div className="ruleset" role="radiogroup" aria-label="Rules">
            {(['classic', 'party'] as Ruleset[]).map(r => (
              <button key={r} role="radio" aria-checked={profile.ruleset === r} className={profile.ruleset === r ? 'on' : ''} onClick={() => { click(); update({ ruleset: r }); }}>
                <b>{r === 'classic' ? 'Classic' : 'Party'}</b><small>{r === 'classic' ? 'Movement and jumping only' : 'Air Hop & Feather Fall power-ups'}</small>
              </button>
            ))}
          </div>
          <button className="primary big" onClick={() => { click(); setScreen('local'); }}>Play Local <span>2 players · {touch ? 'one screen' : 'one keyboard'}</span></button>
          <button className="secondary" onClick={host}>Create Private Room</button>
          <form className="join" onSubmit={e => { e.preventDefault(); if (ROOM_CODE.test(joinCode.toUpperCase())) join(); }}>
            <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))} placeholder="CODE" aria-label="Room code" autoCapitalize="characters" autoComplete="off" />
            <button className="secondary" disabled={!ROOM_CODE.test(joinCode)}>Join Private Room</button>
          </form>
          {invite && <p className="invite-note">You were invited to room <b>{invite}</b>. Pick your character below, then press Join.</p>}
          <button className="ghost" onClick={() => { click(); setHowTo(true); }}>How to Play</button>
        </div>

        <div className="card players">
          <h2>Characters</h2>
          {[0, 1].map(i => (
            <div className="player-pick" key={i} style={{ ['--seat' as string]: SEAT_COLORS[i] }}>
              <span className="seat-tag">P{i + 1}{i === 0 ? ' · you online' : ''}</span>
              <AvatarIcon look={looks[i]} size={64} />
              <div>
                <input value={profile.names[i]} maxLength={14} aria-label={`Player ${i + 1} name`} onChange={e => { const names = [...profile.names] as [string, string]; names[i] = e.target.value; update({ names }); }} />
                <div className="avatar-row">
                  {AVATARS.map(a => <button key={a.id} className={looks[i].avatar === a.id ? 'on' : ''} aria-label={a.name} title={`${a.name}: ${a.tagline}`} onClick={() => { click(); const l = [...profile.looks] as [Look, Look]; l[i] = { ...l[i], avatar: a.id }; update({ looks: l }); }}><AvatarIcon look={{ ...looks[i], avatar: a.id }} size={30} /></button>)}
                </div>
                <button className="chip" onClick={() => { click(); setLocker(i as 0 | 1); }}>Colours & trails</button>
              </div>
            </div>
          ))}
          {next && <div className="progress"><span>Next unlock: <b>{next.name}</b> ({next.cost} 🪙)</span><i style={{ width: `${Math.min(100, profile.coins / next.cost * 100)}%` }} /></div>}
        </div>

        <div className="card settings">
          <h2>Settings</h2>
          <label className="row">Sound <input type="range" min={0} max={1} step={.05} value={profile.volume} onChange={e => update({ volume: Number(e.target.value) })} aria-label="Volume" /></label>
          <label className="row"><input type="checkbox" checked={profile.muted} onChange={e => update({ muted: e.target.checked })} /> Mute all sound</label>
          <label className="row"><input type="checkbox" checked={profile.reducedMotion} onChange={e => update({ reducedMotion: e.target.checked })} /> Reduced motion (no shaking, flashing or spinning)</label>
          <p className="muted">Coins come from completed matches and only buy looks. They never change how anyone plays.</p>
        </div>
      </section>

      {howTo && <HowTo onClose={() => setHowTo(false)} />}
      {locker !== null && <Locker seat={locker} profile={profile} onChange={setProfile} onClose={() => setLocker(null)} onClick={click} />}
    </main>
  );
}

function Online({ net, sound, profile, touch, onExit, onMatchOver }: { net: Net; sound: Sound; profile: Profile; touch: boolean; onExit(): void; onMatchOver(c: number): void }) {
  useSyncExternalStore(cb => net.subscribe(cb), () => `${net.status}|${net.seat}|${net.slowStart}|${JSON.stringify(net.room)}|${net.error?.code}`);
  const [copied, setCopied] = useState(false);
  const room = net.room, seat = net.seat;
  if (net.error && (net.error.code === 'full' || net.error.code === 'not-found' || net.error.code === 'too-many-rooms') && !room) {
    return <div className="lobby"><div className="panel"><h2>{net.error.code === 'full' ? 'That room is full' : net.error.code === 'not-found' ? 'Room not found' : 'Server busy'}</h2><p>{net.error.message}</p><button className="primary" onClick={onExit}>Back to home</button></div></div>;
  }
  if (!room || seat < 0) return <div className="lobby"><div className="panel">
    <h2>{net.status === 'closed' ? 'Could not reach the game server' : 'Connecting…'}</h2>
    {net.status !== 'closed' && net.slowStart && <p>Waking up the online server. The first game after a quiet spell can take up to a minute.</p>}
    {net.status === 'closed' && <p>{ROOM_SERVER ? 'The online server is not answering right now. Try again in a minute, or play Local in the meantime.' : <>Online rooms need the Crumble Clash server running (<code>npm run dev</code>).</>}</p>}
    <button className="ghost" onClick={onExit}>Cancel</button></div></div>;

  // In the match itself it's simply you and your friend.
  const matchNames = [0, 1].map(i => i === seat ? 'You' : 'Friend') as [string, string];
  const looks = room.seats.map((s, i) => s?.look || profile.looks[i]) as [Look, Look];
  if (room.status !== 'lobby') {
    return <>
      <Game mode="online" net={net} seat={seat} room={room} looks={looks} names={matchNames} ruleset={room.ruleset} sound={sound} reduced={profile.reducedMotion} touch={touch} onExit={onExit} onMatchOver={onMatchOver} />
      {net.status === 'reconnecting' && <div className="net-banner">Connection lost — reconnecting…</div>}
    </>;
  }
  const link = `${location.origin}${location.pathname}?room=${room.code}`, me = room.seats[seat];
  return (
    <div className="lobby">
      <div className="panel lobby-panel">
        <span className="eyebrow">PRIVATE ROOM</span>
        <h2 className="code" aria-label={`Room code ${room.code.split('').join(' ')}`}>{room.code}</h2>
        <div className="share"><input readOnly value={link} aria-label="Invite link" onFocus={e => e.currentTarget.select()} /><button className="chip" onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)); }}>{copied ? 'Copied!' : 'Copy invite'}</button></div>
        <div className="ruleset compact" role="radiogroup" aria-label="Rules">
          {(['classic', 'party'] as Ruleset[]).map(r => <button key={r} role="radio" aria-checked={room.ruleset === r} className={room.ruleset === r ? 'on' : ''} disabled={seat !== 0} onClick={() => net.send({ type: 'ruleset', ruleset: r })}>{r === 'classic' ? 'Classic' : 'Party'}</button>)}
        </div>
        {seat !== 0 && <p className="muted">The host picks the rules.</p>}
        <div className="seats">
          {room.seats.map((s, i) => (
            <div className={`seat ${s?.ready ? 'ready' : ''}`} key={i} style={{ ['--seat' as string]: SEAT_COLORS[i] }}>
              {s ? <><AvatarIcon look={s.look} size={44} /><b>{s.name}{i === seat ? ' (you)' : ''}</b><span>{!s.connected ? 'Reconnecting…' : s.ready ? 'Ready ✓' : 'Not ready'}</span></>
                : <><div className="empty-avatar">?</div><b>Waiting for a friend…</b><span>Share the code or link</span></>}
            </div>
          ))}
        </div>
        <button className={`primary big ${me?.ready ? 'on' : ''}`} onClick={() => { sound.unlock(); sound.play('click'); net.send({ type: 'ready', ready: !me?.ready }); }}>{me?.ready ? 'Ready ✓ (tap to cancel)' : "I'm ready"}</button>
        <p className="muted">{room.seats.every(Boolean) ? 'The match starts when both players are ready.' : 'Waiting for your friend to join.'}</p>
        {net.status === 'reconnecting' && <p className="warn-text">Connection lost — reconnecting…</p>}
        <button className="ghost" onClick={onExit}>Leave room</button>
      </div>
    </div>
  );
}

function HowTo({ onClose }: { onClose(): void }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="howto-title" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel howto">
        <h2 id="howto-title">How to Play</h2>
        <ol>
          <li><b>Every tile cracks when you stand on it</b> and disappears {CRUMBLE.delay} seconds later. Touching it again doesn't reset the clock, and jumping over a tile doesn't wake it.</li>
          <li><b>Fall through a hole</b> and you drop to the floor below. There are three floors. Fall past the bottom one and you're out.</li>
          <li><b>Last one standing wins the round.</b> If you both fall at the same moment it's a draw. First to {MATCH.roundsToWin} round wins takes the match.</li>
          <li><b>Don't stall:</b> after {MATCH.roundTimeLimit} seconds the outer rings flash yellow and then collapse, one ring at a time.</li>
          <li><b>Party rules</b> add power-ups: <em>Air Hop</em> (press Jump in mid-air, carry up to {PARTY.airHopMax}) and <em>Feather Fall</em> (hold Jump while falling to drift down slowly; it never lifts you).</li>
        </ol>
        <table className="keys-table"><tbody>
          <tr><th></th><th>Move</th><th>Jump</th></tr>
          <tr><td>Player 1 (local)</td><td>W A S D</td><td>Q</td></tr>
          <tr><td>Player 2 (local)</td><td>Arrow keys</td><td>Space</td></tr>
          <tr><td>Online</td><td>WASD or arrows</td><td>Space</td></tr>
          <tr><td>Phone / tablet</td><td>Drag the thumbstick</td><td>JUMP button</td></tr>
        </tbody></table>
        <p className="muted">Esc or P pauses a local match. The ring under your feet shows when your next jump is ready.</p>
        <button className="primary" onClick={onClose}>Got it</button>
      </div>
    </div>
  );
}

function Locker({ seat, profile, onChange, onClose, onClick }: { seat: 0 | 1; profile: Profile; onChange(p: Profile): void; onClose(): void; onClick(): void }) {
  const look = profile.looks[seat];
  const equip = (key: 'color' | 'trail', item: Cosmetic) => {
    onClick();
    let next = profile;
    if (!profile.owned.includes(item.id)) { if (profile.coins < item.cost) return; next = { ...profile, coins: profile.coins - item.cost, owned: [...profile.owned, item.id] }; }
    const looks = [...next.looks] as [Look, Look]; looks[seat] = { ...looks[seat], [key]: item.id }; onChange({ ...next, looks });
  };
  const row = (key: 'color' | 'trail', items: Cosmetic[]) => (
    <div className="cosmetics">
      {items.map(item => {
        const owned = profile.owned.includes(item.id), on = look[key] === item.id;
        return <button key={item.id} className={`${on ? 'on' : ''} ${owned ? '' : 'locked'}`} disabled={!owned && profile.coins < item.cost} onClick={() => equip(key, item)}>
          <i style={{ background: item.value || (key === 'color' ? AVATARS.find(a => a.id === look.avatar)?.color : 'transparent') }} />
          <b>{item.name}</b><small>{on ? 'Equipped' : owned ? 'Owned' : `${item.cost} 🪙`}</small>
        </button>;
      })}
    </div>
  );
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Colours and trails" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel locker">
        <h2>Player {seat + 1} looks</h2>
        <AvatarIcon look={ownedLook(profile, look)} size={80} />
        <p className="wallet">🪙 {profile.coins} coins</p>
        <h3>Colours</h3>{row('color', COLORS)}
        <h3>Trails</h3>{row('trail', TRAILS)}
        <p className="muted">Looks are purely cosmetic.</p>
        <button className="primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** Flat portraits of the four characters, matching their 3D silhouettes. */
export function AvatarIcon({ look, size }: { look: Look; size: number }) {
  const a = AVATARS.find(x => x.id === look.avatar) ?? AVATARS[0];
  const body = COLORS.find(c => c.id === look.color)?.value || a.color;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="avatar-icon">
      <ellipse cx="32" cy="58" rx="16" ry="3.5" fill="#00000022" />
      {a.id === 'bramble' && <><circle cx="32" cy="36" r="19" fill={body} /><path d="M32 17 q-9 -6 -14 -2 q7 5 14 2 q9 -6 14 -2 q-7 5 -14 2" fill={a.accent} /></>}
      {a.id === 'zip' && <><rect x="19" y="16" width="26" height="40" rx="13" fill={body} /><line x1="32" y1="16" x2="32" y2="6" stroke="#1c1f33" strokeWidth="2" /><circle cx="32" cy="5" r="3.5" fill={a.accent} /><rect x="19" y="42" width="26" height="3" fill={a.accent} /></>}
      {a.id === 'nugget' && <><rect x="14" y="22" width="36" height="32" rx="7" fill={body} /><rect x="19" y="27" width="26" height="8" rx="3" fill={a.accent} /><rect x="16" y="16" width="6" height="8" fill={a.accent} /><rect x="42" y="16" width="6" height="8" fill={a.accent} /></>}
      {a.id === 'comet' && <><path d="M32 8 C46 22 52 34 44 50 Q32 58 20 50 C12 34 18 22 32 8Z" fill={body} /><path d="M50 30 q8 6 2 14" stroke={a.accent} strokeWidth="4" fill="none" strokeLinecap="round" /></>}
      {a.id !== 'nugget' && <><circle cx="26" cy={a.id === 'zip' ? 27 : 33} r="4.2" fill="#fff" /><circle cx="38" cy={a.id === 'zip' ? 27 : 33} r="4.2" fill="#fff" /><circle cx="26.6" cy={a.id === 'zip' ? 27.6 : 33.6} r="2.1" fill="#1c1f33" /><circle cx="38.6" cy={a.id === 'zip' ? 27.6 : 33.6} r="2.1" fill="#1c1f33" /></>}
      {a.id === 'nugget' && <><circle cx="27" cy="31" r="2.6" fill="#fff" /><circle cx="37" cy="31" r="2.6" fill="#fff" /></>}
    </svg>
  );
}
