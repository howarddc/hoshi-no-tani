import * as THREE from 'three';
import { CFG } from './config.js';
import { DEG } from './math.js';
import { FHEAD, VHEAD } from './glsl.js';

/*  The shared uniform block and the material factories.
    G holds the uniform OBJECTS that every shader shares; U() returns a
    shallow copy, so all materials keep pointing at the same objects and a
    single write to G.uTime.value updates every one of them at once.  A
    material needing its own value for a uniform must be given its own
    object — see the uni/dUni pair in the tree setup.

    These live outside main.js because train.js builds materials during its
    own construction, and main.js is the entry: nothing can import from it. */

export const SUN = (()=>{
  const el=CFG.sunElev*DEG, az=CFG.sunAzim*DEG;
  return new THREE.Vector3(Math.sin(az)*Math.cos(el), Math.sin(el), Math.cos(az)*Math.cos(el)).normalize();
})();

export const G = {
  uTime:        { value:0 },
  uSunDir:      { value:SUN.clone() },
  uCamPos:      { value:new THREE.Vector3() },
  uWindOrigin:  { value:new THREE.Vector2() },
  uCloudDrift:  { value:new THREE.Vector2() },
  uMeanWind:    { value:new THREE.Vector2(3,1) },
  uWindTex:     { value:null },
  uHeight:      { value:null },
  uSplat:       { value:null },
  uMeadow:      { value:null },
  uShadowMap:   { value:null },
  uCloudSh:     { value:null },
  uCloudShOrigin:{ value:new THREE.Vector2() },
  uLightMat:    { value:new THREE.Matrix4() },
  uShadowTexel: { value:1/2048 },
  uPuff:        { value:null },
  uProxyC:      { value:new THREE.Vector2() },
  uShadowC:     { value:new THREE.Vector2() },
  uCull:        { value:new THREE.Vector4(0,0,-1.1,0) },
  uWindLag:     { value:new THREE.Vector2() },
  uCloudAmount: { value:1.0 },
  uFogMul:      { value:1.0 },
};
export const U = extra => Object.assign({}, G, extra||{});
export const RSM = (vs, fs, uni, opt)=> new THREE.RawShaderMaterial(Object.assign({
  vertexShader: VHEAD + vs, fragmentShader: FHEAD + fs,
  uniforms: uni, glslVersion: THREE.GLSL3,
}, opt||{}));
export const TRANSP = {
  transparent:true, depthWrite:false, blending:THREE.CustomBlending,
  blendSrc:THREE.SrcAlphaFactor, blendDst:THREE.OneMinusSrcAlphaFactor,
  blendEquation:THREE.AddEquation,
  blendSrcAlpha:THREE.ZeroFactor, blendDstAlpha:THREE.OneFactor,
  blendEquationAlpha:THREE.AddEquation,
};
