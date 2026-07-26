import * as THREE from 'three';
import { CFG } from './config.js';
import { GL_AIR, GL_CLOUDFIELD, GL_HASH, GL_LIGHT, GL_NOISE, GL_PAL, GL_SHADOW, GL_TERRAIN, GL_UNI, GL_WIND } from './glsl.js';
import { TAU, clamp, lerp, noise2, rng, smoothstep } from './math.js';
import { C, P } from './palette.js';
import { BRIDGE, RIVER_PTS, VILLAGE, pathDistance, riverField, riverWidth, sampleHeight, sampleNormal, waterLevel } from './terrain.js';

/*──────────────────────────────── §8  TREES ─────────────────────────────────*/
/* Trunks are generalised cylinders swept along a curve; canopies are clusters
   of scalloped clumps, because Ghibli foliage reads as sculpted mass, not
   leaves.  Every clump takes its own hue from a four-green mosaic.           */

const MeshBuf = () => ({ pos:[], nrm:[], clm:[], flx:[], hue:[], idx:[], n:0 });
function pushVert(M, x,y,z, nx,ny,nz, cx,cy,cz, flex, hue){
  M.pos.push(x,y,z); M.nrm.push(nx,ny,nz); M.clm.push(cx,cy,cz);
  M.flx.push(flex); M.hue.push(hue); return M.n++;
}
export function finishMesh(M){
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M.pos),3));
  g.setAttribute('nrm',      new THREE.BufferAttribute(new Float32Array(M.nrm),3));
  g.setAttribute('clm',      new THREE.BufferAttribute(new Float32Array(M.clm),3));
  g.setAttribute('flx',      new THREE.BufferAttribute(new Float32Array(M.flx),1));
  g.setAttribute('hue',      new THREE.BufferAttribute(new Float32Array(M.hue),1));
  g.setIndex(M.idx);
  return g;
}

// swept tapered tube along a polyline
function addTube(M, pts, radii, seg, hueV){
  const rings=[];
  for(let i=0;i<pts.length;i++){
    const p=pts[i];
    let t;
    if(i===0) t=[pts[1][0]-p[0], pts[1][1]-p[1], pts[1][2]-p[2]];
    else if(i===pts.length-1) t=[p[0]-pts[i-1][0], p[1]-pts[i-1][1], p[2]-pts[i-1][2]];
    else t=[pts[i+1][0]-pts[i-1][0], pts[i+1][1]-pts[i-1][1], pts[i+1][2]-pts[i-1][2]];
    const L=Math.hypot(t[0],t[1],t[2])||1; t=[t[0]/L,t[1]/L,t[2]/L];
    let up=[0,1,0]; if(Math.abs(t[1])>0.94) up=[1,0,0];
    let s=[t[1]*up[2]-t[2]*up[1], t[2]*up[0]-t[0]*up[2], t[0]*up[1]-t[1]*up[0]];
    const sl=Math.hypot(s[0],s[1],s[2])||1; s=[s[0]/sl,s[1]/sl,s[2]/sl];
    const u=[t[1]*s[2]-t[2]*s[1], t[2]*s[0]-t[0]*s[2], t[0]*s[1]-t[1]*s[0]];
    const ring=[];
    const flex = Math.pow(clamp(i/(pts.length-1),0,1), 1.6)*0.55;
    for(let j=0;j<seg;j++){
      const a=j/seg*TAU;
      const ca=Math.cos(a), sa=Math.sin(a);
      const wob = 1 + Math.sin(a*3+i)*0.09 + Math.cos(a*5-i*0.7)*0.05;
      const r=radii[i]*wob;
      const nx=s[0]*ca+u[0]*sa, ny=s[1]*ca+u[1]*sa, nz=s[2]*ca+u[2]*sa;
      ring.push(pushVert(M, p[0]+nx*r, p[1]+ny*r, p[2]+nz*r, nx,ny,nz, p[0],p[1],p[2], flex, hueV));
    }
    rings.push(ring);
  }
  for(let i=0;i<rings.length-1;i++) for(let j=0;j<seg;j++){
    const a=rings[i][j], b=rings[i][(j+1)%seg], c=rings[i+1][j], d=rings[i+1][(j+1)%seg];
    M.idx.push(a,c,b, b,c,d);
  }
}

// a scalloped canopy clump: an icosphere pushed around by noise
const ICO = (()=>{
  const t=(1+Math.sqrt(5))/2;
  let v=[[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],
         [t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]].map(p=>{const l=Math.hypot(...p);return [p[0]/l,p[1]/l,p[2]/l];});
  let f=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
         [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  const sub=(v,f)=>{ const nf=[], cache={};
    const mid=(a,b)=>{ const k=a<b?a+'_'+b:b+'_'+a; if(cache[k]!==undefined)return cache[k];
      const p=[(v[a][0]+v[b][0])/2,(v[a][1]+v[b][1])/2,(v[a][2]+v[b][2])/2];
      const l=Math.hypot(...p); v.push([p[0]/l,p[1]/l,p[2]/l]); return cache[k]=v.length-1; };
    for(const t of f){ const a=mid(t[0],t[1]),b=mid(t[1],t[2]),c=mid(t[2],t[0]);
      nf.push([t[0],a,c],[t[1],b,a],[t[2],c,b],[a,b,c]); }
    return nf; };
  const L1 = { v:v.map(a=>a.slice()), f:f.map(a=>a.slice()) };
  L1.f = sub(L1.v, L1.f);
  const L2 = { v:L1.v.map(a=>a.slice()), f:L1.f.map(a=>a.slice()) };
  L2.f = sub(L2.v, L2.f);
  return { L0:{v,f}, L1, L2 };
})();

function addClump(M, cx,cy,cz, rx,ry,rz, seed, hueV, detail){
  const src = detail>=2 ? ICO.L2 : (detail>=1 ? ICO.L1 : ICO.L0);
  const base = M.n;
  const r = rng(seed*7919|0);
  const ph = [r()*10, r()*10, r()*10];
  for(const p of src.v){
    // scalloped displacement: cauliflower lobes, not a smooth ball
    const d = 1
      + 0.20*Math.sin(p[0]*4.1+ph[0])*Math.sin(p[1]*3.7+ph[1])
      + 0.14*Math.sin(p[2]*6.3+ph[2])*Math.cos(p[0]*5.1+ph[1])
      + 0.09*noise2(p[0]*3.4+ph[0], p[2]*3.4+ph[2]);
    const x=cx+p[0]*rx*d, y=cy+p[1]*ry*d, z=cz+p[2]*rz*d;
    pushVert(M, x,y,z, p[0],p[1],p[2], cx,cy,cz, 1.0, hueV);
  }
  for(const f of src.f) M.idx.push(base+f[0], base+f[1], base+f[2]);
}

export function makeTree(kind, detail, seed){
  const M = MeshBuf(); const r = rng(seed);
  const H = kind==='poplar' ? 13+r()*5 : kind==='pine' ? 12+r()*6 :
            kind==='willow' ? 8+r()*3 : 10+r()*4;
  const trunkSeg = detail>=2 ? 8 : (detail>=1 ? 6 : 4);

  if(kind==='pine'){
    const pts=[], rad=[];
    for(let i=0;i<=6;i++){ const u=i/6; pts.push([Math.sin(u*2.1)*0.35*u*H*0.06, u*H, Math.cos(u*1.7)*0.3*u*H*0.06]);
      rad.push(lerp(H*0.035, H*0.006, u)); }
    addTube(M, pts, rad, trunkSeg, 0.0);
    const tiers = detail>=1 ? 6 : 4;
    for(let i=0;i<tiers;i++){
      const u = 0.30 + 0.68*(i/(tiers-1));
      const rr = (1-u)*H*0.30 + H*0.05;
      addClump(M, 0, u*H + H*0.04, 0, rr, rr*0.36, rr, seed+i*13, 0.15+r()*0.7, Math.max(0,detail-1));
    }
  } else if(kind==='poplar'){
    const pts=[], rad=[];
    for(let i=0;i<=7;i++){ const u=i/7; pts.push([Math.sin(u*3.0)*0.5, u*H, Math.cos(u*2.2)*0.45]);
      rad.push(lerp(H*0.028, H*0.005, u)); }
    addTube(M, pts, rad, trunkSeg, 0.0);
    const n = detail>=1 ? 9 : 5;
    for(let i=0;i<n;i++){
      const u = 0.20 + 0.78*(i/(n-1));
      const rr = H*(0.17 - 0.08*Math.abs(u-0.55)*1.4);
      addClump(M, Math.sin(u*7)*0.5, u*H, Math.cos(u*6)*0.45, rr*0.9, rr*1.35, rr*0.9,
               seed+i*29, 0.2+r()*0.7, Math.max(0,detail-1));
    }
  } else if(kind==='willow'){
    const pts=[], rad=[];
    for(let i=0;i<=5;i++){ const u=i/5; pts.push([u*u*1.7, u*H*0.72, Math.sin(u*2)*0.6]);
      rad.push(lerp(H*0.05, H*0.012, u)); }
    addTube(M, pts, rad, trunkSeg, 0.0);
    const n = detail>=1 ? 12 : 6;
    for(let i=0;i<n;i++){
      const a=r()*TAU, rr0=Math.sqrt(r())*H*0.42;
      const cx=Math.cos(a)*rr0+1.5, cz=Math.sin(a)*rr0;
      const cy=H*0.62 + (r()-0.3)*H*0.22;
      const rr=H*(0.13+r()*0.09);
      addClump(M, cx, cy, cz, rr*1.15, rr*0.8, rr*1.15, seed+i*37, 0.5+r()*0.5, Math.max(0,detail-1));
      // trailing curtain
      if(detail>=1) addClump(M, cx*1.05, cy-rr*1.5, cz*1.05, rr*0.55, rr*1.5, rr*0.55,
                             seed+i*41, 0.6+r()*0.4, Math.max(0,detail-1));
    }
  } else { // broadleaf: the camphor / oak silhouette
    const pts=[], rad=[];
    const lean=(r()-0.5)*0.5;
    for(let i=0;i<=6;i++){ const u=i/6;
      pts.push([lean*u*u*H*0.14 + Math.sin(u*3.4)*0.35, u*H*0.52, Math.cos(u*2.6)*0.35]);
      rad.push(lerp(H*0.062, H*0.026, u)); }
    addTube(M, pts, rad, trunkSeg, 0.0);
    const nb = detail>=2 ? 5 : (detail>=1 ? 4 : 0);
    for(let i=0;i<nb;i++){
      const a=i/nb*TAU + r()*0.9;
      const bl=H*(0.26+r()*0.16);
      const bp=[], br=[];
      for(let j=0;j<=3;j++){ const u=j/3;
        bp.push([Math.cos(a)*bl*u*0.9, H*0.50 + u*bl*0.72 - u*u*bl*0.12, Math.sin(a)*bl*u*0.9]);
        br.push(lerp(H*0.020, H*0.006, u)); }
      addTube(M, bp, br, Math.max(3,trunkSeg-2), 0.0);
    }
    const n = detail>=2 ? 22 : (detail>=1 ? 12 : 7);
    const CR = H*0.40;
    for(let i=0;i<n;i++){
      let cx,cy,cz,rr;
      if(i===0){ cx=0; cy=H*0.78; cz=0; rr=CR*0.72; }
      else{ const a=r()*TAU, dd=Math.pow(r(),0.55)*CR*1.02;
        cx=Math.cos(a)*dd; cz=Math.sin(a)*dd*0.92;
        cy=H*0.74 + (r()-0.44)*CR*0.95 - dd*0.20;
        rr=CR*(0.26+r()*0.26); }
      addClump(M, cx,cy,cz, rr*1.12, rr*0.86, rr*1.12, seed+i*53, r(), Math.max(0,detail-1));
    }
  }
  return M;
}


/*──────────────── tree shader: bending trunks, swaying clumps, flutter ─────*/
export const TREE_VS = ()=> /* glsl */`
${GL_UNI}
uniform vec2 uMeanWind;
uniform float uTreeH;      // nominal archetype height
uniform float uFlex;       // archetype stiffness multiplier (willow >> pine)
uniform float uCullR;      // >0 : reject instances beyond this radius
${GL_HASH}${GL_NOISE}${GL_TERRAIN}${GL_WIND}
in vec3 nrm; in vec3 clm; in float flx; in float hue;
in vec4 iPos;              // xyz = root, w = scale
in vec4 iVar;              // rot, hueShift, phase, kind
out vec3 vW; out vec3 vN; out float vHue; out float vLeaf; out float vDist;
out float vY; out float vAO;
void main(){
  // The sun shadow map covers a bounded square around the walker, so a tree two
  // kilometres away cannot possibly cast into it — yet every instance in the
  // valley was being transformed, swayed and rasterised into it every other
  // frame.  The depth material sets uCullR; the beauty material leaves it 0.
  if(uCullR > 0.0 && distance(iPos.xz, uShadowC) > uCullR){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
  }
  float sc = iPos.w;
  float rot = iVar.x, ph = iVar.z;
  float c = cos(rot), s = sin(rot);
  vec3 lp  = position * sc;
  vec3 ln  = nrm;
  vec3 lc  = clm * sc;
  vec3 rp  = vec3(lp.x*c - lp.z*s, lp.y, lp.x*s + lp.z*c);
  vec3 rn  = vec3(ln.x*c - ln.z*s, ln.y, ln.x*s + ln.z*c);
  vec3 rc  = vec3(lc.x*c - lc.z*s, lc.y, lc.x*s + lc.z*c);
  float H  = uTreeH * sc;

  vec4 W = windSample(iPos.xz);
  float prof = windProfile(max(H*0.62, 0.6));
  vec2 wv = W.rg * prof;
  float gust = W.b, exc = W.a;
  float spd = length(wv);

  vec2 bd = normalize(wv + vec2(1e-5));
  float yn = clamp(rp.y / max(H, 0.5), 0.0, 1.4);

  // trunk: static bend + a resonant mode near 0.5 Hz, mass-lagged behind grass
  float f0  = 0.40 + 0.26*fract(ph*0.31831);
  float osc = sin(uTime*6.2831853*f0 + ph);
  float bend = (spd*0.052 + (exc*0.30 + max(gust-1.0,0.0)*0.55)*0.16*osc) * uFlex;
  bend = clamp(bend, -0.55, 0.75);
  vec3 p = rp;
  p.xz += bd * (bend * yn*yn * H * 0.42);
  p.y  -= bend*bend * yn*yn * H * 0.22;

  // clumps: a faster secondary sway, each with its own phase
  float cph = dot(rc.xz, vec2(0.61, 0.43)) + ph*2.7;
  float f1  = 0.70 + 0.42*fract(sin(cph)*137.51);
  float csw = sin(uTime*6.2831853*f1 + cph);
  vec3  cOff = vec3(bd.x, 0.15*csw, bd.y) * csw * (0.06 + 0.34*gust) * 0.34 * flx * sc;
  p += cOff;

  // leaves flutter around their clump centre
  vec3 rel = rp - rc;
  float rl = length(rel) + 1e-4;
  float flut = sin(uTime*5.1 + dot(rel, vec3(3.3,4.9,2.7)) + cph*1.7);
  p += (rel/rl) * flut * 0.045 * flx * sc * (0.35 + 0.8*gust);

  vec3 wp = iPos.xyz + p;
  vW = wp; vN = normalize(rn); vHue = fract(hue + iVar.y);
  vLeaf = step(0.9, flx); vY = clamp(rp.y/max(H,0.5), 0.0, 1.0);
  vAO = mix(0.62, 1.0, smoothstep(0.0, 0.55, vY));
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

export const TREE_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
uniform vec2 uMeanWind;
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_TERRAIN}
${GL_CLOUDFIELD}${GL_SHADOW}${GL_LIGHT}${GL_AIR}
in vec3 vW; in vec3 vN; in float vHue; in float vLeaf; in float vDist;
in float vY; in float vAO;
out vec4 outColor;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vW);
  vec3 lit, mid, shd; float trans, rim;

  if(vLeaf > 0.5){
    // four-green canopy mosaic
    vec3 base = vHue<0.26 ? ${C.cVarA} : (vHue<0.52 ? ${C.cLit} :
                (vHue<0.76 ? ${C.cVarB} : ${C.cVarC}));
    float grain = pn2(vW.xz*0.85 + vW.y*0.6)*0.5+0.5;
    lit = mix(base, ${C.cLit}, 0.42) * (1.02 + 0.24*grain);
    mid = mix(${C.cMid}, base*0.72, 0.45);
    shd = mix(${C.cShade}, ${C.cDeep}, grain*0.45);
    trans = 1.05; rim = 0.52;
  } else {
    float bark = pn2(vec2(atan(N.z,N.x)*3.4, vW.y*3.1))*0.5+0.5;
    lit = ${C.trunkLit} * (0.82 + 0.34*bark);
    mid = mix(${C.trunkLit}, ${C.trunkShade}, 0.55);
    shd = ${C.trunkShade} * (0.85 + 0.3*bark);
    trans = 0.0; rim = 0.28;
  }
  // moss on the shaded north side of trunks and the underside of clumps
  float moss = smoothstep(0.15, -0.5, N.y) * (pn2(vW.xz*1.6 + vW.y)*0.5+0.5);
  shd = mix(shd, ${C.moss}*0.55, moss*0.35*(1.0-vLeaf));

  float ndl = dot(N, uSunDir);
  float sh = sunShadow(vW, ndl) * cloudShadow(vW);
  Surf s;
  s.N=N; s.V=V; s.P=vW; s.shade=shd; s.mid=mid; s.lit=lit;
  s.soft = mix(0.09, 0.20, clamp(vDist*0.004,0.0,1.0));
  s.jit = (vn2(vW.xz*3.9 + vW.y*1.7) - 0.5)*0.055;
  s.shadow = sh; s.trans = trans; s.transCol = ${C.cTrans};
  s.rim = rim; s.ao = vAO; s.ambient = 1.0;
  vec3 col = paint(s);
  col = aerial(col, vDist, V, vW.y);
  outColor = vec4(SAFE3(col), gFogAmt);
}`;

/*──────────────── placement: woods, hedgerows, and one hero tree ──────────*/
export function scatterTrees(){
  const groups = {};           // key `${kind}_${detail}` -> array of instances
  const add=(kind,detail,x,z,scale,rot,hue,phase)=>{
    const k=kind+'_'+detail; (groups[k] = groups[k]||[]).push({x,z,scale,rot,hue,phase,kind,detail});
  };
  const r = rng(31337);
  const cx = CFG.spawn.x, cz = CFG.spawn.z;
  const detailFor = d => d<150 ? 2 : (d<520 ? 1 : 0);

  // hero tree on the ridge shoulder, framing the right of the opening shot
  add('broadleaf', 2, -80.5, 79.0, 1.26, 0.7, 0.15, 1.3);
  add('broadleaf', 2, -104, 54, 0.92, 2.4, 0.55, 3.1);
  add('broadleaf', 2, -14, 126, 0.98, 4.1, 0.35, 5.2);
  add('pine',      2, -96, 108, 0.85, 1.1, 0.62, 2.2);

  // riverside willows
  for(let i=0;i<70;i++){
    const t = 0.10 + r()*0.80;
    const pi = clamp(Math.round(t*(RIVER_PTS.length-1)),1,RIVER_PTS.length-2);
    const p = RIVER_PTS[pi];
    const pm=RIVER_PTS[pi-1], pp=RIVER_PTS[pi+1];
    let tx=pp.x-pm.x, tz=pp.z-pm.z; const L=Math.hypot(tx,tz)||1; tx/=L; tz/=L;
    const sgn = r()<0.5?-1:1;
    const off = riverWidth(p.t) + 4 + r()*16;
    const x = p.x - tz*off*sgn, z = p.z + tx*off*sgn;
    const d = Math.hypot(x-cx, z-cz);
    if(d > 700) continue;
    const rf = riverField(x,z);
    if(rf.d < riverWidth(rf.t)+2) continue;
    add(r()<0.72?'willow':'broadleaf', detailFor(d), x, z, 0.7+r()*0.6, r()*TAU, r(), r()*10);
  }

  // woods: clustered stands on the shoulders, denser away from the meadow
  for(let c=0;c<130;c++){
    const a=r()*TAU, rr=140 + Math.pow(r(),0.55)*900;
    const gx = cx + Math.cos(a)*rr, gz = cz + Math.sin(a)*rr;
    if(Math.abs(gx)>1150 || Math.abs(gz)>1150) continue;
    const n = 4 + (r()*22|0);
    const spread = 18 + r()*46;
    for(let i=0;i<n;i++){
      const x = gx + (r()-0.5)*spread*2, z = gz + (r()-0.5)*spread*2;
      if(Math.abs(x)>1180||Math.abs(z)>1180) continue;
      const nrm = sampleNormal(x,z,4);
      if(nrm.y < 0.72) continue;
      const rf = riverField(x,z);
      const h = sampleHeight(x,z);
      if(h < waterLevel(rf.t)+2.6) continue;
      if(Math.hypot(x-VILLAGE.x, z-VILLAGE.z) < VILLAGE.r*0.75) continue;
      if(Math.hypot(x-BRIDGE.x, z-BRIDGE.z) < 60) continue;
      if(pathDistance(x,z) < 6) continue;
      const d = Math.hypot(x-cx, z-cz);
      if(d < 26) continue;
      const kind = r()<0.34 ? 'pine' : (r()<0.22 ? 'poplar' : 'broadleaf');
      add(kind, detailFor(d), x, z, 0.62+r()*0.72, r()*TAU, r(), r()*10);
    }
  }
  // hedgerow / field-boundary trees near the village
  for(let i=0;i<130;i++){
    const a=r()*TAU, rr=60+Math.pow(r(),0.7)*260;
    const x=VILLAGE.x+Math.cos(a)*rr, z=VILLAGE.z+Math.sin(a)*rr;
    const nrm=sampleNormal(x,z,4);
    if(nrm.y<0.80) continue;
    const rf=riverField(x,z);
    if(sampleHeight(x,z) < waterLevel(rf.t)+3) continue;
    const d=Math.hypot(x-cx,z-cz);
    add(r()<0.3?'poplar':'broadleaf', detailFor(d), x, z, 0.55+r()*0.5, r()*TAU, r(), r()*10);
  }
  return groups;
}
