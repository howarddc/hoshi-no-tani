import * as THREE from 'three';
import { GL_AIR, GL_CLOUDFIELD, GL_HASH, GL_LIGHT, GL_NOISE, GL_PAL, GL_SHADOW, GL_SKY, GL_TERRAIN, GL_UNI, GL_WIND } from './glsl.js';
import { clamp, smoothstep } from './math.js';
import { C, P } from './palette.js';
import { RIVER_PTS, riverWidth, waterLevel } from './terrain.js';

/*──────────────────────────────── §7  RIVER ─────────────────────────────────*/
/* A swept ribbon on the spline.  Flow-aligned anisotropic streaks advect at the
   local current speed, the sun glitter is hard-quantised into discrete winking
   glints rather than a specular lobe, and the wind field's gusts land on the
   surface as cat's-paw ripple patches.                                        */

export function buildRiverGeometry(){
  const NL = 760, NC = 14;
  const pos = new Float32Array((NL+1)*(NC+1)*3);
  const dat = new Float32Array((NL+1)*(NC+1)*4);   // across(-1..1), t, speed, bankDist
  const flw = new Float32Array((NL+1)*(NC+1)*2);
  const idx = [];
  let k=0, k4=0, k2=0;
  for(let i=0;i<=NL;i++){
    const t = i/NL;
    const pi = clamp(Math.round(t*(RIVER_PTS.length-1)), 1, RIVER_PTS.length-2);
    const p  = RIVER_PTS[pi];
    const pm = RIVER_PTS[Math.max(0,pi-4)], pp = RIVER_PTS[Math.min(RIVER_PTS.length-1,pi+4)];
    let tx = pp.x-pm.x, tz = pp.z-pm.z; const L=Math.hypot(tx,tz)||1; tx/=L; tz/=L;
    const nx = -tz, nz = tx;
    const w  = riverWidth(p.t);
    const y  = waterLevel(p.t);
    // narrows run faster
    const spd = 0.9 + 2.6*(12.0/Math.max(w,6.0));
    for(let j=0;j<=NC;j++){
      const a = j/NC*2-1;
      const px = p.x + nx*a*w, pz = p.z + nz*a*w;
      pos[k++]=px; pos[k++]=y - Math.abs(a)*0.06; pos[k++]=pz;
      dat[k4++]=a; dat[k4++]=p.t; dat[k4++]=spd; dat[k4++]=w;
      flw[k2++]=tx; flw[k2++]=tz;
    }
  }
  for(let i=0;i<NL;i++) for(let j=0;j<NC;j++){
    const a=i*(NC+1)+j, b=a+1, c=a+NC+1, d=c+1;
    idx.push(a,c,b, b,c,d);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('wdat', new THREE.BufferAttribute(dat,4));
  g.setAttribute('wflow', new THREE.BufferAttribute(flw,2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export const WATER_VS = ()=> /* glsl */`
${GL_UNI}
in vec4 wdat; in vec2 wflow;
out vec3 vW; out vec4 vD; out vec2 vF; out float vDist; out vec4 vScr;
void main(){
  vW = position; vD = wdat; vF = wflow;
  vec4 mv = modelViewMatrix * vec4(position,1.0);
  vDist = -mv.z;
  vec4 cp = projectionMatrix * mv;
  vScr = cp;
  gl_Position = cp;
}`;

export const WATER_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
uniform vec2 uMeanWind;
uniform sampler2D uReflect;
uniform float uReflectOn;
uniform float uReflectPlane;
uniform vec4  uPiers[8];
uniform int   uPierN;
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_TERRAIN}${GL_WIND}
${GL_SKY}${GL_CLOUDFIELD}${GL_SHADOW}${GL_LIGHT}${GL_AIR}
in vec3 vW; in vec4 vD; in vec2 vF; in float vDist; in vec4 vScr;
out vec4 outColor;

float ripple(vec2 q, float t, float sp, float gust){
  float n1 = pn2(vec2(q.x*0.049 - t*sp*0.055, q.y*0.40));
  float n2 = pn2(vec2(q.x*0.121 - t*sp*0.115, q.y*0.92) + 7.0);
  float n3 = pn2(vec2(q.x*0.315 - t*sp*0.255, q.y*2.30) + 19.0);
  // wind-driven capillary chop: this is the cat's paw
  float n4 = pn2(vec2(q.x*1.15 - t*2.4, q.y*1.05 + t*0.7) + 31.0) * gust;
  return n1*0.52 + n2*0.30 + n3*0.17 + n4*0.30;
}

void main(){
  vec3 P = vW;
  vec3 V = normalize(uCamPos - P);
  vec2 fl = normalize(vF); vec2 cr = vec2(-fl.y, fl.x);
  float across = vD.x, tRiv = vD.y, sp = vD.z, halfW = vD.w;

  vec4 wnd = windSample(P.xz);
  float gust = clamp(wnd.b*0.7, 0.0, 1.6);

  vec2 q = vec2(dot(P.xz, fl), dot(P.xz, cr));
  float e = 0.42;
  float h0 = ripple(q, uTime, sp, gust);
  float hx = ripple(q + vec2(e,0.0), uTime, sp, gust);
  float hy = ripple(q + vec2(0.0,e), uTime, sp, gust);
  float amp = mix(0.055, 0.20, clamp(sp*0.22,0.0,1.0)) * (0.55 + 0.9*gust);
  // shallower water is choppier at the edges
  amp *= mix(1.35, 1.0, smoothstep(0.55, 0.9, abs(across)) * 0.0 + 0.5);
  vec2 dh = vec2(hx-h0, hy-h0)/e * amp * 14.0;
  vec3 N = normalize(vec3(-(dh.x*fl.x + dh.y*cr.x), 1.0, -(dh.x*fl.y + dh.y*cr.y)));
  // flatten the normal with distance so the far river doesn't shimmer to noise
  N = normalize(mix(N, vec3(0.0,1.0,0.0), smoothstep(120.0, 520.0, vDist)*0.75));

  float ndl = dot(N, uSunDir);
  float sh = sunShadow(P, ndl) * cloudShadow(P);

  // ── depth-graded body colour, in bands ─────────────────────────────────
  // Painted water is not a smooth gradient; it is a few flat plates of colour
  // whose boundaries you can point at, and which follow the CHANNEL rather than
  // the ripples.  The soft-edged steps below are what read as "painted" instead
  // of "shader" — the same three-tone logic as everything else in the valley.
  float depth = 1.0 - abs(across);
  depth = smoothstep(0.0, 0.62, depth);
  float bedDepth = depth * mix(0.55, 1.0, smoothstep(9.0, 30.0, halfW));
  // a slow meander in the plate boundaries so they are drawn, not measured
  float plateJ = pn2(vec2(q.x*0.045, q.y*0.42) + 3.0)*0.070;
  float b1 = smoothstep(0.16 + plateJ, 0.30 + plateJ, bedDepth);
  float b2 = smoothstep(0.50 + plateJ, 0.68 + plateJ, bedDepth);
  vec3 body = mix(${C.wShallow}, ${C.wMid}, b1);
  body = mix(body, ${C.wDeep}, b2);
  // the gravel bed showing through the shallows (cool wet stone, not sand)
  float bedN = pn2(P.xz*0.55)*0.5+0.5;
  vec3 wetBed = mix(${C.wetStone}, ${C.wShallow}, 0.45)*mix(0.80,1.06,bedN);
  body = mix(wetBed, body, smoothstep(0.02, 0.22, bedDepth));
  // caustic light rocking over the shallow bed
  float caus = pn2(vec2(q.x*1.7 - uTime*sp*0.8, q.y*2.9 + uTime*0.5));
  caus = pow(clamp(caus*0.5+0.5, 0.0, 1.0), 3.0);
  body += ${C.wSpark}*caus*0.20*(1.0 - smoothstep(0.05, 0.40, bedDepth))*sh;

  // ── reflection ─────────────────────────────────────────────────────────
  vec3 R = reflect(-V, N);
  vec3 skyRefl = skyDomeLite(normalize(vec3(R.x, max(R.y, 0.012), R.z)));
  vec3 refl = skyRefl;
  float haveRefl = 0.0;
  if(uReflectOn > 0.5){
    vec2 su = vScr.xy/vScr.w*0.5 + 0.5;
    // a real reflection smears ALONG the view, not across it: displacing the
    // lookup far more vertically than horizontally is what makes a mirrored
    // bank look like it is lying on moving water instead of printed on it
    su += vec2(N.x*0.026, N.z*0.115);
    vec3 pr = texture(uReflect, clamp(su, vec2(0.002), vec2(0.998))).rgb;
    float valid = 1.0 - smoothstep(4.0, 26.0, abs(P.y - uReflectPlane));
    valid *= smoothstep(0.0,0.05,su.x)*smoothstep(1.0,0.95,su.x)
           * smoothstep(0.0,0.05,su.y)*smoothstep(1.0,0.95,su.y);
    haveRefl = valid;
    refl = mix(skyRefl, pr, valid*0.92);
  }
  // Stylised water keeps its own colour at grazing angles rather than becoming
  // a mirror of the warm horizon haze — but when we actually HAVE the mirrored
  // bank to show, it earns a good deal more of the surface.
  float fres = 0.035 + 0.70*pow(1.0 - clamp(dot(N,V),0.0,1.0), 4.0);
  fres = clamp(fres, 0.0, 0.46 + 0.26*haveRefl);

  vec3 col = mix(body, refl, fres*0.86);
  col = mix(col*0.74 + K_SHADOW*0.10, col, sh*0.82 + 0.18);

  // ── flow ribbons ───────────────────────────────────────────────────────
  // Long, thin, current-aligned creases are the single most recognisable thing
  // about painted river water: they show you which way it is going without any
  // motion at all.  Two travelling bands, sharpened to a line.
  {
    float r1 = pn2(vec2(q.x*0.075 - uTime*sp*0.10, q.y*0.55) + 5.0);
    float r2 = pn2(vec2(q.x*0.155 - uTime*sp*0.17, q.y*1.05) + 41.0);
    float rib = smoothstep(0.28, 0.62, abs(r1)*0.75 + abs(r2)*0.45);
    float bright = smoothstep(0.0, 0.5, r1 + r2);
    col = mix(col, mix(${C.wDeepShade}, ${C.wSpark}, bright), rib*0.16*(0.4+0.6*sh));
  }

  // ── quantised sun glitter ──────────────────────────────────────────────
  float f = dot(normalize(R), uSunDir);
  float broad = pow(max(f, 0.0), 22.0);
  float glintN = pn2(q*vec2(1.9, 3.6) - vec2(uTime*sp*1.1, uTime*0.35))*0.5+0.5;
  float twinkle = step(0.42, glintN) * (0.55 + 0.75*pn2(q*7.0 - uTime*2.0));
  float glint = smoothstep(0.9975, 0.99925, f) * twinkle;
  float glitterPath = smoothstep(0.55, 1.0, dot(normalize(vec2(V.x,V.z)), -normalize(uSunDir.xz)));
  col += ${C.wSpark} * (glint*2.6 + broad*0.42) * sh * (0.35 + 0.75*glitterPath);

  // ── foam ───────────────────────────────────────────────────────────────
  float edge = smoothstep(0.88, 1.0, abs(across));
  float scal = pn2(vec2(q.x*0.85 - uTime*sp*0.7, q.y*2.2))*0.5+0.5;
  float foam = smoothstep(0.42, 0.96, edge*(0.50+0.95*scal));
  for(int i=0;i<8;i++){
    if(i>=uPierN) break;
    vec2 dpz = P.xz - uPiers[i].xy;
    float d = length(dpz) - uPiers[i].z;
    // a wake streams downstream of every pier
    float alongP = dot(dpz, fl);
    float wake = exp(-max(d,0.0)*0.30) * smoothstep(-1.0, 6.0, alongP) * exp(-max(alongP,0.0)*0.045);
    float bow  = exp(-max(d,0.0)*0.85);
    foam = max(foam, (bow*0.9 + wake*0.55) * (0.5 + 0.75*scal));
  }
  foam = clamp(foam, 0.0, 1.0);
  col = mix(col, ${C.wFoam}*mix(0.80, 1.10, scal), foam*0.55);

  // cat's paws darken the surface where a gust touches down
  col *= mix(1.0, 0.86, smoothstep(0.75, 1.6, gust));

  col += K_SUN * pow(clamp(dot(V,-uSunDir),0.0,1.0), 5.0) * 0.16 * sh;
  col = aerial(col, vDist, V, P.y);
  outColor = vec4(SAFE3(col), gFogAmt);
}`;
