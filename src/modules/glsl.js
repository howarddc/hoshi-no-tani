import { CFG } from './config.js';
import { C } from './palette.js';

/*───────────────────────────── §2  GLSL LIBRARY ────────────────────────────*/
// Shared chunks injected into every shader.  One physics, one palette, one sky.

// RawShaderMaterial gives us a blank slate: we declare the built-ins ourselves.
export const VHEAD = /* glsl */`precision highp float;
precision highp int;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
in vec3 position;
`;
/*  NaN firewall.  One non-finite fragment survives the tonemap as an undefined
    value, and an undefined value on a billboard reads as a solid dark square —
    which is exactly what stray "black boxes" are.  Worse, the bloom downsample
    smears one of them across a whole neighbourhood.  Two ALU makes it
    structurally impossible: NaN != NaN, so equal(c,c) is false only for NaN. */
export const GL_SAFE = /* glsl */`
vec3  SAFE3(vec3 c){ return clamp(mix(vec3(0.0), c, equal(c, c)), vec3(0.0), vec3(64.0)); }
float SAFE1(float x){ return (x == x) ? clamp(x, 0.0, 64.0) : 0.0; }
`;
export const FHEAD = /* glsl */`precision highp float;
precision highp int;
${GL_SAFE}`;

export const GL_HASH = /* glsl */`
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3 hash32(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3+=dot(p3,p3.yxz+33.33); return fract((p3.xxy+p3.yzz)*p3.zyx); }
float hash13(vec3 p){ p=fract(p*0.1031); p+=dot(p,p.zyx+31.32); return fract((p.x+p.y)*p.z); }
vec3 hash33(vec3 p){ p=fract(p*vec3(0.1031,0.1030,0.0973)); p+=dot(p,p.yxz+33.33);
  return fract((p.xxy+p.yxx)*p.zyx); }
`;

export const GL_NOISE = /* glsl */`
float vn2(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x),
             mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x),u.y); }
float vn3(vec3 p){ vec3 i=floor(p), f=fract(p); vec3 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  float a=hash13(i+vec3(0,0,0)), b=hash13(i+vec3(1,0,0));
  float c=hash13(i+vec3(0,1,0)), d=hash13(i+vec3(1,1,0));
  float e=hash13(i+vec3(0,0,1)), g=hash13(i+vec3(1,0,1));
  float h=hash13(i+vec3(0,1,1)), k=hash13(i+vec3(1,1,1));
  return mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y), mix(mix(e,g,u.x),mix(h,k,u.x),u.y), u.z); }
vec2 grad2(vec2 i){ float a=hash12(i)*6.2831853; return vec2(cos(a),sin(a)); }
float pn2(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  float a=dot(grad2(i),f), b=dot(grad2(i+vec2(1,0)),f-vec2(1,0));
  float c=dot(grad2(i+vec2(0,1)),f-vec2(0,1)), d=dot(grad2(i+vec2(1,1)),f-vec2(1,1));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y)*1.42; }
vec3 grad3(vec3 i){ return normalize(hash33(i)*2.0-1.0); }
float pn3(vec3 p){ vec3 i=floor(p), f=fract(p); vec3 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  float n000=dot(grad3(i+vec3(0,0,0)),f-vec3(0,0,0));
  float n100=dot(grad3(i+vec3(1,0,0)),f-vec3(1,0,0));
  float n010=dot(grad3(i+vec3(0,1,0)),f-vec3(0,1,0));
  float n110=dot(grad3(i+vec3(1,1,0)),f-vec3(1,1,0));
  float n001=dot(grad3(i+vec3(0,0,1)),f-vec3(0,0,1));
  float n101=dot(grad3(i+vec3(1,0,1)),f-vec3(1,0,1));
  float n011=dot(grad3(i+vec3(0,1,1)),f-vec3(0,1,1));
  float n111=dot(grad3(i+vec3(1,1,1)),f-vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x),mix(n010,n110,u.x),u.y),
             mix(mix(n001,n101,u.x),mix(n011,n111,u.x),u.y),u.z)*1.35; }
float fbm2(vec2 p, int oct){ float a=0.5,s=0.0,n=0.0;
  for(int i=0;i<8;i++){ if(i>=oct)break; s+=a*pn2(p); n+=a; p*=2.02; p+=vec2(3.1,1.7); a*=0.5; }
  return s/n; }
float fbm3(vec3 p, int oct){ float a=0.5,s=0.0,n=0.0;
  for(int i=0;i<6;i++){ if(i>=oct)break; s+=a*pn3(p); n+=a; p*=2.03; p+=vec3(2.7,1.3,4.1); a*=0.5; }
  return s/n; }
`;

// ── shared uniform block (declared identically in every shader) ──────────────
export const GL_UNI = /* glsl */`
uniform float uTime;
uniform vec3  uSunDir;        // world -> sun, normalised
uniform vec3  uCamPos;
uniform vec2  uWindOrigin;    // centre of the wind render target, world xz
uniform vec2  uCloudDrift;
uniform sampler2D uWindTex;
uniform sampler2D uHeight;
uniform sampler2D uSplat;
uniform sampler2D uMeadow;    // baked tussock / hue field (see bakeMeadow)
uniform sampler2D uShadowMap;
uniform sampler2D uCloudSh;   // baked cloud-shadow coverage
uniform vec2  uCloudShOrigin;
uniform vec2  uShadowC;      // centre of the sun shadow map, world xz
uniform vec4  uCull;         // xy = view direction on the ground, z = cos(half angle)
uniform vec2  uWindLag;      // mean wind direction x the response-lag distance
uniform mat4  uLightMat;
uniform float uShadowTexel;
uniform float uCloudAmount;
uniform float uFogMul;
`;

// ── palette constants -> glsl ────────────────────────────────────────────────
export const GL_PAL = () => /* glsl */`
const vec3 K_SUN        = ${C.sun};
const vec3 K_AMB_SKY    = ${C.ambSky};
const vec3 K_AMB_GND    = ${C.ambGround};
const vec3 K_SHADOW     = ${C.shadowTint};
const vec3 K_HAZE       = ${C.haze};
const vec3 K_MIST       = ${C.mist};
const vec3 K_SKY_ZEN    = ${C.skyZenith};
const vec3 K_SKY_UP     = ${C.skyUpper};
const vec3 K_SKY_MID    = ${C.skyMid};
const vec3 K_SKY_HOR    = ${C.skyHorizon};
const vec3 K_SKY_HORSUN = ${C.skyHorizonSun};
const vec3 K_SKY_ANTI   = ${C.skyAnti};
const vec3 K_SUN_GLOW   = ${C.sunGlow};
const vec3 K_SUN_DISC   = ${C.sunDisc};
const vec3 K_C_TOP      = ${C.cloudTop};
const vec3 K_C_BODY     = ${C.cloudBody};
const vec3 K_C_TERM     = ${C.cloudTerm};
const vec3 K_C_UNDER    = ${C.cloudUnder};
const vec3 K_C_CORE     = ${C.cloudCore};
const vec3 K_C_RIM      = ${C.cloudRim};
const float SUN_I = 1.38;
`;

// ── sky: a painted gradient, not a scattering integral ──────────────────────
export const GL_SKY = /* glsl */`
vec3 skyDome(vec3 d, out float sunMask){
  float y  = d.y;
  float yy = max(y, -0.18);
  // four-stop vertical wash
  vec3 col = mix(K_SKY_HOR, K_SKY_MID, smoothstep(-0.02, 0.13, yy));
  col = mix(col, K_SKY_UP,  smoothstep(0.10, 0.36, yy));
  col = mix(col, K_SKY_ZEN, smoothstep(0.32, 0.86, yy));

  // azimuthal asymmetry: warm toward the sun, cool away from it
  vec2 dh = normalize(d.xz + vec2(1e-5));
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
  float az = dot(dh, sh) * 0.5 + 0.5;
  float horiz = pow(1.0 - clamp(yy, 0.0, 1.0), 3.4);
  col = mix(col, K_SKY_ANTI,    horiz * (1.0-az) * 0.62);
  col = mix(col, K_SKY_HORSUN,  horiz * pow(az, 2.1) * 0.92);

  // Mie forward-scatter halo
  float ang = dot(d, uSunDir);
  float halo = pow(max(ang, 0.0), 7.0);
  float wide = pow(max(ang, 0.0), 1.9);
  col = mix(col, K_SUN_GLOW, clamp(halo*0.72 + wide*0.16, 0.0, 0.9));

  // sun disc (painted 3x oversize, never blown out)
  sunMask = smoothstep(0.99977, 0.99992, ang);
  col = mix(col, K_SUN_DISC*1.9, sunMask);

  // thin cirrus streaks, sheared by the upper wind
  float cd = smoothstep(0.035, 0.30, yy);
  if(cd > 0.001){
    vec2 sp = d.xz / max(y, 0.05) * 0.0016;
    sp += uCloudDrift * 0.00022;
    vec2 w = vec2(fbm2(sp*2.1+vec2(7.3,2.1),3), fbm2(sp*2.1+vec2(1.9,9.4),3));
    float ci = fbm2(vec2(sp.x*0.55, sp.y*3.4) + w*0.6, 4);
    ci = smoothstep(0.10, 0.44, ci) * cd * (0.30 + 0.5*pow(max(ang,0.0),1.4));
    col = mix(col, ${C.cirrus}*(0.92+0.55*pow(max(ang,0.0),3.0)), ci*0.55*uCloudAmount);
  }
  return col;
}
vec3 skyDome(vec3 d){ float s; return skyDome(d, s); }

// The same wash without the sun disc and without the warped cirrus fbm.  A
// reflection in moving water resolves none of that detail — it just costs ten
// octaves of noise per pixel of river and comes back as sparkle.
vec3 skyDomeLite(vec3 d){
  float yy = max(d.y, -0.18);
  vec3 col = mix(K_SKY_HOR, K_SKY_MID, smoothstep(-0.02, 0.13, yy));
  col = mix(col, K_SKY_UP,  smoothstep(0.10, 0.36, yy));
  col = mix(col, K_SKY_ZEN, smoothstep(0.32, 0.86, yy));
  vec2 dh = normalize(d.xz + vec2(1e-5));
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
  float az = dot(dh, sh)*0.5 + 0.5;
  float horiz = pow(1.0 - clamp(yy, 0.0, 1.0), 3.4);
  col = mix(col, K_SKY_ANTI,   horiz*(1.0-az)*0.62);
  col = mix(col, K_SKY_HORSUN, horiz*pow(az, 2.1)*0.92);
  float ang = max(dot(d, uSunDir), 0.0);
  col = mix(col, K_SUN_GLOW, clamp(pow(ang,7.0)*0.72 + pow(ang,1.9)*0.16, 0.0, 0.9));
  return col;
}
`;

// ── cloud coverage field: drives BOTH the visible cumulus and their shadows ──
export const CSH_SPAN = 4600;      // metres covered by the baked cloud-shadow map
export const GL_CLOUDFIELD = /* glsl */`
// The analytic coverage field.  Thirteen octaves of warped fbm — beautiful,
// and far too expensive to evaluate once per fragment of a full screen.  It is
// therefore evaluated ONCE PER FRAME into a 512² map (see CLOUDSH_FS) that is
// centred on where the cloud deck projects along the sun vector; every surface
// in the valley then reads its cloud shadow with a single texture fetch.  The
// field's finest feature is ~95 m across and the map is 9 m/texel, so the baked
// version is indistinguishable from the live one.
float cloudField(vec2 q){
  vec2 p = (q - uCloudDrift) * 0.00071;
  vec2 w = vec2(fbm2(p*1.55+vec2(11.3,4.7),3), fbm2(p*1.55+vec2(37.1,19.2),3));
  float f = fbm2(p + w*0.62, 4);
  float g = fbm2(p*3.7 + w*1.1, 3);
  f = f*0.78 + g*0.22;
  return clamp(smoothstep(-0.035, 0.30, f) * uCloudAmount, 0.0, 1.0);
}
const float CSH_SPAN = ${CSH_SPAN.toFixed(1)};
vec2 cloudShadowUV(vec3 wp){
  float t = (${CFG.cloudDeck.toFixed(1)} - wp.y) / max(uSunDir.y, 0.06);
  vec2 q = wp.xz + uSunDir.xz * t;
  return (q - uCloudShOrigin) / CSH_SPAN + 0.5;
}
float cloudShadow(vec3 wp){
  vec2 uv = cloudShadowUV(wp);
  float c = texture(uCloudSh, clamp(uv, vec2(0.0015), vec2(0.9985))).r;
  return 1.0 - 0.64 * c;
}
`;

// ── sun shadow map with a hand-drawn edge ───────────────────────────────────
export const GL_SHADOW = /* glsl */`
// four taps, no painterly wobble — for surfaces too small to show the edge
float sunShadowFast(vec3 wp, float ndl){
  vec4 lp = uLightMat * vec4(wp, 1.0);
  vec3 pc = lp.xyz / lp.w * 0.5 + 0.5;
  if(pc.z > 0.9995) return 1.0;
  vec2 e = abs(pc.xy - 0.5);
  float fade = 1.0 - smoothstep(0.40, 0.497, max(e.x, e.y));
  if(fade <= 0.001) return 1.0;
  float bias = mix(0.0026, 0.0006, clamp(ndl,0.0,1.0));
  float s = 0.0;
  s += step(pc.z-bias, texture(uShadowMap, pc.xy + vec2( 1.0, 1.0)*uShadowTexel).r);
  s += step(pc.z-bias, texture(uShadowMap, pc.xy + vec2(-1.0, 1.0)*uShadowTexel).r);
  s += step(pc.z-bias, texture(uShadowMap, pc.xy + vec2( 1.0,-1.0)*uShadowTexel).r);
  s += step(pc.z-bias, texture(uShadowMap, pc.xy + vec2(-1.0,-1.0)*uShadowTexel).r);
  return mix(1.0, s*0.25, fade);
}
float sunShadow(vec3 wp, float ndl){
  vec4 lp = uLightMat * vec4(wp, 1.0);
  vec3 pc = lp.xyz / lp.w;
  pc = pc * 0.5 + 0.5;
  if(pc.z > 0.9995) return 1.0;
  vec2 e = abs(pc.xy - 0.5);
  float fade = 1.0 - smoothstep(0.40, 0.497, max(e.x, e.y));
  if(fade <= 0.001) return 1.0;
  float bias = mix(0.0022, 0.00045, clamp(ndl,0.0,1.0));
  // Painterly wobble: the shadow edge is DRAWN, not filtered — the noise offset
  // is what gives the edge its brush character, and it is specified in metres
  // so it stays the same shape whatever the map's span or resolution.  Because
  // the wobble dominates the silhouette, five taps in a cross read the same as
  // the old nine in a box, on every lit fragment in the valley.
  float j0 = vn2(wp.xz*2.7) - 0.5;
  float j1 = vn2(wp.zx*8.3 + 9.7) - 0.5;
  vec2 jo = vec2(j0*2.0 + j1*0.9, j1*1.6 - j0*0.7) * ${(0.34/CFG.shadowSpan).toFixed(8)};
  float r = uShadowTexel*1.7;
  float s = step(pc.z - bias, texture(uShadowMap, pc.xy + jo).r);
  s += step(pc.z - bias, texture(uShadowMap, pc.xy + jo + vec2( r, r)).r);
  s += step(pc.z - bias, texture(uShadowMap, pc.xy + jo + vec2(-r, r)).r);
  s += step(pc.z - bias, texture(uShadowMap, pc.xy + jo + vec2( r,-r)).r);
  s += step(pc.z - bias, texture(uShadowMap, pc.xy + jo + vec2(-r,-r)).r);
  return mix(1.0, s*0.2, fade);
}
`;

// ── the painter's light model ───────────────────────────────────────────────
export const GL_LIGHT = /* glsl */`
// three-colour hue-path ramp; transitions are soft but visibly banded
vec3 ramp3(float t, vec3 shade, vec3 mid, vec3 lit, float soft, float jit){
  float a = smoothstep(0.17 - soft + jit, 0.17 + soft + jit, t);
  float b = smoothstep(0.58 - soft + jit, 0.58 + soft + jit, t);
  return mix(mix(shade, mid, a), lit, b);
}
struct Surf {
  vec3 N; vec3 V; vec3 P;     // normal, surface->eye, world pos
  vec3 shade; vec3 mid; vec3 lit;
  float soft;                 // band softness
  float jit;                  // painterly wobble of the band edges
  float shadow;               // 0 shadowed .. 1 lit
  float trans;                // translucency thickness 0..1
  vec3  transCol;
  float rim; float ao; float ambient;
};
vec3 paint(Surf s){
  float ndl  = dot(s.N, uSunDir);
  // Half-lambert. A 13.5° sun grazes flat ground at ndl≈0.23; plain Lambert
  // would drop the whole valley floor into the shade band and golden hour
  // would read as dusk.
  float wrap = clamp(ndl*0.62 + 0.46, 0.0, 1.0);
  float jit  = s.jit;
  float t    = wrap * mix(0.34, 1.0, s.shadow);
  vec3  col  = ramp3(t, s.shade, s.mid, s.lit, s.soft, jit);

  float litAmt = smoothstep(0.34, 0.86, t);
  col *= mix(vec3(0.94), K_SUN * 1.32, litAmt * 0.62);

  // shadows change hue, they do not go black
  col = mix(col*0.80 + K_SHADOW*0.040, col, s.shadow*0.82 + 0.18);

  // Hemispheric ambient TINTS rather than washes: normalised to unit luminance
  // so it can rotate hue (cool from the sky, warm from the ground bounce)
  // without ever bleaching the palette.
  vec3 hemi = mix(K_AMB_GND, K_AMB_SKY, s.N.y*0.5 + 0.5);
  vec3 hueOnly = hemi / max(dot(hemi, vec3(0.2126,0.7152,0.0722)), 1e-3);
  col *= mix(vec3(1.0), hueOnly, 0.22 * s.ambient * (1.0 - litAmt*0.55));
  col += hemi * 0.052 * s.ambient * s.ao * (1.0 - litAmt*0.85);

  // backlight rim — the connective tissue of the whole image
  float back = smoothstep(0.05, 0.85, dot(s.V, -uSunDir));
  float fres = pow(1.0 - clamp(dot(s.N, s.V), 0.0, 1.0), 4.2);
  col += K_SUN * (fres * back * s.rim * 1.15 * s.shadow);

  // subsurface transmission (grass, leaves, smoke)
  if(s.trans > 0.001){
    // light coming THROUGH the blade, not bouncing off it: only the part of
    // the surface that is nearly edge-on to the sun actually transmits
    float tr = pow(clamp(dot(s.V, -uSunDir), 0.0, 1.0), 3.2);
    float thin = pow(clamp(1.0 - abs(dot(s.N, uSunDir)), 0.0, 1.0), 2.2);
    col += s.transCol * tr * thin * s.trans * s.shadow * 0.52;
  }
  col *= s.ao;
  return col;
}
`;

// ── aerial perspective ──────────────────────────────────────────────────────
export const GL_AIR = /* glsl */`
float gFogAmt = 0.0;   // written by aerial(), read back as the alpha channel so
                       // the post chain knows how far away each pixel is
vec3 aerial(vec3 col, float dist, vec3 V, float worldY){
  dist = (dist == dist) ? min(dist, 1.0e6) : 1.0e6;   // a NaN depth must not
  float d  = max(dist - ${CFG.fogNear.toFixed(1)}, 0.0);   // poison the colour
  float hf = mix(1.0, exp(-max(worldY - 6.0, 0.0)/260.0), 0.72);
  float f  = 1.0 - exp(-pow(d / ${CFG.fogFar.toFixed(1)}, 1.28) * 3.1 * hf * uFogMul);
  float mie = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 3.4);
  vec3 fc = mix(K_HAZE, K_SKY_HORSUN, mie*0.88);
  fc = mix(fc, K_SKY_ANTI, clamp(dot(-V,uSunDir),-1.0,0.0)*-0.32);
  // mist pooling in the valley floor
  float pool = smoothstep(46.0, 8.0, worldY) * smoothstep(120.0, 420.0, dist);
  fc = mix(fc, K_MIST, pool*0.45);
  f  = clamp(f + pool*0.16, 0.0, 1.0);
  gFogAmt = f;
  return mix(col, fc, f);
}
`;

// ── terrain sampling (single source of truth, shared with the CPU) ──────────
export const GL_TERRAIN = /* glsl */`
const float W_SIZE = ${CFG.world.toFixed(1)};
const float W_INV  = ${(1/CFG.world).toFixed(9)};
float terrainH(vec2 p){ return texture(uHeight, p*W_INV + 0.5).r; }
float terrainHLod(vec2 p, float l){ return textureLod(uHeight, p*W_INV + 0.5, l).r; }
vec3 terrainN(vec2 p, float e){
  float l=terrainH(p-vec2(e,0.0)), r=terrainH(p+vec2(e,0.0));
  float d=terrainH(p-vec2(0.0,e)), u=terrainH(p+vec2(0.0,e));
  return normalize(vec3(l-r, 2.0*e, d-u));
}
vec4 splatAt(vec2 p){ return texture(uSplat, p*W_INV + 0.5); }
`;

// ── wind field sampling + boundary-layer profile ────────────────────────────
export const GL_WIND = /* glsl */`
const float WIND_SPAN = ${CFG.windRTSpan.toFixed(1)};
// Beyond the render target we still want visible gust bands rolling over the
// far hills, so the fallback is an analytic version of the same travelling wave.
float windBandAnalytic(vec2 p){
  vec2 q = p - uMeanWind * (uTime * 1.22);
  float a = fbm2(q * 0.0052, 3);
  float b = pn2(q * 0.0168 + 13.0);
  float c = pn2(q * 0.055  + 41.0);
  return clamp(a*1.30 + b*0.55 + c*0.22, -1.2, 1.4);
}
vec4 windSample(vec2 p){
  vec2 uv = (p - uWindOrigin) / WIND_SPAN + 0.5;
  vec2 c = clamp(uv, vec2(0.003), vec2(0.997));
  vec4 w = texture(uWindTex, c);
  float edge = 1.0 - smoothstep(0.40, 0.498, max(abs(uv.x-0.5), abs(uv.y-0.5)));
  // Inside the render target the simulated field IS the answer.  The analytic
  // fallback costs ~20 hash evaluations and is pure waste there — and since a
  // blade's vertices all sample the same point, this branch is perfectly
  // coherent across a warp.  It is the single largest saving in the grass VS.
  if(edge >= 0.999) return w;
  float band = windBandAnalytic(p);
  float gust = clamp(0.80 + band*0.95, 0.05, 2.3);
  vec4 fb = vec4(uMeanWind*gust, gust, clamp(band, 0.0, 1.0)*0.85);
  return mix(fb, w, edge);
}
// logarithmic boundary layer, normalised to the 10 m reference height
float windProfile(float z){
  return log((max(z,0.015) + 0.06) / 0.06) * 0.19523;
}
`;

