/** The four original characters, built from simple shapes, with idle/run/jump/fall/victory/defeat animation. */
import * as THREE from 'three';
import { AVATARS, COLORS, type Look } from '../shared/rewards';
import type { Anim } from '../shared/sim';

export interface Character {
  root: THREE.Group; look: Look;
  /** Advance the animation. `speed` is ground speed; `squash` kicks in on landings. */
  animate(anim: Anim, speed: number, dt: number, time: number, reduced: boolean): void;
  land(hard: boolean): void;
  dispose(): void;
}

const std = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: .55, metalness: .05, ...extra });

export function bodyColor(look: Look) {
  const avatar = AVATARS.find(a => a.id === look.avatar) ?? AVATARS[0];
  return COLORS.find(c => c.id === look.color)?.value || avatar.color;
}

export function createCharacter(look: Look): Character {
  const avatar = AVATARS.find(a => a.id === look.avatar) ?? AVATARS[0];
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  const main = std(bodyColor(look)), accent = std(avatar.accent), white = std('#ffffff', { roughness: .3 }), dark = std('#1c1f33', { roughness: .4 });
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [main, accent, white, dark];
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = body) => { disposables.push(geo); const m = new THREE.Mesh(geo, mat); m.castShadow = false; parent.add(m); return m; };

  // Body silhouettes: each character has a shape you can recognise at a glance, even from far away.
  let eyeY = .62, eyeZ = .3, eyeSpread = .13;
  if (avatar.id === 'bramble') {
    mesh(new THREE.SphereGeometry(.4, 24, 18), main).position.y = .5;
    const stem = mesh(new THREE.CylinderGeometry(.03, .04, .18, 8), accent); stem.position.y = .97;
    for (const s of [-1, 1]) { const leaf = mesh(new THREE.SphereGeometry(.13, 12, 8), accent); leaf.scale.set(1.3, .35, .7); leaf.position.set(s * .12, 1.04, 0); leaf.rotation.z = s * .5; }
    for (let i = 0; i < 6; i++) { const a = i * 1.05; const dot = mesh(new THREE.SphereGeometry(.035, 8, 6), std('#ffd1df')); dot.position.set(Math.sin(a) * .36, .38 + (i % 2) * .16, Math.cos(a) * .2 - .05); }
    eyeY = .6; eyeZ = .34;
  } else if (avatar.id === 'zip') {
    mesh(new THREE.CapsuleGeometry(.27, .5, 8, 20), main).position.y = .55;
    const pole = mesh(new THREE.CylinderGeometry(.018, .018, .32, 6), dark); pole.position.y = 1.2;
    mesh(new THREE.SphereGeometry(.07, 12, 10), accent).position.y = 1.38;
    const belt = mesh(new THREE.TorusGeometry(.275, .03, 8, 24), accent); belt.rotation.x = Math.PI / 2; belt.position.y = .4;
    eyeY = .78; eyeZ = .25; eyeSpread = .11;
  } else if (avatar.id === 'nugget') {
    const box = mesh(new THREE.BoxGeometry(.66, .6, .58, 2, 2, 2), main); box.position.y = .42;
    const visor = mesh(new THREE.BoxGeometry(.5, .17, .06), dark); visor.position.set(0, .55, .3);
    for (const s of [-1, 1]) { const ear = mesh(new THREE.BoxGeometry(.1, .14, .1), accent); ear.position.set(s * .26, .79, 0); }
    eyeY = .55; eyeZ = .335; eyeSpread = .12;
  } else {
    const shape = [new THREE.Vector2(0, .05), new THREE.Vector2(.18, .1), new THREE.Vector2(.38, .38), new THREE.Vector2(.36, .62), new THREE.Vector2(.2, .86), new THREE.Vector2(0, .95)];
    mesh(new THREE.LatheGeometry(shape, 24), main);
    const swirl = mesh(new THREE.TorusGeometry(.2, .05, 8, 20, Math.PI * 1.4), accent); swirl.position.set(0, .55, -.32); swirl.rotation.y = Math.PI / 2;
    const star = mesh(new THREE.OctahedronGeometry(.09), accent); star.position.y = 1.02;
    eyeY = .6; eyeZ = .31;
  }
  // Eyes: white with dark pupils, the main source of expression.
  const eyes: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group(); eye.position.set(s * eyeSpread, eyeY, eyeZ); body.add(eye);
    mesh(new THREE.SphereGeometry(.085, 14, 10), white, eye).scale.z = .6;
    const pupil = mesh(new THREE.SphereGeometry(.045, 10, 8), dark, eye); pupil.position.z = .045;
    eyes.push(eye);
  }
  // Hands and feet give the run and the reactions their character.
  const hands = [-1, 1].map(s => { const h = mesh(new THREE.SphereGeometry(.085, 10, 8), accent); h.position.set(s * .42, .45, 0); return h; });
  const feet = [-1, 1].map(s => { const f = mesh(new THREE.SphereGeometry(.11, 12, 8), dark, root); f.scale.set(1, .6, 1.4); f.position.set(s * .15, .06, 0); return f; });

  let squash = 0, phase = 0, spin = 0;
  return {
    root, look,
    land(hard) { squash = hard ? 1 : .55; },
    animate(anim, speed, dt, time, reduced) {
      squash = Math.max(0, squash - dt * 4.5);
      phase += dt * (reduced ? 0 : 6 + speed * 2.6);
      let bob = 0, lean = 0, sx = 1, sy = 1, arm = 0, armUp = 0, eyeScale = 1;
      body.rotation.set(0, 0, 0); root.rotation.x = 0; root.rotation.z = 0;
      if (anim === 'run') { bob = Math.abs(Math.sin(phase)) * .07; lean = .16; arm = Math.sin(phase) * .25; }
      else if (anim === 'idle') { sy = 1 + Math.sin(time * 2.4) * .025; sx = 1 - Math.sin(time * 2.4) * .015; }
      else if (anim === 'jump') { sy = 1.12; sx = .92; armUp = .35; }
      else if (anim === 'fall') { sy = .96; armUp = .55 + (reduced ? 0 : Math.sin(time * 22) * .12); eyeScale = 1.25; }
      else if (anim === 'win') { bob = reduced ? 0 : Math.abs(Math.sin(time * 6)) * .32; armUp = .6; if (!reduced) spin += dt * 2.5; }
      else if (anim === 'lose') { sy = .86; sx = 1.06; lean = .32; eyeScale = .35; arm = -.1; }
      else if (anim === 'out') { armUp = .7; if (!reduced) { root.rotation.x = time * 5; root.rotation.z = time * 3; } }
      if (anim !== 'win') spin *= Math.exp(-dt * 6);
      const s = squash; sy *= 1 - .22 * s; sx *= 1 + .18 * s;
      body.scale.set(sx, sy, sx); body.position.y = bob; body.rotation.x = lean; body.rotation.y = spin;
      hands.forEach((h, i) => { const side = i ? 1 : -1; h.position.set(side * (.42 + armUp * .05), .45 + armUp * .5, arm * side); });
      feet.forEach((f, i) => { const side = i ? 1 : -1; f.position.z = anim === 'run' ? Math.sin(phase + (i ? Math.PI : 0)) * .16 : 0; f.position.y = .06 + (anim === 'run' ? Math.max(0, Math.sin(phase + (i ? Math.PI : 0))) * .08 : anim === 'jump' || anim === 'fall' ? .1 : 0); f.position.x = side * .15; });
      for (const e of eyes) e.scale.set(eyeScale, eyeScale * (anim === 'idle' && !reduced && (time % 3.4) < .1 ? .1 : 1), eyeScale);
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}

/** Height of the top of a character, for name tags. */
export const TAG_HEIGHT = 1.65;
