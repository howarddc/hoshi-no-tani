import * as THREE from 'three';
import { TAU, clamp, lerp, smoothstep } from './math.js';
import { GL_AIR, GL_HASH, GL_NOISE, GL_PAL, GL_UNI } from './glsl.js';
import { C } from './palette.js';
import { LC, PB, finishPainted, pbox, pcyl, tint } from './railway.js';

/*──────────────────────────── §17  TREATS ───────────────────────────────────*/
/* Hold out a biscuit; a corgi comes and takes it; hearts.
 *
 * Three pieces that only meet in update():
 *
 *   the hand    a viewmodel — a mesh kept in front of the camera each frame
 *   the lure    corgis steer toward you while the biscuit is out
 *   the hearts  ordinary particles, spawned at the muzzle on a successful feed
 *
 * The hand is NOT parented to the camera. Three only renders what hangs off
 * the scene, so a camera child would need the camera adding to the graph, and
 * that quietly changes what the shadow and reflection passes walk. It is far
 * less invasive to leave it a normal scene mesh and rewrite its transform from
 * the camera every frame — it then obeys the same NO_CAST contract as anything
 * else, and the reflection pass drops it because it is not in reflectSet.
 *
 * The interaction deliberately does not require precision. Asking someone to
 * land a 5 cm biscuit on a 4 cm muzzle in a first-person view with no crosshair
 * would be a chore, so REACH is generous and the dogs walk INTO you: hold the
 * treat out and the nearest few come trotting, which turns aiming into waiting.
 */

/*  Reach is measured from the biscuit to the corgi's muzzle marker.
    The number is only half the story: an adult's hand at rest is about 1.2 m
    above a corgi's nose, so the first version of this almost never fired —
    measured gaps of 1.33-1.95 m against a 0.85 m reach. Widening the radius
    would have "fixed" it by letting you feed dogs you were nowhere near.
    What actually closes the distance is both parties doing what they really
    do: the offer pose reaches DOWN (see _biscuit), and the corgi sits up and
    begs for it (see Corgi.beg). They meet in the middle, and 1.0 m is then
    ordinary rather than generous.                                            */
const REACH   = 1.60;
const LURE_R  = 14.0;   // how far a corgi will notice the biscuit
const COOL    = 2.6;    // seconds before the same dog can be fed again

/*──────────────────────── hearts ────────────────────────*/
/*  The implicit heart (x²+y²-1)³ = x²y³, which is cheaper than it looks and
    gives a proper cusp and point rather than two circles and a triangle.    */
export const HEART_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_AIR}
in vec2 vC; in float vAge; in float vSeed; in float vOp; in float vKind;
in vec3 vW; in vec3 vR; in vec3 vU; in vec3 vF; in float vDist;
out vec4 outColor;
void main(){
  // pop out, then drift up and shrink away
  float grow = smoothstep(0.0, 0.18, vAge) * (1.0 - 0.35*smoothstep(0.45, 1.0, vAge));
  if(!(grow > 0.01)) discard;
  vec2 p = vC / max(grow, 0.02) * 1.18;
  p.x *= 1.0 + 0.10*sin(vAge*9.0 + vSeed*6.0);   // a small beat
  p.y = -p.y;                                     // lobes up, point down
  float xx = p.x*p.x, yy = p.y*p.y;
  float t  = xx + yy - 1.0;
  float d  = t*t*t - xx*p.y*yy;
  float a  = smoothstep(0.05, -0.03, d);
  if(!(a > 0.01)) discard;                        // NaN-safe
  // lighter in the middle so it reads as painted rather than as a sticker
  float core = smoothstep(0.55, -0.35, d);
  vec3 col = mix(${C.heartEdge}, ${C.heartCore}, core);
  float a2 = a * vOp * (1.0 - smoothstep(0.55, 1.0, vAge));
  vec3 V = normalize(uCamPos - vW);
  col = aerial(col, vDist, V, vW.y);
  outColor = vec4(SAFE3(col), clamp(a2, 0.0, 1.0));
}`;

/*──────────────────────── the hand ────────────────────────*/
/*  Built facing +Z, origin at the wrist, so the whole thing can be dropped in
    front of the camera and pointed with the camera's own quaternion.        */
export function buildTreatHand(){
  const M = PB();
  const skin = LC('handSkin'), cuff = LC('handCuff');
  const bis = LC('treatBiscuit'), bisD = LC('treatBiscuitDark');

  // forearm, receding out of frame
  pcyl(M, [0,-0.02,-0.22], [0,0,-0.045], 0.052, 0.045, 8, cuff, 0, true, false);
  pcyl(M, [0,0,-0.05], [0,0.004,0.01], 0.047, 0.044, 8, skin, 0, false, false);
  // palm, tilted a little open
  pbox(M, 0, 0.006, 0.055, 0.044, 0.019, 0.052, 0, skin, 0);
  // four fingers, curled up to cradle the biscuit
  for(let i=0;i<4;i++){
    const x = -0.030 + i*0.020;
    const l = 0.050 - Math.abs(i-1.4)*0.005;
    pcyl(M, [x, 0.000, 0.100], [x, 0.020, 0.100+l], 0.0095, 0.0085, 6, skin, 0, true, true);
  }
  // thumb, across the near side
  pcyl(M, [0.040,-0.004,0.062], [0.020, 0.016, 0.116], 0.011, 0.0095, 6, skin, 0, true, true);

  /*  The biscuit: a bone, because a bone reads as "dog treat" at a glance and
      a plain lozenge does not.                                               */
  const by = 0.030, bz = 0.128;
  pcyl(M, [-0.030, by, bz], [0.030, by, bz], 0.0125, 0.0125, 8, bis, 0, true, true);
  for(const sx of [-1, 1]) for(const sy of [-1, 1]){
    pcyl(M, [sx*0.034, by + sy*0.011, bz], [sx*0.040, by + sy*0.013, bz],
         0.0125, 0.0115, 7, sy > 0 ? bis : tint(bisD, 1.04), 0, true, true);
  }
  return finishPainted(M);
}

/*──────────────────────── the controller ────────────────────────*/
const _fwd = new THREE.Vector3(), _rgt = new THREE.Vector3(), _up = new THREE.Vector3();
const _hand = new THREE.Vector3(), _mouth = new THREE.Vector3();

export class Treats {
  constructor(handMesh, hearts){
    this.hand = handMesh;
    this.hearts = hearts;
    this.out = false;         // is the biscuit being offered
    this.given = 0;           // the score
    this.raise = 0;           // 0 stowed, 1 fully out
    this.give = 0;            // countdown of the little "here you go" push
    this.bob = 0;
    /*  Set by the caller, as train.onChuff and walker.onFootstep are. Keeping
        it a callback is what stops this module needing to know the audio
        engine exists.                                                       */
    this.onFeed = null;
  }

  toggle(){ this.out = !this.out; return this.out; }

  /*  The biscuit's world position — the thing that actually has to reach the
      dog. Derived from the camera rather than read back off the mesh, so the
      test does not depend on the mesh having been updated first.            */
  _biscuit(camera, out){
    _fwd.set(0,0,-1).applyQuaternion(camera.quaternion);
    _rgt.set(1,0,0).applyQuaternion(camera.quaternion);
    _up .set(0,1,0).applyQuaternion(camera.quaternion);
    /*  Where this sits is constrained from both ends. Too high and it never
        reaches a begging corgi; too low and it leaves the screen — the mesh
        moves WITH the camera, so once it is below the frame no amount of
        looking down brings it back. The camera is 52 deg vertically, so the
        drop must stay under tan(26 deg) = 0.49 of the forward distance.
        Stowed it deliberately breaks that ratio and slides out of view.     */
    const reach = 0.40 + this.raise*0.24 + this.give*0.14;
    return out.copy(camera.position)
      .addScaledVector(_fwd, reach)
      .addScaledVector(_rgt, 0.17 - this.raise*0.04)
      .addScaledVector(_up, -0.34 + this.raise*0.08 - this.bob*0.012);
  }

  update(dt, t, camera, corgis){
    this.raise += ((this.out ? 1 : 0) - this.raise) * clamp(dt*7.0, 0, 1);
    this.give = Math.max(0, this.give - dt*2.2);
    this.bob = Math.sin(t*1.6)*0.5 + Math.sin(t*2.7)*0.3;

    // ── place the viewmodel ──
    this._biscuit(camera, _hand);
    // stowed, it sits below the frame rather than being toggled invisible, so
    // there is a hand dropping out of view instead of one blinking off
    this.hand.visible = this.raise > 0.01;
    if(this.hand.visible){
      this.hand.position.copy(camera.position)
        .addScaledVector(_fwd, 0.40 + this.raise*0.18 + this.give*0.12)
        .addScaledVector(_rgt, 0.19)
        .addScaledVector(_up, -0.34 + this.raise*0.10 - this.bob*0.010);
      this.hand.quaternion.copy(camera.quaternion);
      this.hand.rotateX(-0.30 + this.raise*0.22);
      this.hand.rotateY(-0.20);
      this.hand.rotateZ(0.12 + this.bob*0.02);
    }

    if(!corgis) return;

    // ── the lure, and the feed ──
    for(let i=0;i<corgis.dogs.length;i++){
      const d = corgis.dogs[i];
      d.fedCool = Math.max(0, d.fedCool - dt);
      d.joy     = Math.max(0, d.joy - dt);

      if(!this.out){ d.lure = null; continue; }

      const dx = d.pos.x - camera.position.x, dz = d.pos.y - camera.position.z;
      const far = Math.hypot(dx, dz);
      /*  Lure them to a spot IN FRONT of you, not to you.
          Homing on the camera itself made them converge from every side and
          settle at your heels — measured forward distances of 0.04, -0.60,
          -0.31 m, i.e. behind the eye — so you fed dogs you could not see.
          A point a little ahead, fanned into three lanes, keeps the pack in
          shot and stops them stacking on one pixel.                         */
      const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
      const ox = -_fwd.z/fl, oz = _fwd.x/fl;          // horizontal perpendicular
      const lane = ((i % 3) - 1) * 0.62;
      // a dog that has just been fed loses interest for a moment, which stops
      // the whole pack piling onto one spot and never dispersing again
      d.lure = (far < LURE_R && d.fedCool <= 0)
        ? { x: camera.position.x + _fwd.x/fl*1.85 + ox*lane,
            z: camera.position.z + _fwd.z/fl*1.85 + oz*lane } : null;

      if(d.fedCool > 0 || far > 3.0) continue;
      d.mouthWorld(_mouth);
      if(_mouth.distanceTo(_hand) > REACH) continue;

      /*  ── eaten ──
          One biscuit at a time: the hand goes away and you press G again for
          the next. That is what makes each treat a decision rather than a
          hosepipe — walk in holding it out and you would otherwise feed the
          whole pack in three seconds without choosing anything.
          `out = false` also clears every lure on the next pass, so the pack
          disperses and has to be called back in.                            */
      this.given++;
      d.fedCool = COOL;
      d.joy = 2.2;
      d.lure = null;
      this.give = 1.0;
      this.out = false;
      this.burst(_mouth);
      if(this.onFeed) this.onFeed(_mouth);
      break;                    // exactly one dog gets it; the rest missed out
    }
  }

  /*  Hearts, at the muzzle. Spawned upward with a little sideways spread so
      they separate as they rise instead of stacking into one blob.          */
  burst(at){
    if(!this.hearts) return;
    const n = 4 + (Math.random()*3 | 0);
    for(let i=0;i<n;i++){
      const a = Math.random()*TAU;
      this.hearts.spawn({
        x: at.x + (Math.random()-0.5)*0.10,
        y: at.y + 0.10 + Math.random()*0.06,
        z: at.z + (Math.random()-0.5)*0.10,
        vx: Math.cos(a)*0.22, vy: 0.62 + Math.random()*0.34, vz: Math.sin(a)*0.22,
        life: 1.5 + Math.random()*0.7,
        size: 0.075 + Math.random()*0.035,
        seed: Math.random()*100, kind: 0, op: 0.95,
      });
    }
  }

  /*  Hearts drift up, slow down, and wobble. Kept here rather than in the
      frame loop so everything the treat owns lives in one place.            */
  updateHearts(dt){
    if(!this.hearts) return;
    const P = this.hearts;
    for(let i=0;i<P.max;i++){
      const d = P.data[i];
      if(!d.alive) continue;
      d.age += dt;
      if(d.age >= d.life){ P.kill(d); continue; }
      d.vy += (0.42 - d.vy) * clamp(dt*1.4, 0, 1);
      d.vx *= (1 - clamp(dt*1.7, 0, 1));
      d.vz *= (1 - clamp(dt*1.7, 0, 1));
      d.x += d.vx*dt + Math.sin(d.age*4.0 + d.seed)*dt*0.10;
      d.y += d.vy*dt;
      d.z += d.vz*dt;
    }
  }
}
