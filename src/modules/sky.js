import * as THREE from 'three';
import { CSH_SPAN, GL_AIR, GL_CLOUDFIELD, GL_HASH, GL_LIGHT, GL_NOISE, GL_PAL, GL_SKY, GL_UNI } from './glsl.js';
import { TAU, clamp, fbm2, rng, smoothstep } from './math.js';

/*─────────────────────────── §4  SKY & CUMULUS ──────────────────────────────*/
/* The visible clouds and the shadows they throw are two readings of the *same*
   coverage field, so a shadow always belongs to a cloud you can point at.     */

/* One 1024² atlas of four puff profiles, rendered once at load.
   R = scalloped alpha profile   G = interior density   B = rim mask
   Per-puff variety comes from picking a tile and rotating the billboard, so
   the look is identical to evaluating the noise live — at 1/8 the cost.     */
export const PUFFATLAS_FS = ()=> /* glsl */`
precision highp float;
${GL_HASH}${GL_NOISE}
in vec2 vUv; out vec4 outColor;
void main(){
  vec2 tile = floor(vUv*2.0);
  float seed = (tile.x + tile.y*2.0)*37.13 + 5.0;
  vec2 c = fract(vUv*2.0)*2.0 - 1.0;
  float r = length(c);
  float ang = atan(c.y, c.x);
  vec2 ring = vec2(cos(ang), sin(ang));
  float lob = fbm2(ring*2.35 + seed*13.7, 3) + fbm2(ring*5.1 + seed*29.1, 2)*0.45;
  float R = 0.80 + lob*0.20;
  float a  = smoothstep(R, R-0.34, r);
  float den = fbm2(c*2.6 + seed*31.3, 3)*0.5 + 0.5;
  float edge = smoothstep(R-0.36, R-0.02, r);
  // smoke wants a softer shoulder than cumulus; keep it in alpha
  float aSoft = smoothstep(R, R-0.42, r);
  outColor = vec4(a, den, edge, aSoft);
}`;

/*  The cloud-shadow map.  One 512² fetch of the coverage field, centred on the
    point where the cloud deck projects along the sun vector (at a 13.5° sun
    that is nearly four kilometres up-sun of the camera), re-baked every second
    frame.  Every opaque shader in the valley used to evaluate thirteen octaves
    of warped fbm per fragment for this; now they read one texel.             */
export const CLOUDSH_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}${GL_HASH}${GL_NOISE}${GL_CLOUDFIELD}
in vec2 vUv; out vec4 outColor;
void main(){
  vec2 q = uCloudShOrigin + (vUv - 0.5)*CSH_SPAN;
  float c = smoothstep(0.06, 0.60, cloudField(q));
  outColor = vec4(c, c, c, 1.0);
}`;

export const SKY_VS = /* glsl */`
out vec3 vDir;
void main(){
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = (projectionMatrix * mv).xyww;   // force to the far plane
}`;

export const SKY_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
uniform vec2 uMeanWind;
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_SKY}
in vec3 vDir;
out vec4 outColor;
void main(){
  vec3 d = normalize(vDir);
  float sm;
  vec3 col = skyDome(d, sm);
  // ground-side wash so the dome never shows a hard edge below the horizon
  col = mix(col, mix(K_HAZE, K_MIST, 0.35), smoothstep(0.0, -0.16, d.y));
  outColor = vec4(SAFE3(col), 0.0);
}`;

/*──────────────────────── procedural cumulus congestus ─────────────────────*/
/* Each formation is grown the way a real cumulus grows: a broad base disc,
   then a few towers of decreasing radius, then cauliflower on the shoulders. */

export function buildClouds(){
  const r = rng(90210);
  const puffs = [];        // {cx,cy,cz, rad, seed, hf, fx, fz, fi}
  const GRID = 9, SP = 3050;
  let fi = 0;
  for(let gz=0; gz<GRID; gz++) for(let gx=0; gx<GRID; gx++){
    const fx = (gx-(GRID-1)/2)*SP + (r()-0.5)*SP*0.75;
    const fz = (gz-(GRID-1)/2)*SP + (r()-0.5)*SP*0.75;
    const base = 620 + r()*820;
    const scale = 0.72 + r()*0.85;
    const nTow = 2 + (r()*3|0);
    const baseR = (300 + r()*230) * scale;
    let maxY = 0;
    const local = [];
    // broad flat base
    const nb = 7 + (r()*7|0);
    for(let i=0;i<nb;i++){
      const a = r()*TAU, rr = Math.sqrt(r())*baseR;
      const px = Math.cos(a)*rr, pz = Math.sin(a)*rr*0.72;
      const py = (r()*0.10)*baseR;
      local.push({x:px,y:py,z:pz, rad:(0.44+r()*0.32)*baseR, seed:r()*100});
      maxY = Math.max(maxY, py);
    }
    // towers
    for(let t=0;t<nTow;t++){
      const a = r()*TAU, rr = Math.sqrt(r())*baseR*0.55;
      let tx = Math.cos(a)*rr, tz = Math.sin(a)*rr*0.7;
      const hTop = (0.85 + r()*1.15)*baseR;
      const steps = 4 + (r()*4|0);
      for(let s=0;s<steps;s++){
        const u = s/(steps-1);
        const py = u*hTop;
        const rad = (0.52 - 0.22*u*u + r()*0.13) * baseR * (1.0 - 0.25*u);
        const jx = (r()-0.5)*baseR*0.30*(0.4+u), jz=(r()-0.5)*baseR*0.30*(0.4+u);
        local.push({x:tx+jx, y:py, z:tz+jz, rad, seed:r()*100});
        maxY = Math.max(maxY, py);
        // cauliflower shoulders
        if(s>0 && r()<0.7){
          const aa=r()*TAU, dd=rad*(0.55+r()*0.5);
          local.push({x:tx+jx+Math.cos(aa)*dd, y:py+(r()-0.3)*rad*0.5,
                      z:tz+jz+Math.sin(aa)*dd, rad:rad*(0.42+r()*0.30), seed:r()*100});
        }
      }
    }
    for(const p of local){
      puffs.push({ cx:fx+p.x, cy:base+p.y, cz:fz+p.z, rad:p.rad, seed:p.seed,
                   hf: maxY>1 ? clamp(p.y/maxY,0,1) : 0.5, fx, fz, fi });
    }
    fi++;
  }

  const n = puffs.length;
  const pos  = new Float32Array(n*4*3);
  const cor  = new Float32Array(n*4*2);
  const dat  = new Float32Array(n*4*3);   // rad, seed, heightFrac
  const fcen = new Float32Array(n*4*2);
  for(let i=0;i<n;i++){
    const p=puffs[i];
    for(let v=0;v<4;v++){
      const k=(i*4+v);
      pos[k*3]=p.cx; pos[k*3+1]=p.cy; pos[k*3+2]=p.cz;
      cor[k*2]  = (v===1||v===3)? 1:-1;
      cor[k*2+1]= (v>=2)? 1:-1;
      dat[k*3]=p.rad; dat[k*3+1]=p.seed; dat[k*3+2]=p.hf;
      fcen[k*2]=p.fx; fcen[k*2+1]=p.fz;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('corner',   new THREE.BufferAttribute(cor,2));
  g.setAttribute('pdata',    new THREE.BufferAttribute(dat,3));
  g.setAttribute('fcen',     new THREE.BufferAttribute(fcen,2));
  const idx = new Uint32Array(n*6);
  g.setIndex(new THREE.BufferAttribute(idx,1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0,900,0), 40000);
  return { geom:g, puffs, index:idx, count:n };
}

export const CLOUD_VS = ()=> /* glsl */`
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_CLOUDFIELD}
in vec2 corner; in vec3 pdata; in vec2 fcen;
out vec2 vC; out float vSeed; out float vHF; out vec3 vW; out float vOp;
out vec3 vRight; out vec3 vUp; out vec3 vFwd;
void main(){
  vec3 wc = position + vec3(uCloudDrift.x, 0.0, uCloudDrift.y);
  vec2 fw = fcen + uCloudDrift;
  // the same field that draws the shadow decides whether this puff exists
  float cf = cloudField(fw);
  float op = smoothstep(0.16, 0.52, cf);
  vOp = op;
  if(op < 0.012){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vUp    = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
  vFwd   = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));

  float rad = pdata.x * mix(0.80, 1.06, op);
  float ra = pdata.y*2.399963;                    // golden-angle spin per puff
  float cr = cos(ra), sr = sin(ra);
  vec2 rc = vec2(corner.x*cr - corner.y*sr, corner.x*sr + corner.y*cr);
  vec3 wp = wc + vRight*(rc.x*rad) + vUp*(rc.y*rad*0.86);
  vC = rc; vSeed = pdata.y; vHF = pdata.z; vW = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

export const CLOUD_FS = ()=> /* glsl */`
precision highp float;
${GL_UNI}
${GL_PAL()}${GL_HASH}${GL_NOISE}${GL_LIGHT}${GL_AIR}
uniform sampler2D uPuff;
in vec2 vC; in float vSeed; in float vHF; in vec3 vW; in float vOp;
in vec3 vRight; in vec3 vUp; in vec3 vFwd;
out vec4 outColor;
void main(){
  float r = length(vC);
  if(!(r <= 1.02)) discard;
  // scalloped silhouette + interior density, baked once into the atlas
  vec2 tile = vec2(mod(floor(vSeed*4.0), 2.0), mod(floor(vSeed*2.0), 2.0));
  vec4 pf = texture(uPuff, (clamp(vC,-1.0,1.0)*0.5 + 0.5)*0.5 + tile*0.5);
  // An analytic radial falloff multiplies the baked profile.  It softens the
  // silhouette a touch, and — the reason it is here — it makes a hard-edged
  // opaque quad structurally impossible even if the atlas is unavailable.
  float a = pf.r * smoothstep(1.02, 0.60, r);
  if(!(a > 0.004)) discard;
  float den = pf.g;
  float R = 0.80;
  a *= mix(0.62, 1.0, den);
  a *= vOp;

  // fake volumetric normal from the billboard disc, biased upward (cumulus
  // tops face the sky, bellies face the ground)
  float zz = sqrt(max(0.0, 1.0 - min(r,1.0)*min(r,1.0)));
  vec3 N = normalize(vRight*vC.x + vUp*vC.y + vFwd*zz*0.85 + vec3(0.0, 0.62, 0.0));
  vec3 V = normalize(uCamPos - vW);

  float ndl = dot(N, uSunDir);
  float t = clamp(ndl*0.5 + 0.5, 0.0, 1.0);
  // Height fraction as its own term rather than a nudge to the lambert: it is
  // what separates a stack of towers into readable storeys instead of one grey
  // mass, because a cumulus is lit as much by the sky dome above it as by the
  // sun on its shoulder.
  t = mix(t, clamp(t + vHF*0.36 - 0.10, 0.0, 1.0), 0.78);
  t *= mix(0.68, 1.10, den);
  float term = smoothstep(0.30, 0.54, t);       // the terminator, as a line

  // tighter bands: a painted cloud has an edge you can point at
  vec3 col = ramp3(t, K_C_UNDER, K_C_TERM, K_C_TOP, 0.085, (den-0.5)*0.06);
  // the belly goes violet fast, and it does not pass through grey to get there
  col = mix(mix(K_C_CORE, K_C_UNDER, 0.30), col, smoothstep(0.0, 0.28, t));
  col = mix(col, K_C_BODY, 0.13);
  // the sunlit flank takes the colour of the light that is on it
  col *= mix(vec3(1.0), K_SUN*1.28, term*0.44);

  // silver lining: the rim of a backlit cumulus blazes
  float back = clamp(dot(V, -uSunDir), 0.0, 1.0);
  float edge = pf.b;
  float sunEdge = clamp(dot(normalize(vRight*vC.x + vUp*vC.y), uSunDir)*0.5+0.5, 0.0, 1.0);
  // sharpen the rim from a gradient into a line — same fetch, more drawing
  float rimLine = smoothstep(0.30, 0.84, edge);
  float silver = rimLine * pow(sunEdge, 1.9) * (0.34 + 1.7*pow(back, 1.3));
  col = mix(col, K_C_RIM*1.45, clamp(silver, 0.0, 0.94));
  // ...and a thin cool line down the shaded side, which is the thing that
  // actually reads as "drawn" rather than "rendered"
  col = mix(col, mix(K_C_CORE, K_SHADOW, 0.42),
            rimLine*(1.0-sunEdge)*(1.0-term)*0.36);
  // whole-cloud glow when the sun is directly behind
  col += K_SUN * pow(back, 6.0) * 0.62 * (1.0-edge*0.4);

  float dist = length(uCamPos - vW);
  col = aerial(col, dist*0.55, V, vW.y);
  outColor = vec4(SAFE3(col), clamp(a, 0.0, 1.0));
}`;
