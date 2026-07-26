import * as THREE from 'three';
import { CFG } from './config.js';
import { GL_HASH, GL_NOISE, GL_TERRAIN, GL_UNI } from './glsl.js';
import { DEG, clamp, noise2, rng, smoothstep } from './math.js';

/*───────────────────────────── §5  THE WIND ─────────────────────────────────*/
/*  Real wind is not sin(t).  It is a mean flow with a slowly-meandering
    direction, a Kolmogorov −5/3 cascade of eddies frozen into that flow and
    carried along with it (Taylor), coherent gust cells that outrun the mean
    and veer as they arrive, a logarithmic boundary layer, and terrain that
    speeds it up over crests, shelters the lee, and channels it down valleys.
    All of that is evaluated once per frame into one 256² texture that every
    other system in the scene reads.                                          */

export const WindSys = {
  meanSpeed: 4.2,          // m/s at the 10 m reference height
  meanDir:   292 * DEG,    // the direction the wind comes FROM
  baseSpeed: 4.2,
  baseDir:   292 * DEG,
  tgtSpeed:  4.2,
  tgtDir:    292 * DEG,
  gustiness: 1.0,
  vec: new THREE.Vector2(),
  fwd: [0,1], side: [-1,0],
  cells: [],
  cloudDrift: new THREE.Vector2(),
  cloudWind: new THREE.Vector2(),
  time: 0,
};

(function initWind(){
  const r = rng(4242);
  const fx = Math.sin(WindSys.meanDir + Math.PI), fz = Math.cos(WindSys.meanDir + Math.PI);
  WindSys.fwd = [fx, fz]; WindSys.side = [-fz, fx];
  WindSys.vec.set(fx*WindSys.meanSpeed, fz*WindSys.meanSpeed);
  for(let i=0;i<6;i++){
    WindSys.cells.push({
      s: -1400 + i*430 + r()*260,   // along-wind station of the cell head
      c: (r()-0.5)*900,             // cross-wind offset
      len:  26 + r()*34,
      wid:  70 + r()*130,
      amp:  0.85 + r()*1.35,
      veer: (r()-0.5)*0.42,
      life: 0,
    });
  }
})();

export function updateWind(dt, camPos){
  const W = WindSys;
  W.time += dt;
  // Ornstein-Uhlenbeck meander of the mean flow
  const kS = 1 - Math.exp(-dt/25), kD = 1 - Math.exp(-dt/40);
  W.tgtSpeed += (Math.random()-0.5)*dt*2.4;
  W.tgtSpeed = clamp(W.tgtSpeed, W.baseSpeed*0.62, W.baseSpeed*1.45);
  W.tgtDir   += (Math.random()-0.5)*dt*0.16;
  W.tgtDir    = clamp(W.tgtDir, W.baseDir-0.34, W.baseDir+0.34);
  W.meanSpeed += (W.tgtSpeed - W.meanSpeed)*kS;
  W.meanDir   += (W.tgtDir   - W.meanDir  )*kD;

  // direction the air travels toward
  const fx = Math.sin(W.meanDir + Math.PI), fz = Math.cos(W.meanDir + Math.PI);
  W.vec.set(fx*W.meanSpeed, fz*W.meanSpeed);
  W.fwd = [fx, fz]; W.side = [-fz, fx];

  // gust cells ride downwind faster than the mean flow
  const adv = W.meanSpeed * 1.25 * dt;
  for(const c of W.cells){
    c.s += adv; c.life += dt;
    // measure the cell head relative to the camera along the wind axis
    const rel = c.s - (camPos.x*fx + camPos.z*fz);
    if(rel > 620){
      const r = Math.random();
      c.s -= 1560 + r*280;
      c.c  = (Math.random()-0.5)*940;
      c.len = 26 + Math.random()*34;
      c.wid = 70 + Math.random()*130;
      c.amp = 0.8 + Math.random()*1.4;
      c.veer = (Math.random()-0.5)*0.44;
      c.life = 0;
    }
  }
  // the cloud deck runs faster and slightly veered from the surface wind
  const cd = W.meanDir + Math.PI + 0.19;
  W.cloudWind.set(Math.sin(cd)*W.meanSpeed*2.35, Math.cos(cd)*W.meanSpeed*2.35);
  W.cloudDrift.x += W.cloudWind.x*dt;
  W.cloudDrift.y += W.cloudWind.y*dt;
}

/* CPU mirror — audio, smoke, pollen, birds and the camera all sample this. */
export function windAtJS(x, z, height){
  const W = WindSys;
  const [fx,fz] = W.fwd, [sx,sz] = W.side;
  let vx = W.vec.x, vz = W.vec.y;
  const along = x*fx + z*fz, cross = x*sx + z*sz;
  let gustW = 0, veer = 0;
  for(const c of W.cells){
    const u = (along - c.s)/c.len;
    if(u > 0.16 || u < -6.0) continue;
    const head = smoothstep(0.14, 0.0, u);
    const body = Math.exp(u*2.05);
    const cw = Math.exp(-Math.pow(Math.abs(cross-c.c)/(c.wid*0.5), 2.3));
    const g = c.amp*head*body*cw*W.gustiness;
    gustW += g; veer += g*c.veer;
  }
  // 2-octave turbulence mirror
  const t = W.time;
  const q1x = (x - W.vec.x*t)*0.0125, q1z = (z - W.vec.y*t)*0.0125;
  const n1 = noise2(q1x, q1z), n1b = noise2(q1x+3.7, q1z-1.9);
  const q2x = q1x*2.6, q2z = q1z*2.6;
  const n2 = noise2(q2x+11, q2z+5), n2b = noise2(q2x-7, q2z+13);
  const tux = (n1*1.0 + n2*0.79)*W.meanSpeed*0.19;
  const tuz = (n1b*1.0 + n2b*0.79)*W.meanSpeed*0.19;
  vx += tux; vz += tuz;
  // gust adds magnitude and veers the direction
  const gs = 1 + gustW*0.85;
  const ca = Math.cos(veer), sa = Math.sin(veer);
  const rx = (vx*ca - vz*sa)*gs, rz = (vx*sa + vz*ca)*gs;
  const prof = height===undefined ? 1 : Math.log((Math.max(height,0.015)+0.06)/0.06)*0.19523;
  return { x:rx*prof, z:rz*prof, gust:gustW, speed:Math.hypot(rx,rz)*prof };
}

/*──────────────────── the wind field pass (fullscreen) ────────────────────*/
export const WIND_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
uniform vec2  uMeanWind;
uniform vec4  uCellA[6];      // xy: head station + cross offset, z: len, w: width
uniform vec4  uCellB[6];      // x: amp, y: veer, z: age, w: -
uniform vec2  uFwd; uniform vec2 uSide;
uniform float uGustiness; uniform float uTurbI;
${GL_HASH}${GL_NOISE}${GL_TERRAIN}
in vec2 vUv;
out vec4 outColor;

/* divergence-free turbulence with an inertial-subrange amplitude spectrum:
   eddy velocity at wavenumber k scales as k^(-1/3), and each octave
   decorrelates on its own turnover time tau ~ k^(-2/3).                     */
vec2 turbulence(vec2 p, float t, out float mag){
  vec2 v = vec2(0.0);
  float k = 0.0118, amp = 1.0, e = 0.021;
  mag = 0.0;
  for(int i=0;i<4;i++){
    vec2 q = (p - uMeanWind*t) * k;
    float tt = t * (0.055 * pow(2.0, float(i)*0.667));
    float n0 = pn3(vec3(q,                tt));
    float nx = pn3(vec3(q + vec2(e,0.0),  tt));
    float ny = pn3(vec3(q + vec2(0.0,e),  tt));
    vec2 curl = vec2(ny - n0, -(nx - n0)) / e;
    v   += amp * curl;
    mag += amp * length(curl);
    k *= 2.0; amp *= 0.7937;               // 2^(-1/3)
  }
  return v;
}

void main(){
  vec2 p = uWindOrigin + (vUv - 0.5) * ${CFG.windRTSpan.toFixed(1)};
  float t = uTime;

  vec2 flow = uMeanWind;
  float meanSpd = max(length(uMeanWind), 0.05);

  // ── coherent gust cells ────────────────────────────────────────────────
  float along = dot(p, uFwd), cross = dot(p, uSide);
  float gust = 0.0, veer = 0.0, front = 0.0;
  for(int i=0;i<6;i++){
    float u = (along - uCellA[i].x) / uCellA[i].z;
    if(u > 0.18 || u < -6.5) continue;
    float head = smoothstep(0.15, 0.0, u);
    float body = exp(u*2.05);
    float cw   = exp(-pow(abs(cross - uCellA[i].y)/(uCellA[i].w*0.5), 2.3));
    float g = uCellB[i].x * head * body * cw;
    gust  += g;
    veer  += g * uCellB[i].y;
    front += uCellB[i].x * exp(-abs(u)*9.0) * cw;   // the sharp leading edge
  }
  gust *= uGustiness; front *= uGustiness;

  // ── inertial-subrange turbulence, advected with the flow ───────────────
  float tmag;
  vec2 turb = turbulence(p, t, tmag) * meanSpd * uTurbI;
  flow += turb;

  // ── terrain coupling ───────────────────────────────────────────────────
  float h  = terrainH(p);
  float hs = 0.25*(terrainH(p+vec2(58.0,0.0)) + terrainH(p-vec2(58.0,0.0))
                 + terrainH(p+vec2(0.0,58.0)) + terrainH(p-vec2(0.0,58.0)));
  float crest = (h - hs) / 24.0;
  float speedup = 1.0 + 0.92*clamp(crest, 0.0, 1.1);
  float hUp = terrainH(p - uFwd*48.0);
  float shelter = exp(-max(hUp - h, 0.0)/23.0);
  speedup *= mix(0.42, 1.0, shelter);

  vec3 n = terrainN(p, 7.0);
  vec2 grad = -n.xz;
  float slope = length(grad);
  vec2 contour = normalize(vec2(-grad.y, grad.x) + vec2(1e-6));
  if(dot(contour, uFwd) < 0.0) contour = -contour;
  vec2 fdir = normalize(flow + vec2(1e-6));
  fdir = normalize(mix(fdir, contour, clamp(slope*2.1, 0.0, 0.58)));

  // over open water the surface is smoother: a little faster, a little steadier
  vec4 sp = splatAt(p);
  float water = 1.0 - smoothstep(0.0, 0.035, sp.r);
  speedup *= mix(1.0, 1.14, water);

  float spd = length(flow) * speedup * (1.0 + gust*1.35);
  // the gust front veers the direction as it passes over
  float a = veer * 0.85;
  vec2 dir = vec2(fdir.x*cos(a) - fdir.y*sin(a), fdir.x*sin(a) + fdir.y*cos(a));

  vec2 vel = dir * spd;
  float gustNorm = spd / max(meanSpd, 0.4);
  float excite = clamp(front*1.35 + tmag*0.22, 0.0, 3.0);

  outColor = vec4(vel, gustNorm, excite);
}`;

const FS_QUAD_VS = /* glsl */`
in vec3 position; in vec2 uv;
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/* debug view of the field */
export const WINDVIEW_FS = /* glsl */`
precision highp float;
uniform sampler2D uWindTex; uniform float uMean;
in vec2 vUv; out vec4 outColor;
void main(){
  vec4 w = texture(uWindTex, vUv);
  float s = length(w.rg)/max(uMean,0.3);
  vec3 c = mix(vec3(0.06,0.12,0.22), vec3(0.95,0.86,0.55), smoothstep(0.3,1.9,s));
  c = mix(c, vec3(1.0,0.42,0.32), smoothstep(0.4,1.8,w.a));
  float g = fract(vUv.x*24.0)<0.02||fract(vUv.y*24.0)<0.02 ? 0.25 : 0.0;
  outColor = vec4(c + g, 1.0);
}`;
