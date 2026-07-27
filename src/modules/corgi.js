import * as THREE from 'three';
import { CFG } from './config.js';
import { TAU, clamp, lerp, smoothstep, rng } from './math.js';
import { sampleHeight, sampleNormal, riverField, pathDistance } from './terrain.js';
import { PB, pcyl, pbox, finishPainted, LC, mixc } from './railway.js';

/*──────────────────────────── §16  THE CORGIS ───────────────────────────────*/
/* A few Pembrokes loose in the meadow by the spawn knoll.
 *
 * These are the first things in the valley with any will of their own, so they
 * are built differently from everything else in it.  The train runs on rails
 * and the mill wheel turns on a fixed axis: both can be posed from a single
 * scalar.  A dog wanders, and a wandering thing needs a body whose parts move
 * independently of one another, so each corgi is a small hierarchy of meshes
 * rather than one rigid buffer:
 *
 *     corgi                    yaw, and the walk across the ground
 *       └ body                 the bob and the roll of a trot
 *           ├ torso            one mesh, the sausage and its ruff
 *           ├ head             bobs, and dips to sniff
 *           ├ tail             wags, permanently
 *           └ leg x4           each swings about its own hip
 *
 * The geometry is deliberately chunky.  Everything else hand-modelled in this
 * valley — the cottages, the tender, the viaduct's voussoirs — is boxes and
 * capped cylinders read through the painterly light model, and a smoothly
 * subdivided dog would look like it had wandered in from another film.
 *
 * A note on scale, because it drove the placement.  Built at life size a
 * Pembroke stands 0.29 m at the shoulder — and this meadow is about a metre
 * tall (grass.js: `hgt` lands near 1.0 and exceeds 1.4 in the lush clumps).
 * A life-size corgi in it is not chest-deep, it is *gone*: the first version of
 * this was six invisible dogs, findable only by flying up and spotting the odd
 * reddish pixel between the blades.
 *
 * Two ways out. Scaling a corgi tall enough to clear a metre of grass makes it
 * a Great Dane wearing a corgi suit, so instead they are scaled up only
 * slightly, for readability, and they live where the grass does not — the
 * footpath. bakeSplat clears the tread completely (`mask *= smoothstep(0.7,
 * 2.4, dp)`), so the path and its verge are the one place near the spawn knoll
 * where a small dog is a small dog and not a rumour.
 *
 * They still bound off into the deep meadow now and again, and when they do all
 * you see is a pair of ears and a wagging tail moving through the blades. That
 * is the good version of the bug.                                            */

/*  Enough to read clearly at ten metres without turning a corgi into a
    wolfhound. 1.35 puts the shoulder at ~0.39 m and the ear tips near 0.65 m —
    a large Pembroke, and unmistakably still a Pembroke.                      */
const SIZE = 1.35;

/*  Four coats.  `top` is the back and skull, `side` the flanks where a real
    Pembroke's colour breaks toward the belly, `trim` the white that runs up the
    chest, muzzle, paws and tail tip on nearly every one of them.             */
const COATS = [
  { name:'red',    top:'dogRed',   side:'dogRed',   belly:'dogCream', trim:'dogWhite' },
  { name:'sable',  top:'dogSable', side:'dogRed',   belly:'dogFawn',  trim:'dogWhite' },
  { name:'fawn',   top:'dogFawn',  side:'dogFawn',  belly:'dogCream', trim:'dogWhite' },
  { name:'tri',    top:'dogBlack', side:'dogBlack', belly:'dogTan',   trim:'dogWhite' },
];

/*  Material slots understood by PAINTED_FS: 0 is matte, 1 takes crisper light
    bands.  Fur is matte; the nose gets slot 1 so it reads as wet.            */
const M_FUR = 0, M_WET = 1;

function coatOf(c){
  return {
    top:   LC(c.top),
    side:  LC(c.side),
    belly: LC(c.belly),
    trim:  LC(c.trim),
    nose:  LC('dogNose'),
    tongue:LC('dogTongue'),
    // a shade between flank and belly, for where the two meet
    blend: mixc(LC(c.side), LC(c.belly), 0.5),
  };
}

/*  ── torso ──────────────────────────────────────────────────────────────
    Origin at the centre of the chest cavity, y measured from the ground.
    A Pembroke is a long dog on short legs; the ratio is the whole silhouette,
    so the barrel runs 0.52 m between the hip and shoulder joints.           */
function buildTorso(K){
  const M = PB();
  const y = 0.0;                       // the body group carries the height
  // barrel — slightly deeper at the chest than at the loin
  pcyl(M, [0,y,-0.26], [0,y+0.012,0.20], 0.125, 0.135, 12, K.side, M_FUR, true, true);
  // belly, a paler underside laid just below the barrel's waist
  pcyl(M, [0,y-0.055,-0.22], [0,y-0.05,0.17], 0.085, 0.092, 10, K.belly, M_FUR, true, true);
  // saddle — the darker back, sitting proud of the barrel
  pcyl(M, [0,y+0.055,-0.24], [0,y+0.062,0.16], 0.098, 0.104, 10, K.top, M_FUR, true, true);
  // ruff: the chest fluff a corgi carries like a shirt front
  pcyl(M, [0,y-0.01,0.17], [0,y-0.005,0.255], 0.128, 0.10, 10, K.trim, M_FUR, false, true);
  // haunches
  pcyl(M, [-0.055,y-0.02,-0.20], [-0.05,y-0.015,-0.30], 0.105, 0.075, 8, K.side, M_FUR, false, true);
  pcyl(M, [ 0.055,y-0.02,-0.20], [ 0.05,y-0.015,-0.30], 0.105, 0.075, 8, K.side, M_FUR, false, true);
  return finishPainted(M);
}

/*  ── head ────────────────────────────────────────────────────────────────
    Origin at the base of the neck, so the whole head can nod about it.      */
function buildHead(K){
  const M = PB();
  // neck
  pcyl(M, [0,0,0], [0,0.075,0.062], 0.082, 0.075, 10, K.top, M_FUR, false, false);
  // skull
  pcyl(M, [0,0.075,0.055], [0,0.085,0.135], 0.083, 0.070, 10, K.top, M_FUR, true, false);
  // cheeks, a touch wider than the skull — a corgi's face is a wedge
  pcyl(M, [0,0.062,0.075], [0,0.068,0.125], 0.088, 0.078, 10, K.side, M_FUR, false, false);
  // muzzle
  pcyl(M, [0,0.068,0.128], [0,0.060,0.215], 0.052, 0.036, 8, K.trim, M_FUR, false, true);
  // nose — slot 1, so it catches a harder highlight than the fur
  pbox(M, 0, 0.062, 0.222, 0.019, 0.016, 0.014, 0, K.nose, M_WET);
  // eyes
  pbox(M, -0.045, 0.098, 0.135, 0.013, 0.014, 0.010, 0, K.nose, M_WET);
  pbox(M,  0.045, 0.098, 0.135, 0.013, 0.014, 0.010, 0, K.nose, M_WET);
  // brow pips — the tan dots over the eyes that give a corgi its expression
  pbox(M, -0.045, 0.119, 0.118, 0.016, 0.006, 0.012, 0, K.belly, M_FUR);
  pbox(M,  0.045, 0.119, 0.118, 0.016, 0.006, 0.012, 0, K.belly, M_FUR);

  /*  Ears.  The single most recognisable thing about the breed: enormous,
      upright, rounded at the tip, and set wide on the skull. Cones, tilted
      out and back, with a paler inner cone set just inside each one.        */
  for(const s of [-1, 1]){
    const base = [s*0.062, 0.128, 0.072];
    const tip  = [s*0.098, 0.238, 0.045];
    pcyl(M, base, tip, 0.050, 0.013, 8, K.top, M_FUR, true, true);
    const ib = [s*0.058, 0.132, 0.083];
    const it = [s*0.090, 0.225, 0.058];
    pcyl(M, ib, it, 0.034, 0.009, 7, K.belly, M_FUR, false, true);
  }
  return finishPainted(M);
}

/*  ── leg ─────────────────────────────────────────────────────────────────
    Origin at the hip, hanging down, so a rotation about local X swings it.
    Pembroke forelegs turn out slightly at the pastern; the front pair get a
    little more crook than the back.                                         */
function buildLeg(K, front){
  const M = PB();
  const len = front ? 0.155 : 0.165;
  const r0  = front ? 0.048 : 0.052;
  pcyl(M, [0,0,0], [0,-len*0.55,front?0.004:-0.006], r0, 0.036, 8, K.side, M_FUR, true, false);
  pcyl(M, [0,-len*0.55,front?0.004:-0.006], [0,-len,0], 0.036, 0.031, 8, K.trim, M_FUR, false, false);
  // paw
  pbox(M, 0, -len-0.016, 0.012, 0.036, 0.018, 0.045, 0, K.trim, M_FUR);
  return finishPainted(M);
}

/*  ── tail ────────────────────────────────────────────────────────────────
    Origin at the root, pointing back and up. Pembrokes are famously short in
    the tail; this is a fluffy nub rather than the plume a Cardigan carries.  */
function buildTail(K){
  const M = PB();
  pcyl(M, [0,0,0], [0,0.075,-0.055], 0.055, 0.045, 8, K.top, M_FUR, false, false);
  pcyl(M, [0,0.075,-0.055], [0,0.125,-0.085], 0.045, 0.030, 8, K.trim, M_FUR, false, true);
  return finishPainted(M);
}

/*  Hip and shoulder positions, in torso space. front pair, then rear.       */
const HIPS = [
  { x:-0.088, y:-0.035, z: 0.155, front:true  },
  { x: 0.088, y:-0.035, z: 0.155, front:true  },
  { x:-0.092, y:-0.030, z:-0.185, front:false },
  { x: 0.092, y:-0.030, z:-0.185, front:false },
];

class Corgi {
  constructor(coat, mat, seed, home){
    const K = coatOf(coat);
    const r = rng(seed);
    this.r = r;
    this.coat = coat.name;
    this.home = home;

    this.group = new THREE.Group();
    this.body  = new THREE.Group();
    this.group.add(this.body);

    const torso = new THREE.Mesh(buildTorso(K), mat);
    torso.frustumCulled = false;
    this.body.add(torso);

    this.head = new THREE.Group();
    this.head.position.set(0, 0.052, 0.205);
    this.head.add(new THREE.Mesh(buildHead(K), mat));
    this.body.add(this.head);

    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.045, -0.275);
    this.tail.add(new THREE.Mesh(buildTail(K), mat));
    this.body.add(this.tail);

    // one leg geometry per pair, shared by the two sides
    const geoF = buildLeg(K, true), geoR = buildLeg(K, false);
    this.legs = HIPS.map(h=>{
      const g = new THREE.Group();
      g.position.set(h.x, h.y, h.z);
      g.add(new THREE.Mesh(h.front ? geoF : geoR, mat));
      this.body.add(g);
      return g;
    });
    for(const o of this.group.children) o.frustumCulled = false;

    // ── state ──
    this.pos  = new THREE.Vector2(home.x + (r()-0.5)*9, home.z + (r()-0.5)*9);
    this.yaw  = r()*TAU;
    this.gait = r()*TAU;          // where in the trot cycle it starts
    this.speed = 0;
    this.size = 0.92 + r()*0.18;  // a little variation in build
    this.group.scale.setScalar(this.size * SIZE);
    this.target = null;
    this.rest = 1.0 + r()*3.0;    // seconds until it next picks somewhere to go
    this.sniff = 0;
    this.perk  = r()*TAU;
    this.pickTarget();
  }

  /*  Somewhere new to trot to.  Four times in five it stays on the path and
      its verge, where the sward is short and you can actually see a dog; the
      fifth is a dash out into the deep meadow, which is the half of the
      behaviour that sells the other half.  Never into the river, which a corgi
      at this scale would be swimming rather than prancing through.          */
  pickTarget(){
    const r = this.r;
    const wander = r() < 0.2 ? 9.0 : 3.2;    // metres of tolerated grass
    for(let i=0;i<16;i++){
      const a = r()*TAU, d = 2.5 + r()*14.0;
      const x = this.home.x + Math.cos(a)*d, z = this.home.z + Math.sin(a)*d;
      if(riverField(x, z).d < 11) continue;
      if(pathDistance(x, z) > wander) continue;
      this.target = new THREE.Vector2(x, z);
      return;
    }
    this.target = new THREE.Vector2(this.home.x, this.home.z);
  }

  update(dt, t){
    const r = this.r;
    const toX = this.target.x - this.pos.x, toZ = this.target.y - this.pos.y;
    const dist = Math.hypot(toX, toZ);

    if(dist < 0.9){
      // arrived — stand about, have a sniff, then choose somewhere else
      this.rest -= dt;
      if(this.sniff <= 0 && r() < dt*0.6) this.sniff = 0.8 + r()*1.6;
      if(this.rest <= 0){ this.pickTarget(); this.rest = 2.0 + r()*5.0; }
    }

    const wantMove = dist >= 0.9 && this.sniff <= 0;
    // corgis do not build up speed so much as arrive at it
    const tgtSpeed = wantMove ? (1.5 + (this.size-0.92)*1.4) : 0;
    this.speed += (tgtSpeed - this.speed) * clamp(dt*3.2, 0, 1);
    this.sniff = Math.max(0, this.sniff - dt);

    if(dist > 0.05){
      let d = Math.atan2(toX, toZ) - this.yaw;
      while(d >  Math.PI) d -= TAU;
      while(d < -Math.PI) d += TAU;
      this.yaw += d * clamp(dt*3.4, 0, 1);
    }
    this.pos.x += Math.sin(this.yaw) * this.speed * dt;
    this.pos.y += Math.cos(this.yaw) * this.speed * dt;

    // ── the trot ──
    /*  The gait clock advances with distance travelled, not with time, so the
        legs cannot skate: at a standstill the cycle stops dead. Stride length
        is roughly the dog's own body length, which for a corgi is short and
        very quick — hence the 3.1.                                           */
    this.gait += this.speed * dt * 3.1;
    const g = this.gait;
    const moving = smoothstep(0.05, 0.8, this.speed);

    // diagonal pairs, as a real trot: front-left with rear-right
    const swing = [0, Math.PI, Math.PI, 0];
    for(let i=0;i<4;i++){
      const ph = g + swing[i];
      const lift = Math.sin(ph);
      // the prance: the forward reach is bigger than the backward push, which
      // is what makes a trot look springy instead of like a pendulum
      this.legs[i].rotation.x = (lift > 0 ? lift*0.85 : lift*0.55) * 0.62 * moving;
    }

    // body rises on each diagonal beat, and rolls very slightly into it
    const bob = Math.sin(g*2) * 0.016 * moving;
    this.body.position.y = 0.205 + bob;
    this.body.rotation.z = Math.sin(g) * 0.055 * moving;
    this.body.rotation.x = -0.02 * moving;

    // head: bobs against the body, dips right down when sniffing
    const sn = smoothstep(0, 0.35, this.sniff);
    this.head.rotation.x = lerp(-Math.sin(g*2 + 0.7) * 0.05 * moving, 0.72, sn);
    this.head.rotation.y = Math.sin(t*0.7 + this.perk) * 0.12 * (1 - moving*0.6);
    this.head.position.y = 0.052 - sn*0.045;

    /*  The tail never stops.  It is faster when the dog is moving and faster
        again when its nose is down, which is the single cheapest thing you can
        do to make an animal look pleased with itself.                        */
    const wagRate = 9.0 + moving*7.0 + sn*6.0;
    this.tail.rotation.y = Math.sin(t*wagRate + this.perk) * (0.42 + moving*0.22);
    this.tail.rotation.x = -0.35 - moving*0.22;

    // ── set down on the ground, following the slope ──
    const gy = sampleHeight(this.pos.x, this.pos.y);
    const n  = sampleNormal(this.pos.x, this.pos.y, 0.9);
    this.group.position.set(this.pos.x, gy, this.pos.y);
    this.group.rotation.y = this.yaw;
    // lean into the hill: project the ground normal onto the dog's own axes
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    this.group.rotation.x =  clamp((n.x*fx + n.z*fz) * 0.9, -0.35, 0.35);
    this.group.rotation.z = -clamp((n.x*fz - n.z*fx) * 0.9, -0.35, 0.35);
  }
}

/*  Find where the footpath runs closest to the spawn knoll, and make that the
    pack's home. Searching for it rather than hard-coding a coordinate means
    the dogs follow the path if anyone ever moves it — and PATH_CTRL is exactly
    the sort of thing someone reshapes on a whim.                            */
function findHome(){
  let best = { x: CFG.spawn.x, z: CFG.spawn.z, d: 1e9 };
  for(let dz=-30; dz<=30; dz+=1.5){
    for(let dx=-30; dx<=30; dx+=1.5){
      const x = CFG.spawn.x + dx, z = CFG.spawn.z + dz;
      const d = pathDistance(x, z);
      // prefer the path, but break ties toward the spawn point so the pack is
      // in front of you when you arrive rather than somewhere off the horizon
      const score = d + Math.hypot(dx, dz) * 0.12;
      if(score < best.d && riverField(x, z).d > 14) best = { x, z, d: score };
    }
  }
  return best;
}

/*  The pack.  Returns a group to add to the scene and an update(dt, t).     */
export function buildCorgis(material, count = 6){
  const home = findHome();
  const group = new THREE.Group();
  const dogs = [];
  for(let i=0;i<count;i++){
    // walk the coat list so all four are always present before any repeats
    const c = new Corgi(COATS[i % COATS.length], material, 4200 + i*977, home);
    group.add(c.group);
    dogs.push(c);
  }
  group.frustumCulled = false;
  return {
    group, dogs, home,
    update(dt, t){ for(const d of dogs) d.update(dt, t); },
  };
}
