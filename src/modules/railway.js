import * as THREE from 'three';
import { GL_AIR, GL_CLOUDFIELD, GL_HASH, GL_LIGHT, GL_NOISE, GL_PAL, GL_SHADOW, GL_TERRAIN, GL_UNI } from './glsl.js';
import { TAU, clamp, lerp, smootherstep, smoothstep } from './math.js';
import { C, LIN, P } from './palette.js';
import { BRIDGE, catmull, terrainAt } from './terrain.js';
import { BR } from './viaduct.js';
import { makeDF } from './field.js';
import { TRACK, setTrack } from './track-ref.js';

/*──────────────────────────── §9b  THE RAILWAY ─────────────────────────────*/
/* The track is graded like a real railway: the raw ground profile is smoothed
   and then iteratively clamped to a maximum gradient of 2.5%, so the line
   cuts through the shoulders and rides an embankment across the flats.       */

export function trackAdjust(x, z, h){
  if(!TRACK) return h;
  const f = TRACK.field(x,z);
  if(f.d > 34) return h;
  const y = TRACK.yAt(f.t);
  const target = y - 0.85;
  const rise = target - h;              // + = embankment, - = cutting
  // A railway can raise the ground about seven metres on an embankment and
  // sink about fifteen into a cutting.  Beyond that the line is on a VIADUCT,
  // and the valley underneath has to stay open — otherwise the earthworks
  // swallow the arches.
  const limit = rise > 0 ? (1 - smootherstep(5.0, 9.5, rise))
                         : (1 - smootherstep(11.0, 18.0, -rise));
  if(limit <= 0.001) return h;
  const w = smootherstep(34, 9, f.d) * limit;
  return lerp(h, target, w*0.92);
}

export function buildTrack(){
  const bAlong = BR.ax, bPerp = BR.pp;
  const B = [BRIDGE.x, BRIDGE.z];
  const P = (a,c)=>[B[0] + bAlong[0]*a + bPerp[0]*(c||0), B[1] + bAlong[1]*a + bPerp[1]*(c||0)];
  const CTRL = [
    [B[0]-bAlong[0]*1150 + 240, B[1]-bAlong[1]*1150 + 90],
    [B[0]-bAlong[0]*760  + 120, B[1]-bAlong[1]*760  + 40],
    [B[0]-bAlong[0]*420  + 26,  B[1]-bAlong[1]*420  + 8],
    P(-150), P(-72), P(0), P(72), P(150),
    [B[0]+bAlong[0]*300 + 40,  B[1]+bAlong[1]*300 - 70],
    [B[0]+bAlong[0]*560 + 165, B[1]+bAlong[1]*560 - 200],
    [B[0]+bAlong[0]*900 + 400, B[1]+bAlong[1]*900 - 400],
  ];
  const N = 1400, pts=[]; let acc=0;
  for(let i=0;i<=N;i++){
    const p = catmull(CTRL, i/N);
    if(i>0) acc += Math.hypot(p[0]-pts[i-1].x, p[1]-pts[i-1].z);
    pts.push({x:p[0], z:p[1], s:acc, y:0});
  }
  const total = acc;
  pts.forEach(p=>p.t = p.s/total);

  // raw ground, then a railway engineer's grading pass
  for(const p of pts) p.y = terrainAt(p.x, p.z) + 0.9;
  for(let pass=0; pass<7; pass++){
    const src = pts.map(p=>p.y);
    for(let i=0;i<pts.length;i++){
      let s=0,n=0;
      for(let k=-26;k<=26;k++){ const j=clamp(i+k,0,pts.length-1); s+=src[j]; n++; }
      pts[i].y = s/n;
    }
  }
  // hard-set the bridge deck, then blend the approaches
  const sB = total*0.5;
  let iB = 0, best=1e9;
  for(let i=0;i<pts.length;i++){ const d=Math.hypot(pts[i].x-B[0], pts[i].z-B[1]); if(d<best){best=d;iB=i;} }
  const sMid = pts[iB].s;
  for(const p of pts){
    const da = Math.abs(p.s - sMid);
    if(da < 80) p.y = BR.deck;
    else if(da < 260) p.y = lerp(BR.deck, p.y, smootherstep(80, 260, da));
  }
  // enforce a maximum gradient
  const ds = total/N;
  for(let pass=0; pass<70; pass++){
    for(let i=1;i<pts.length;i++){
      const dy = pts[i].y - pts[i-1].y, mx = 0.025*ds;
      if(Math.abs(dy) > mx){ const ex=(Math.abs(dy)-mx)*Math.sign(dy)*0.5; pts[i].y-=ex; pts[i-1].y+=ex; }
    }
    for(const p of pts){ const da=Math.abs(p.s-sMid); if(da<80) p.y=BR.deck; }
  }
  const field = makeDF(pts, 384);
  const yAt = (t)=>{ const i=clamp(Math.round(t*N),0,N); return pts[i].y; };
  setTrack({ pts, total, field, yAt, iB, sMid, N });
  return TRACK;
}
export function trackPose(s){                        // world position + tangent at arc length s
  const T = TRACK;
  const u = clamp(s/T.total, 0, 1);
  const fi = u*T.N, i = clamp(Math.floor(fi), 0, T.N-1), f = fi-i;
  const a=T.pts[i], b=T.pts[i+1];
  const x=lerp(a.x,b.x,f), z=lerp(a.z,b.z,f), y=lerp(a.y,b.y,f);
  const i0=clamp(i-4,0,T.N), i1=clamp(i+4,0,T.N);
  let tx=T.pts[i1].x-T.pts[i0].x, tz=T.pts[i1].z-T.pts[i0].z, ty=T.pts[i1].y-T.pts[i0].y;
  const L=Math.hypot(tx,tz,ty)||1;
  return { x,y,z, tx:tx/L, ty:ty/L, tz:tz/L };
}

/*  Ballast, sleepers and bullhead rail, for the WHOLE length of the line.
    It used to be built for a ±540 m window around the viaduct, which meant the
    train ran on nothing at all for most of its journey and the line simply
    vanished into the hills — the "missing track".  The full run is ~2.3 km and
    still only ~170k vertices, one draw call, so there was never a reason to
    truncate it.  The rail is a real section — foot, web and head — rather than
    a ribbon, so it catches the low sun along its top face and reads as steel
    from the far bank.                                                        */
export function buildPermanentWay(){
  const pos=[], nrm=[], col=[], idx=[]; let n=0;
  const V=(x,y,z,nx,ny,nz,c)=>{pos.push(x,y,z);nrm.push(nx,ny,nz);col.push(c);return n++;};
  const quad=(a,b,c,d)=>{idx.push(a,b,c,a,c,d);};
  const T=TRACK, GA=1.435/2;
  const s0 = 2, s1 = T.total - 2;
  const step = 1.2;
  // rail section, as (lateral offset from the rail centreline, height): foot,
  // web, head — traced up one side, over the top and down the other
  const SECT = [
    [ 0.085, 0.02], [ 0.085, 0.055], [ 0.030, 0.075], [ 0.030, 0.155],
    [ 0.072, 0.175], [ 0.072, 0.215], [-0.072, 0.215], [-0.072, 0.175],
    [-0.030, 0.155], [-0.030, 0.075], [-0.085, 0.055], [-0.085, 0.02],
  ];
  const shadeOf = (i)=> (SECT[i][1] > 0.20 ? 2.35 : (SECT[i][1] > 0.10 ? 1.15 : 0.85));
  let prev = null;
  for(let s=s0; s<=s1; s+=step){
    const p = trackPose(s);
    const px=-p.tz, pz=p.tx;
    const cur = {p, px, pz};
    if(prev){
      for(const side of [-1,1]){
        const o = side*GA;
        for(let i=0;i<SECT.length-1;i++){
          const A=SECT[i], B=SECT[i+1];
          // face normal: perpendicular to the section edge, in the sleeper plane
          let ex=-(B[1]-A[1]), ey=(B[0]-A[0]);
          const el=Math.hypot(ex,ey)||1; ex/=el; ey/=el;
          const nA=[prev.px*ex, ey, prev.pz*ex], nB=[cur.px*ex, ey, cur.pz*ex];
          const shd = (shadeOf(i)+shadeOf(i+1))*0.5;
          const pA=[prev.p.x+prev.px*(o+A[0]), prev.p.y+A[1], prev.p.z+prev.pz*(o+A[0])];
          const pB=[prev.p.x+prev.px*(o+B[0]), prev.p.y+B[1], prev.p.z+prev.pz*(o+B[0])];
          const qA=[cur.p.x +cur.px *(o+A[0]), cur.p.y +A[1], cur.p.z +cur.pz *(o+A[0])];
          const qB=[cur.p.x +cur.px *(o+B[0]), cur.p.y +B[1], cur.p.z +cur.pz *(o+B[0])];
          quad(V(pA[0],pA[1],pA[2],nA[0],nA[1],nA[2],shd),
               V(qA[0],qA[1],qA[2],nB[0],nB[1],nB[2],shd),
               V(qB[0],qB[1],qB[2],nB[0],nB[1],nB[2],shd),
               V(pB[0],pB[1],pB[2],nA[0],nA[1],nA[2],shd));
        }
      }
      // ballast prism: 1:2 shoulders down to the formation
      const w0=2.75, w1=1.75;
      const A=[prev.p.x+prev.px*-w0, prev.p.y-0.52, prev.p.z+prev.pz*-w0];
      const Bv=[cur.p.x+cur.px*-w0, cur.p.y-0.52, cur.p.z+cur.pz*-w0];
      const Cv=[cur.p.x+cur.px*-w1, cur.p.y+0.02, cur.p.z+cur.pz*-w1];
      const D=[prev.p.x+prev.px*-w1, prev.p.y+0.02, prev.p.z+prev.pz*-w1];
      quad(V(A[0],A[1],A[2],0,1,0,0.70),V(Bv[0],Bv[1],Bv[2],0,1,0,0.70),
           V(Cv[0],Cv[1],Cv[2],0,1,0,0.88),V(D[0],D[1],D[2],0,1,0,0.88));
      const A2=[prev.p.x+prev.px*w1, prev.p.y+0.02, prev.p.z+prev.pz*w1];
      const B2=[cur.p.x+cur.px*w1, cur.p.y+0.02, cur.p.z+cur.pz*w1];
      const C2=[cur.p.x+cur.px*w0, cur.p.y-0.52, cur.p.z+cur.pz*w0];
      const D2=[prev.p.x+prev.px*w0, prev.p.y-0.52, prev.p.z+prev.pz*w0];
      quad(V(A2[0],A2[1],A2[2],0,1,0,0.88),V(B2[0],B2[1],B2[2],0,1,0,0.88),
           V(C2[0],C2[1],C2[2],0,1,0,0.70),V(D2[0],D2[1],D2[2],0,1,0,0.70));
      quad(V(D[0],D[1],D[2],0,1,0,0.95),V(Cv[0],Cv[1],Cv[2],0,1,0,0.95),
           V(B2[0],B2[1],B2[2],0,1,0,0.95),V(A2[0],A2[1],A2[2],0,1,0,0.95));
    }
    prev = cur;
  }
  // sleepers
  for(let s=s0; s<=s1; s+=0.78){
    const p=trackPose(s); const px=-p.tz, pz=p.tx;
    const hw=1.32, hl=0.14, hh=0.095;
    const c0=[p.x, p.y+0.02, p.z];
    const ex=[px*hw, 0, pz*hw], ey=[0,hh,0], ez=[p.tx*hl, 0, p.tz*hl];
    const V8=[];
    for(let i=0;i<8;i++){
      const sx=(i&1)?1:-1, sy=(i&2)?1:-1, sz=(i&4)?1:-1;
      V8.push([c0[0]+ex[0]*sx+ez[0]*sz, c0[1]+ey[1]*sy, c0[2]+ex[2]*sx+ez[2]*sz]);
    }
    const F=[[0,1,3,2],[4,6,7,5],[0,2,6,4],[1,5,7,3],[2,3,7,6],[0,4,5,1]];
    const NR=[[0,-1,0],[0,1,0],[-px,0,-pz],[px,0,pz],[p.tx,0,p.tz],[-p.tx,0,-p.tz]];
    // creosoted timber weathers unevenly
    const sh = 0.40 + 0.22*(0.5 + 0.5*Math.sin(s*11.7));
    for(let f=0;f<6;f++){
      const q=F[f], nn=NR[f];
      quad(V(V8[q[0]][0],V8[q[0]][1],V8[q[0]][2],nn[0],nn[1],nn[2],sh),
           V(V8[q[1]][0],V8[q[1]][1],V8[q[1]][2],nn[0],nn[1],nn[2],sh),
           V(V8[q[2]][0],V8[q[2]][1],V8[q[2]][2],nn[0],nn[1],nn[2],sh),
           V(V8[q[3]][0],V8[q[3]][1],V8[q[3]][2],nn[0],nn[1],nn[2],sh));
    }
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(pos),3));
  g.setAttribute('nrm',new THREE.BufferAttribute(new Float32Array(nrm),3));
  g.setAttribute('shade',new THREE.BufferAttribute(new Float32Array(col),1));
  g.setIndex(idx); g.computeBoundingSphere();
  return g;
}

/*──────────────────── stone: one instanced, individually worn block ────────*/
export function roundedBoxGeometry(round){
  const pos=[], nrm=[], idx=[]; let n=0;
  const faces=[
    {n:[ 1,0,0], u:[0,0,-1], v:[0,1,0]}, {n:[-1,0,0], u:[0,0, 1], v:[0,1,0]},
    {n:[0, 1,0], u:[1,0, 0], v:[0,0,1]}, {n:[0,-1,0], u:[1,0, 0], v:[0,0,-1]},
    {n:[0,0, 1], u:[1,0, 0], v:[0,1,0]}, {n:[0,0,-1], u:[-1,0,0], v:[0,1,0]},
  ];
  const S=2;
  for(const f of faces){
    const base=n;
    for(let j=0;j<=S;j++) for(let i=0;i<=S;i++){
      const a=i/S*2-1, b=j/S*2-1;
      let p=[f.n[0]+f.u[0]*a+f.v[0]*b, f.n[1]+f.u[1]*a+f.v[1]*b, f.n[2]+f.u[2]*a+f.v[2]*b];
      // pull the corners in for a chamfered block that catches the light
      const k=1.0-round;
      const len=Math.hypot(p[0],p[1],p[2]);
      const q=[p[0]*k + p[0]/len*round, p[1]*k + p[1]/len*round, p[2]*k + p[2]/len*round];
      const edge = Math.max(Math.abs(a),Math.abs(b));
      const nn = edge>0.9 ? [ (f.n[0]+q[0]*0.55), (f.n[1]+q[1]*0.55), (f.n[2]+q[2]*0.55) ] : f.n.slice();
      const nl=Math.hypot(nn[0],nn[1],nn[2])||1;
      pos.push(q[0],q[1],q[2]); nrm.push(nn[0]/nl,nn[1]/nl,nn[2]/nl); n++;
    }
    for(let j=0;j<S;j++) for(let i=0;i<S;i++){
      const a=base+j*(S+1)+i, b=a+1, c=a+S+1, d=c+1;
      idx.push(a,c,b, b,c,d);
    }
  }
  const g=new THREE.InstancedBufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(pos),3));
  g.setAttribute('nrm',new THREE.BufferAttribute(new Float32Array(nrm),3));
  g.setIndex(idx);
  return g;
}

export const STONE_VS = ()=> /* glsl */`
${GL_UNI}
uniform vec2 uAx; uniform vec2 uPp;
${GL_HASH}${GL_NOISE}
in vec3 nrm;
in vec4 sA;   // pos.xyz, seed
in vec4 sB;   // size.xyz, pitch
out vec3 vW; out vec3 vN; out float vSeed; out float vDist; out vec3 vL;
void main(){
  float seed = sA.w;
  vec3 l = position * sB.xyz;
  // every stone is worn to its own shape
  vec3 wob = (hash33(position*2.3 + seed*3.77) - 0.5);
  l += wob * min(min(sB.x,sB.y),sB.z) * 0.30;
  vec3 nl = normalize(nrm + wob*0.55);
  float cp=cos(sB.w), sp=sin(sB.w);
  vec3 b  = vec3(l.x*cp - l.y*sp, l.x*sp + l.y*cp, l.z);
  vec3 bn = vec3(nl.x*cp - nl.y*sp, nl.x*sp + nl.y*cp, nl.z);
  vec3 wp = sA.xyz + vec3(uAx.x*b.x + uPp.x*b.z, b.y, uAx.y*b.x + uPp.y*b.z);
  vN = normalize(vec3(uAx.x*bn.x + uPp.x*bn.z, bn.y, uAx.y*bn.x + uPp.y*bn.z));
  vW = wp; vSeed = seed; vL = position;
  vec4 mv = viewMatrix*vec4(wp,1.0); vDist=-mv.z;
  gl_Position = projectionMatrix*mv;
}`;

export const STONE_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_TERRAIN}
${GL_CLOUDFIELD}${GL_SHADOW}${GL_LIGHT}${GL_AIR}
in vec3 vW; in vec3 vN; in float vSeed; in float vDist; in vec3 vL;
out vec4 outColor;
void main(){
  vec3 N=normalize(vN), V=normalize(uCamPos-vW);
  float k=fract(vSeed*0.61803);
  vec3 base = k<0.25 ? ${C.sA} : (k<0.5 ? ${C.sB} : (k<0.75 ? ${C.sC} : ${C.sD}));
  float grain = pn2(vW.xz*7.0 + vW.y*5.0)*0.5+0.5;
  float grain2 = pn2(vW.xz*23.0 - vW.y*11.0)*0.5+0.5;
  base *= 0.88 + 0.26*grain + 0.08*grain2;
  vec3 lit=base, mid=mix(base,${C.sShade},0.55), shd=mix(${C.sShade},${C.sDeep},0.5);

  // lichen on the light, moss where water runs and on the shaded faces
  float lich = smoothstep(0.55,0.92, pn2(vW.xz*2.1+vW.y*1.7)*0.5+0.5 + N.y*0.22);
  lit = mix(lit, ${C.lichen}, lich*0.42); mid = mix(mid, ${C.lichen}*0.7, lich*0.3);
  float damp = smoothstep(${(BR.water+7).toFixed(1)}, ${(BR.water-1).toFixed(1)}, vW.y);
  float mossN = pn2(vW.xz*1.3 + vW.y*0.9)*0.5+0.5;
  float moss = clamp(damp*0.85 + smoothstep(0.1,-0.55,N.y)*0.55*mossN, 0.0, 1.0)*mossN;
  lit = mix(lit, ${C.moss}, moss*0.60); mid = mix(mid, ${C.moss}*0.6, moss*0.55);
  shd = mix(shd, ${C.cDeep}, moss*0.5);

  float ndl=dot(N,uSunDir);
  float sh = sunShadow(vW,ndl)*cloudShadow(vW);
  Surf s; s.N=N; s.V=V; s.P=vW; s.shade=shd; s.mid=mid; s.lit=lit;
  s.soft=0.10; s.shadow=sh; s.trans=0.0; s.transCol=vec3(0.0);
  s.jit = (vn2(vW.xz*3.9 + vW.y*1.7) - 0.5)*0.055;
  s.rim=0.30; s.ao=mix(0.80,1.0,smoothstep(0.0,0.75,length(vL.xy))); s.ambient=1.0;
  vec3 col=paint(s);
  col = aerial(col, vDist, V, vW.y);
  outColor = vec4(SAFE3(col), gFogAmt);
}`;

/* the mortar core behind the stones, and every other plain shaded solid */
export const SOLID_VS = ()=> /* glsl */`
${GL_UNI}
in vec3 nrm; in float shade;
out vec3 vW; out vec3 vN; out float vS; out float vDist;
void main(){
  vec4 wp = modelMatrix * vec4(position,1.0);
  vW = wp.xyz; vN = normalize(mat3(modelMatrix)*nrm); vS = shade;
  vec4 mv = viewMatrix*wp; vDist=-mv.z;
  gl_Position = projectionMatrix*mv;
}`;
export const SOLID_FS = (litC, midC, shdC, extra)=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_TERRAIN}
${GL_CLOUDFIELD}${GL_SHADOW}${GL_LIGHT}${GL_AIR}
in vec3 vW; in vec3 vN; in float vS; in float vDist;
out vec4 outColor;
void main(){
  vec3 N=normalize(vN), V=normalize(uCamPos-vW);
  vec3 lit=${litC}, mid=${midC}, shd=${shdC};
  ${extra||''}
  float g = pn2(vW.xz*3.1+vW.y*2.3)*0.5+0.5;
  lit *= 0.90+0.20*g; mid *= 0.90+0.20*g;
  lit *= vS; mid *= mix(1.0, vS, 0.6);
  float ndl=dot(N,uSunDir);
  float sh=sunShadow(vW,ndl)*cloudShadow(vW);
  Surf s; s.N=N; s.V=V; s.P=vW; s.shade=shd; s.mid=mid; s.lit=lit;
  s.soft=0.10; s.jit=(vn2(vW.xz*3.9 + vW.y*1.7)-0.5)*0.055;
  s.shadow=sh; s.trans=0.0; s.transCol=vec3(0.0);
  s.rim=0.25; s.ao=1.0; s.ambient=1.0;
  vec3 col=paint(s);
  col=aerial(col,vDist,V,vW.y);
  outColor = vec4(SAFE3(col), gFogAmt);
}`;


/*────────────── a small mesh toolkit for everything hand-modelled ──────────*/
export const LC = k => [LIN[k].r, LIN[k].g, LIN[k].b];
export const tint = (c,f)=>[c[0]*f, c[1]*f, c[2]*f];
export const mixc = (a,b,t)=>[lerp(a[0],b[0],t), lerp(a[1],b[1],t), lerp(a[2],b[2],t)];

export function PB(){ return {pos:[],nrm:[],col:[],mat:[],idx:[],n:0}; }
export function pv(M,x,y,z,nx,ny,nz,c,m){
  M.pos.push(x,y,z); M.nrm.push(nx,ny,nz); M.col.push(c[0],c[1],c[2]); M.mat.push(m||0);
  return M.n++;
}
export function pq(M,a,b,c,d){ M.idx.push(a,b,c, a,c,d); }
function pt3(M,a,b,c){ M.idx.push(a,b,c); }
export function rotY(x,z,ca,sa){ return [x*ca - z*sa, x*sa + z*ca]; }

export function pbox(M, cx,cy,cz, hx,hy,hz, yaw, col, mat){
  const ca=Math.cos(yaw), sa=Math.sin(yaw);
  const P=(sx,sy,sz)=>{ const [x,z]=rotY(sx*hx, sz*hz, ca,sa); return [cx+x, cy+sy*hy, cz+z]; };
  const NF=(nx,nz)=>{ const [x,z]=rotY(nx,nz,ca,sa); return [x,0,z]; };
  const faces=[
    {q:[[ 1,-1,-1],[ 1,-1, 1],[ 1, 1, 1],[ 1, 1,-1]], n:NF(1,0)},
    {q:[[-1,-1, 1],[-1,-1,-1],[-1, 1,-1],[-1, 1, 1]], n:NF(-1,0)},
    {q:[[-1, 1,-1],[ 1, 1,-1],[ 1, 1, 1],[-1, 1, 1]], n:[0,1,0]},
    {q:[[-1,-1, 1],[ 1,-1, 1],[ 1,-1,-1],[-1,-1,-1]], n:[0,-1,0]},
    {q:[[-1,-1, 1],[-1, 1, 1],[ 1, 1, 1],[ 1,-1, 1]], n:NF(0,1)},
    {q:[[ 1,-1,-1],[ 1, 1,-1],[-1, 1,-1],[-1,-1,-1]], n:NF(0,-1)},
  ];
  for(const f of faces){
    const v=f.q.map(s=>{ const p=P(s[0],s[1],s[2]); return pv(M,p[0],p[1],p[2],f.n[0],f.n[1],f.n[2],col,mat); });
    pq(M,v[0],v[1],v[2],v[3]);
  }
}

export function pcyl(M, a, b, r0, r1, seg, col, mat, capA, capB){
  let t=[b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const L=Math.hypot(t[0],t[1],t[2])||1; t=[t[0]/L,t[1]/L,t[2]/L];
  let up=[0,1,0]; if(Math.abs(t[1])>0.94) up=[1,0,0];
  let s=[t[1]*up[2]-t[2]*up[1], t[2]*up[0]-t[0]*up[2], t[0]*up[1]-t[1]*up[0]];
  const sl=Math.hypot(s[0],s[1],s[2])||1; s=[s[0]/sl,s[1]/sl,s[2]/sl];
  const u=[t[1]*s[2]-t[2]*s[1], t[2]*s[0]-t[0]*s[2], t[0]*s[1]-t[1]*s[0]];
  const r0i=[], r1i=[];
  for(let i=0;i<seg;i++){
    const ang=i/seg*TAU, ca=Math.cos(ang), sa=Math.sin(ang);
    const nx=s[0]*ca+u[0]*sa, ny=s[1]*ca+u[1]*sa, nz=s[2]*ca+u[2]*sa;
    r0i.push(pv(M, a[0]+nx*r0, a[1]+ny*r0, a[2]+nz*r0, nx,ny,nz, col, mat));
    r1i.push(pv(M, b[0]+nx*r1, b[1]+ny*r1, b[2]+nz*r1, nx,ny,nz, col, mat));
  }
  for(let i=0;i<seg;i++){ const j=(i+1)%seg; pq(M, r0i[i], r1i[i], r1i[j], r0i[j]); }
  if(capB){ const c=pv(M,b[0],b[1],b[2],t[0],t[1],t[2],col,mat);
    for(let i=0;i<seg;i++){ const j=(i+1)%seg;
      const p1=pv(M, M.pos[r1i[i]*3],M.pos[r1i[i]*3+1],M.pos[r1i[i]*3+2],t[0],t[1],t[2],col,mat);
      const p2=pv(M, M.pos[r1i[j]*3],M.pos[r1i[j]*3+1],M.pos[r1i[j]*3+2],t[0],t[1],t[2],col,mat);
      pt3(M,c,p1,p2); } }
  if(capA){ const c=pv(M,a[0],a[1],a[2],-t[0],-t[1],-t[2],col,mat);
    for(let i=0;i<seg;i++){ const j=(i+1)%seg;
      const p1=pv(M, M.pos[r0i[i]*3],M.pos[r0i[i]*3+1],M.pos[r0i[i]*3+2],-t[0],-t[1],-t[2],col,mat);
      const p2=pv(M, M.pos[r0i[j]*3],M.pos[r0i[j]*3+1],M.pos[r0i[j]*3+2],-t[0],-t[1],-t[2],col,mat);
      pt3(M,c,p2,p1); } }
}

// gabled roof with an overhang; ridge runs along local X
export function proof(M, cx,cy,cz, hx,hz,hh, yaw, col, mat){
  const ca=Math.cos(yaw), sa=Math.sin(yaw);
  const P=(x,y,z)=>{ const [rx,rz]=rotY(x,z,ca,sa); return [cx+rx, cy+y, cz+rz]; };
  const A=P(-hx,0,-hz), B=P(hx,0,-hz), Cc=P(hx,0,hz), D=P(-hx,0,hz);
  const E=P(-hx,hh,0), F=P(hx,hh,0);
  const nA=(()=>{ const n=[0,hz,-hh]; const l=Math.hypot(n[1],n[2]); const [x,z]=rotY(0,n[2]/l,ca,sa); return [x, n[1]/l, z]; })();
  const nB=(()=>{ const n=[0,hz, hh]; const l=Math.hypot(n[1],n[2]); const [x,z]=rotY(0,n[2]/l,ca,sa); return [x, n[1]/l, z]; })();
  let v=[A,B,F,E].map(p=>pv(M,p[0],p[1],p[2],nA[0],nA[1],nA[2],col,mat)); pq(M,v[0],v[1],v[2],v[3]);
  v=[D,E,F,Cc].map(p=>pv(M,p[0],p[1],p[2],nB[0],nB[1],nB[2],col,mat)); pq(M,v[0],v[1],v[2],v[3]);
  const nE=(()=>{const [x,z]=rotY(-1,0,ca,sa); return [x,0,z];})();
  const nF=(()=>{const [x,z]=rotY( 1,0,ca,sa); return [x,0,z];})();
  let t=[A,E,D].map(p=>pv(M,p[0],p[1],p[2],nE[0],nE[1],nE[2],col,mat)); pt3(M,t[0],t[1],t[2]);
  t=[B,Cc,F].map(p=>pv(M,p[0],p[1],p[2],nF[0],nF[1],nF[2],col,mat)); pt3(M,t[0],t[1],t[2]);
}

export function finishPainted(M){
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(M.pos),3));
  g.setAttribute('nrm',new THREE.BufferAttribute(new Float32Array(M.nrm),3));
  g.setAttribute('vcol',new THREE.BufferAttribute(new Float32Array(M.col),3));
  g.setAttribute('vmat',new THREE.BufferAttribute(new Float32Array(M.mat),1));
  g.setIndex(M.idx); g.computeBoundingSphere();
  return g;
}

export const PAINTED_VS = ()=> /* glsl */`
${GL_UNI}
in vec3 nrm; in vec3 vcol; in float vmat;
out vec3 vW; out vec3 vN; out vec3 vC; out float vM; out float vDist;
void main(){
  vec4 wp = modelMatrix*vec4(position,1.0);
  vW = wp.xyz; vN = normalize(mat3(modelMatrix)*nrm); vC=vcol; vM=vmat;
  vec4 mv = viewMatrix*wp; vDist=-mv.z;
  gl_Position = projectionMatrix*mv;
}`;

export const PAINTED_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_TERRAIN}
${GL_CLOUDFIELD}${GL_SHADOW}${GL_LIGHT}${GL_AIR}
in vec3 vW; in vec3 vN; in vec3 vC; in float vM; in float vDist;
out vec4 outColor;
void main(){
  vec3 N=normalize(vN), V=normalize(uCamPos-vW);
  vec3 base = vC;
  float g = pn2(vW.xz*4.3 + vW.y*3.7)*0.5+0.5;
  float g2 = pn2(vW.xz*17.0 - vW.y*9.0)*0.5+0.5;
  base *= 0.90 + 0.20*g + 0.06*g2;

  // lit / mid / shade travel along a hue path, never a brightness ramp
  vec3 lit = base*1.12;
  vec3 mid = mix(base*0.76, K_AMB_SKY*0.22, 0.16);
  vec3 shd = mix(base*0.40, K_SHADOW*0.60, 0.44);
  float rim = 0.30, ao = 1.0;

  if(vM > 1.5 && vM < 2.5){                 // lit window
    float flick = 0.94 + 0.06*sin(uTime*2.1 + vW.x*3.1 + vW.z*1.7);
    outColor = vec4(SAFE3(base*2.4*flick + K_SUN*0.25), 0.0);
    return;
  }
  if(vM > 0.5 && vM < 1.5){                 // painted metal: crisper bands
    lit = base*1.25; mid = base*0.62;
    shd = mix(base*0.30, K_SHADOW*0.7, 0.5);
    rim = 0.62;
  }
  if(vM > 2.5){                             // glass / dark opening
    lit = mix(base, K_SKY_MID, 0.55); mid = base*0.7; shd = base*0.42; rim=0.75;
  }

  float ndl=dot(N,uSunDir);
  float sh=sunShadow(vW,ndl)*cloudShadow(vW);
  Surf s; s.N=N; s.V=V; s.P=vW; s.shade=shd; s.mid=mid; s.lit=lit;
  s.soft = mix(0.075, 0.19, clamp(vDist*0.004,0.0,1.0));
  s.jit = (vn2(vW.xz*3.9 + vW.y*1.7) - 0.5)*0.055;
  s.shadow=sh; s.trans=0.0; s.transCol=vec3(0.0);
  s.rim=rim; s.ao=ao; s.ambient=1.0;
  vec3 col=paint(s);
  col=aerial(col,vDist,V,vW.y);
  outColor = vec4(SAFE3(col), gFogAmt);
}`;

/*──────────────────── solid world: what you cannot walk through ────────────*/
/*  Every building registers an oriented box as it is modelled, so the collision
    set can never drift out of step with the geometry.                        */
export const SOLIDS = [];
export function pushSolid(x, z, hx, hz, yaw){
  SOLIDS.push({ x, z, hx, hz, ca:Math.cos(yaw), sa:Math.sin(yaw),
                rr: Math.pow(Math.hypot(hx,hz) + 1.4, 2) });
}
