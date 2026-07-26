import * as THREE from 'three';
import { RSM, TRANSP, U } from './materials.js';
import { FHEAD, GL_AIR, GL_CLOUDFIELD, GL_HASH, GL_LIGHT, GL_NOISE, GL_PAL, GL_UNI, VHEAD } from './glsl.js';
import { TAU, clamp, rng, smoothstep } from './math.js';
import { C, P } from './palette.js';
import { LC, PAINTED_FS, PAINTED_VS, PB, finishPainted, mixc, pbox, pcyl, pq, pv, tint, trackPose } from './railway.js';
import { TRACK } from './track-ref.js';
import { NO_CAST, addMesh, setDepth } from './scene-contract.js';
import { CLOUD_FS } from './sky.js';

/*──────────────────────────── §10  THE TRAIN ───────────────────────────────*/
/* A 2-6-0 with a solved valve gear: the crank pin drives the main rod, which
   drives the crosshead through a real slider-crank solution, and the cranks
   are quartered 90° like every steam locomotive ever built.  Exhaust puffs
   are emitted on the four-beats-per-revolution the cylinders actually fire. */

const LOCO = {
  driveR: 0.82, crank: 0.52, rodL: 1.95, crossY: 0.90,
  drivers: [-0.55, 1.15, 2.85], pony: [4.15],
  speed: 9.6,
};

function buildLocoBody(){
  const M=PB();
  const dark=LC('boiler'), red=LC('livery'), brass=LC('brass'), band=LC('carBand');
  // frames & footplate
  pbox(M, 0.9, 0.60, 0, 3.75, 0.13, 1.02, 0, tint(dark,1.15), 1);
  pbox(M, 0.9, 0.78, 0, 3.9, 0.07, 1.16, 0, tint(dark,0.85), 1);
  // boiler, smokebox, chimney, dome
  pcyl(M, [-1.55,1.42,0],[3.30,1.46,0], 0.76, 0.72, 16, dark, 1, false, false);
  pcyl(M, [3.30,1.46,0],[4.34,1.46,0], 0.84, 0.84, 16, tint(dark,0.82), 1, false, true);
  pcyl(M, [3.20,1.46,0],[3.30,1.46,0], 0.88, 0.88, 16, tint(band,0.55), 1, false,false);
  pcyl(M, [3.98,2.24,0],[3.98,2.60,0], 0.235,0.235, 12, tint(dark,0.9), 1, false,false);
  pcyl(M, [3.98,2.60,0],[3.98,2.86,0], 0.245,0.38, 12, tint(dark,1.05), 1, false,true);
  pcyl(M, [1.45,2.06,0],[1.45,2.34,0], 0.36, 0.30, 12, brass, 1, false, false);
  pcyl(M, [1.45,2.34,0],[1.45,2.44,0], 0.30, 0.09, 12, brass, 1, false, true);
  pcyl(M, [0.25,2.02,0],[0.25,2.26,0], 0.10, 0.08, 8, brass, 1, false, true);
  pcyl(M, [0.55,2.02,0],[0.55,2.26,0], 0.10, 0.08, 8, brass, 1, false, true);
  // boiler bands
  for(const bx of [-0.9,0.1,1.0,2.0,2.9])
    pcyl(M, [bx,1.44,0],[bx+0.06,1.44,0], 0.79, 0.79, 16, tint(band,0.5), 1, false,false);
  // cab
  pbox(M, -2.10, 2.05, 0, 1.05, 0.98, 1.02, 0, tint(dark,1.05), 1);
  pbox(M, -2.10, 3.06, 0, 1.22, 0.07, 1.14, 0, tint(dark,0.78), 1);
  for(const s of [-1,1]){
    pbox(M, -1.55, 2.35, s*1.03, 0.34, 0.36, 0.03, 0, tint(LC('carWin'),0.55), 3);
    pbox(M, -2.60, 2.35, s*1.03, 0.30, 0.36, 0.03, 0, tint(LC('carWin'),0.55), 3);
  }
  pbox(M, -3.16, 2.30, 0, 0.06, 0.72, 0.95, 0, tint(dark,0.9), 1);
  // cylinders + guide bars
  for(const s of [-1,1]){
    pbox(M, 3.72, 0.86, s*1.00, 0.56, 0.30, 0.24, 0, tint(dark,1.1), 1);
    pbox(M, 3.72, 1.20, s*1.00, 0.40, 0.06, 0.20, 0, tint(band,0.5), 1);
    pbox(M, 2.90, 0.90, s*1.00, 0.62, 0.035, 0.10, 0, tint(dark,1.3), 1);
  }
  // buffer beam, cowcatcher, lamp
  pbox(M, 4.62, 0.66, 0, 0.10, 0.34, 1.26, 0, red, 1);
  for(let i=0;i<5;i++){
    const u=i/4-0.5;
    pbox(M, 4.86, 0.42, u*1.9, 0.30, 0.04, 0.05, 0.0, tint(dark,1.2), 1);
  }
  pbox(M, 4.40, 2.10, 0, 0.16, 0.20, 0.18, 0, tint(LC('carWin'),0.9), 2);
  // handrails
  for(const s of [-1,1]) pcyl(M, [-1.4,1.95,s*0.72],[3.3,1.98,s*0.70], 0.028,0.028, 6, brass, 1);
  return finishPainted(M);
}
function buildWheel(R, spokes, col){
  const M=PB(); const dark=col||LC('boiler'); const red=LC('livery');
  pcyl(M, [0,0,-0.075],[0,0,0.075], R, R, 22, tint(dark,0.95), 1, true, true);
  pcyl(M, [0,0,-0.10],[0,0,0.10], R*0.99, R*0.99, 22, tint(dark,1.25), 1, false,false);
  pcyl(M, [0,0,-0.11],[0,0,0.11], R*0.22, R*0.22, 10, tint(dark,1.4), 1, true, true);
  for(let i=0;i<spokes;i++){
    const a=i/spokes*TAU;
    const cx=Math.cos(a)*R*0.55, cy=Math.sin(a)*R*0.55;
    const M2=Math.cos(a), S2=Math.sin(a);
    // spoke as a thin box rotated in the wheel plane
    const hx=R*0.42, hy=R*0.055;
    const P=(sx,sy,sz)=>[cx + sx*hx*M2 - sy*hy*S2, cy + sx*hx*S2 + sy*hy*M2, sz*0.05];
    const V8=[];
    for(let k=0;k<8;k++){ const sx=(k&1)?1:-1, sy=(k&2)?1:-1, sz=(k&4)?1:-1; V8.push(P(sx,sy,sz)); }
    const F=[[0,1,3,2],[4,6,7,5],[0,2,6,4],[1,5,7,3],[2,3,7,6],[0,4,5,1]];
    for(const f of F){
      const v=f.map(q=>pv(M,V8[q][0],V8[q][1],V8[q][2], 0,0,1, tint(dark,1.15), 1));
      pq(M,v[0],v[1],v[2],v[3]);
    }
  }
  pcyl(M, [0,0,0.10],[0,0,0.16], R*0.10, R*0.10, 8, red, 1, false, true);
  return finishPainted(M);
}
function buildRod(len, thick, col){
  const M=PB();
  pbox(M, 0, 0, 0, len/2, thick, 0.035, 0, col, 1);
  pbox(M, -len/2, 0, 0, thick*1.5, thick*1.6, 0.05, 0, tint(col,0.8), 1);
  pbox(M,  len/2, 0, 0, thick*1.5, thick*1.6, 0.05, 0, tint(col,0.8), 1);
  return finishPainted(M);
}
function buildTender(){
  const M=PB(); const dark=LC('boiler'), band=LC('carBand');
  pbox(M, 0, 0.62, 0, 2.6, 0.14, 1.10, 0, tint(dark,1.1), 1);
  pbox(M, 0, 1.55, 0, 2.5, 0.82, 1.15, 0, tint(dark,1.0), 1);
  pbox(M, 0, 2.40, 0, 2.5, 0.05, 1.18, 0, tint(band,0.45), 1);
  // coal heap
  const r=rng(77);
  for(let i=0;i<26;i++){
    const x=(r()-0.5)*4.2, z=(r()-0.5)*1.7;
    pbox(M, x, 2.44+r()*0.30, z, 0.16+r()*0.16, 0.12+r()*0.13, 0.16+r()*0.14,
         r()*3, tint(LC('boiler'), 0.8+r()*0.6), 1);
  }
  return finishPainted(M);
}
function buildCarriage(i){
  const M=PB();
  const body = mixc(LC('carBody'), LC('livery'), i===0?0.0:0.0);
  const band = LC('carBand');
  pbox(M, 0, 1.55, 0, 5.6, 0.95, 1.30, 0, body, 1);
  pbox(M, 0, 2.52, 0, 5.65, 0.10, 1.34, 0, tint(body,0.72), 1);
  pcyl(M, [-5.6,2.56,0],[5.6,2.56,0], 1.24, 1.24, 12, tint(body,0.80), 1);
  pbox(M, 0, 0.72, 0, 5.7, 0.12, 1.25, 0, tint(LC('boiler'),1.0), 1);
  pbox(M, 0, 2.02, 0, 5.62, 0.10, 1.33, 0, band, 1);
  for(let w=0;w<9;w++){
    const x=(w-4)*1.16;
    for(const s of [-1,1])
      pbox(M, x, 1.72, s*1.31, 0.40, 0.40, 0.03, 0, LC('carWin'), 2);
  }
  for(const bx of [-3.7, 3.7]) for(const s of [-1,1]){
    pbox(M, bx, 0.52, s*0.92, 0.85, 0.22, 0.14, 0, tint(LC('boiler'),0.9), 1);
  }
  return finishPainted(M);
}

export class Train {
  constructor(scene, uni){
    this.scene=scene; this.G=uni;
    this.group=new THREE.Group();
    // NB: must go through RSM so the RawShaderMaterial gets its preamble
    // (precision, built-in matrices, `in vec3 position`).  Without it the
    // program silently fails to link and every mesh draws as a black box.
    this.mat = RSM(PAINTED_VS(), PAINTED_FS(), uni, { side: THREE.DoubleSide });
    this.parts=[];
    const mk=(g)=>{ const m=new THREE.Mesh(g,this.mat); m.frustumCulled=false; return m; };
    this.body = mk(buildLocoBody());
    this.locoGroup = new THREE.Group(); this.locoGroup.add(this.body);
    const dw = buildWheel(LOCO.driveR, 12);
    const pw = buildWheel(0.44, 8);
    this.wheels=[];
    for(const x of LOCO.drivers) for(const s of [-1,1]){
      const w=mk(dw); w.position.set(x, LOCO.driveR, s*0.94);
      this.locoGroup.add(w); this.wheels.push({m:w, side:s, x, drive:true});
    }
    for(const x of LOCO.pony) for(const s of [-1,1]){
      const w=mk(pw); w.position.set(x, 0.44, s*0.94);
      this.locoGroup.add(w); this.wheels.push({m:w, side:s, x, drive:false, r:0.44});
    }
    const rodCol=[0.62,0.66,0.70];
    this.coupling=[]; this.mainRod=[]; this.crosshead=[]; this.pistonRod=[];
    const cl = LOCO.drivers[2]-LOCO.drivers[0];
    for(const s of [-1,1]){
      const c=mk(buildRod(cl, 0.062, rodCol)); c.position.z=s*1.06; this.locoGroup.add(c);
      this.coupling.push({m:c, side:s});
      const mr=mk(buildRod(LOCO.rodL, 0.055, rodCol)); mr.position.z=s*1.18; this.locoGroup.add(mr);
      this.mainRod.push({m:mr, side:s});
      const ch=mk(buildRod(0.26, 0.085, rodCol)); ch.position.z=s*1.18; this.locoGroup.add(ch);
      this.crosshead.push({m:ch, side:s});
      const pr=mk(buildRod(0.80, 0.038, rodCol)); pr.position.z=s*1.00; this.locoGroup.add(pr);
      this.pistonRod.push({m:pr, side:s});
    }
    this.group.add(this.locoGroup);

    this.tenderGroup=new THREE.Group();
    this.tenderGroup.add(mk(buildTender()));
    const tw=buildWheel(0.52, 8);
    for(const x of [-1.7,0,1.7]) for(const s of [-1,1]){
      const w=mk(tw); w.position.set(x,0.52,s*0.96); this.tenderGroup.add(w);
      this.wheels.push({m:w, side:s, x, drive:false, r:0.52, tender:true});
    }
    this.group.add(this.tenderGroup);

    this.cars=[];
    for(let i=0;i<4;i++){
      const g=new THREE.Group(); g.add(mk(buildCarriage(i)));
      const cw=buildWheel(0.50,8);
      for(const bx of [-3.7,3.7]) for(const dx of [-0.85,0.85]) for(const s of [-1,1]){
        const w=mk(cw); w.position.set(bx+dx,0.50,s*0.98); g.add(w);
        this.wheels.push({m:w, side:s, x:bx+dx, drive:false, r:0.50, car:i});
      }
      this.cars.push(g); this.group.add(g);
    }
    // a plain container: collectShadowSet walks straight through it to the
    // meshes, which are given their depth material by setDepth() in boot (§0c)
    scene.add(this.group);

    this.s = -1e9; this.active=false; this.theta=0; this.lastChuff=0; this.chuffCount=0;
    this.speed = LOCO.speed;
    this.group.visible=false;
    this.smokePos = new THREE.Vector3();
    this.onChuff = null;
  }
  /*  It used to enter the line at s = 40 — over a kilometre of graded track
      before the viaduct, which at line speed is more than two minutes of
      nothing.  Press T and the telemetry said "crossing" while the valley
      stayed empty.  It now enters 260 m out: about half a minute of watching it
      come, which is the shot, and it leaves the far side 380 m later.        */
  start(){
    this.s = Math.max(6, TRACK.sMid - 260);
    this.sEnd = Math.min(TRACK.total - 6, TRACK.sMid + 380);
    this.active=true; this.group.visible=true; this.theta=0;
  }
  place(obj, s, lift){
    const p = trackPose(s);
    obj.position.set(p.x, p.y + (lift||0), p.z);
    obj.rotation.set(0, Math.atan2(p.tx, p.tz) - Math.PI/2, 0);
    const pitch = Math.asin(clamp(p.ty,-1,1));
    obj.rotateZ(pitch);
    return p;
  }
  update(dt, t){
    if(!this.active) return;
    this.s += this.speed*dt;
    if(this.s > (this.sEnd || TRACK.total - 40)){ this.active=false; this.group.visible=false; return; }
    const p = this.place(this.locoGroup, this.s, 0.32);
    this.place(this.tenderGroup, this.s - 8.4, 0.32);
    for(let i=0;i<4;i++) this.place(this.cars[i], this.s - 15.6 - i*13.2, 0.30);

    // wheel rotation from true rolling
    this.theta -= this.speed*dt / LOCO.driveR;
    for(const w of this.wheels){
      const R = w.drive ? LOCO.driveR : w.r;
      w.m.rotation.z = w.drive ? this.theta : -this.s/R;
    }
    // quartered cranks: right side leads the left by 90°
    const Rc = LOCO.crank;
    for(let i=0;i<2;i++){
      const side = this.coupling[i].side;
      const th = this.theta + (side>0 ? Math.PI/2 : 0);
      const ox = Math.cos(th)*Rc, oy = Math.sin(th)*Rc;
      const c = this.coupling[i].m;
      c.position.set((LOCO.drivers[0]+LOCO.drivers[2])/2 + ox, LOCO.driveR + oy, side*1.06);
      // slider-crank: solve the crosshead from the main-rod triangle
      const pinX = LOCO.drivers[1] + ox, pinY = LOCO.driveR + oy;
      const dy = LOCO.crossY - pinY;
      const dx = Math.sqrt(Math.max(0.01, LOCO.rodL*LOCO.rodL - dy*dy));
      const cxx = pinX + dx, cyy = LOCO.crossY;
      const mr = this.mainRod[i].m;
      mr.position.set((pinX+cxx)/2, (pinY+cyy)/2, side*1.18);
      mr.rotation.set(0,0, Math.atan2(cyy-pinY, cxx-pinX));
      const ch = this.crosshead[i].m; ch.position.set(cxx, cyy, side*1.18); ch.rotation.set(0,0,0);
      const pr = this.pistonRod[i].m; pr.position.set(cxx+0.42, cyy, side*1.00); pr.rotation.set(0,0,0);
    }
    // exhaust: four beats per revolution
    const rev = -this.theta/TAU;
    const beat = Math.floor(rev*4);
    if(beat !== this.chuffCount){
      this.chuffCount = beat;
      const wp = new THREE.Vector3(3.98, 2.95, 0);
      this.locoGroup.localToWorld(wp);
      this.smokePos.copy(wp);
      const fwd = new THREE.Vector3(p.tx, p.ty, p.tz);
      if(this.onChuff) this.onChuff(wp, fwd, this.speed);
    }
  }
}

/*───────────────── billboard particles: smoke, pollen, motes ──────────────*/
export class Particles {
  constructor(scene, uni, max, fragShader, order, sort){
    this.max=max; this.n=0; this.sort = !!sort;
    this.p = new Float32Array(max*4);       // x,y,z,size
    this.q = new Float32Array(max*4);       // age01, seed, opacity, kind
    this.data = new Array(max);
    for(let i=0;i<max;i++) this.data[i]={alive:false,x:0,y:0,z:0,vx:0,vy:0,vz:0,age:0,life:1,size:1,seed:0,kind:0,op:1};
    const g=new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]),3));
    g.setIndex([0,1,2, 0,2,3]);
    this.aP=new THREE.InstancedBufferAttribute(this.p,4); this.aP.setUsage(THREE.DynamicDrawUsage);
    this.aQ=new THREE.InstancedBufferAttribute(this.q,4); this.aQ.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iP', this.aP); g.setAttribute('iQ', this.aQ);
    g.instanceCount=0;
    g.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,0,0), 1e6);
    this.geom=g;
    this.mat=new THREE.RawShaderMaterial(Object.assign({
      vertexShader: VHEAD + PARTICLE_VS(), fragmentShader: FHEAD + fragShader,
      uniforms: uni, glslVersion: THREE.GLSL3, side:THREE.DoubleSide,
    }, TRANSP));
    this.mesh=new THREE.Mesh(g,this.mat);
    this.mesh.frustumCulled=false; this.mesh.renderOrder=order||20;
    // parented into lifeGroup, which is bulk — this never reaches the test
    addMesh(scene, this.mesh, NO_CAST);
    this.free=[]; for(let i=max-1;i>=0;i--) this.free.push(i);
  }
  spawn(o){
    if(!this.free.length) return null;
    const i=this.free.pop(); const d=this.data[i];
    d.alive=true; Object.assign(d,o);
    if(o.age===undefined) d.age=0;
    return d;
  }
  commit(camPos){
    let k=0;
    if(this.sort){
      const order=this._ord || (this._ord=[]);
      order.length=0;
      for(let i=0;i<this.max;i++){ const d=this.data[i]; if(!d.alive) continue;
        const dx=d.x-camPos.x, dy=d.y-camPos.y, dz=d.z-camPos.z;
        order.push(dx*dx+dy*dy+dz*dz, i); }
      const pairs=this._pairs || (this._pairs=[]);
      pairs.length=0;
      for(let i=0;i<order.length;i+=2) pairs.push(i);
      pairs.sort((a,b)=>order[b]-order[a]);
      for(const pi of pairs){
        const d=this.data[order[pi+1]];
        this.p[k*4]=d.x; this.p[k*4+1]=d.y; this.p[k*4+2]=d.z; this.p[k*4+3]=d.size;
        this.q[k*4]=clamp(d.age/d.life,0,1); this.q[k*4+1]=d.seed; this.q[k*4+2]=d.op; this.q[k*4+3]=d.kind;
        k++;
      }
    } else {
      for(let i=0;i<this.max;i++){ const d=this.data[i]; if(!d.alive) continue;
        this.p[k*4]=d.x; this.p[k*4+1]=d.y; this.p[k*4+2]=d.z; this.p[k*4+3]=d.size;
        this.q[k*4]=clamp(d.age/d.life,0,1); this.q[k*4+1]=d.seed; this.q[k*4+2]=d.op; this.q[k*4+3]=d.kind;
        k++; }
    }
    this.n=k; this.geom.instanceCount=k;
    if(k>0){ this.aP.needsUpdate=true; this.aQ.needsUpdate=true; }
  }
  kill(d){ d.alive=false; const i=this.data.indexOf(d); if(i>=0) this.free.push(i); }
}

const PARTICLE_VS = ()=> /* glsl */`
${GL_UNI}
in vec4 iP; in vec4 iQ;
out vec2 vC; out float vAge; out float vSeed; out float vOp; out float vKind;
out vec3 vW; out vec3 vR; out vec3 vU; out vec3 vF; out float vDist;
void main(){
  vR = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vU = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
  vF = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  vC = position.xy; vAge=iQ.x; vSeed=iQ.y; vOp=iQ.z; vKind=iQ.w;
  float rot = iQ.y*6.2831 + iQ.x*0.9;
  float cr=cos(rot), sr=sin(rot);
  vec2 c = vec2(position.x*cr - position.y*sr, position.x*sr + position.y*cr);
  float sz = iP.w;
  if(!(sz > 0.0) || !(sz < 400.0) || !(dot(iP.xyz,iP.xyz) < 1.0e12)){
    gl_Position = vec4(2.0,2.0,2.0,1.0); return;   // never let a bad particle
  }                                                // become a black square
  vec3 wp = iP.xyz + vR*(c.x*sz) + vU*(c.y*sz);
  vW = wp;
  vec4 mv = viewMatrix*vec4(wp,1.0); vDist=-mv.z;
  gl_Position = projectionMatrix*mv;
}`;

export const SMOKE_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_CLOUDFIELD}${GL_LIGHT}${GL_AIR}
uniform sampler2D uPuff;
in vec2 vC; in float vAge; in float vSeed; in float vOp; in float vKind;
in vec3 vW; in vec3 vR; in vec3 vU; in vec3 vF; in float vDist;
out vec4 outColor;
void main(){
  float r=length(vC);
  if(!(r <= 1.0)) discard;                 // NaN-safe
  vec2 tile = vec2(mod(floor(vSeed*8.0), 2.0), mod(floor(vSeed*3.0), 2.0));
  vec4 pf = texture(uPuff, (clamp(vC,-1.0,1.0)*0.5 + 0.5)*0.5 + tile*0.5);
  // as in CLOUD_FS: an analytic radial falloff on top of the baked profile, so
  // a puff can never degenerate into a hard opaque square
  float a = pf.a * smoothstep(1.0, 0.55, r);
  float den = pf.g;
  float R = 0.78;
  a *= mix(0.5,1.0,den);
  // dissipate: thins and frays with age
  a *= vOp * (1.0 - smoothstep(0.45, 1.0, vAge));
  a *= mix(1.0, den, smoothstep(0.3,1.0,vAge));
  if(!(a > 0.004)) discard;

  float zz=sqrt(max(0.0,1.0-min(r,1.0)*min(r,1.0)));
  vec3 N=normalize(vR*vC.x + vU*vC.y + vF*zz*0.9 + vec3(0.0,0.42,0.0));
  vec3 V=normalize(uCamPos-vW);
  float ndl=dot(N,uSunDir);
  float t=clamp(ndl*0.5+0.5,0.0,1.0)*mix(0.75,1.05,den);
  vec3 fresh = mix(${C.smokeOld}, ${C.smokeNew}, 1.0-smoothstep(0.05,0.85,vAge));
  vec3 lit = fresh*1.06;
  vec3 mid = mix(fresh*0.80, K_C_UNDER, 0.35);
  vec3 shd = mix(K_C_CORE, K_SHADOW, 0.30)*mix(1.0,0.72,vKind);
  vec3 col = ramp3(t, shd, mid, lit, 0.16, (den-0.5)*0.08);
  float back = clamp(dot(V,-uSunDir),0.0,1.0);
  col += K_SUN * pow(back, 3.4) * 0.62 * (1.0 - smoothstep(0.4,1.0,vAge));
  col = mix(col, K_C_RIM, pf.b*pow(back,1.4)*0.55);
  col = aerial(col, vDist, V, vW.y);
  outColor = vec4(SAFE3(col), clamp(a, 0.0, 1.0));
}`;

export const MOTE_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_AIR}
in vec2 vC; in float vAge; in float vSeed; in float vOp; in float vKind;
in vec3 vW; in vec3 vR; in vec3 vU; in vec3 vF; in float vDist;
out vec4 outColor;
void main(){
  float r=length(vC);
  if(!(r <= 1.0)) discard;                 // NaN-safe
  float a = smoothstep(1.0, 0.15, r);
  a *= a;
  vec3 V=normalize(uCamPos-vW);
  // motes flare when they cross the sun vector
  float back = clamp(dot(V,-uSunDir),0.0,1.0);
  float flare = pow(back, 3.0);
  vec3 col = mix(vec3(0.86,0.88,0.78), K_SUN*1.5, 0.35+0.65*flare);
  col *= 0.55 + 1.5*flare;
  a *= vOp * (0.16 + 0.72*flare) * (1.0 - smoothstep(0.85,1.0,vAge));
  if(!(a > 0.004)) discard;                // NaN-safe
  outColor = vec4(SAFE3(col), clamp(a,0.0,1.0));
}`;

export const BIRD_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_AIR}
in vec2 vC; in float vAge; in float vSeed; in float vOp; in float vKind;
in vec3 vW; in vec3 vR; in vec3 vU; in vec3 vF; in float vDist;
out vec4 outColor;
void main(){
  // a painted gull silhouette: two swept wings that flap
  vec2 c = vC;
  float flap = sin(vAge*6.2831*4.0 + vSeed*17.0);
  float y = -abs(c.x)*(0.55 + 0.55*flap) + 0.06;
  float d = abs(c.y - y);
  float body = smoothstep(0.30, 0.05, d) * smoothstep(1.0, 0.85, abs(c.x));
  float head = smoothstep(0.18, 0.0, length(c - vec2(0.0, 0.10)));
  float a = clamp(body + head, 0.0, 1.0) * vOp;
  if(!(a > 0.02)) discard;                 // NaN-safe
  vec3 V = normalize(uCamPos - vW);
  vec3 col = mix(vec3(0.16,0.18,0.24), K_HAZE, 0.35);
  col = mix(col, K_SUN*0.9, pow(clamp(dot(V,-uSunDir),0.0,1.0),2.0)*0.45);
  col = aerial(col, vDist, V, vW.y);
  outColor = vec4(SAFE3(col), clamp(a, 0.0, 1.0));
}`;
