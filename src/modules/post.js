import { GL_HASH, GL_NOISE, GL_PAL, GL_SAFE } from './glsl.js';
import { clamp, smoothstep } from './math.js';

/*──────────────────────── §12  POST — THE FILM PRINT ───────────────────────*/
/* Bloom, watercolour softening, chroma bleed, a custom print curve that pulls
   shadows violet and highlights cream, paper grain, vignette, and an ordered
   dither so the sky gradient can never band.                                 */

export const DEPTH_FS = /* glsl */`
precision mediump float;
out vec4 o;
void main(){ o = vec4(1.0); }`;

export const BRIGHT_FS = ()=> /* glsl */`
precision highp float;
${GL_SAFE}
uniform sampler2D uSrc; uniform float uThresh; uniform float uSoft;
in vec2 vUv; out vec4 outColor;
void main(){
  // the firewall lives here too: one bad texel entering the bloom pyramid gets
  // smeared over a whole neighbourhood by the downsample chain
  vec3 c = SAFE3(texture(uSrc, vUv).rgb);
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  float k = smoothstep(uThresh, uThresh+uSoft, l);
  outColor = vec4(c*k, 1.0);
}`;

export const DOWN_FS = /* glsl */`
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel;
in vec2 vUv; out vec4 outColor;
void main(){
  vec2 t=uTexel;
  vec3 a=texture(uSrc,vUv+t*vec2(-2,-2)).rgb, b=texture(uSrc,vUv+t*vec2(0,-2)).rgb, c=texture(uSrc,vUv+t*vec2(2,-2)).rgb;
  vec3 d=texture(uSrc,vUv+t*vec2(-2, 0)).rgb, e=texture(uSrc,vUv).rgb,               f=texture(uSrc,vUv+t*vec2(2, 0)).rgb;
  vec3 g=texture(uSrc,vUv+t*vec2(-2, 2)).rgb, h=texture(uSrc,vUv+t*vec2(0, 2)).rgb, i=texture(uSrc,vUv+t*vec2(2, 2)).rgb;
  vec3 j=texture(uSrc,vUv+t*vec2(-1,-1)).rgb, k=texture(uSrc,vUv+t*vec2(1,-1)).rgb;
  vec3 l=texture(uSrc,vUv+t*vec2(-1, 1)).rgb, m=texture(uSrc,vUv+t*vec2(1, 1)).rgb;
  vec3 o = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
  outColor = vec4(o,1.0);
}`;

export const UP_FS = /* glsl */`
precision highp float;
uniform sampler2D uSrc; uniform sampler2D uPrev; uniform vec2 uTexel; uniform float uRadius;
in vec2 vUv; out vec4 outColor;
void main(){
  vec2 t=uTexel*uRadius;
  vec3 s = texture(uSrc,vUv+t*vec2(-1,-1)).rgb*1.0 + texture(uSrc,vUv+t*vec2(0,-1)).rgb*2.0
         + texture(uSrc,vUv+t*vec2( 1,-1)).rgb*1.0 + texture(uSrc,vUv+t*vec2(-1,0)).rgb*2.0
         + texture(uSrc,vUv).rgb*4.0                + texture(uSrc,vUv+t*vec2( 1,0)).rgb*2.0
         + texture(uSrc,vUv+t*vec2(-1, 1)).rgb*1.0 + texture(uSrc,vUv+t*vec2(0, 1)).rgb*2.0
         + texture(uSrc,vUv+t*vec2( 1, 1)).rgb*1.0;
  outColor = vec4(texture(uPrev,vUv).rgb + s/16.0, 1.0);
}`;

export const BLUR_FS = /* glsl */`
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform vec2 uDir;
in vec2 vUv; out vec4 outColor;
void main(){
  vec2 d = uTexel*uDir;
  vec3 c = texture(uSrc,vUv).rgb*0.227;
  c += (texture(uSrc,vUv+d*1.3846).rgb + texture(uSrc,vUv-d*1.3846).rgb)*0.316;
  c += (texture(uSrc,vUv+d*3.2308).rgb + texture(uSrc,vUv-d*3.2308).rgb)*0.070;
  outColor = vec4(c,1.0);
}`;

export const COMPOSITE_FS = ()=> /* glsl */`
precision highp float;
uniform sampler2D uScene, uBloom, uSoft;
uniform vec2  uRes;
uniform float uTime, uExposure, uBloomAmt, uPaint, uCA, uVignette, uGrain;
${GL_SAFE}${GL_HASH}${GL_NOISE}
${GL_PAL()}
in vec2 vUv; out vec4 outColor;

/*  Luma FXAA.  A million-blade meadow is the worst possible case for spatial
    aliasing, which is why the scene used to be brute-force supersampled at
    1.3x.  Resolving the edges here instead buys back 1.45x of the entire
    fragment budget — every shaded pixel in the frame — for five extra taps in
    one full-screen pass.  Blades are already floored to ~1 px wide by the grass
    shader, so there is nothing thinner than a pixel for it to smear.         */
// The buffer is linear HDR, where a sunlit blade can sit at 1.5 and a shaded
// one at 0.03.  Thresholding raw linear luma makes FXAA fire almost nowhere in
// the light and everywhere in the dark; folding it through the same Reinhard
// shape the eye will see puts every threshold back in the range the algorithm
// was designed for, which is the difference between it working on grass and not.
float fxLuma(vec3 c){ c = c/(c + vec3(1.0)); return dot(c, vec3(0.2126,0.7152,0.0722)); }
vec3 fxaa(sampler2D tex, vec2 uv, vec2 rcp, vec3 mC){
  float lNW = fxLuma(texture(tex, uv + vec2(-1.0,-1.0)*rcp).rgb);
  float lNE = fxLuma(texture(tex, uv + vec2( 1.0,-1.0)*rcp).rgb);
  float lSW = fxLuma(texture(tex, uv + vec2(-1.0, 1.0)*rcp).rgb);
  float lSE = fxLuma(texture(tex, uv + vec2( 1.0, 1.0)*rcp).rgb);
  float lM  = fxLuma(mC);
  float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE)));
  float lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));
  if(lMax - lMin < max(0.016, lMax*0.055)) return mC;   // flat: leave it alone
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float red = max((lNW+lNE+lSW+lSE)*0.0156, 0.0039);
  float rcpDir = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir*rcpDir, vec2(-6.0), vec2(6.0)) * rcp;
  vec3 a = 0.5*(texture(tex, uv + dir*(1.0/3.0 - 0.5)).rgb
              + texture(tex, uv + dir*(2.0/3.0 - 0.5)).rgb);
  vec3 b = a*0.5 + 0.25*(texture(tex, uv - dir*0.5).rgb + texture(tex, uv + dir*0.5).rgb);
  float lB = fxLuma(b);
  return (lB < lMin || lB > lMax) ? a : b;
}

vec3 tonemap(vec3 x){
  x = max(x, vec3(0.0));
  vec3 a = x*(x*0.36 + 0.42);
  vec3 b = x*(x*0.34 + 0.66) + 0.11;
  return clamp(a/b, 0.0, 1.0);
}
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
vec3 toSRGB(vec3 c){
  return mix(c*12.92, 1.055*pow(max(c,vec3(1e-5)), vec3(1.0/2.4))-0.055, step(0.0031308, c));
}

void main(){
  vec2 uv = vUv;
  vec2 d  = uv - 0.5;
  float r2 = dot(d,d);

  // ── edge resolve, then a whisper of chromatic aberration at the rim ────
  // the centre texel was being fetched four separate times — by FXAA, twice by
  // the aberration and once for the fog weight.  One fetch, passed around.
  vec4 src = texture(uScene, uv);
  vec2 rcp = 1.0/uRes;
  vec3 c = SAFE3(fxaa(uScene, uv, rcp, src.rgb));
  float ca = uCA * (0.0016 + r2*0.0060);
  c.r += texture(uScene, uv + d*ca).r - src.r;
  c.b += texture(uScene, uv - d*ca).b - src.b;
  c = SAFE3(c);
  float fogW = src.a;

  // ── watercolour softening with distance (wet-in-wet, not bokeh) ────────
  vec3 soft = texture(uSoft, uv).rgb;
  float wet = clamp(fogW*0.85, 0.0, 1.0);
  c = mix(c, soft, wet * 0.42 * uPaint);

  // ── chroma bleed: paint runs, pixels do not ────────────────────────────
  // this used to be a flat 20% everywhere, which quietly smeared the colour of
  // near detail too; it belongs to distance, like the softening it accompanies
  {
    float lc = luma(c);
    vec3 chroma = soft - vec3(luma(soft));
    c = mix(c, vec3(lc) + chroma, (0.09 + 0.17*wet)*uPaint);
  }

  // ── bloom ──────────────────────────────────────────────────────────────
  vec3 bl = texture(uBloom, uv).rgb;
  c += bl * uBloomAmt * mix(vec3(1.0), K_SUN, 0.55);

  // ── the print ──────────────────────────────────────────────────────────
  // last chance: the soft/bloom chains are sampled here and a single bad texel
  // anywhere upstream would otherwise survive the tonemap as a solid block
  c = SAFE3(c) * uExposure;
  c = tonemap(c);

  // shadows to violet, highlights to cream — the single biggest lever
  float l = luma(c);
  vec3 shadowPush = mix(vec3(0.90,0.95,1.16), vec3(1.0), smoothstep(0.0, 0.34, l));
  vec3 highPush   = mix(vec3(1.0), vec3(1.055,1.012,0.925), smoothstep(0.44, 0.98, l));
  c *= mix(vec3(1.0), shadowPush, 0.85*uPaint) * mix(vec3(1.0), highPush, 0.9*uPaint);
  // lift: nothing in a Ghibli frame is ever pure black
  vec3 lift = vec3(0.017, 0.021, 0.036)*uPaint;
  c = c*(1.0 - lift) + lift;
  // gentle S and a nudge of saturation in the midtones
  c = mix(c, c*c*(3.0-2.0*c), 0.16*uPaint);
  l = luma(c);
  float satBoost = 1.0 + 0.16*uPaint*smoothstep(0.10,0.42,l)*(1.0-smoothstep(0.62,0.96,l));
  c = mix(vec3(l), c, satBoost);

  // ── paper tooth ────────────────────────────────────────────────────────
  // two gradient-noise evaluations, not four: this is a +/-3% multiplier on the
  // final colour, and it runs on every pixel of the frame
  vec2 gp = uv*uRes/2.4;
  float grain = pn2(gp*0.5)*0.62 + pn2(gp*0.13 + 11.0)*0.38;
  float fibre = pn2(vec2(uv.x*uRes.x*0.06, uv.y*uRes.y*0.9));
  c *= 1.0 + grain*0.030*uGrain + fibre*0.010*uGrain;

  // ── vignette, warm-dark ────────────────────────────────────────────────
  float vig = pow(clamp(1.0 - r2*1.15, 0.0, 1.0), 1.55);
  c *= mix(vec3(1.0), mix(vec3(0.62,0.60,0.66), vec3(1.0), vig), uVignette);

  c = toSRGB(clamp(c, 0.0, 1.0));

  // ── ordered dither: the sky must never band ────────────────────────────
  float dth = fract(dot(gl_FragCoord.xy, vec2(0.7548776662, 0.5698402909)));
  c += (dth - 0.5)/255.0;
  outColor = vec4(c, 1.0);
}`;
