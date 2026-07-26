/*─────────────────────────────── §1  MATH / NOISE ───────────────────────────*/

export const TAU = Math.PI * 2, DEG = Math.PI / 180;
export const clamp = (x,a,b)=> x<a?a:(x>b?b:x);
export const lerp  = (a,b,t)=> a+(b-a)*t;
export const smoothstep = (e0,e1,x)=>{ const t=clamp((x-e0)/(e1-e0),0,1); return t*t*(3-2*t); };
export const smootherstep = (e0,e1,x)=>{ const t=clamp((x-e0)/(e1-e0),0,1); return t*t*t*(t*(t*6-15)+10); };

// deterministic PRNG (mulberry32)
export function rng(seed){ let a=seed>>>0; return ()=>{ a|=0; a=a+0x6D2B79F5|0;
  let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t;
  return ((t^t>>>14)>>>0)/4294967296; }; }

// classic 2D gradient noise with a permutation table
const PERM = new Uint8Array(512), GX = new Float32Array(256), GY = new Float32Array(256);
(function(){ const r = rng(20240715); const p = new Uint8Array(256);
  for(let i=0;i<256;i++) p[i]=i;
  for(let i=255;i>0;i--){ const j=(r()*(i+1))|0; const t=p[i]; p[i]=p[j]; p[j]=t; }
  for(let i=0;i<512;i++) PERM[i]=p[i&255];
  for(let i=0;i<256;i++){ const a=r()*TAU; GX[i]=Math.cos(a); GY[i]=Math.sin(a); }
})();

export function noise2(x,y){
  const xi=Math.floor(x), yi=Math.floor(y);
  const xf=x-xi, yf=y-yi;
  const u=xf*xf*xf*(xf*(xf*6-15)+10), v=yf*yf*yf*(yf*(yf*6-15)+10);
  const X=xi&255, Y=yi&255;
  const a=PERM[X+PERM[Y]], b=PERM[X+1+PERM[Y]];
  const c=PERM[X+PERM[Y+1]], d=PERM[X+1+PERM[Y+1]];
  const n00=GX[a]*xf     + GY[a]*yf;
  const n10=GX[b]*(xf-1) + GY[b]*yf;
  const n01=GX[c]*xf     + GY[c]*(yf-1);
  const n11=GX[d]*(xf-1) + GY[d]*(yf-1);
  return lerp(lerp(n00,n10,u), lerp(n01,n11,u), v) * 1.4;
}
export function fbm2(x,y,oct=5,lac=2.03,gain=0.5){
  let a=0.5,f=1,s=0,n=0;
  for(let i=0;i<oct;i++){ s+=a*noise2(x*f,y*f); n+=a; a*=gain; f*=lac; }
  return s/n;
}
export function ridged(x,y,oct=5,lac=2.07,gain=0.5){
  let a=0.5,f=1,s=0,n=0,w=1;
  for(let i=0;i<oct;i++){
    let v=1-Math.abs(noise2(x*f,y*f)); v*=v; v*=w; w=clamp(v*1.6,0,1);
    s+=a*v; n+=a; a*=gain; f*=lac;
  }
  return s/n*2-1;
}
export function billow(x,y,oct=4,lac=2.0,gain=0.5){
  let a=0.5,f=1,s=0,n=0;
  for(let i=0;i<oct;i++){ s+=a*Math.abs(noise2(x*f,y*f)); n+=a; a*=gain; f*=lac; }
  return (s/n)*2-1;
}
