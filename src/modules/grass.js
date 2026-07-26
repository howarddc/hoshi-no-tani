import * as THREE from 'three';
import { DENS_POW, RINGS } from './config.js';
import { FHEAD, GL_AIR, GL_CLOUDFIELD, GL_HASH, GL_LIGHT, GL_NOISE, GL_PAL, GL_SHADOW, GL_TERRAIN, GL_UNI, GL_WIND, VHEAD } from './glsl.js';
import { clamp, rng, smoothstep } from './math.js';
import { C, P } from './palette.js';
import { tint } from './railway.js';
import { addBulk } from './scene-contract.js';
import { sampleHeight } from './terrain.js';

/*──────────────────────────────── §6  GRASS ─────────────────────────────────*/
/*  Every blade is a quadratic Bézier whose tip is solved for the quasi-static
    equilibrium of gravity, wind and Hookean recovery (Jahrmann & Wimmer 2017),
    then corrected so it can never stretch or sink through the ground.  Four
    overlapping LOD rings carry blades from underfoot to the far ridge; blade
    width is floored to an angular size so distant grass thins in density but
    never in coverage — the field never dissolves.

    PERFORMANCE.  Three things make a million-blade field affordable:
      1. the instance buffer is SHUFFLED, so drawing the first K instances of a
         chunk is a uniform random thinning of it.  Every chunk therefore gets
         an instance count scaled by how much of it is actually inside its
         ring's distance band — the fade-out region costs almost nothing;
      2. all chunks of a ring share ONE material, so three.js sorts them
         front-to-back by depth and early-Z throws away most of the (very
         heavy) fragment work before it runs;
      3. the fragment shader has three tiers — the far rings drop the PCF
         shadow lookup and the per-pixel painterly noise entirely.            */

function buildBladeGeometry(segs){
  const n = Math.max(1, segs);
  const nv = 2*n + 1;
  const vtx = new Float32Array(nv*3);   // named `position` so three binds it
  let k=0;
  for(let i=0;i<n;i++){
    const v = i/n;
    vtx[k++]=0;   vtx[k++]=v; vtx[k++]=0;
    vtx[k++]=1;   vtx[k++]=v; vtx[k++]=0;
  }
  vtx[k++]=0.5; vtx[k++]=1; vtx[k++]=0;
  const tri=[];
  for(let i=0;i<n-1;i++){
    const a=i*2, b=a+1, c=a+2, d=a+3;
    tri.push(a,c,b, b,c,d);
  }
  const a=(n-1)*2;
  tri.push(a, 2*n, a+1);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(vtx,3));
  g.setIndex(tri);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

function buildBladeInstances(geom, chunkSize, count, seed){
  const r = rng(seed);
  /*  Stored as normalised 16-bit rather than float32: the offset is a fraction
      of a chunk, so even the 250 m far chunks resolve to under 4 mm, and this
      is the ONE attribute the GPU refetches for every single instance.  Two
      and a half million instances a frame at 8 bytes each is 20 MB of vertex
      fetch; at 4 bytes it is 10 MB, for no difference anyone can see.        */
  const ip = new Uint16Array(count*2);
  // stratified jitter: even coverage without a visible grid
  const side = Math.ceil(Math.sqrt(count));
  const cell = 1/side;                       // in chunk-fractions now
  let k=0;
  for(let i=0;i<count;i++){
    const gx = i % side, gy = (i/side)|0;
    ip[k++] = Math.min(65535, ((gx + r())*cell)*65535) | 0;
    ip[k++] = Math.min(65535, ((gy + r())*cell)*65535) | 0;
  }
  // Fisher-Yates: after this, ANY prefix of the buffer is a uniform random
  // sample of the whole chunk, which is what lets us thin a chunk simply by
  // lowering its instance count.
  for(let i=count-1;i>0;i--){
    const j=(r()*(i+1))|0;
    const ax=ip[i*2], az=ip[i*2+1];
    ip[i*2]=ip[j*2]; ip[i*2+1]=ip[j*2+1];
    ip[j*2]=ax;      ip[j*2+1]=az;
  }
  geom.setAttribute('iPos', new THREE.InstancedBufferAttribute(ip, 2, true));
  geom.instanceCount = count;
  return geom;
}

/*  `depthOnly` builds the variant used by the prepass.  It solves the identical
    blade — it has to, or the depth it lays down would not match — but it emits
    no varyings and skips the curved cross-section normal, the AO, the occlusion
    term and the tint, none of which a depth-only pass can use.  Seventeen
    interpolants written and immediately discarded is real vertex-export
    bandwidth, and export bandwidth is exactly what a grass field runs out of. */
const GRASS_VS = (depthOnly)=> /* glsl */`
${GL_UNI}
uniform vec2  uMeanWind;
uniform float uChunkSize;
uniform vec4  uLod;            // near, nearWidth, far, farWidth
uniform vec3  uLodB;           // widthBoost(angular), heightScale, ringDistance
uniform float uWindGain;
uniform float uPlayerPush;
${GL_HASH}${GL_NOISE}${GL_TERRAIN}${GL_WIND}
in vec2 iPos;
${ depthOnly ? '' : `
out vec3  vW;
out vec3  vN;
out float vT;        // height along the blade 0..1
out float vBend;     // how far the blade is laid over 0..1
out vec3  vTint;
out float vSide;     // -1..1 across the blade
out float vOccl;     // shaded by taller neighbours
out float vVar;      // per-blade value/hue jitter, seed head packed in
`}
void degenerate(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }

void main(){
  vec2 vtx = position.xy;              // x = across the blade, y = along it
  // The chunk origin comes straight out of the model matrix (three keeps that
  // up to date per object for free), so all of a ring's chunks can share ONE
  // material with ZERO per-draw uniform traffic.
  vec2 cCen = vec2(modelMatrix[3][0], modelMatrix[3][2]);
  vec2 wxz  = (cCen - vec2(uChunkSize*0.5)) + iPos*uChunkSize;
  vec2 toB  = wxz - uCamPos.xz;
  float d2  = dot(toB, toB);
  float invD = inversesqrt(max(d2, 1e-4));
  float dist = d2*invD;

  /*  Lateral view-cone rejection, per blade, as the very first thing the shader
      does — five instructions, no memory access, no hashing.
      Culling happens per CHUNK on the CPU, and a chunk is a coarse unit: the
      one the camera is standing in is always kept, yet more than half of its
      blades are behind your head.  uCull.xy is the view direction flattened
      onto the ground and uCull.z the cosine of the widest frustum corner
      (measured every frame from the real corner rays, so it is exact at any
      pitch and aspect) with a nine-degree pad for blade width and wind lean.
      Blades within about five metres are exempt, since at that range a blade's
      own width subtends more than the pad.                                    */
  if(d2 > 30.0 && dot(toB, uCull.xy)*invD < uCull.z){ degenerate(); return; }

  // ── overlapping LOD fades: blades grow in and shrink out, never pop ─────
  float fadeIn  = uLod.x <= 0.01 ? 1.0 : smoothstep(uLod.x - uLod.y, uLod.x + uLod.y, dist);
  float fadeOut = uLod.z <= 0.0  ? 1.0 : 1.0 - smoothstep(uLod.z - uLod.w, uLod.z, dist);
  float fade = fadeIn * fadeOut;
  if(fade < 0.006){ degenerate(); return; }

  // ── the density law, resolved per blade ────────────────────────────────
  // The CPU already thinned this chunk to the density its NEAREST corner
  // deserves (it deliberately over-draws), so all that is left here is to
  // reject the surplus against this blade's own true distance.  The result is
  // a perfectly smooth radial density gradient with no chunk banding at all —
  // which is what lets the far ring use 250 m chunks and 40-odd draw calls.
  float rQ = hash12(wxz*1.317 + 7.71);
  float dn = uLodB.z;
  // chunkKeep — the fraction the CPU already drew — rides in on the model
  // matrix's Y scale.  It is constant across a chunk, so computing it per
  // vertex was one pow() per vertex to arrive at a number we already knew.
  float chunkKeep = modelMatrix[1][1];
  // ...and the exponent is 1.5 exactly so the remaining evaluation is
  // x·x·inversesqrt(x): three cheap instructions instead of a pow.
  float xr = min(dn/max(dist, dn), 1.0);
  float bladeKeep = xr*xr*inversesqrt(max(xr, 1e-6));
  // A hard accept/reject makes a blade POP into existence as you walk toward
  // it, and a field full of popping blades shimmers — which is most of what
  // reads as "jagged" in distant grass.  The last fifth of the acceptance
  // window is a growth ramp instead, so a blade rises out of the sward.
  float need = rQ*chunkKeep;
  if(need > bladeKeep){ degenerate(); return; }   // conservative early gate

  /*  All three memory reads are issued here, back to back, and none of their
      addresses depends on another's result.  That is deliberate and it is the
      whole point of this block: a vertex texture fetch is a few hundred cycles
      of latency, and the shader used to chain them — read the meadow, work out
      the blade's height from it, then use that height to decide WHERE to sample
      the wind — which serialises two full round trips per vertex, twelve
      million times a frame.  The upwind lag is now a fixed 2.6 m instead of a
      height-dependent one; at a metre of grass the difference is not visible,
      and the three fetches now overlap each other and the hashing below.     */
  vec4  md     = textureLod(uMeadow, wxz*W_INV + 0.5, 0.0);
  float ground = terrainHLod(wxz, 0.0);
  vec4  Wsam   = windSample(wxz - uWindLag);

  float mask = md.b;
  if(mask < 0.035){ degenerate(); return; }
  float thr  = bladeKeep*(0.78 + 0.22*mask);
  float grow = clamp((thr - need) / max(thr*0.22, 1e-5), 0.0, 1.0);
  if(grow <= 0.004){ degenerate(); return; }
  fade *= grow;

  // per-blade randomness hashed from WORLD position: the instance buffer is
  // shared by every chunk of this ring, yet nothing visibly tiles
  vec3 h3 = hash32(wxz*0.9173 + 11.0);
  float rH = h3.x, rO = h3.y, rS = h3.z;
  float rP = hash12(wxz*2.713 + 31.4);
  // Grass is negatively gravitropic — the stem grows toward vertical whatever
  // the slope does.  Being correct here also removes four heightmap taps per
  // vertex, which is what pays for the blade count.
  vec3 up = vec3(0.0, 1.0, 0.0);

  // ── tussocks: height, hue and lean cluster at metre and decametre scales
  float clumpA = md.r, clumpB = md.g, dryv = md.a;

  // a wild hay meadow, not a lawn
  float hgt = (0.62 + rH*0.58);
  hgt *= 0.68 + 0.74*clumpB;
  hgt *= 0.84 + 0.38*clumpA;
  hgt *= mix(1.24, 0.82, dryv);          // dry shoulders carry a shorter sward
  hgt *= mix(0.68, 1.0, mask);
  hgt *= uLodB.y;
  hgt  = max(hgt, 0.08);

  float wid = (0.0082 + rS*0.0070) * (0.84 + 0.40*clumpA);
  // angular floor: a blade is never allowed to fall below ~1 pixel wide
  wid = max(wid, dist * uLodB.x);

  float stiff = 0.52 + rS*0.46 + clumpB*0.10;

  // ── frame ──────────────────────────────────────────────────────────────
  float orient = rO*6.2831853 + clumpA*2.4;
  vec3 axis = vec3(cos(orient), 0.0, sin(orient));
  // at distance, swing the blade to present its face to the eye so it can
  // never disappear edge-on
  vec3 toCam = normalize(vec3(uCamPos.x - wxz.x, 0.0, uCamPos.z - wxz.y) + vec3(1e-5));
  float faceCam = smoothstep(16.0, 80.0, dist);
  axis = normalize(mix(axis, normalize(cross(vec3(0.0,1.0,0.0), toCam)), faceCam*0.88));

  vec3 side  = normalize(cross(up, axis) + vec3(1e-6));
  vec3 front = normalize(cross(side, up));

  vec3 p0  = vec3(wxz.x, ground - 0.035, wxz.y);
  vec3 iv2 = p0 + up*hgt*0.965 + front*hgt*(0.20 + rH*0.34);

  // ── forces ─────────────────────────────────────────────────────────────
  // The field was sampled a little UPWIND of the blade, up at the top of the
  // shader — a spatial stand-in for the blade's own response lag, so that a
  // gust front visibly *sweeps* across the meadow instead of switching on.
  vec2 wv = Wsam.rg; float gustN = Wsam.b, excite = Wsam.a;
  float prof = windProfile(hgt*0.70);
  vec3 wind3 = vec3(wv.x, 0.0, wv.y) * prof;

  vec3 gE = vec3(0.0,-1.0,0.0) * (1.6 + 1.4*rH);
  vec3 gF = 0.25 * length(gE) * front;
  vec3 gv = (gE + gF) * 0.048;

  vec3 dir0 = normalize(iv2 - p0);
  float fd = 1.0 - abs(dot(normalize(wind3 + vec3(1e-5)), dir0));   // alignment
  float fr = clamp(dot(iv2 - p0, up)/hgt, 0.0, 1.0);                // straightness
  vec3 wf = wind3 * (0.30 + 0.95*fd) * fr * uWindGain * (0.55 + 0.75*hgt);

  // quasi-static equilibrium of recovery + gravity + wind (Hooke)
  vec3 v2 = iv2 + (gv + wf) / max(stiff, 0.18);

  // ── ringing: a gust front leaves the blade quivering at its own frequency
  float fB = 1.85 + rS*1.55;
  float ph = rQ*6.2831853;
  float osc = sin(uTime*6.2831853*fB + ph);
  float amp = (excite*0.50 + max(gustN-0.85,0.0)*0.42) * (0.040 + 0.075*(1.0-stiff));
  vec2  wdirn = normalize(wv + vec2(1e-5));
  v2 += vec3(wdirn.x, 0.0, wdirn.y) * osc * amp * hgt;
  // never frozen: a low flutter always present
  v2 += side * sin(uTime*7.4*(0.65+rS) + ph*2.3) * hgt * 0.020 * (0.35 + gustN*0.65);

  // ── the walker parts the grass ─────────────────────────────────────────
  if(uPlayerPush > 0.0){
    vec2 dp = wxz - uCamPos.xz;
    float pd = length(dp);
    if(pd < 2.0){
      float vert = 1.0 - smoothstep(1.1, 2.4, abs(uCamPos.y - ground));
      float push = smoothstep(1.45, 0.15, pd) * vert * uPlayerPush;
      v2 += vec3(dp.x, -0.55, dp.y)/max(pd, 0.02) * push * hgt * 0.85;
    }
  }

  // ── state corrections (Jahrmann §5.2) ──────────────────────────────────
  v2 -= up * min(dot(up, v2 - p0), 0.0);
  vec3 d20 = v2 - p0;
  float lproj = length(d20 - up*dot(d20, up));
  vec3 v1 = p0 + hgt*up*max(1.0 - lproj/hgt, 0.05*max(lproj/hgt, 1.0));
  float L0 = length(v2 - p0);
  float L1 = length(v1 - p0) + length(v2 - v1);
  float L  = (2.0*L0 + L1)/3.0;
  float rr = hgt / max(L, 1e-4);
  v1 = p0 + rr*(v1 - p0);
  v2 = v1 + rr*(v2 - v1);

  // ── evaluate the Bézier ────────────────────────────────────────────────
  float head = step(0.895, rP);     // one blade in ten carries a seed head
  float t = vtx.y;
  vec3 a = mix(p0, v1, t);
  vec3 b = mix(v1, v2, t);
  vec3 c = mix(a, b, t);
  vec3 tang = normalize(b - a + vec3(0.0,1e-5,0.0));

  // sqrt rather than pow(x, 0.40): the profile differs by a couple of percent
  // over the length of a blade and it is one transcendental fewer per vertex
  float wprof = sqrt(1.0 - t) * (0.60 + 0.42*smoothstep(0.0, 0.16, t));
  wprof = mix(wprof, wprof*1.9, head*smoothstep(0.80, 0.99, t));
  float u = (vtx.x - 0.5);
  vec3 sideW = normalize(side - tang*dot(side, tang) + vec3(1e-6));
  vec3 pos = c + sideW * (u * wid * wprof * 2.0 * fade);
  // shrink the whole blade as it fades, so LOD changes are invisible
  pos = mix(p0 + vec3(0.0, 0.02, 0.0), pos, 0.30 + 0.70*fade);

  // ── curved cross-section: two triangles wide, shades like a rolled leaf
  vec3 faceN = normalize(cross(sideW, tang));
  vec3 N = normalize(faceN + sideW*(u*2.0)*0.66);

${ depthOnly ? '' : `
  vBend = clamp(1.0 - dot(normalize(v2-p0), up), 0.0, 1.0);
  vT    = t;
  vSide = u*2.0;
  vW    = pos;
  vN    = N;
  // vDist and vAO are exact functions of vW and vT, so interpolating them was
  // paying vertex export and fragment-input registers to carry a value the
  // fragment shader can reconstruct for one instruction
  // a blade shorter than its neighbours sits in their shade: this is what
  // gives a dense sward its internal depth instead of one flat wall of green
  vOccl = smoothstep(0.18, 1.05, hgt / (0.42 + 0.72*clumpB));
  // the seed-head flag rides in the integer part of vVar
  vVar  = rS*0.6 + rH*0.4 + head*2.0;

  // per-blade hue: the meadow is a mosaic, never one green
  vTint = vec3(clumpB, clumpA, clamp(dryv + (rH-0.5)*0.22, 0.0, 1.0));
`}
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}`;

/* tier 0/1 = full quality (PCF shadow, painterly noise);
   tier 2   = fast 4-tap shadow, no per-pixel noise;
   tier 3   = cloud shadow only (it is beyond the shadow map anyway).        */
const GRASS_FS = (tier)=> /* glsl */`
precision highp float;
${GL_UNI}
uniform vec2 uMeanWind;
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_TERRAIN}${GL_WIND}
${GL_CLOUDFIELD}${GL_SHADOW}${GL_LIGHT}${GL_AIR}
in vec3 vW; in vec3 vN; in float vT; in float vBend;
in vec3 vTint; in float vSide; in float vOccl; in float vVar;
out vec4 outColor;

void main(){
  vec3 N = normalize(vN);
  vec3 toEye = uCamPos - vW;
  float vDist = length(toEye);
  vec3 V = toEye / max(vDist, 1e-4);
  if(!gl_FrontFacing) N = -N;
  float vHead = step(1.5, vVar);
  float vVarF = vVar - vHead*2.0;
  float vAO   = mix(0.34, 1.0, pow(vT, 0.55));

  // ── vertical hue path: teal at the root, yellow-green at the tip ───────
  float t = vT;
  vec3 lit = mix(${C.gLow}, ${C.gMid}, smoothstep(0.00, 0.26, t));
  lit = mix(lit, ${C.gUpper}, smoothstep(0.20, 0.66, t));
  lit = mix(lit, ${C.gTip},   smoothstep(0.80, 1.00, t));
  vec3 mid = mix(${C.gBase}, ${C.gMid}, smoothstep(0.05, 0.80, t));
  vec3 shd = mix(${C.gBase}*0.82, ${C.gLow}, smoothstep(0.15, 0.95, t));

  // meadow mosaic
  lit = mix(lit, ${C.gPatchC}, smoothstep(0.35,0.85,vTint.x)*0.45);
  lit = mix(lit, ${C.gPatchA}, smoothstep(0.65,0.15,vTint.x)*0.35);
  mid = mix(mid, ${C.gPatchB}, smoothstep(0.3,0.8,vTint.y)*0.40);
  shd = mix(shd, ${C.tHollow}, smoothstep(0.4,0.9,vTint.y)*0.35);
  float dry = smoothstep(0.68, 0.99, vTint.z) * smoothstep(0.45, 0.98, t);
  lit = mix(lit, ${C.gDry}, dry*0.60);
  mid = mix(mid, ${C.gDry}*0.72, dry*0.42);

  // no two blades in a meadow are the same green
  float vj = 0.84 + 0.34*vVarF;
  lit *= vj; mid *= vj*0.98; shd *= 0.92 + 0.20*vVarF;
  lit = mix(lit, ${C.gPatchB}, smoothstep(0.72, 1.0, vVarF)*0.30);

  float ndl = dot(N, uSunDir);
${ tier <= 1 ? `  float sh = sunShadow(vW, ndl) * cloudShadow(vW);`
  : tier === 2 ? `  float sh = sunShadowFast(vW, ndl) * cloudShadow(vW);`
  :              `  float sh = cloudShadow(vW);` }
  float selfShadow = mix(0.62, 1.0, pow(t, 0.75));

  // Everything that varies ACROSS the width of a blade — the fanned normal, the
  // rim, the wind flash, the midrib — is sub-pixel detail once a blade is only
  // two or three pixels wide, and sub-pixel detail does not resolve, it
  // sparkles.  nearK retires those terms with distance and leaves the ones that
  // vary ALONG the blade, which stay several pixels tall much further out.
  float nearK = 1.0 - smoothstep(55.0, 240.0, vDist);
  N = normalize(mix(vec3(0.0,1.0,0.0), N, 0.34 + 0.66*nearK));

  Surf s;
  s.N=N; s.V=V; s.P=vW;
  s.shade=shd; s.mid=mid; s.lit=lit;
  s.soft = ${ tier <= 1 ? 'mix(0.11, 0.24, clamp(vDist*0.008,0.0,1.0))' : '0.20' };
  s.jit  = ${ tier <= 1 ? '(vn2(vW.xz*3.9 + vW.y*1.7) - 0.5)*0.055' : '(vVarF-0.5)*0.05' };
  s.shadow = sh*selfShadow*mix(0.52, 1.0, vOccl);
  s.trans  = 1.00*smoothstep(0.12,0.68,t);
  s.transCol = ${C.gTrans};
  s.rim = 0.34*(0.25 + 0.75*nearK); s.ao = vAO; s.ambient = 1.0;
  vec3 col = paint(s);

  // ── the wind flash ─────────────────────────────────────────────────────
  // a blade laid over by a gust turns its broad face up and catches the light:
  // this is what makes a gust visible as a pale band racing across the field
  float geom = pow(clamp(1.0 - abs(dot(N,V)), 0.0, 1.0), 1.9)*0.45
             + pow(clamp(dot(N, normalize(uSunDir + V)), 0.0, 1.0), 3.2)*0.55;
  float flash = smoothstep(0.34, 0.86, vBend) * smoothstep(0.14, 0.78, t);
  col = mix(col, ${C.gSheen}, geom*flash*0.55*(0.30 + 0.70*sh)*(0.32 + 0.68*nearK));

  // seed head: a warm bronze plume on one blade in ten
  if(vHead > 0.5){
    float hd = smoothstep(0.78, 0.94, t);
    col = mix(col, mix(${C.gDry}, vec3(0.32,0.22,0.14), 0.42)*1.25, hd*0.82);
  }
  // a hint of the midrib, and the deep interior of the sward
  col *= 1.0 - abs(vSide)*0.13*nearK;
  col *= mix(0.46, 1.0, vOccl*0.55 + 0.45);

  // Out past a hundred metres a blade is only two or three pixels wide, and
  // full contrast against the ground behind it is what makes distant grass
  // crawl and sparkle as the camera moves.  Converging it toward the sward
  // mean keeps every bit of the texture and takes the edge energy out of it —
  // which is, not coincidentally, exactly what a painter does at that depth.
  col = mix(col, mix(col, ${C.tMid}, 0.62), smoothstep(90.0, 430.0, vDist)*0.42);

  col = aerial(col, vDist, V, vW.y);
  outColor = vec4(SAFE3(col), gFogAmt);
}`;

/*──────────────── the ring/chunk manager ────────────────*/
export class GrassField {
  constructor(scene, sharedUniforms, quality){
    this.scene = scene; this.G = sharedUniforms;
    // Every chunk lives under one group.  The shadow and reflection passes then
    // hide the entire field with a single flag instead of walking ~250 meshes
    // and pushing a save-record for each of them, twice, every frame.
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    addBulk(scene, this.group);
    this.rings = [];
    this.built = false;
    this.quality = quality;
    this.density = 1.0;
    this.drawn = 0;
  }
  dispose(){
    for(const r of this.rings){
      for(const m of r.meshes) this.group.remove(m);
      r.geom.dispose(); r.mat.dispose();
      if(r.preMat) r.preMat.dispose();
    }
    this.rings.length = 0;
  }
  build(q){
    this.dispose();
    const segs = q.blades;
    for(let li=0; li<RINGS.length; li++){
      const R = RINGS[li];
      const n = Math.max(64, Math.round(R.blades * q.grass[Math.min(li,q.grass.length-1)] * this.density));
      const geom = buildBladeInstances(buildBladeGeometry(segs[li]), R.chunk, n, 7000+li*131);
      // The grid is derived, never hand-tuned: it must be wide enough for the
      // ring to physically reach its own `far`, or an un-grassed annulus opens
      // up between this ring and the next.
      const grid = Math.max(3, (Math.ceil(2*R.far/R.chunk) + 1) | 1);
      const uni = Object.assign({}, this.G, {
        uChunkSize: { value:R.chunk },
        uLod:       { value:new THREE.Vector4(R.near, Math.max(7,R.near*0.26), R.far, R.far*0.26) },
        uLodB:      { value:new THREE.Vector3(0.0011*R.wpx, R.hs, R.dn) },
        uWindGain:  { value:0.235 },
        uPlayerPush:{ value: li===0 ? 1.0 : 0.0 },
      });
      // ONE material for the whole ring: three then sorts its chunks by depth
      // (same material id -> sort falls through to z), giving front-to-back
      // draw order and therefore early-Z rejection of most fragments.
      /*  The beauty pass writes depth even though the prepass already did.
          Skipping the write looks like free bandwidth and is a trap: the
          prepass occluder is not pixel-identical to the blade, so wherever the
          blade covers a pixel the prepass did not, nothing records that the
          pixel is now opaque — and the sky, which is drawn last against the far
          plane, walks straight through the silhouette.  Correct beats clever. */
      const mat = new THREE.RawShaderMaterial({
        vertexShader: VHEAD + GRASS_VS(false),
        fragmentShader: FHEAD + GRASS_FS(li),
        uniforms: uni, side: THREE.DoubleSide, glslVersion: THREE.GLSL3,
      });

      /*  DEPTH PREPASS — the single most valuable thing in this renderer.
          Standing in a metre-tall sward at ~1200 blades/m², a horizontal view
          is roughly thirty blades deep at every pixel.  Sorting chunks
          front-to-back only gets early-Z between chunks; inside a chunk the
          instance order is a deliberate shuffle, so nearly all of that depth
          complexity was being fully SHADED and then thrown away.
          So the two near rings are drawn twice: once with colour writes off and
          no fragment work at all, which lays down the final depth at the rate
          the rasteriser can manage; then normally, where the hardware's early
          depth test now rejects every hidden fragment before the painterly
          shading, the shadow lookup or the cloud lookup ever runs.
          It also front-loads the depth for the TERRAIN, which is drawn after
          the prepass and was previously shading a full screen of hillside that
          the grass immediately covered.
          Because the beauty pass keeps the ordinary LESS-EQUAL test rather than
          switching to EQUAL, an exact depth match is not required and there is
          no way for this to drop a blade.                                     */
      const preMat = li < 2 ? new THREE.RawShaderMaterial({
        vertexShader: VHEAD + GRASS_VS(true),
        fragmentShader: FHEAD + 'out vec4 o;\nvoid main(){ o = vec4(1.0); }',
        uniforms: uni, side: THREE.DoubleSide, glslVersion: THREE.GLSL3,
        colorWrite: false,
      }) : null;
      /*  The occluder is the blade itself, at full tessellation.  A cheaper
          stand-in is tempting — a depth prepass is allowed to under-cover, only
          never to over-cover — but the arithmetic does not work out: dropping
          the near blade to a single flat segment saves 1.7 M vertices and then
          hands back six million shaded fragments through the gaps, because a
          straight chord at 86% width covers barely half of what a curved blade
          with a sqrt width profile does.  Occlusion is worth more than
          geometry here, so the prepass shares the beauty geometry outright.   */
      const ring = { R, meshes:[], grid, uni, geom, mat, preMat, maxInst:n, li };
      const half = (grid-1)/2;
      for(let j=0;j<grid;j++) for(let i=0;i<grid;i++){
        const m = new THREE.Mesh(geom, mat);
        m.frustumCulled = false;
        m.renderOrder = 4 + li;
        m.userData = { ring, ci:i-half, cj:j-half, size:R.chunk, count:n };
        m.onBeforeRender = grassBeforeRender;
        ring.meshes.push(m); this.group.add(m);
        if(preMat){
          // parented to the beauty chunk so it inherits both its visibility and
          // its model matrix (which is where the vertex shader reads the chunk
          // origin from) with no extra bookkeeping at all
          const pm = new THREE.Mesh(geom, preMat);
          pm.frustumCulled = false;
          pm.renderOrder = -20 + li;      // before the terrain, before everything
          pm.userData = m.userData;
          pm.onBeforeRender = grassBeforeRender;
          m.add(pm);
        }
      }
      this.rings.push(ring);
    }
    this.built = true;
  }
  // a blade must never be allowed to shrink below ~1 screen pixel, or the
  // field visibly thins out with distance instead of merely getting sparser
  setAngular(angPerPx){
    for(let i=0;i<this.rings.length;i++)
      this.rings[i].uni.uLodB.value.x = angPerPx * RINGS[i].wpx;
  }
  update(cam, frustum){
    const cp = cam.position;
    const box = GrassField._box || (GrassField._box = new THREE.Box3());
    let drawn = 0;
    for(const ring of this.rings){
      const R = ring.R, cs = R.chunk;
      const ox = Math.floor(cp.x/cs)*cs, oz = Math.floor(cp.z/cs)*cs;
      const nearW = Math.max(7, R.near*0.26), farW = R.far*0.26;
      for(const m of ring.meshes){
        const d = m.userData;
        const x = ox + d.ci*cs, z = oz + d.cj*cs;
        const cx = x+cs*0.5, cz = z+cs*0.5;
        const dd = Math.hypot(cx-cp.x, cz-cp.z);
        if(dd - cs*0.75 > R.far){ m.visible=false; continue; }
        if(dd + cs*0.75 < R.near - nearW){ m.visible=false; continue; }
        const gy = sampleHeight(cx, cz);
        box.min.set(x-1, gy-40, z-1); box.max.set(x+cs+1, gy+42, z+cs+1);
        if(!frustum.intersectsBox(box)){ m.visible=false; continue; }
        m.visible = true;
        // the shuffled instance buffer means a prefix is a fair sample, so we
        // can thin a chunk simply by drawing fewer of its blades
        let f = 1;
        if(R.near > 0.01) f *= smoothstep(R.near - nearW - cs*0.6, R.near + nearW, dd);
        f *= 1 - smoothstep(R.far - farW, R.far + cs*0.6, dd);
        // ...and the density law evaluated at the chunk's NEAREST point, so it
        // is always an over-estimate.  The vertex shader then thins each blade
        // against its own distance; the CPU may only over-draw, never under-
        // draw, or the chunk would show a hard density seam at its near edge.
        const nx = Math.max(Math.abs(cp.x - cx) - cs*0.5, 0);
        const nz = Math.max(Math.abs(cp.z - cz) - cs*0.5, 0);
        const dNear = Math.max(Math.hypot(nx, nz), R.dn);
        const dens = Math.min(1, Math.pow(R.dn / dNear, DENS_POW));
        d.count = Math.max(24, Math.round(ring.maxInst * clamp(f, 0, 1) * dens));
        drawn += d.count;
        // position drives the depth sort AND, via modelMatrix, the chunk origin
        // the vertex shader works from — so it must be the chunk centre exactly.
        // The Y scale is a free ride for `dens`: the shader needs it, it is
        // constant per chunk, and sending it this way costs no uniform upload
        // and saves a pow() on every vertex of the chunk.
        m.position.set(cx, gy, cz);
        m.scale.y = dens;
      }
    }
    this.drawn = drawn;
  }
}
/*  The ONLY per-chunk state left.  There is deliberately no uniform write and
    no `uniformsNeedUpdate` here: forcing a full uniform re-upload for each of
    ~250 chunk draws was pure CPU overhead, and the chunk origin now rides in
    on the model matrix, which three maintains per object anyway.             */
function grassBeforeRender(){
  this.geometry.instanceCount = this.userData.count;
}
