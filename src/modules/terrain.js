import * as THREE from 'three';
import { CFG, HALF, HM, WS } from './config.js';
import { GL_AIR, GL_CLOUDFIELD, GL_HASH, GL_LIGHT, GL_NOISE, GL_PAL, GL_SHADOW, GL_TERRAIN, GL_UNI, GL_WIND } from './glsl.js';
import { TAU, billow, clamp, fbm2, lerp, noise2, ridged, rng, smootherstep, smoothstep } from './math.js';
import { C, P } from './palette.js';
import { TRACK } from './track-ref.js';
import { makeDF } from './field.js';

/*──────────────────────────────── §3  TERRAIN ───────────────────────────────*/
/* One heightmap is the single source of truth for the CPU and the GPU alike:
   the mesh, the grass roots, the camera's feet and the wind's terrain coupling
   all read the same 1280² float texture.  Nothing can ever disagree.          */

export const heightData = new Float32Array(HM*HM);
export const splatData  = new Uint8Array(CFG.dataRes*CFG.dataRes*4);
/*  The meadow field: everything the grass vertex shader needs to know about a
    patch of ground, in ONE texture fetch.
      R  tussock band   (~68 m)   height, lean and hue cluster on it
      G  swale band     (~292 m)  the larger drifts
      B  grass mask                where grass grows at all
      A  dryness                   straw-gold on the exposed shoulders
    Originally this was five live gradient-noise evaluations plus a separate
    splat fetch, per vertex, on twelve million vertices a frame.  Since a blade
    is a centimetre wide and the shortest band here is 68 m across, a 4.7 m
    texel is far finer than anything the field actually varies by — the baked
    version is not an approximation, it is the same function tabulated.
    Being ONE texture rather than two matters as much as the arithmetic: at this
    vertex count, a texture fetch removed is a fetch removed twelve million
    times.                                                                    */
export const MEADOW_RES = 512;
export const meadowData = new Uint8Array(MEADOW_RES*MEADOW_RES*4);

/* ── the river's course: a Catmull-Rom spline through hand-placed controls ── */
const RIVER_CTRL = [
  [ 640, 330],[ 420, 262],[ 250, 196],[ 100, 176],[ -40, 150],
  [-195, 113],[-330,  58],[-470,  26],[-640,  -6],[-860, -34],
  [-1080,-24],[-1300, 10],
];
export function catmull(pts, t){                       // t in [0,1] across the whole run
  const n = pts.length - 1;
  let s = t * (n - 2) + 1; let i = Math.floor(s); i = clamp(i, 1, n-2);
  const f = s - i;
  const p0=pts[i-1], p1=pts[i], p2=pts[i+1], p3=pts[i+2]||pts[i+1];
  const f2=f*f, f3=f2*f;
  const cx = 0.5*((2*p1[0]) + (-p0[0]+p2[0])*f + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*f2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*f3);
  const cz = 0.5*((2*p1[1]) + (-p0[1]+p2[1])*f + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*f2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*f3);
  return [cx, cz];
}
export const RIVER_PTS = [];                            // dense polyline + arc length
{ const N = 900; let acc = 0;
  for(let i=0;i<=N;i++){
    const p = catmull(RIVER_CTRL, i/N);
    if(i>0) acc += Math.hypot(p[0]-RIVER_PTS[i-1].x, p[1]-RIVER_PTS[i-1].z);
    RIVER_PTS.push({x:p[0], z:p[1], s:acc});
  }
  const total = acc; RIVER_PTS.forEach(p=>p.t = p.s/total); RIVER_PTS.total = total;
}
// water surface elevation as a function of the along-river parameter
const WATER_Y0 = 36, WATER_Y1 = 2.5;
export function waterLevel(t){
  t = clamp(t,0,1);
  // gentle downhill with a slight pool above the bridge
  return lerp(WATER_Y0, WATER_Y1, Math.pow(t, 0.86)) + Math.sin(t*11.0)*0.55;
}
// river half-width grows downstream
export function riverWidth(t){ return 9.5 + 16.0*Math.pow(clamp(t,0,1),0.7) + Math.sin(t*17.0)*2.2; }

/* ── distance + along-parameter field via a rasterise-then-EDT pass ── */
const DF = 512, DFS = WS/DF;                     // 4.69 m cells
const dfDist = new Float32Array(DF*DF).fill(1e9);
const dfT    = new Float32Array(DF*DF);
{
  // seed
  const sx = new Int16Array(DF*DF).fill(-9999), sy = new Int16Array(DF*DF).fill(-9999);
  for(const p of RIVER_PTS){
    const gx = Math.round((p.x + HALF)/DFS), gy = Math.round((p.z + HALF)/DFS);
    if(gx<0||gy<0||gx>=DF||gy>=DF) continue;
    const i = gy*DF+gx;
    if(dfDist[i] > 0){ dfDist[i]=0; sx[i]=gx; sy[i]=gy; dfT[i]=p.t; }
  }
  // 8SSEDT-ish two-pass vector propagation
  const relax=(i,j)=>{ if(sx[j]===-9999) return;
    const gx=i%DF, gy=(i/DF)|0;
    const d=(sx[j]-gx)*(sx[j]-gx)+(sy[j]-gy)*(sy[j]-gy);
    if(d<dfDist[i]){ dfDist[i]=d; sx[i]=sx[j]; sy[i]=sy[j]; dfT[i]=dfT[j]; } };
  for(let it=0; it<2; it++){
    for(let y=0;y<DF;y++) for(let x=0;x<DF;x++){ const i=y*DF+x;
      if(x>0) relax(i,i-1); if(y>0) relax(i,i-DF);
      if(x>0&&y>0) relax(i,i-DF-1); if(x<DF-1&&y>0) relax(i,i-DF+1); }
    for(let y=DF-1;y>=0;y--) for(let x=DF-1;x>=0;x--){ const i=y*DF+x;
      if(x<DF-1) relax(i,i+1); if(y<DF-1) relax(i,i+DF);
      if(x<DF-1&&y<DF-1) relax(i,i+DF+1); if(x>0&&y<DF-1) relax(i,i+DF-1); }
  }
  for(let i=0;i<DF*DF;i++) dfDist[i] = Math.sqrt(dfDist[i]) * DFS;
}
export function riverField(x,z){                        // -> {d, t} bilinear
  const fx = clamp((x+HALF)/DFS, 0, DF-1.001), fy = clamp((z+HALF)/DFS, 0, DF-1.001);
  const x0=fx|0, y0=fy|0, tx=fx-x0, ty=fy-y0;
  const i00=y0*DF+x0, i10=i00+1, i01=i00+DF, i11=i01+1;
  const d = lerp(lerp(dfDist[i00],dfDist[i10],tx), lerp(dfDist[i01],dfDist[i11],tx), ty);
  const t = lerp(lerp(dfT[i00],dfT[i10],tx), lerp(dfT[i01],dfT[i11],tx), ty);
  return {d, t};
}

/* ── the valley cross-section: the shape that makes the whole composition ──
   Everything within the local river half-width sits below the waterline, so the
   water ribbon can never float above its own bed.                            */
function valleyProfile(d, wobble, w){
  const bed = w*0.55;
  if(d < bed)  return -3.4 + d*0.02;
  if(d < w)    return lerp(-3.3, -0.42, smootherstep(bed, w, d));
  const bank = w + 13 + wobble*6;
  if(d < bank) return lerp(-0.42, 2.6, smootherstep(w, bank, d));
  if(d < 150){ const u=(d-bank)/(150-bank); return 2.6 + 42.0*Math.pow(u, 0.55); }
  return lerp(44.6, 60, smootherstep(150, 320, d));
}

/* ── the hero landmarks that the terrain must accommodate ── */
export const BRIDGE = { x:CFG.bridge.x, z:CFG.bridge.z };
export const VILLAGE = { x:-452, z:186, r:150 };
const SPAWN_KNOLL = { x:CFG.spawn.x-6, z:CFG.spawn.z-4, r:78, h:8.4 };

function baseHills(x,z){
  const s = 0.00085;
  let h = 0;
  h += fbm2(x*s,      z*s,      4) * 46;
  h += ridged(x*s*2.6+11, z*s*2.6-7, 4) * 20;
  h += billow(x*s*6.1-3, z*s*6.1+5, 3) * 7.5;
  h += noise2(x*s*17.0, z*s*17.0) * 2.1;
  // domain-warped large forms so ridges meander instead of tiling
  const wx = noise2(x*s*0.55+31, z*s*0.55-19)*90;
  const wz = noise2(x*s*0.55-13, z*s*0.55+27)*90;
  h += fbm2((x+wx)*s*0.42, (z+wz)*s*0.42, 3) * 34;
  return h;
}

let _bridgeDeck = null;
function bridgeDeckY(){
  if(_bridgeDeck === null) _bridgeDeck = waterLevel(riverField(BRIDGE.x, BRIDGE.z).t) + 26.0;
  return _bridgeDeck;
}

export function terrainAt(x,z){
  const rf = riverField(x,z);
  const wl = waterLevel(rf.t);
  const wob = noise2(x*0.0032+4.4, z*0.0032-2.1);
  const regional = wl + 60;
  let hBase = regional + baseHills(x,z);
  const prof = wl + valleyProfile(rf.d, wob, riverWidth(rf.t))
             + noise2(x*0.0068, z*0.0068)*3.4*smoothstep(24,110,rf.d)
             + noise2(x*0.021,  z*0.021 )*0.9*smoothstep(16,60,rf.d);
  const k = 1 - smootherstep(150, 330, rf.d);
  let h = lerp(hBase, prof, k);

  // spawn knoll — puts the camera on an overlook for the opening frame
  const dk = Math.hypot(x-SPAWN_KNOLL.x, z-SPAWN_KNOLL.z);
  h += SPAWN_KNOLL.h * Math.pow(Math.max(0, 1 - dk/SPAWN_KNOLL.r), 2.0);

  // village terrace: a gentle shelf on the far bank
  const dv = Math.hypot(x-VILLAGE.x, z-VILLAGE.z);
  if(dv < VILLAGE.r*1.5){
    const w = smootherstep(VILLAGE.r*1.5, VILLAGE.r*0.35, dv);
    const target = wl + 16 + (z-VILLAGE.z)*0.075 + noise2(x*0.01,z*0.01)*2.2;
    h = lerp(h, target, w*0.72);
  }
  // (the railway's own grading shapes the approaches; see trackAdjust —
  //  nothing is stamped under the bridge itself)
  return h;
}

/* bridge orientation: perpendicular to the river at the crossing */
export const BRIDGE_AXIS = (()=>{                       // along the track
  const a = riverField(BRIDGE.x, BRIDGE.z);
  let i = Math.round(a.t*(RIVER_PTS.length-1));
  i = clamp(i, 3, RIVER_PTS.length-4);
  const p0=RIVER_PTS[i-3], p1=RIVER_PTS[i+3];
  const tx=p1.x-p0.x, tz=p1.z-p0.z, L=Math.hypot(tx,tz);
  return [-tz/L, tx/L];
})();
export const BRIDGE_PERP = [-BRIDGE_AXIS[1], BRIDGE_AXIS[0]];

/* ── bake ── */
export function bakeTerrain(onProgress){
  for(let y=0;y<HM;y++){
    const wz = (y/(HM-1))*WS - HALF;
    for(let x=0;x<HM;x++){
      const wx = (x/(HM-1))*WS - HALF;
      heightData[y*HM+x] = terrainAt(wx,wz);
    }
    if(onProgress && (y&63)===0) onProgress(y/HM);
  }
}
let PATH_DF = null;
export function bakeSplat(){
  const R = CFG.dataRes;
  PATH_DF = makeDF(PATH_PTS.map((p,i)=>({x:p[0], z:p[1], t:i/PATH_PTS.length})), 384);
  for(let y=0;y<R;y++){
    const wz=(y/(R-1))*WS-HALF;
    for(let x=0;x<R;x++){
      const wx=(x/(R-1))*WS-HALF;
      const rf = riverField(wx,wz);
      const h  = sampleHeight(wx,wz);
      const n  = sampleNormal(wx,wz);
      const slope = 1-n.y;
      const wl = waterLevel(rf.t);
      const moist = clamp(1 - smoothstep(6, 120, rf.d) + (h < wl+3 ? 0.4:0), 0, 1);
      // The meadow covers everything.  Only open water, genuine cliff, the
      // footpath tread and the permanent way are bare — and even those get a
      // ragged, noise-broken edge rather than a smooth analytic blob.
      let mask = 1;
      mask *= 1 - smoothstep(0.60, 0.88, slope);       // cliffs only
      mask *= smoothstep(-0.55, 0.75, h - wl);         // right down to the water
      const dv = Math.hypot(wx-VILLAGE.x, wz-VILLAGE.z);
      mask *= lerp(1, 0.42, smoothstep(VILLAGE.r*0.70, VILLAGE.r*0.16, dv));
      const dp = PATH_DF(wx,wz).d;
      mask *= smoothstep(0.7, 2.4, dp);
      if(TRACK){ const tf = TRACK.field(wx,wz); mask *= smoothstep(1.8, 4.6, tf.d); }
      const rag = fbm2(wx*0.085+13.7, wz*0.085-5.3, 3)
                + noise2(wx*0.27, wz*0.27)*0.35;
      mask = clamp(mask*1.30 - 0.09 + rag*0.20, 0, 1);
      // dryness: seed-head yellow on exposed, south-facing, well-drained ground
      const dry = clamp(
        fbm2(wx*0.0125+9.1, wz*0.0125-4.2, 3)*0.85 + 0.06
        + smoothstep(0.14,0.38,slope)*0.26 - smoothstep(46,4,rf.d)*0.95, 0, 1);
      const i=(y*R+x)*4;
      splatData[i  ] = clamp(rf.d/320,0,1)*255;
      splatData[i+1] = moist*255;
      splatData[i+2] = clamp(mask,0,1)*255;
      splatData[i+3] = dry*255;
    }
  }
}

// must run after bakeSplat(): it folds the grass mask and dryness in
export function bakeMeadow(){
  const R = MEADOW_RES, SR = CFG.dataRes;
  for(let y=0;y<R;y++){
    const wz=(y/(R-1))*WS-HALF;
    for(let x=0;x<R;x++){
      const wx=(x/(R-1))*WS-HALF;
      const cA = noise2(wx*0.092  + 3.3,  wz*0.092  + 3.3 )*0.5+0.5;  // tussocks, ~68 m
      const cB = noise2(wx*0.0215 + 17.0, wz*0.0215 + 17.0)*0.5+0.5;  // swales,  ~292 m
      // resample the splat mask / dryness onto this grid (both are 512² too)
      const sx = clamp(Math.round(x/(R-1)*(SR-1)), 0, SR-1);
      const sy = clamp(Math.round(y/(R-1)*(SR-1)), 0, SR-1);
      const si = (sy*SR + sx)*4;
      const i=(y*R+x)*4;
      meadowData[i  ] = clamp(cA,0,1)*255;
      meadowData[i+1] = clamp(cB,0,1)*255;
      meadowData[i+2] = splatData[si+2];      // grass mask
      meadowData[i+3] = splatData[si+3];      // dryness
    }
  }
}

/*  The permanent way must never be swallowed by the hillside.  trackAdjust
    deliberately refuses to fill a deep gorge (or the viaduct's arches would be
    buried in an earth causeway), but a *cutting* can always be dug: no amount
    of excavation can fill a valley.  This second pass therefore guarantees a
    level, un-buried formation for the full length of the line.               */
export function carveTrackBed(){
  if(!TRACK) return;
  for(let y=0;y<HM;y++){
    const wz=(y/(HM-1))*WS-HALF;
    for(let x=0;x<HM;x++){
      const wx=(x/(HM-1))*WS-HALF;
      const f=TRACK.field(wx,wz);
      if(f.d > 26) continue;
      const formation = TRACK.yAt(f.t) - 0.92;
      const h = heightData[y*HM+x];
      if(h <= formation + 0.05) continue;          // already low enough
      // full depth on the 4.4 m formation, then a 1:3 batter out to 26 m
      const w = 1 - smootherstep(4.4, 26.0, f.d);
      const target = formation + Math.max(0, f.d-4.4)*0.34;
      heightData[y*HM+x] = Math.min(h, lerp(h, Math.min(h, target), w));
    }
  }
}

/* ── the footpath that leads the eye out of frame-left ── */
const PATH_CTRL = [
  [ 120, 30],[ 40, 62],[ -30, 96],[ -96, 120],[ -150, 136],
  [ -212, 152],[ -268, 150],[ -318, 132],[ -352, 104],
];
const PATH_PTS = (()=>{ const a=[]; for(let i=0;i<=420;i++){ const p=catmull(PATH_CTRL,i/420); a.push(p);} return a; })();
export function pathDistance(x,z){
  let best=1e9;
  for(let i=0;i<PATH_PTS.length;i+=3){
    const dx=x-PATH_PTS[i][0], dz=z-PATH_PTS[i][1];
    const d=dx*dx+dz*dz; if(d<best) best=d;
  }
  return Math.sqrt(best);
}

/* ── CPU sampling that matches the GPU bilinear exactly ── */
export function sampleHeight(x,z){
  const fx = clamp((x+HALF)/WS*(HM-1), 0, HM-1.001);
  const fy = clamp((z+HALF)/WS*(HM-1), 0, HM-1.001);
  const x0=fx|0, y0=fy|0, tx=fx-x0, ty=fy-y0;
  const i=y0*HM+x0;
  return lerp(lerp(heightData[i],heightData[i+1],tx),
              lerp(heightData[i+HM],heightData[i+HM+1],tx), ty);
}
export function sampleNormal(x,z,e){
  e = e||2.4;
  const l=sampleHeight(x-e,z), r=sampleHeight(x+e,z);
  const d=sampleHeight(x,z-e), u=sampleHeight(x,z+e);
  const nx=l-r, ny=2*e, nz=d-u; const L=Math.hypot(nx,ny,nz);
  return {x:nx/L, y:ny/L, z:nz/L};
}

/* ── warped clipmap mesh: dense underfoot, coarse at the horizon ── */
export function buildTerrainGeometry(N, R, warpP, cx, cz){
  const pos = new Float32Array((N+1)*(N+1)*3);
  const idx = new Uint32Array(N*N*6);
  let k=0;
  for(let j=0;j<=N;j++){
    const v = j/N*2-1;
    const zz = Math.sign(v)*Math.pow(Math.abs(v), warpP)*R + cz;
    for(let i=0;i<=N;i++){
      const u = i/N*2-1;
      const xx = Math.sign(u)*Math.pow(Math.abs(u), warpP)*R + cx;
      pos[k++]=xx; pos[k++]=0; pos[k++]=zz;
    }
  }
  k=0;
  for(let j=0;j<N;j++) for(let i=0;i<N;i++){
    const a=j*(N+1)+i, b=a+1, c=a+N+1, d=c+1;
    idx[k++]=a; idx[k++]=c; idx[k++]=b;
    idx[k++]=b; idx[k++]=c; idx[k++]=d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setIndex(new THREE.BufferAttribute(idx,1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx,120,cz), R*1.8);
  return g;
}

/*───────────────────────── terrain shader ─────────────────────────*/
export const TERRAIN_VS = ()=> /* glsl */`
${GL_UNI}
${GL_HASH}${GL_NOISE}${GL_TERRAIN}
out vec3 vW; out vec3 vN; out float vDist;
void main(){
  vec3 p = position;
  p.y = terrainH(p.xz);
  vW = p;
  float e = max(1.9, distance(p.xz, uCamPos.xz)*0.020);
  vN = terrainN(p.xz, e);
  vec4 mv = modelViewMatrix * vec4(p,1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

export const TERRAIN_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
uniform vec2 uMeanWind;
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_TERRAIN}${GL_WIND}
${GL_CLOUDFIELD}${GL_SHADOW}${GL_LIGHT}${GL_AIR}
in vec3 vW; in vec3 vN; in float vDist;
out vec4 outColor;

void main(){
  vec3 P = vW;
  vec3 V = normalize(uCamPos - P);
  vec4 sp = splatAt(P.xz);
  float distRiver = sp.r*320.0, moist = sp.g, gmask = sp.b, dry = sp.a;

  // --- fine normal detail (fragment-space only; silhouettes stay soft) ---
  vec3 N = normalize(vN);
  float detail = clamp(1.0 - vDist*0.006, 0.0, 1.0);
  // it faded to nothing past 167 m, yet the four gradient-noise evaluations ran
  // on every terrain pixel to the horizon regardless
  if(detail > 0.004){
    float ns = 0.055;
    vec2 dn = vec2(pn2(P.xz*ns+3.1), pn2(P.xz*ns+17.7));
    dn += vec2(pn2(P.xz*ns*3.3), pn2(P.xz*ns*3.3+9.0))*0.4;
    N = normalize(N + vec3(dn.x, 0.0, dn.y)*0.30*detail);
  }
  float slope = 1.0 - clamp(vN.y, 0.0, 1.0);

  // --- painterly patchwork of greens (never one flat colour) -------------
  // The two low-frequency bands come from the same baked tussock field the
  // grass uses.  That is four fewer noise evaluations per pixel AND — the
  // better reason — the ground mosaic now lines up exactly with the mosaic in
  // the blades standing on it, instead of being an independent pattern.
  vec4 md = texture(uMeadow, P.xz*W_INV + 0.5);
  float q1 = md.g*2.0 - 1.0;
  float q2 = md.r*2.0 - 1.0;
  float q3 = pn2(P.xz*0.098 + 41.0);
  vec3 gLit = mix(${C.tLit}, ${C.gPatchC}, smoothstep(-0.25,0.35,q1)*0.75);
  gLit = mix(gLit, ${C.gPatchA}, smoothstep(0.05,0.55,q2)*0.5);
  vec3 gMid = mix(${C.tMid}, ${C.gPatchB}, smoothstep(-0.3,0.3,q2)*0.6);
  vec3 gShd = mix(${C.tShade}, ${C.tHollow}, smoothstep(-0.2,0.5,q1)*0.42);
  gLit *= 1.0 + q3*0.055; gMid *= 1.0 + q3*0.05;

  // moisture: lusher, cooler, deeper green in the floodplain
  gLit = mix(gLit, ${C.gPatchD}*1.30, moist*0.32);
  gMid = mix(gMid, ${C.gPatchD}, moist*0.36);
  // dryness: seed-head straw on exposed shoulders
  float dd = smoothstep(0.60, 0.98, dry + q2*0.14);
  gLit = mix(gLit, ${C.gDry}, dd*0.55);
  gMid = mix(gMid, ${C.gDry}*0.72, dd*0.42);

  // --- hedgerowed field parcels on the far bank (the Ghibli quilt) --------
  float farm = smoothstep(230.0, 120.0, distance(P.xz, vec2(${VILLAGE.x.toFixed(1)},${VILLAGE.z.toFixed(1)})))
             * smoothstep(0.30, 0.10, slope);
  if(farm > 0.003){
    vec2 fr = mat2(0.87,-0.49,0.49,0.87) * P.xz * 0.0165;
    vec2 wf = vec2(pn2(fr*0.62), pn2(fr*0.62+7.0))*0.42;
    vec2 cell = floor(fr + wf);
    float ch = hash12(cell);
    vec2 fl = fract(fr + wf);
    float edge = min(min(fl.x,1.0-fl.x), min(fl.y,1.0-fl.y));
    vec3 fieldCol = ch<0.25 ? ${C.gPatchA} : (ch<0.5 ? ${C.gDry}*0.92 :
                    (ch<0.72 ? ${C.gPatchC} : ${C.gPatchB}));
    float hedge = 1.0 - smoothstep(0.012, 0.055, edge);
    gLit = mix(gLit, fieldCol*1.12, farm*0.72);
    gMid = mix(gMid, fieldCol*0.82, farm*0.72);
    gLit = mix(gLit, ${C.cMid}, hedge*farm*0.85);
    gMid = mix(gMid, ${C.cShade}, hedge*farm*0.85);
    gShd = mix(gShd, ${C.cDeep}, hedge*farm*0.7);
  }

  // --- rock, path, riverbed ----------------------------------------------
  float rock = smoothstep(0.34, 0.60, slope + (md.a*2.0-1.0)*0.10);
  vec3 rLit = mix(${C.rockLit}, ${C.sB}, md.r);
  gLit = mix(gLit, rLit, rock); gMid = mix(gMid, ${C.rockLit}*0.72, rock);
  gShd = mix(gShd, ${C.rockShade}, rock);

  // a narrow band of cool wet shingle at the waterline, not a beach
  float bed = 1.0 - smoothstep(0.0, 5.0, distRiver);
  vec3 shingle = mix(${C.wetStone}, ${C.rockLit}, 0.45);
  gLit = mix(gLit, shingle*1.15, bed*0.80);
  gMid = mix(gMid, shingle*0.85, bed*0.80);
  gShd = mix(gShd, ${C.wDeepShade}, bed*0.55);

  float pathA = (1.0 - smoothstep(0.02, 0.26, gmask)) * (1.0-bed) * (1.0-rock);
  vec3 earth = mix(${C.pathLit}, ${C.tShade}, 0.28);
  gLit = mix(gLit, earth, pathA*0.85);
  gMid = mix(gMid, earth*0.68, pathA*0.85);
  gShd = mix(gShd, ${C.pathShade}*0.70, pathA*0.80);

  // --- the ground itself carries a fine sward texture, so the field never
  //     reads as a flat painted plane between blades ---------------------
  {
    float sw1 = pn2(P.xz*2.30 + 3.0);
    float sw2 = pn2(P.xz*6.90 + 11.0);
    float sw3 = pn2(vec2(P.x*19.0 + P.z*4.0, P.z*3.1) + 31.0);   // blade-like
    float sward = sw1*0.42 + sw2*0.32 + sw3*0.34;
    float swAmt = gmask * (1.0-rock) * (1.0-bed) * smoothstep(5.0, 26.0, vDist);
    gLit = mix(gLit, mix(gLit*1.30, ${C.gTip}, 0.30), clamp(sward,0.0,1.0)*swAmt*0.62);
    gMid = mix(gMid, gMid*0.66, clamp(-sward,0.0,1.0)*swAmt*0.75);
    gShd = mix(gShd, gShd*0.78, swAmt*0.35);
  }

  // --- grass sheen at distance: the wind waves keep rolling to the horizon
  // windSample already blends the simulated field into its analytic
  // continuation, so one call is the whole answer — evaluating the analytic
  // band a second time here cost ~20 hashes on every terrain pixel on screen.
  float gust = windSample(P.xz).b;
  float grassy = gmask * (1.0-rock) * (1.0-bed);
  // only a genuine gust (well above the mean) flashes the field pale
  float band = smoothstep(1.10, 1.85, gust) * grassy;
  // micro shimmer so mid-distance ground reads as blades, not paint
  float shim = pn2(P.xz*1.35 - uMeanWind*uTime*0.7)*0.5+0.5;
  band *= 0.55 + 0.75*shim;
  float farBlend = smoothstep(26.0, 70.0, vDist);
  gLit = mix(gLit, ${C.gSheen}, band*0.42*farBlend);
  gMid = mix(gMid, ${C.gSheen}*0.72, band*0.30*farBlend);

  // --- light -------------------------------------------------------------
  float ndl = dot(N, uSunDir);
  float sh  = sunShadow(P, ndl) * cloudShadow(P);
  Surf s;
  s.N=N; s.V=V; s.P=P;
  s.shade=gShd; s.mid=gMid; s.lit=gLit;
  s.soft = mix(0.085, 0.20, clamp(vDist*0.004,0.0,1.0));
  s.jit = (vn2(vW.xz*3.9 + vW.y*1.7) - 0.5)*0.055;
  s.shadow=sh; s.trans = grassy*0.55; s.transCol=${C.gTrans}*0.62;
  s.rim = 0.13*grassy + 0.06; s.ao = 1.0; s.ambient=1.0;
  vec3 col = paint(s);

  // cavity shading in the hollows
  float cav = smoothstep(0.0, 26.0, distRiver);
  col *= mix(0.86, 1.0, cav);
  // under a dense sward the ground is in the grass's own shadow, so the gaps
  // between blades read as depth rather than as bare earth
  col *= mix(1.0, 0.56, grassy * (1.0 - smoothstep(6.0, 120.0, vDist)));

  col = aerial(col, vDist, V, P.y);
  outColor = vec4(SAFE3(col), gFogAmt);
}`;

/*  A coarse stand-in for the terrain, used ONLY by the shadow and reflection
    passes.  Those passes do not need 300k triangles of hillside — a 4.7 m grid
    around the player is indistinguishable in a shadow map or in rippled water,
    and it removes two full-detail terrain draws from every frame.           */
export function buildProxyTerrainGeometry(N, half){
  const pos = new Float32Array((N+1)*(N+1)*3);
  const idx = new Uint32Array(N*N*6);
  let k=0;
  for(let j=0;j<=N;j++) for(let i=0;i<=N;i++){
    pos[k++] = (i/N*2-1)*half; pos[k++] = 0; pos[k++] = (j/N*2-1)*half;
  }
  k=0;
  for(let j=0;j<N;j++) for(let i=0;i<N;i++){
    const a=j*(N+1)+i, b=a+1, c=a+N+1, d=c+1;
    idx[k++]=a; idx[k++]=c; idx[k++]=b; idx[k++]=b; idx[k++]=c; idx[k++]=d;
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setIndex(new THREE.BufferAttribute(idx,1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}
/*  uProxyDrop sinks the proxy for the DEPTH pass only.  The proxy is a 3 m grid
    standing in for a heightmap with centimetre detail, so on any real slope it
    pokes up through the true ground — and then every grass blade rooted there
    samples itself as shadowed.  That is the source of the dark stripes crawling
    across the meadow: they trace the proxy's own triangle edges, and because
    the grid follows the camera they slide as you walk.  Sinking the shadow-
    casting copy a metre puts it unambiguously below the ground it approximates,
    so it can never self-shadow, while trees, buildings and the viaduct (which
    are cast at their true height) are completely unaffected.                 */
export const PROXY_TERRAIN_VS = ()=> /* glsl */`
${GL_UNI}
uniform vec2 uProxyC;
uniform float uProxyDrop;
${GL_HASH}${GL_NOISE}${GL_TERRAIN}
out vec3 vW; out vec3 vN; out float vDist;
void main(){
  vec3 p = position; p.xz += uProxyC;
  p.y = terrainH(p.xz) - uProxyDrop;
  vW = p;
  vN = terrainN(p.xz, 5.0);
  vec4 mv = viewMatrix * vec4(p,1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

/*──────────── distant ridge silhouettes: pure haze, pure shape ────────────*/
export function buildRidgeBand(radius, height, seed, segs){
  const pos=[], idx=[], hgt=[];
  const r=rng(seed);
  const off = r()*1000;
  for(let i=0;i<=segs;i++){
    const a = (i/segs)*TAU;
    const x = Math.cos(a)*radius, z = Math.sin(a)*radius;
    let h = 0, amp=1, f=1.6, n=0;
    for(let o=0;o<5;o++){ h += amp*Math.abs(noise2(Math.cos(a)*f*3+off, Math.sin(a)*f*3+off)); n+=amp; amp*=0.52; f*=2.1; }
    h = (h/n);
    h = Math.pow(h, 1.25)*height + height*0.22;
    pos.push(x, 0, z); hgt.push(0);
    pos.push(x, h, z); hgt.push(1);
  }
  for(let i=0;i<segs;i++){
    const a=i*2, b=a+1, c=a+2, d=a+3;
    idx.push(a,b,c, c,b,d);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos),3));
  g.setAttribute('hgt', new THREE.BufferAttribute(new Float32Array(hgt),1));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0,0,0), radius*1.5);
  return g;
}
export const RIDGE_VS = /* glsl */`
${GL_UNI}
uniform float uBaseY;
in float hgt;
out float vH; out vec3 vW;
void main(){
  vec3 p = position; p.y += uBaseY;
  vW = p; vH = hgt;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
}`;
export const RIDGE_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_CLOUDFIELD}
uniform vec3 uNearCol; uniform vec3 uFarCol; uniform float uMix;
in float vH; in vec3 vW;
out vec4 outColor;
void main(){
  vec3 V = normalize(uCamPos - vW);
  float t = clamp(vH, 0.0, 1.0);
  vec3 col = mix(uNearCol, uFarCol, uMix);
  // the sunward flank catches warmth; ridgelines are lighter than their bases
  float sunSide = clamp(dot(normalize(vec2(vW.x,vW.z)), normalize(uSunDir.xz))*0.5+0.5, 0.0, 1.0);
  col = mix(col*0.955, mix(col, K_SKY_HORSUN, 0.30), sunSide);
  col = mix(col*0.90, col*1.06, smoothstep(0.15, 0.95, t));
  // A hint of cloud shadow banding across the far peaks.  The full coverage
  // field is thirteen octaves; at this distance everything is 55% haze anyway,
  // so three octaves of the same warp is indistinguishable and a quarter of the
  // cost across the whole horizon band.
  vec2 cq = (vW.xz*0.5 + uSunDir.xz*900.0 - uCloudDrift) * 0.00071;
  float cs = clamp(smoothstep(-0.035, 0.30, fbm2(cq, 3))*uCloudAmount, 0.0, 1.0);
  col *= mix(1.0, 0.90, smoothstep(0.1,0.7,cs));
  float haze = mix(0.72, 0.30, t);
  col = mix(col, K_HAZE, haze*0.55);
  col = mix(col, K_SKY_HOR, (1.0-t)*0.34);
  outColor = vec4(SAFE3(col), 0.88);
}`;
