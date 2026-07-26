import { HALF, WS } from './config.js';
import { clamp, lerp } from './math.js';

/*  Generic 2-D distance field, shared by the river, the track and the path.
    Lives in its own module because the terrain needs it while building the
    splat map, and importing it from the viaduct made terrain -> viaduct ->
    terrain a cycle: real ES modules then evaluated the viaduct's top-level
    IIFE before the terrain had initialised BRIDGE.                        */

/*──────────── generic distance field (reused by river, track, path) ────────*/
export function makeDF(points, res){
  res = res||384;
  const cell = WS/res;
  const dist = new Float32Array(res*res).fill(1e9);
  const par  = new Float32Array(res*res);
  const sx = new Int16Array(res*res).fill(-9999), sy = new Int16Array(res*res).fill(-9999);
  for(const p of points){
    const gx=Math.round((p.x+HALF)/cell), gy=Math.round((p.z+HALF)/cell);
    if(gx<0||gy<0||gx>=res||gy>=res) continue;
    const i=gy*res+gx;
    if(dist[i]>0){ dist[i]=0; sx[i]=gx; sy[i]=gy; par[i]=p.t; }
  }
  const relax=(i,j)=>{ if(sx[j]===-9999) return;
    const gx=i%res, gy=(i/res)|0;
    const d=(sx[j]-gx)*(sx[j]-gx)+(sy[j]-gy)*(sy[j]-gy);
    if(d<dist[i]){ dist[i]=d; sx[i]=sx[j]; sy[i]=sy[j]; par[i]=par[j]; } };
  for(let it=0; it<2; it++){
    for(let y=0;y<res;y++) for(let x=0;x<res;x++){ const i=y*res+x;
      if(x>0) relax(i,i-1); if(y>0) relax(i,i-res);
      if(x>0&&y>0) relax(i,i-res-1); if(x<res-1&&y>0) relax(i,i-res+1); }
    for(let y=res-1;y>=0;y--) for(let x=res-1;x>=0;x--){ const i=y*res+x;
      if(x<res-1) relax(i,i+1); if(y<res-1) relax(i,i+res);
      if(x<res-1&&y<res-1) relax(i,i+res+1); if(x>0&&y<res-1) relax(i,i+res-1); }
  }
  for(let i=0;i<res*res;i++) dist[i]=Math.sqrt(dist[i])*cell;
  return (x,z)=>{
    const fx=clamp((x+HALF)/cell,0,res-1.001), fy=clamp((z+HALF)/cell,0,res-1.001);
    const x0=fx|0,y0=fy|0,tx=fx-x0,ty=fy-y0, i=y0*res+x0;
    return { d: lerp(lerp(dist[i],dist[i+1],tx), lerp(dist[i+res],dist[i+res+1],tx), ty),
             t: lerp(lerp(par[i],par[i+1],tx),  lerp(par[i+res],par[i+res+1],tx),  ty) };
  };
}
