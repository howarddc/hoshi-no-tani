import * as THREE from 'three';
import { HALF, WS } from './config.js';
import { clamp, lerp, rng } from './math.js';
import { BRIDGE, BRIDGE_AXIS, BRIDGE_PERP, riverField, waterLevel } from './terrain.js';

/*────────────────────────── §9  VIADUCT ──────────────────────────*/
/*  Five semicircular arches of jittered voussoirs on battered piers, dressed
    in ~3,000 individually-shaped stones over a solid mortar core.            */

export const BR = (()=>{
  const rf = riverField(BRIDGE.x, BRIDGE.z);
  const water = waterLevel(rf.t);
  return {
    ax: BRIDGE_AXIS, pp: BRIDGE_PERP,
    water,
    deck: water + 26.0,
    spring: water + 8.2,
    span: 19.0, pierW: 5.2, arches: 5, width: 7.6,
    R: 9.5,
  };
})();
BR.total = BR.arches*BR.span + (BR.arches+1)*BR.pierW;

export function brPoint(along, side, y){
  return [ BRIDGE.x + BR.ax[0]*along + BR.pp[0]*side,
           y,
           BRIDGE.z + BR.ax[1]*along + BR.pp[1]*side ];
}
function archCentres(){
  const out=[]; let s = -BR.total/2 + BR.pierW;
  for(let i=0;i<BR.arches;i++){ out.push(s + BR.span/2); s += BR.span + BR.pierW; }
  return out;
}
export function pierCentres(){
  const out=[]; let s = -BR.total/2;
  for(let i=0;i<=BR.arches;i++){ out.push(s + BR.pierW/2); s += BR.pierW + BR.span; }
  return out;
}

/* solid core: arch barrels, spandrels, piers, deck slab */
export function buildBridgeCore(){
  const pos=[], nrm=[], col=[], idx=[];
  let n=0;
  const V=(p,nn,c)=>{ pos.push(p[0],p[1],p[2]); nrm.push(nn[0],nn[1],nn[2]); col.push(c); return n++; };
  const quad=(a,b,c,d)=>{ idx.push(a,b,c, a,c,d); };
  const W = BR.width/2;

  // arches: intrados + spandrel walls on both faces
  for(const ac of archCentres()){
    const N=26;
    for(let i=0;i<N;i++){
      const t0=i/N, t1=(i+1)/N;
      const a0=Math.PI*t0, a1=Math.PI*t1;
      const x0=-Math.cos(a0)*BR.R, y0=Math.sin(a0)*BR.R;
      const x1=-Math.cos(a1)*BR.R, y1=Math.sin(a1)*BR.R;
      // intrados (barrel underside)
      const p00=brPoint(ac+x0,-W,BR.spring+y0), p01=brPoint(ac+x0, W,BR.spring+y0);
      const p10=brPoint(ac+x1,-W,BR.spring+y1), p11=brPoint(ac+x1, W,BR.spring+y1);
      const nA=[-Math.cos(a0)*0+0, -Math.sin(a0), 0];
      const nn=[-(-Math.cos(a0))*0, -1, 0];
      const nx = -( -Math.cos(a0) ), ny = -Math.sin(a0);
      const nw = [BR.ax[0]*nx, ny, BR.ax[1]*nx];
      quad(V(p00,nw,0.4), V(p10,nw,0.4), V(p11,nw,0.4), V(p01,nw,0.4));
      // spandrel faces (both sides), from the arch curve up to the deck
      for(const sgn of [-1,1]){
        const S = sgn*W;
        const nf=[BR.pp[0]*sgn, 0, BR.pp[1]*sgn];
        const b0=brPoint(ac+x0,S,BR.spring+y0), b1=brPoint(ac+x1,S,BR.spring+y1);
        const t0v=brPoint(ac+x0,S,BR.deck-0.6), t1v=brPoint(ac+x1,S,BR.deck-0.6);
        if(sgn>0) quad(V(b0,nf,0.9), V(b1,nf,0.9), V(t1v,nf,0.9), V(t0v,nf,0.9));
        else      quad(V(b1,nf,0.9), V(b0,nf,0.9), V(t0v,nf,0.9), V(t1v,nf,0.9));
      }
    }
  }
  // piers: battered boxes from the ground to the deck
  for(const pc of pierCentres()){
    const baseY = BR.water - 6.0;
    const topY  = BR.deck - 0.6;
    const steps = 5;
    for(let s=0;s<steps;s++){
      const u0=s/steps, u1=(s+1)/steps;
      const y0=lerp(baseY, topY, u0), y1=lerp(baseY, topY, u1);
      const hw0=lerp(BR.pierW*0.72, BR.pierW*0.5, u0), hw1=lerp(BR.pierW*0.72, BR.pierW*0.5, u1);
      const dw0=lerp(W*1.24, W, u0), dw1=lerp(W*1.24, W, u1);
      for(const sgn of [-1,1]){
        const nf=[BR.pp[0]*sgn,0,BR.pp[1]*sgn];
        const a=brPoint(pc-hw0, sgn*dw0, y0), b=brPoint(pc+hw0, sgn*dw0, y0);
        const c=brPoint(pc+hw1, sgn*dw1, y1), d=brPoint(pc-hw1, sgn*dw1, y1);
        if(sgn>0) quad(V(a,nf,0.75),V(b,nf,0.75),V(c,nf,0.75),V(d,nf,0.75));
        else      quad(V(b,nf,0.75),V(a,nf,0.75),V(d,nf,0.75),V(c,nf,0.75));
      }
      for(const sgn of [-1,1]){
        const nf=[BR.ax[0]*sgn,0,BR.ax[1]*sgn];
        const a=brPoint(pc+sgn*hw0, -dw0, y0), b=brPoint(pc+sgn*hw0, dw0, y0);
        const c=brPoint(pc+sgn*hw1,  dw1, y1), d=brPoint(pc+sgn*hw1,-dw1, y1);
        if(sgn>0) quad(V(a,nf,0.7),V(b,nf,0.7),V(c,nf,0.7),V(d,nf,0.7));
        else      quad(V(b,nf,0.7),V(a,nf,0.7),V(d,nf,0.7),V(c,nf,0.7));
      }
    }
  }
  // deck slab + parapets
  const yTop=BR.deck, yU=BR.deck-0.75;
  const L=BR.total/2 + 9;
  const up=[0,1,0];
  quad(V(brPoint(-L,-W,yTop),up,1.0), V(brPoint(L,-W,yTop),up,1.0),
       V(brPoint(L, W,yTop),up,1.0),  V(brPoint(-L, W,yTop),up,1.0));
  for(const sgn of [-1,1]){
    const nf=[BR.pp[0]*sgn,0,BR.pp[1]*sgn];
    const a=brPoint(-L,sgn*W,yU), b=brPoint(L,sgn*W,yU),
          c=brPoint(L,sgn*W,yTop+1.15), d=brPoint(-L,sgn*W,yTop+1.15);
    if(sgn>0) quad(V(a,nf,0.95),V(b,nf,0.95),V(c,nf,0.95),V(d,nf,0.95));
    else      quad(V(b,nf,0.95),V(a,nf,0.95),V(d,nf,0.95),V(c,nf,0.95));
    // parapet inner face + cap
    const iw = (W-0.55)*sgn;
    const nf2=[-BR.pp[0]*sgn,0,-BR.pp[1]*sgn];
    const e=brPoint(-L,iw,yTop), f=brPoint(L,iw,yTop),
          g=brPoint(L,iw,yTop+1.15), h=brPoint(-L,iw,yTop+1.15);
    if(sgn>0) quad(V(f,nf2,0.9),V(e,nf2,0.9),V(h,nf2,0.9),V(g,nf2,0.9));
    else      quad(V(e,nf2,0.9),V(f,nf2,0.9),V(g,nf2,0.9),V(h,nf2,0.9));
    quad(V(brPoint(-L,sgn*W,yTop+1.15),up,1.1), V(brPoint(L,sgn*W,yTop+1.15),up,1.1),
         V(brPoint(L,iw,yTop+1.15),up,1.1),      V(brPoint(-L,iw,yTop+1.15),up,1.1));
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos),3));
  g.setAttribute('nrm',      new THREE.BufferAttribute(new Float32Array(nrm),3));
  g.setAttribute('shade',    new THREE.BufferAttribute(new Float32Array(col),1));
  g.setIndex(idx); g.computeBoundingSphere();
  return g;
}

/* the dressing: individually shaped, individually coloured stones */
export function buildBridgeStones(){
  const r = rng(5150);
  const inst = [];   // pos(3) size(3) rot(3) seed(1)
  const W = BR.width/2;
  const push=(p, sz, yaw, pitch, seed)=>inst.push([p[0],p[1],p[2], sz[0],sz[1],sz[2], yaw, pitch, seed]);
  const yawOf = () => Math.atan2(BR.ax[0], BR.ax[1]);

  // voussoirs: a ring of wedge stones around each arch, spanning the full depth
  for(const ac of archCentres()){
    const N = 23;
    for(let i=0;i<N;i++){
      const a = Math.PI*(i+0.5)/N;
      const rr = BR.R + 0.72;
      const x = -Math.cos(a)*rr, y = Math.sin(a)*rr;
      const p = brPoint(ac+x, 0, BR.spring+y);
      push(p, [Math.PI*BR.R/N*0.47 + r()*0.06, 0.74 + r()*0.10, W*1.02],
           yawOf(), (a - Math.PI/2), r()*100);
    }
  }
  // spandrel courses on both faces
  for(const ac of archCentres()){
    for(let cRow=0;;cRow++){
      const y = BR.spring + BR.R + 0.9 + cRow*0.86;
      if(y > BR.deck-1.0) break;
      const nAcross = Math.floor(BR.span/1.32);
      for(let i=0;i<nAcross;i++){
        const off = (i - (nAcross-1)/2) * 1.32 + (cRow%2?0.4:0.0) + (r()-0.5)*0.12;
        const ax = ac + off;
        // clip against the arch curve
        const dx = off;
        if(Math.abs(dx) < BR.R+0.7){
          const yc = BR.spring + Math.sqrt(Math.max(0,(BR.R+0.9)*(BR.R+0.9) - dx*dx));
          if(y < yc + 0.5) continue;
        }
        for(const sgn of [-1,1]){
          const p = brPoint(ax, sgn*(W+0.10), y);
          push(p, [0.60+r()*0.07, 0.38+r()*0.05, 0.22+r()*0.06], yawOf(), 0, r()*100);
        }
      }
    }
  }
  // pier facing
  for(const pc of pierCentres()){
    const baseY = BR.water - 1.5, topY = BR.deck-1.0;
    for(let cRow=0;;cRow++){
      const y = baseY + cRow*0.92;
      if(y > topY) break;
      const u = clamp((y-(BR.water-6))/(topY-(BR.water-6)),0,1);
      const hw = lerp(BR.pierW*0.72, BR.pierW*0.5, u);
      const dw = lerp(W*1.24, W, u);
      const nA = Math.max(2, Math.floor(hw*2/1.25));
      for(let i=0;i<nA;i++){
        const off=(i-(nA-1)/2)*(hw*2/nA) + (cRow%2?0.30:0);
        for(const sgn of [-1,1])
          push(brPoint(pc+off, sgn*(dw+0.10), y), [0.56+r()*0.07,0.40+r()*0.05,0.20+r()*0.05], yawOf(), 0, r()*100);
      }
      const nB = Math.max(2, Math.floor(dw*2/1.25));
      for(let i=0;i<nB;i++){
        const off=(i-(nB-1)/2)*(dw*2/nB) + (cRow%2?0.30:0);
        for(const sgn of [-1,1])
          push(brPoint(pc+sgn*(hw+0.10), off, y), [0.20+r()*0.05,0.40+r()*0.05,0.56+r()*0.07], yawOf(), 0, r()*100);
      }
    }
  }
  // string course under the parapet
  for(let i=0;i<Math.floor(BR.total/0.9)+18;i++){
    const s = -BR.total/2-8 + i*0.9;
    for(const sgn of [-1,1])
      push(brPoint(s, sgn*(W+0.22), BR.deck-0.45), [0.44,0.30,0.34], yawOf(), 0, r()*100);
  }
  return inst;
}
