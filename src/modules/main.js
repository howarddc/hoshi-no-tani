import * as THREE from 'three';

import { CFG, HALF, HM, QUALITY, WS } from './config.js';
import { C, LIN, P } from './palette.js';
import { NO_CAST, addBulk, addMesh, setDepth } from './scene-contract.js';
import { DEG, TAU, clamp, lerp, rng } from './math.js';
import { FHEAD, VHEAD } from './glsl.js';
import { G, RSM, SUN, TRANSP, U } from './materials.js';
import { makeDF } from './field.js';
import { TRACK } from './track-ref.js';
import { BRIDGE, MEADOW_RES, PROXY_TERRAIN_VS, RIDGE_FS, RIDGE_VS, RIVER_PTS, TERRAIN_FS, TERRAIN_VS, bakeMeadow, bakeSplat, bakeTerrain, buildProxyTerrainGeometry, buildRidgeBand, buildTerrainGeometry, carveTrackBed, heightData, meadowData, pathDistance, riverWidth, sampleHeight, splatData, waterLevel } from './terrain.js';
import { CLOUDSH_FS, CLOUD_FS, CLOUD_VS, PUFFATLAS_FS, SKY_FS, SKY_VS, buildClouds } from './sky.js';
import { WINDVIEW_FS, WIND_FS, WindSys, updateWind, windAtJS } from './wind.js';
import { GrassField } from './grass.js';
import { WATER_FS, WATER_VS, buildRiverGeometry } from './river.js';
import { TREE_FS, TREE_VS, finishMesh, makeTree, scatterTrees } from './trees.js';
import { BR, brPoint, buildBridgeCore, buildBridgeStones, pierCentres } from './viaduct.js';
import { PAINTED_FS, PAINTED_VS, SOLID_FS, SOLID_VS, STONE_FS, STONE_VS, buildPermanentWay, buildTrack, roundedBoxGeometry, trackAdjust, trackPose } from './railway.js';
import { buildMillWheel, buildVillage } from './village.js';
import { BIRD_FS, MOTE_FS, Particles, SMOKE_FS, Train } from './train.js';
import { buildCorgis } from './corgi.js';
import { HEART_FS, Treats, buildTreatHand } from './treats.js';
import { BLUR_FS, BRIGHT_FS, COMPOSITE_FS, DEPTH_FS, DOWN_FS, UP_FS } from './post.js';
import { Walker } from './walker.js';
import { Audio } from './audio.js';



/*  What remains here is the boot sequence, the frame loop and the sections not
    yet carved out into modules.  The module map and the extraction method live
    in AGENTS.md §9; the shadow contract every mesh must honour is in
    scene-contract.js.                                                        */


/*──────────────────────────── §15  BOOT & MAIN LOOP ────────────────────────*/

const $ = s=>document.querySelector(s);
const setStat=(s,p)=>{ $('#stat').textContent=s; if(p!==undefined) $('#barIn').style.width=(p*100).toFixed(0)+'%'; };
const idle = ()=> new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));

const renderer = new THREE.WebGLRenderer({ antialias:false, powerPreference:'high-performance',
  stencil:false, alpha:false });
renderer.setClearColor(0x0e1219, 1);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // we encode sRGB ourselves
renderer.autoClear = false;
$('#app').appendChild(renderer.domElement);
const gl = renderer.getContext();
const hasFloatLinear = !!gl.getExtension('OES_texture_float_linear');
gl.getExtension('EXT_color_buffer_float');
gl.getExtension('EXT_color_buffer_half_float');
gl.getExtension('EXT_float_blend');

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CFG.fov, 1, 0.12, 14000);
const sunCam = new THREE.OrthographicCamera(-1,1,1,-1, 1, 1400);
sunCam.matrixWorldAutoUpdate = true;
const reflCam = new THREE.PerspectiveCamera(CFG.fov, 1, 0.12, 14000);
reflCam.matrixWorldAutoUpdate = false;

// Every depth-only material: the shadow map's colour attachment is written by
// the driver and never read by anything, which is ~16 MB of pointless
// bandwidth per shadow pass.  colorWrite:false also lets the hardware take its
// double-speed depth-only path.
const DSM = (vs, uni, opt)=> RSM(vs, DEPTH_FS, uni,
  Object.assign({ colorWrite:false }, opt||{}));

/*──────── fullscreen quad plumbing ────────*/
const quadGeo = (()=>{
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1,-1,0, 3,-1,0, -1,3,0]),3));
  g.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array([0,0, 2,0, 0,2]),2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  return g;
})();
const quadCam = new THREE.Camera();
const quadScene = new THREE.Scene();
const quadMesh = new THREE.Mesh(quadGeo, null);
quadMesh.frustumCulled=false; quadScene.add(quadMesh);
function blit(mat, target){
  quadMesh.material = mat;
  renderer.setRenderTarget(target||null);
  renderer.render(quadScene, quadCam);
}
const postMat = (fs, uni)=> new THREE.RawShaderMaterial({
  vertexShader:'precision highp float;\nin vec3 position;\nin vec2 uv;\nout vec2 vUv;\nvoid main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }',
  fragmentShader:'precision highp float;\n'+fs, uniforms:uni, glslVersion:THREE.GLSL3, depthTest:false, depthWrite:false });

/*──────── state ────────*/
const QS = new URLSearchParams(location.search);
const State = {
  // Defaults are deliberately conservative: the valley opens on Low with a
  // thin sward so it comes up quickly and runs on modest hardware. Raise with
  // the 1-4 keys, the settings panel (H), or ?q= and ?d=.
  q: QS.has('q') ? clamp(+QS.get('q'),0,3) : 0,
  density: QS.has('d') ? +QS.get('d') : 0.20,
  scale:   QS.has('s') ? +QS.get('s') : 1.0,
  exposure:1.0, bloom:1.0, paint:1.0,
  autoQ: !QS.has('q'),
  showWind:false, paused:false, running:false,
  fps:60, frameMs:16, adapt:1.0,
  trainActive:false, trainDist:999, trainPan:0, grassNear:1,
};
if(QS.has('t')) window.__startT = +QS.get('t');
let sceneRT, bloomRTs=[], upRTs=[], softRT=[], shadowRT=null, windRT=null, reflRT=null;
let composite, brightMat, downMats=[], upMats=[], blurMats=[], windMat, windViewMat, softDownMat;
const audio = new Audio();
let walker, grass, train, smoke, motes, birdsP, cloudObj, skyMesh, waterMesh, terrainMesh;
let trees=[], ridges=[], reflectSet=[];
let millWheel=null, villageSmokers=[], proxyTerrain=null, puffRT=null;
let corgis=null, treats=null, hearts=null;
let cloudShRT=null, cloudShMat=null, lifeGroup=null;

/*──────── the whole build ────────*/
async function boot(){
  setStat('carving the valley', 0.04); await idle();
  bakeTerrain(p=>setStat('carving the valley', 0.04+p*0.30));
  await idle();

  setStat('laying the permanent way', 0.36); await idle();
  buildTrack();
  // stamp the railway grade into the heightmap
  for(let y=0;y<HM;y++){
    const wz=(y/(HM-1))*WS-HALF;
    for(let x=0;x<HM;x++){
      const wx=(x/(HM-1))*WS-HALF;
      const f=TRACK.field(wx,wz);
      if(f.d<34) heightData[y*HM+x]=trackAdjust(wx,wz,heightData[y*HM+x]);
    }
  }
  // ...then guarantee the formation: a cutting can always be dug, so the line
  // is never buried even where the embankment rule refused to fill
  carveTrackBed();
  await idle();

  // height texture — the single source of truth
  const hType = hasFloatLinear ? THREE.FloatType : THREE.HalfFloatType;
  let hArr = heightData;
  if(hType === THREE.HalfFloatType){
    hArr = new Uint16Array(HM*HM);
    const f32=new Float32Array(1), i32=new Int32Array(f32.buffer);
    const toHalf=(v)=>{ f32[0]=v; const x=i32[0];
      let bits=(x>>16)&0x8000, m=(x>>12)&0x07ff, e=(x>>23)&0xff;
      if(e<103) return bits;
      if(e>142){ bits|=0x7c00; return bits; }
      if(e<113){ m|=0x0800; bits|=(m>>(114-e)); return bits; }
      bits|=((e-112)<<10)|(m>>1); bits+=m&1; return bits; };
    for(let i=0;i<HM*HM;i++) hArr[i]=toHalf(heightData[i]);
  }
  const heightTex = new THREE.DataTexture(hArr, HM, HM, THREE.RedFormat, hType);
  heightTex.minFilter = heightTex.magFilter = THREE.LinearFilter;
  heightTex.wrapS = heightTex.wrapT = THREE.ClampToEdgeWrapping;
  heightTex.internalFormat = hType===THREE.FloatType ? 'R32F' : 'R16F';
  heightTex.needsUpdate = true;
  G.uHeight.value = heightTex;

  setStat('painting the ground', 0.42); await idle();
  bakeSplat();
  const splatTex = new THREE.DataTexture(splatData, CFG.dataRes, CFG.dataRes, THREE.RGBAFormat, THREE.UnsignedByteType);
  splatTex.minFilter = splatTex.magFilter = THREE.LinearFilter;
  splatTex.wrapS = splatTex.wrapT = THREE.ClampToEdgeWrapping;
  splatTex.needsUpdate = true;
  G.uSplat.value = splatTex;
  bakeMeadow();
  const meadowTex = new THREE.DataTexture(meadowData, MEADOW_RES, MEADOW_RES,
    THREE.RGBAFormat, THREE.UnsignedByteType);
  meadowTex.minFilter = meadowTex.magFilter = THREE.LinearFilter;
  meadowTex.wrapS = meadowTex.wrapT = THREE.ClampToEdgeWrapping;
  meadowTex.needsUpdate = true;
  G.uMeadow.value = meadowTex;
  await idle();

  /*── sky ──*/
  /*  The sky is drawn LAST, not first.  SKY_VS forces every vertex to the far
      plane, so with an ordinary less-equal depth test it survives exactly where
      nothing else was drawn and is rejected everywhere else — for free, by the
      hardware.  Drawn first (depth test off) it was shading a full screen of
      four-stop gradient, Mie halo and warped cirrus fbm, and then having almost
      all of it painted over by the valley.                                    */
  skyMesh = new THREE.Mesh(new THREE.BoxGeometry(2,2,2),
    RSM(SKY_VS, SKY_FS(), U(), {side:THREE.BackSide, depthWrite:false, depthTest:true}));
  skyMesh.frustumCulled=false; skyMesh.renderOrder=9;
  addMesh(scene, skyMesh, NO_CAST);

  /*── distant ridges ──*/
  setStat('raising the far hills', 0.46); await idle();
  const ridgeDefs=[
    { r:1520, h:210, seed:11, near:LIN.ridgeNear,  far:LIN.ridgeMid,  mix:0.25, y:-40 },
    { r:2450, h:330, seed:22, near:LIN.ridgeMid,   far:LIN.ridgeFar,  mix:0.55, y:-90 },
    { r:3700, h:470, seed:33, near:LIN.ridgeFar,   far:LIN.ridgeFurthest, mix:0.85, y:-160 },
    { r:5400, h:640, seed:44, near:LIN.ridgeFurthest, far:LIN.haze,   mix:0.95, y:-260 },
  ];
  for(const d of ridgeDefs){
    const m = new THREE.Mesh(buildRidgeBand(d.r, d.h, d.seed, 220),
      RSM(RIDGE_VS, RIDGE_FS(), U({
        uNearCol:{value:new THREE.Vector3(d.near.r,d.near.g,d.near.b)},
        uFarCol:{value:new THREE.Vector3(d.far.r,d.far.g,d.far.b)},
        uMix:{value:d.mix}, uBaseY:{value:d.y},
      }), {side:THREE.DoubleSide}));
    m.frustumCulled=false; m.renderOrder=-500;
    addMesh(scene, m, NO_CAST); ridges.push(m);
  }

  /*── terrain ──*/
  setStat('growing the meadow', 0.50); await idle();
  // 320 divisions still puts the innermost cell at 15 cm — the warp packs the
  // grid so tightly underfoot that a third of the triangles were smaller than
  // a grass blade, under a metre of grass
  const tGeo = buildTerrainGeometry(320, 1190, 1.62, CFG.spawn.x, CFG.spawn.z);
  terrainMesh = new THREE.Mesh(tGeo, RSM(TERRAIN_VS(), TERRAIN_FS(), U()));
  terrainMesh.frustumCulled=false; terrainMesh.renderOrder=1;
  // NO_CAST is not an oversight: the clipmap is warped around the camera, so
  // its triangles slide as you walk and its shadow would crawl.  proxyTerrain
  // below is the fixed-grid stand-in that casts on its behalf.
  addMesh(scene, terrainMesh, NO_CAST);
  // the coarse stand-in that the shadow and reflection passes use instead
  // 192 divisions over ±288 m is an exact 3 m cell, which is what uProxyC is
  // snapped to — a proxy grid that slides against the terrain under it makes
  // its own artefacts crawl, and crawling artefacts are the ones you see
  proxyTerrain = new THREE.Mesh(buildProxyTerrainGeometry(192, 288),
    RSM(PROXY_TERRAIN_VS(), TERRAIN_FS(), U({ uProxyDrop:{value:0.0} })));
  proxyTerrain.frustumCulled = false; proxyTerrain.visible = false;
  proxyTerrain.renderOrder = 1;
  proxyTerrain.userData.proxy = true;
  proxyTerrain.userData.beauty = proxyTerrain.material;
  addMesh(scene, proxyTerrain, DSM(PROXY_TERRAIN_VS(),
    U({ uProxyDrop:{value:1.05} }), {side:THREE.DoubleSide}));

  /*── river ──*/
  const piers = pierCentres().map(pc=>{
    const p = brPoint(pc, 0, 0);
    return new THREE.Vector4(p[0], p[2], BR.pierW*0.62, 0);
  }).slice(0,8);
  const pierN = piers.length;
  while(piers.length < 8) piers.push(new THREE.Vector4(0,0,0,0));   // fill the declared array
  waterMesh = new THREE.Mesh(buildRiverGeometry(),
    RSM(WATER_VS(), WATER_FS(), U({
      uReflect:{value:null}, uReflectOn:{value:0}, uReflectPlane:{value:BR.water},
      uPiers:{value:piers}, uPierN:{value:pierN},
    }), {side:THREE.DoubleSide}));
  waterMesh.frustumCulled=false; waterMesh.renderOrder=3;
  addMesh(scene, waterMesh, NO_CAST);

  /*── clouds ──*/
  setStat('stacking the cumulus', 0.56); await idle();
  cloudObj = buildClouds();
  const cloudMesh = new THREE.Mesh(cloudObj.geom,
    RSM(CLOUD_VS(), CLOUD_FS(), U(), Object.assign({side:THREE.DoubleSide, depthTest:true}, TRANSP)));
  cloudMesh.frustumCulled=false; cloudMesh.renderOrder=10;
  // the cumulus cast through the baked coverage map (§4), not the shadow pass
  addMesh(scene, cloudMesh, NO_CAST);
  cloudObj.mesh = cloudMesh;

  /*── viaduct ──*/
  setStat('building the viaduct', 0.62); await idle();
  const coreMat = RSM(SOLID_VS(), SOLID_FS(C.mortar, `mix(${C.mortar},${C.sShade},0.5)`, C.sDeep), U(), {side:THREE.DoubleSide});
  const core = new THREE.Mesh(buildBridgeCore(), coreMat);
  core.frustumCulled=true; core.renderOrder=2;
  addMesh(scene, core, DSM(SOLID_VS(), U(), {side:THREE.DoubleSide}));
  reflectSet.push(core);

  const stoneList = buildBridgeStones();
  const sGeo = roundedBoxGeometry(0.30);
  const sA = new Float32Array(stoneList.length*4), sB = new Float32Array(stoneList.length*4);
  stoneList.forEach((s,i)=>{
    sA[i*4]=s[0]; sA[i*4+1]=s[1]; sA[i*4+2]=s[2]; sA[i*4+3]=s[8];
    sB[i*4]=s[3]; sB[i*4+1]=s[4]; sB[i*4+2]=s[5]; sB[i*4+3]=s[7];
  });
  sGeo.setAttribute('sA', new THREE.InstancedBufferAttribute(sA,4));
  sGeo.setAttribute('sB', new THREE.InstancedBufferAttribute(sB,4));
  sGeo.instanceCount = stoneList.length;
  sGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(BRIDGE.x, BR.deck-8, BRIDGE.z), 160);
  const stoneUni = U({ uAx:{value:new THREE.Vector2(BR.ax[0],BR.ax[1])},
                       uPp:{value:new THREE.Vector2(BR.pp[0],BR.pp[1])} });
  const stones = new THREE.Mesh(sGeo, RSM(STONE_VS(), STONE_FS(), stoneUni, {side:THREE.DoubleSide}));
  stones.frustumCulled=true; stones.renderOrder=2;
  addMesh(scene, stones, DSM(STONE_VS(), stoneUni, {side:THREE.DoubleSide}));
  reflectSet.push(stones);

  const way = new THREE.Mesh(buildPermanentWay(),
    RSM(SOLID_VS(), SOLID_FS(C.sB, `mix(${C.sShade},${C.pathShade},0.4)`, C.sDeep), U(), {side:THREE.DoubleSide}));
  way.frustumCulled=false; way.renderOrder=2;
  addMesh(scene, way, DSM(SOLID_VS(), U(), {side:THREE.DoubleSide}));
  reflectSet.push(way);

  /*── village ──*/
  setStat('lighting the village', 0.68); await idle();
  const vil = buildVillage();
  villageSmokers = vil.smokers;
  const paintedMat = RSM(PAINTED_VS(), PAINTED_FS(), U(), {side:THREE.DoubleSide});
  const vMesh = new THREE.Mesh(vil.geom, paintedMat);
  vMesh.frustumCulled=true; vMesh.renderOrder=2;
  const paintedDepth = DSM(PAINTED_VS(), U(), {side:THREE.DoubleSide});
  addMesh(scene, vMesh, paintedDepth);
  millWheel = new THREE.Mesh(buildMillWheel(vil.mill), paintedMat);
  millWheel.position.set(vil.mill.x, vil.mill.y, vil.mill.z);
  millWheel.rotation.y = vil.mill.yaw;
  millWheel.frustumCulled=true;
  addMesh(scene, millWheel, paintedDepth);   // shares the village's depth pass

  /*── trees ──*/
  setStat('planting the woods', 0.74); await idle();
  const groups = scatterTrees();
  const heightOf = { broadleaf:11.5, pine:14.5, poplar:15.0, willow:9.5 };
  const flexOf   = { broadleaf:1.0, pine:0.52, poplar:0.80, willow:1.75 };
  for(const key in groups){
    const list = groups[key];
    const [kind, detailS] = key.split('_'); const detail = +detailS;
    const geom = finishMesh(makeTree(kind, detail, 1000 + kind.length*97 + detail*13));
    const iPos = new Float32Array(list.length*4), iVar = new Float32Array(list.length*4);
    let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
    list.forEach((o,i)=>{
      const y = sampleHeight(o.x,o.z)-0.35;
      iPos[i*4]=o.x; iPos[i*4+1]=y; iPos[i*4+2]=o.z; iPos[i*4+3]=o.scale;
      iVar[i*4]=o.rot; iVar[i*4+1]=o.hue; iVar[i*4+2]=o.phase; iVar[i*4+3]=0;
      minX=Math.min(minX,o.x); maxX=Math.max(maxX,o.x);
      minZ=Math.min(minZ,o.z); maxZ=Math.max(maxZ,o.z);
    });
    geom.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos,4));
    geom.setAttribute('iVar', new THREE.InstancedBufferAttribute(iVar,4));
    geom.instanceCount = list.length;
    geom.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((minX+maxX)/2, 60, (minZ+maxZ)/2),
      Math.hypot(maxX-minX, maxZ-minZ)/2 + 60);
    const uni  = U({ uTreeH:{value:heightOf[kind]}, uFlex:{value:flexOf[kind]},
                     uCullR:{value:0.0} });
    // the depth variant needs its own uniform object so it can carry the
    // shadow-volume radius without the beauty pass inheriting it
    const dUni = U({ uTreeH:{value:heightOf[kind]}, uFlex:{value:flexOf[kind]},
                     uCullR:{value:CFG.shadowSpan*0.76} });
    const m = new THREE.Mesh(geom, RSM(TREE_VS(), TREE_FS(), uni, {side:THREE.DoubleSide}));
    m.frustumCulled=false; m.renderOrder=2;
    addMesh(scene, m, DSM(TREE_VS(), dUni, {side:THREE.DoubleSide}));
    trees.push(m);
    if(detail>0) reflectSet.push(m);
  }

  /*── train ──*/
  setStat('raising steam', 0.82); await idle();
  train = new Train(scene, U());
  setDepth(train.group, DSM(PAINTED_VS(), U(), {side:THREE.DoubleSide}));
  reflectSet.push(train.group);

  /*── corgis ──*/
  // They share the train's painted material, so they cost no extra shader
  // compile; the depth variant is their own because setDepth walks a subtree
  // and the train's is already in place.
  setStat('letting the dogs out', 0.85); await idle();
  corgis = buildCorgis(paintedMat, 6);
  setDepth(corgis.group, DSM(PAINTED_VS(), U(), {side:THREE.DoubleSide}));
  scene.add(corgis.group);

  // the biscuit you hold out (§17). A viewmodel 0.4 m from the eye: it casts
  // no shadow, and the reflection pass drops it since it is not in reflectSet.
  const handMesh = new THREE.Mesh(buildTreatHand(), paintedMat);
  handMesh.frustumCulled = false; handMesh.renderOrder = 8; handMesh.visible = false;
  addMesh(scene, handMesh, NO_CAST);

  /*── particles ──*/
  // one container, so the shadow and reflection passes skip all of them with a
  // single flag rather than a save-record per mesh per pass
  lifeGroup = new THREE.Group();
  addBulk(scene, lifeGroup);
  smoke  = new Particles(lifeGroup, U(), 520,  SMOKE_FS(), 22, true);
  motes  = new Particles(lifeGroup, U(), 2400, MOTE_FS(),  24, false);
  birdsP = new Particles(lifeGroup, U(), 60,   BIRD_FS(),  21, false);
  hearts = new Particles(lifeGroup, U(), 140,  HEART_FS(), 25, true);
  treats = new Treats(handMesh, hearts);
  initMotes(); initBirds();

  train.onChuff = (wp, fwd, spd)=>{
    for(let i=0;i<2;i++){
      smoke.spawn({ x:wp.x+(Math.random()-0.5)*0.25, y:wp.y+0.1, z:wp.z+(Math.random()-0.5)*0.25,
        vx:fwd.x*spd*0.55+(Math.random()-0.5)*0.9, vy:5.4+Math.random()*2.6,
        vz:fwd.z*spd*0.55+(Math.random()-0.5)*0.9,
        life:16+Math.random()*9, size:0.85+Math.random()*0.5, seed:Math.random()*100,
        kind:0, op:0.92 });
    }
    const d = camera.position.distanceTo(wp);
    audio.chuff(clamp(0.34*140/(50+d),0.02,0.4), 0, clamp(1.0-d*0.0009,0.35,1.0));
  };

  /*── grass ──*/
  setStat('sowing a million blades', 0.88); await idle();
  grass = new GrassField(scene, G, QUALITY[State.q]);
  // seed the field's density before the first build, or it builds a full-
  // density sward and then throws it away when bindInput syncs the slider
  grass.density = State.density;
  grass.build(QUALITY[State.q]);

  /*── camera / rig ──*/
  walker = new Walker(camera);
  walker.groundY = sampleHeight(walker.pos.x, walker.pos.z);
  walker.onFootstep = (spd,pos)=>{
    const stone = pathDistance(pos.x,pos.z) < 2.6;
    audio.footstep(spd, stone);
  };

  // diagnostics
  {
    let mn=1e9, mx=-1e9;
    for(let i=0;i<heightData.length;i+=7){ const v=heightData[i]; if(v<mn)mn=v; if(v>mx)mx=v; }
    const sh = sampleHeight(CFG.spawn.x, CFG.spawn.z);
    window.__dbg = { hMin:mn, hMax:mx, spawnH:sh, eye:sh+CFG.eyeHeight,
      water:BR.water, deck:BR.deck, sun:[SUN.x,SUN.y,SUN.z],
      brAx:BR.ax, hType: hasFloatLinear?'float':'half' };
    console.log('DBG '+JSON.stringify(window.__dbg));
  }

  setStat('mixing the paint', 0.94); await idle();
  buildTargets();
  // one-off: bake the cumulus / smoke puff profiles into a mip-mapped atlas
  puffRT = new THREE.WebGLRenderTarget(1024, 1024, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, depthBuffer: false });
  blit(postMat(PUFFATLAS_FS(), {}), puffRT);
  G.uPuff.value = puffRT.texture;
  // the cloud-shadow map: baked every other frame, read by every opaque shader
  cloudShRT = new THREE.WebGLRenderTarget(512, 512, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false, depthBuffer: false });
  // uCloudSh is nulled here so the bake can never form a feedback loop with its
  // own target, whatever the driver decides to keep after dead-code removal
  cloudShMat = postMat(CLOUDSH_FS(), U({ uCloudSh:{ value:null } }));
  G.uCloudSh.value = cloudShRT.texture;
  cloudShadowPass();
  renderer.setRenderTarget(null);
  window.addEventListener('resize', buildTargets);
  bindInput();
  setStat('ready', 1.0);
  $('#enter').classList.add('on');
  for(const b of document.querySelectorAll('#qPreset button'))
    b.classList.toggle('on', +b.dataset.q === State.q);
  State.running = true;
  window.__ready = true; window.__W = walker; window.__H = sampleHeight;
  window.__corgis = corgis; window.__treats = treats;
  // pre-roll a few frames so the first visible frame is fully warmed
  for(let i=0;i<3;i++){ frame(performance.now()); }
  requestAnimationFrame(loop);
}

/*──────── render targets ────────*/
function buildTargets(){
  const q = QUALITY[State.q];
  const dpr = Math.min(window.devicePixelRatio||1, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, true);
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  reflCam.aspect = camera.aspect; reflCam.fov = camera.fov; reflCam.updateProjectionMatrix();

  // The scene buffer must never be SMALLER than the canvas.  If it is, the
  // composite magnifies it (blurry) while FXAA has already resolved edges at
  // the lower resolution and cannot put the detail back (jagged) — you get both
  // at once, which is exactly what happens on a hi-dpi display.  So the render
  // scale multiplies the device ratio rather than replacing it, and every
  // preset above Low is >= 1.0 so the final resolve is always a downsample.
  const want = dpr * q.px * State.scale;
  const px = q.px < 1.0 ? want
           : Math.max(dpr, Math.min(want, Math.max(dpr, 1.40)));
  const W = Math.max(320, Math.floor(window.innerWidth*px));
  const H = Math.max(240, Math.floor(window.innerHeight*px));

  // the angular size of one rendered pixel — the floor for grass blade width
  const angPerPx = 2*Math.tan(CFG.fov*DEG/2)/H;
  if(grass && grass.built) grass.setAngular(angPerPx);
  ANG_PER_PX = angPerPx;

  if(sceneRT) sceneRT.dispose();
  sceneRT = new THREE.WebGLRenderTarget(W,H,{
    type:THREE.HalfFloatType, format:THREE.RGBAFormat,
    minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter,
    depthBuffer:true, stencilBuffer:false, samples: 0,   // supersampled instead
  });
  bloomRTs.forEach(r=>r.dispose()); bloomRTs=[];
  upRTs.forEach(r=>r.dispose()); upRTs=[];
  const mkRT=(w,h)=>new THREE.WebGLRenderTarget(w,h,{type:THREE.HalfFloatType, format:THREE.RGBAFormat,
      minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter, depthBuffer:false});
  let bw=Math.max(2,W>>1), bh=Math.max(2,H>>1);
  for(let i=0;i<q.bloomLv;i++){
    bloomRTs.push(mkRT(bw,bh));
    upRTs.push(mkRT(bw,bh));
    bw=Math.max(2,bw>>1); bh=Math.max(2,bh>>1);
  }
  softRT.forEach(r=>r.dispose()); softRT=[];
  for(let i=0;i<2;i++) softRT.push(new THREE.WebGLRenderTarget(Math.max(2,W>>3), Math.max(2,H>>3),
    {type:THREE.HalfFloatType, format:THREE.RGBAFormat, minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter, depthBuffer:false}));

  if(reflRT) reflRT.dispose();
  reflRT = new THREE.WebGLRenderTarget(Math.max(2,W>>1), Math.max(2,H>>1),
    {type:THREE.HalfFloatType, format:THREE.RGBAFormat, minFilter:THREE.LinearFilter,
     magFilter:THREE.LinearFilter, depthBuffer:true});

  if(!shadowRT || shadowRT.width!==q.shadow){
    if(shadowRT) shadowRT.dispose();
    shadowRT = new THREE.WebGLRenderTarget(q.shadow, q.shadow, {
      minFilter:THREE.NearestFilter, magFilter:THREE.NearestFilter, format:THREE.RGBAFormat,
      depthBuffer:true, stencilBuffer:false });
    shadowRT.depthTexture = new THREE.DepthTexture(q.shadow, q.shadow, THREE.UnsignedIntType);
    shadowRT.depthTexture.format = THREE.DepthFormat;
    shadowRT.depthTexture.minFilter = THREE.NearestFilter;
    shadowRT.depthTexture.magFilter = THREE.NearestFilter;
    G.uShadowMap.value = shadowRT.depthTexture;
    G.uShadowTexel.value = 1/q.shadow;
  }
  if(!windRT || windRT.width!==q.wind){
    if(windRT) windRT.dispose();
    windRT = new THREE.WebGLRenderTarget(q.wind, q.wind, {
      type:THREE.HalfFloatType, format:THREE.RGBAFormat,
      minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter,
      wrapS:THREE.ClampToEdgeWrapping, wrapT:THREE.ClampToEdgeWrapping, depthBuffer:false });
    G.uWindTex.value = windRT.texture;
  }
  waterMesh.material.uniforms.uReflect.value = reflRT.texture;

  // post materials
  if(!windMat){
    const cellA=[], cellB=[];
    for(let i=0;i<6;i++){ cellA.push(new THREE.Vector4()); cellB.push(new THREE.Vector4()); }
    windMat = postMat(WIND_FS(), U({
      uCellA:{value:cellA}, uCellB:{value:cellB},
      uFwd:{value:new THREE.Vector2(1,0)}, uSide:{value:new THREE.Vector2(0,1)},
      uGustiness:{value:1.0}, uTurbI:{value:0.26},
    }));
    windViewMat = postMat(WINDVIEW_FS, { uWindTex:{value:null}, uMean:{value:4.2} });
    brightMat = postMat(BRIGHT_FS(), { uSrc:{value:null}, uThresh:{value:1.02}, uSoft:{value:0.75} });
    composite = postMat(COMPOSITE_FS(), {
      uScene:{value:null}, uBloom:{value:null}, uSoft:{value:null},
      uRes:{value:new THREE.Vector2()}, uTime:{value:0}, uExposure:{value:1.0},
      uBloomAmt:{value:1.0}, uPaint:{value:1.0}, uCA:{value:1.0},
      uVignette:{value:1.0}, uGrain:{value:1.0},
    });
  }
  downMats.forEach(m=>m.dispose()); downMats=[];
  upMats.forEach(m=>m.dispose()); upMats=[];
  for(let i=0;i<bloomRTs.length;i++)
    downMats.push(postMat(DOWN_FS, { uSrc:{value:null}, uTexel:{value:new THREE.Vector2(1,1)} }));
  for(let i=bloomRTs.length-1;i>0;i--)
    upMats.push(postMat(UP_FS, { uSrc:{value:null}, uPrev:{value:null},
      uTexel:{value:new THREE.Vector2(1,1)}, uRadius:{value:1.4} }));
  blurMats.forEach(m=>m.dispose()); blurMats=[];
  for(let i=0;i<2;i++) blurMats.push(postMat(BLUR_FS, { uSrc:{value:null},
    uTexel:{value:new THREE.Vector2(1/softRT[0].width, 1/softRT[0].height)},
    uDir:{value:new THREE.Vector2(i?0:1, i?1:0)} }));
  if(softDownMat) softDownMat.dispose();
  softDownMat = postMat(DOWN_FS, { uSrc:{value:null}, uTexel:{value:new THREE.Vector2(1,1)} });
  composite.uniforms.uRes.value.set(W,H);
  G.uShadowTexel.value = 1/shadowRT.width;
}
let ANG_PER_PX = 0.001;


/*──────────────────────────── life: motes & birds ──────────────────────────*/
const MOTE_N = 2200;
function initMotes(){
  const r=rng(1717);
  for(let i=0;i<MOTE_N;i++){
    const a=r()*TAU, rr=Math.sqrt(r())*30;
    const x=CFG.spawn.x+Math.cos(a)*rr, z=CFG.spawn.z+Math.sin(a)*rr;
    motes.spawn({ x, y:sampleHeight(x,z)+0.2+r()*9, z,
      vx:0,vy:0,vz:0, life:1e7, size:0.014, seed:r()*100, kind:0, op:0.55+r()*0.45 });
  }
}
/*  2,200 pollen motes each wanted a heightmap lookup and a full JS wind-field
    evaluation every frame — several milliseconds of pure CPU for something the
    eye reads as drifting dust.  Integrating a third of them per frame at 3x the
    timestep is visually identical and costs a third as much.                  */
let _motePhase = 0;
function updateMotes(dt, cam){
  const t = WindSys.time;
  const STRIDE = 3;
  _motePhase = (_motePhase + 1) % STRIDE;
  dt *= STRIDE;
  for(let i=_motePhase;i<motes.max;i+=STRIDE){
    const d=motes.data[i]; if(!d.alive) continue;
    const g = sampleHeight(d.x,d.z);
    const h = Math.max(0.05, d.y-g);
    const w = windAtJS(d.x, d.z, h);
    // drag toward the air, plus buoyancy and a little swirl
    const drag = 3.1;
    d.vx += (w.x - d.vx)*clamp(drag*dt,0,1);
    d.vz += (w.z - d.vz)*clamp(drag*dt,0,1);
    const swirl = Math.sin(t*1.7 + d.seed*3.1)*0.32 + Math.sin(t*0.63 + d.seed*7.7)*0.22;
    d.vy += (0.16 + swirl*0.5 - d.vy*1.4)*clamp(dt*2.2,0,1);
    d.x += d.vx*dt; d.y += d.vy*dt; d.z += d.vz*dt;
    if(d.y < g+0.06){ d.y = g+0.06; d.vy = Math.abs(d.vy)*0.3 + 0.2; }
    // keep the swarm around the walker
    const dx=d.x-cam.position.x, dz=d.z-cam.position.z;
    const dd=Math.hypot(dx,dz);
    if(dd > 34 || d.y-g > 13){
      const a=Math.random()*TAU, rr=Math.sqrt(Math.random())*26;
      d.x = cam.position.x+Math.cos(a)*rr; d.z = cam.position.z+Math.sin(a)*rr;
      d.y = sampleHeight(d.x,d.z)+0.15+Math.random()*7;
      d.vx=d.vy=d.vz=0;
    }
    const dist = Math.hypot(d.x-cam.position.x, d.y-cam.position.y, d.z-cam.position.z);
    d.size = clamp(Math.max(0.012, dist*0.0021), 0.01, 1.2);
    d.age = 0;
    if(!isFinite(d.x+d.y+d.z)){ d.x=cam.position.x; d.z=cam.position.z;
      d.y=sampleHeight(d.x,d.z)+2; d.vx=d.vy=d.vz=0; }
  }
}
const BIRDS=[];
function initBirds(){
  const r=rng(2929);
  for(let i=0;i<34;i++){
    const a=r()*TAU, rr=120+r()*260;
    const b={ x:CFG.spawn.x+Math.cos(a)*rr, z:CFG.spawn.z+Math.sin(a)*rr,
      y:0, vx:(r()-0.5)*8, vy:0, vz:(r()-0.5)*8, ph:r(), p:null };
    b.y = sampleHeight(b.x,b.z)+45+r()*45;
    b.p = birdsP.spawn({x:b.x,y:b.y,z:b.z, life:1, size:1.15, seed:r()*100, kind:0, op:1, age:r()});
    BIRDS.push(b);
  }
}
function updateBirds(dt, t){
  const cx=CFG.spawn.x-120, cz=CFG.spawn.z+40;
  for(let i=0;i<BIRDS.length;i++){
    const b=BIRDS[i];
    let sx=0,sz=0,sy=0, ax=0,ay=0,az=0, gx=0,gy=0,gz=0, n=0;
    for(let j=0;j<BIRDS.length;j++){
      if(i===j) continue;
      const o=BIRDS[j];
      const dx=o.x-b.x, dy=o.y-b.y, dz=o.z-b.z;
      const d2=dx*dx+dy*dy+dz*dz;
      if(d2 < 900){
        n++; gx+=o.x; gy+=o.y; gz+=o.z; ax+=o.vx; ay+=o.vy; az+=o.vz;
        if(d2 < 90){ const d=Math.sqrt(d2)+1e-3; sx-=dx/d; sy-=dy/d; sz-=dz/d; }
      }
    }
    if(n){ gx/=n; gy/=n; gz/=n; ax/=n; ay/=n; az/=n;
      b.vx += ((gx-b.x)*0.06 + (ax-b.vx)*0.16 + sx*2.2)*dt*4;
      b.vy += ((gy-b.y)*0.05 + (ay-b.vy)*0.16 + sy*2.2)*dt*4;
      b.vz += ((gz-b.z)*0.06 + (az-b.vz)*0.16 + sz*2.2)*dt*4;
    }
    // wander, and a long slow orbit of the valley
    b.vx += (Math.sin(t*0.31+b.ph*9)*2.4 + (cx-b.x)*0.010)*dt;
    b.vz += (Math.cos(t*0.27+b.ph*7)*2.4 + (cz-b.z)*0.010)*dt;
    const ground = sampleHeight(b.x,b.z);
    const want = ground + 62 + Math.sin(t*0.2+b.ph*5)*22;
    b.vy += (want-b.y)*0.22*dt*4;
    const w = windAtJS(b.x,b.z,40);
    b.vx += w.x*0.30*dt; b.vz += w.z*0.30*dt;
    const sp=Math.hypot(b.vx,b.vy,b.vz);
    if(sp>0.01){ const k=lerp(1, 11.5/sp, clamp(dt*1.5,0,1)); b.vx*=k; b.vy*=k; b.vz*=k; }
    b.x+=b.vx*dt; b.y+=b.vy*dt; b.z+=b.vz*dt;
    const p=b.p;
    p.x=b.x; p.y=b.y; p.z=b.z;
    // flap fast when climbing, glide when descending
    const climb = clamp(b.vy*0.25+0.5, 0, 1);
    p.age = (p.age + dt*(0.9+1.5*climb)) % 1;
    p.op = 0.92;
    p.size = 1.05 + climb*0.25;
  }
}
function updateSmoke(dt){
  for(let i=0;i<smoke.max;i++){
    const d=smoke.data[i]; if(!d.alive) continue;
    d.age += dt;
    if(d.age >= d.life){ smoke.kill(d); continue; }
    const u = d.age/d.life;
    const w = windAtJS(d.x, d.z, Math.max(1, d.y - sampleHeight(d.x,d.z)));
    // buoyancy decays as the puff cools and mixes with the air
    const buoy = (d.kind===1 ? 1.5 : 4.2) * Math.exp(-d.age*0.42);
    d.vy += (buoy - d.vy)*clamp(dt*1.3,0,1);
    const mix = clamp(dt*(0.55 + u*1.6), 0, 1);
    d.vx += (w.x - d.vx)*mix;
    d.vz += (w.z - d.vz)*mix;
    d.x += d.vx*dt; d.y += d.vy*dt; d.z += d.vz*dt;
    d.size += dt*(d.kind===1 ? 0.55 : 1.55)*(1.0 - u*0.5);
    d.size = clamp(d.size, 0.05, 60);
    d.op = (d.kind===1?0.55:0.95) * (1 - u*0.15);
    if(!isFinite(d.x+d.y+d.z+d.size)) smoke.kill(d);
  }
}
let villSmokeT=0;
function emitVillageSmoke(dt){
  villSmokeT -= dt;
  if(villSmokeT>0 || !villageSmokers.length) return;
  villSmokeT = 0.55;
  const s = villageSmokers[(Math.random()*villageSmokers.length)|0];
  smoke.spawn({ x:s.x+(Math.random()-0.5)*0.2, y:s.y, z:s.z+(Math.random()-0.5)*0.2,
    vx:0, vy:1.5, vz:0, life:22+Math.random()*10, size:0.5+Math.random()*0.4,
    seed:Math.random()*100, kind:1, op:0.5 });
}

/*──────────────────────────── render passes ────────────────────────────────*/
/*  Three parallel arrays, never re-allocated.  The old version pushed a fresh
    [mesh, material, visible] tuple for every mesh in the scene, twice a frame —
    with ~250 grass chunks that is ~30k short-lived arrays a second, which is
    exactly the kind of garbage that shows up as periodic stutter.  Bulk
    containers (the grass field, the particle systems) are hidden with a single
    flag instead of being walked at all.                                      */
const _swObj=[], _swMat=[], _swVis=[]; let _swN=0;
const _bulk=[];
/*  The three-way branch below is the whole of the cast/no-cast rule, and §0c is
    the contract that keeps every mesh honest about which arm it lands in.    */
function collectShadowSet(o){
  if(o.userData.bulk){ _bulk.push([o, o.visible]); o.visible = false; return; }
  if(o.isMesh){
    _swObj[_swN]=o; _swMat[_swN]=o.material; _swVis[_swN]=o.visible; _swN++;
    if(o.userData.proxy){ o.visible = true; o.material = o.userData.depth; }
    else if(o.userData.depth) o.material = o.userData.depth;
    else o.visible = false;
  }
  const ch=o.children;
  for(let i=0;i<ch.length;i++) collectShadowSet(ch[i]);
}
function beginShadow(){ _swN=0; _bulk.length=0; collectShadowSet(scene); }
function endSwap(){
  for(let i=0;i<_swN;i++){ _swObj[i].material=_swMat[i]; _swObj[i].visible=_swVis[i]; }
  for(let i=0;i<_bulk.length;i++) _bulk[i][0].visible=_bulk[i][1];
  _swN=0; _bulk.length=0;
}

/*  The cloud coverage field, evaluated once into a 512² map instead of once per
    fragment of an eight-megapixel frame.  It is by a wide margin the single
    biggest saving in the renderer: cloudShadow() is called by the terrain, the
    grass, the water, the stone, the trees and the village, and it used to cost
    thirteen octaves of domain-warped fbm — around 250 ALU — every time.       */
function cloudShadowPass(){
  const t = (CFG.cloudDeck - camera.position.y) / Math.max(SUN.y, 0.06);
  G.uCloudShOrigin.value.set(camera.position.x + SUN.x*t, camera.position.z + SUN.z*t);
  blit(cloudShMat, cloudShRT);
}

const _tmpV = new THREE.Vector3(), _tmpF = new THREE.Vector3();

/*  The ground-plane view cone the grass vertex shader culls against.
    Rather than assume a horizontal field of view, this measures the widest
    lateral deviation of the four actual frustum corner rays once per frame, so
    it stays exact at any aspect ratio and any pitch.  Looking steeply up or
    down the corner rays lose their horizontal direction entirely; the cone is
    then disabled outright (cos = -1.1 passes everything) rather than guessed
    at, because the one thing this must never do is cull a visible blade.     */
const _cf = new THREE.Vector3(), _cr = new THREE.Vector3(), _cu = new THREE.Vector3();
function updateCullCone(){
  const q = camera.quaternion;
  _cf.set(0,0,-1).applyQuaternion(q);
  _cr.set(1,0,0).applyQuaternion(q);
  _cu.set(0,1,0).applyQuaternion(q);
  const th = Math.tan(camera.fov*DEG/2), tw = th*camera.aspect;
  const rl = Math.hypot(_cf.x, _cf.z);
  if(rl < 0.30){ G.uCull.value.set(1, 0, -1.1, 0); return; }
  const rx = _cf.x/rl, rz = _cf.z/rl;
  let minDot = 1;
  for(let i=0;i<4;i++){
    const sx = (i&1) ? 1 : -1, sy = (i&2) ? 1 : -1;
    const dx = _cf.x + _cr.x*sx*tw + _cu.x*sy*th;
    const dz = _cf.z + _cr.z*sx*tw + _cu.z*sy*th;
    const l = Math.hypot(dx, dz);
    if(l < 1e-3){ minDot = -1; break; }
    const dp = (dx*rx + dz*rz)/l;
    if(dp < minDot) minDot = dp;
  }
  // nine degrees of pad covers blade width, wind lean and the seam between rings
  const half = Math.acos(clamp(minDot, -1, 1)) + 0.157;
  G.uCull.value.set(rx, rz, half >= Math.PI ? -1.1 : Math.cos(half), 0);
}
function shadowPass(){
  _tmpF.set(0,0,-1).applyQuaternion(camera.quaternion);
  const span = CFG.shadowSpan;
  const texel = span/shadowRT.width*2;
  let cx = camera.position.x + _tmpF.x*span*0.30;
  let cz = camera.position.z + _tmpF.z*span*0.30;
  cx = Math.round(cx/texel)*texel; cz = Math.round(cz/texel)*texel;
  // trees cull against the map's own centre, not the camera's
  G.uShadowC.value.set(cx, cz);
  const cy = sampleHeight(cx,cz);
  sunCam.left=-span/2; sunCam.right=span/2; sunCam.top=span/2; sunCam.bottom=-span/2;
  // a 13.5° sun sits almost on the horizon, so the light camera has to stand a
  // long way back or half the valley falls behind its near plane
  sunCam.near=1; sunCam.far=1500;
  sunCam.position.set(cx + SUN.x*760, cy + SUN.y*760, cz + SUN.z*760);
  sunCam.up.set(0,1,0);
  sunCam.lookAt(cx, cy, cz);
  sunCam.updateProjectionMatrix(); sunCam.updateMatrixWorld(true);
  G.uLightMat.value.multiplyMatrices(sunCam.projectionMatrix, sunCam.matrixWorldInverse);

  beginShadow();
  renderer.setRenderTarget(shadowRT);
  renderer.clear(true, true, false);
  renderer.render(scene, sunCam);
  endSwap();
}

const _mirror = new THREE.Matrix4();
function reflectionPass(){
  const planeY = BR.water;
  if(camera.position.y < planeY + 0.5){ waterMesh.material.uniforms.uReflectOn.value = 0; return; }
  const m = _mirror.set(1,0,0,0, 0,-1,0,2*planeY, 0,0,1,0, 0,0,0,1);
  reflCam.matrixWorld.multiplyMatrices(m, camera.matrixWorld);
  reflCam.matrixWorldInverse.copy(reflCam.matrixWorld).invert();
  reflCam.projectionMatrix.copy(camera.projectionMatrix);
  reflCam.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  _swN=0; _bulk.length=0;
  const keep = REFLECT_KEEP;
  keep.clear();
  for(const o of reflectSet) o.traverse(c=>{ if(c.isMesh) keep.add(c); });
  keep.add(skyMesh); keep.add(proxyTerrain);
  for(const r of ridges) keep.add(r);
  (function walk(o){
    if(o.userData.bulk){ _bulk.push([o, o.visible]); o.visible=false; return; }
    if(o.isMesh){
      _swObj[_swN]=o; _swMat[_swN]=o.material; _swVis[_swN]=o.visible; _swN++;
      if(!keep.has(o)) o.visible=false;
    }
    const ch=o.children;
    for(let i=0;i<ch.length;i++) walk(ch[i]);
  })(scene);
  proxyTerrain.visible = true; proxyTerrain.material = proxyTerrain.userData.beauty;

  _reflSave.copy(G.uCamPos.value);
  G.uCamPos.value.setFromMatrixPosition(reflCam.matrixWorld);
  skyMesh.position.copy(G.uCamPos.value);

  renderer.setRenderTarget(reflRT);
  renderer.clear(true, true, false);
  renderer.render(scene, reflCam);

  G.uCamPos.value.copy(_reflSave);
  skyMesh.position.copy(camera.position);
  endSwap();
  waterMesh.material.uniforms.uReflectOn.value = 1;
}
const REFLECT_KEEP = new Set();
const _reflSave = new THREE.Vector3();

function windPass(){
  const W = WindSys;
  const u = windMat.uniforms;
  u.uMeanWind.value.copy(W.vec);
  u.uFwd.value.set(W.fwd[0], W.fwd[1]);
  u.uSide.value.set(W.side[0], W.side[1]);
  u.uGustiness.value = W.gustiness;
  for(let i=0;i<6;i++){
    const c=W.cells[i];
    u.uCellA.value[i].set(c.s, c.c, c.len, c.wid);
    u.uCellB.value[i].set(c.amp, c.veer, c.life, 0);
  }
  blit(windMat, windRT);
}

function postChain(){
  if(QS.get('post')==='0'){
    if(!rawMat) rawMat = postMat('uniform sampler2D uSrc;\nin vec2 vUv;\nout vec4 o;\nvoid main(){ vec3 c=texture(uSrc,vUv).rgb; c=c/(c+1.0); o=vec4(pow(c,vec3(1.0/2.2)),1.0); }',
      { uSrc:{value:null} });
    rawMat.uniforms.uSrc.value = sceneRT.texture;
    blit(rawMat, null); return;
  }
  brightMat.uniforms.uSrc.value = sceneRT.texture;
  blit(brightMat, bloomRTs[0]);
  for(let i=1;i<bloomRTs.length;i++){
    const mt = downMats[i];
    mt.uniforms.uSrc.value = bloomRTs[i-1].texture;
    mt.uniforms.uTexel.value.set(1/bloomRTs[i-1].width, 1/bloomRTs[i-1].height);
    blit(mt, bloomRTs[i]);
  }
  const n = bloomRTs.length;
  for(let k=0;k<upMats.length;k++){
    const i = n-2-k;
    const mt = upMats[k];
    mt.uniforms.uSrc.value = (k===0) ? bloomRTs[n-1].texture : upRTs[i+1].texture;
    mt.uniforms.uPrev.value = bloomRTs[i].texture;
    mt.uniforms.uTexel.value.set(1/upRTs[i].width, 1/upRTs[i].height);
    blit(mt, upRTs[i]);
  }
  softDownMat.uniforms.uSrc.value = sceneRT.texture;
  softDownMat.uniforms.uTexel.value.set(1/softRT[0].width, 1/softRT[0].height);
  blit(softDownMat, softRT[0]);
  blurMats[0].uniforms.uSrc.value = softRT[0].texture; blit(blurMats[0], softRT[1]);
  blurMats[1].uniforms.uSrc.value = softRT[1].texture; blit(blurMats[1], softRT[0]);

  const c = composite.uniforms;
  c.uScene.value = sceneRT.texture;
  c.uBloom.value = (upRTs.length ? upRTs[0].texture : bloomRTs[0].texture);
  c.uSoft.value  = softRT[0].texture;
  c.uTime.value  = G.uTime.value;
  c.uExposure.value = State.exposure;
  c.uBloomAmt.value = 0.62*State.bloom;
  c.uPaint.value = State.paint;
  c.uCA.value = State.paint;
  c.uVignette.value = 0.85;
  c.uGrain.value = State.paint;
  blit(composite, null);

  if(State.showWind){
    windViewMat.uniforms.uWindTex.value = windRT.texture;
    windViewMat.uniforms.uMean.value = WindSys.meanSpeed;
    const s = Math.floor(Math.min(window.innerWidth, window.innerHeight)*0.30);
    renderer.setRenderTarget(null);
    renderer.setViewport(12, 12, s, s); renderer.setScissor(12,12,s,s); renderer.setScissorTest(true);
    quadMesh.material = windViewMat; renderer.render(quadScene, quadCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0,0,window.innerWidth,window.innerHeight);
  }
}

/*──────────────────────────── the frame ───────────────────────────────────*/
let last = performance.now(), tAcc = 0, fpsAcc=[], nextTrain = 11.0, warmed=0;
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4();
let cloudSortT=0, rawMat=null, frameNo=0, windWarm=false, shadowWarm=false, cloudWarm=false;
// a handful of probe spheres along the river; if none is in the frustum there
// is no water on screen and the whole reflection pass can be skipped
const RIVER_PROBES = (()=>{ const a=[];
  for(let i=0;i<=28;i++){ const p=RIVER_PTS[Math.round(i/28*(RIVER_PTS.length-1))];
    a.push(new THREE.Sphere(new THREE.Vector3(p.x, waterLevel(p.t), p.z), riverWidth(p.t)+14)); }
  return a; })();
/*  The planar reflection is a second full render of the valley.  It is worth it
    when you are standing on the bank; it is worth nothing when the river is a
    thread of blue four hundred metres off, where the sky term alone is
    indistinguishable.  So it must be both ON SCREEN and NEAR.               */
function riverOnScreen(fr, cp){
  for(let i=0;i<RIVER_PROBES.length;i++){
    const s = RIVER_PROBES[i];
    if(!fr.intersectsSphere(s)) continue;
    if(cp && s.center.distanceToSquared(cp) > 380*380) continue;
    return true;
  }
  return false;
}

function frame(now){
  let dt = Math.min(0.05, (now-last)/1000); last = now;
  if(State.paused) dt = 0;
  tAcc += dt;

  updateWind(dt, camera.position);
  walker.update(dt, tAcc);
  camera.updateMatrixWorld(true);

  G.uTime.value = tAcc;
  G.uCamPos.value.copy(camera.position);
  G.uMeanWind.value.copy(WindSys.vec);
  G.uCloudDrift.value.copy(WindSys.cloudDrift);
  // snapped to the proxy's own 3 m cell so the grid is fixed in world space
  G.uProxyC.value.set(Math.round(camera.position.x/3)*3, Math.round(camera.position.z/3)*3);
  updateCullCone();
  { // the blade's response lag, as a vector, once per frame instead of per vertex
    const w = WindSys.vec, l = Math.hypot(w.x, w.y) || 1;
    G.uWindLag.value.set(w.x/l*2.6, w.y/l*2.6);
  }
  skyMesh.position.copy(camera.position);

  if(!train.active && tAcc > nextTrain){
    train.start(); nextTrain = tAcc + 110;
    audio.whistle(0.16);
    setTimeout(()=>{ if(train.active) audio.whistle(0.13); }, 2600);
  }
  train.update(dt, tAcc);
  State.trainActive = train.active;
  if(train.active){
    const p = trackPose(train.s);
    _tmpV.set(p.x, p.y, p.z);
    State.trainDist = camera.position.distanceTo(_tmpV);
    const rgt = _tmpF.set(1,0,0).applyQuaternion(camera.quaternion);
    const dx=p.x-camera.position.x, dz=p.z-camera.position.z, L=Math.hypot(dx,dz)||1;
    State.trainPan = (rgt.x*dx+rgt.z*dz)/L;
  }
  if(millWheel) millWheel.rotation.z -= dt*0.55;
  if(corgis) corgis.update(dt, tAcc);
  // after the corgis, so the lure it sets is acted on next frame, and the
  // mouth it tests against is this frame's
  if(treats){ treats.update(dt, tAcc, camera, corgis); treats.updateHearts(dt); }

  updateSmoke(dt); emitVillageSmoke(dt);
  updateMotes(dt, camera); updateBirds(dt, tAcc);
  smoke.commit(camera.position); motes.commit(camera.position); birdsP.commit(camera.position);
  if(hearts) hearts.commit(camera.position);

  cloudSortT -= dt;
  if(cloudSortT <= 0){ cloudSortT = 0.4; sortClouds(); }

  _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_pm);
  grass.update(camera, _frustum);
  State.grassNear = clamp(splatSampleMask(camera.position.x, camera.position.z), 0, 1);

  // The wind field and the sun shadow both change slowly compared with the
  // camera, so they run at half rate on alternate frames — invisible, and it
  // takes two whole passes off most frames.
  /*  Three auxiliary passes, none of which the eye can follow at frame rate:
      the wind field drifts, the sun does not move at all and the cloud deck
      creeps.  Interleaving them one per frame means each frame pays for one
      instead of two, and nothing updates slower than 20 Hz.                  */
  frameNo++;
  const phase = frameNo % 3;
  if(phase === 0 || !windWarm){ windWarm = true;
    G.uWindOrigin.value.set(camera.position.x, camera.position.z);
    windPass();
  }
  if(phase === 1 || !shadowWarm){ shadowWarm = true; shadowPass(); }
  if(phase === 2 || !cloudWarm){ cloudWarm = true; cloudShadowPass(); }
  // the reflection is only worth anything when water is actually on screen
  const wantRefl = riverOnScreen(_frustum, camera.position);
  if(State.q >= 2 && phase === 0 && wantRefl) reflectionPass();
  else if(!wantRefl) waterMesh.material.uniforms.uReflectOn.value = 0;

  renderer.setRenderTarget(sceneRT);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);
  postChain();

  audio.update(dt, camera, walker, State);

  fpsAcc.push(dt); if(fpsAcc.length>40) fpsAcc.shift();
  let s=0; for(const v of fpsAcc) s+=v;
  State.fps = fpsAcc.length/Math.max(s,1e-4);
  // long enough that shader compilation, texture uploads and the first GC are
  // all well behind us before we let the auto-quality logic judge the frame rate
  if(++warmed === 260) autoQuality();
}
function splatSampleMask(x,z){
  const R=CFG.dataRes;
  const fx=clamp((x+HALF)/WS*(R-1),0,R-1), fy=clamp((z+HALF)/WS*(R-1),0,R-1);
  return splatData[(((fy|0)*R + (fx|0))*4)+2]/255;
}
/*  Depth-sorting ~3,600 cumulus puffs used to build 3,600 throwaway [d,i] pairs
    and hand them to Array.sort every 0.4 s — a textbook garbage-collection
    hitch.  The order barely changes between calls, so a persistent index array
    plus an insertion pass is not only allocation-free but effectively O(n).  */
let _cldD=null, _cldI=null;
function sortClouds(){
  const cp=camera.position, drift=WindSys.cloudDrift;
  const P=cloudObj.puffs, idx=cloudObj.index, n=P.length;
  if(!_cldD){
    _cldD=new Float32Array(n); _cldI=new Int32Array(n);
    for(let i=0;i<n;i++) _cldI[i]=i;
  }
  for(let i=0;i<n;i++){
    const p=P[i];
    const dx=p.cx+drift.x-cp.x, dy=p.cy-cp.y, dz=p.cz+drift.y-cp.z;
    _cldD[i]=dx*dx+dy*dy+dz*dz;
  }
  for(let a=1;a<n;a++){                       // insertion sort, far -> near
    const v=_cldI[a], key=_cldD[v];
    let b=a-1;
    while(b>=0 && _cldD[_cldI[b]] < key){ _cldI[b+1]=_cldI[b]; b--; }
    _cldI[b+1]=v;
  }
  const LIM = 1.7e8;
  let cnt=0;
  for(let j=0;j<n;j++) if(_cldD[_cldI[j]] <= LIM) cnt++;
  let skip = cnt > 1500 ? cnt-1500 : 0;       // keep the NEAREST 1500
  let k=0;
  for(let j=0;j<n;j++){
    const i=_cldI[j];
    if(_cldD[i] > LIM) continue;
    if(skip > 0){ skip--; continue; }
    const b=i*4;
    idx[k++]=b; idx[k++]=b+1; idx[k++]=b+2;
    idx[k++]=b; idx[k++]=b+2; idx[k++]=b+3;
  }
  cloudObj.geom.index.needsUpdate=true;
  cloudObj.geom.setDrawRange(0, k);
}
function setQuality(q){
  q = clamp(q|0, 0, 3);
  if(q === State.q) return;
  State.q = q; State.autoQ = false;
  for(const b of document.querySelectorAll('#qPreset button'))
    b.classList.toggle('on', +b.dataset.q === q);
  rebuildGrass(); buildTargets();
  toast(['low','medium','high','ultra'][q]);
}
function rebuildGrass(){
  grass.build(QUALITY[State.q]);
  grass.setAngular(ANG_PER_PX);
}
function autoQuality(){
  if(!State.autoQ) return;
  if(State.fps < 34 && State.q > 0){
    const q = State.q - 1; State.q = -1; setQuality(q); State.autoQ = true;
  }
}
function loop(now){
  requestAnimationFrame(loop);
  if(!State.running) return;
  try{ frame(now); } catch(e){
    State.running=false;
    const el=document.getElementById('err'); el.style.display='block'; el.textContent+='\n'+(e.stack||e);
  }
  hudTick();
}
let hudT=0, teleNodes=null;
function hudTick(){
  hudT++; if(hudT%12) return;
  if(!teleNodes){
    const t=$('#tele'); t.textContent='';
    const mk=(cls)=>{ const s=document.createElement('span'); s.className=cls; t.appendChild(s); return s; };
    teleNodes={ a:mk('k'), b:mk('v'), c:mk('k'), d:mk('v'), br:t.appendChild(document.createElement('br')),
                e:mk('k'), f:mk('v'), g:mk('k'), h:mk('v') };
    teleNodes.i = t.appendChild(document.createElement('br'));
    teleNodes.j = mk('k'); teleNodes.k2 = mk('v');
    teleNodes.a.textContent='wind '; teleNodes.c.textContent='  gust ';
    teleNodes.e.textContent='train '; teleNodes.g.textContent='  fps ';
    teleNodes.j.textContent='treats ';
  }
  const w = windAtJS(camera.position.x, camera.position.z, 10);
  const eta = Math.max(0, nextTrain - tAcc);
  teleNodes.b.textContent = w.speed.toFixed(1)+' m/s';
  teleNodes.d.textContent = (WindSys.meanSpeed*(1+w.gust*0.9)).toFixed(1);
  teleNodes.f.textContent = train.active ? 'crossing' : (eta<1?'—':eta.toFixed(0)+'s');
  teleNodes.h.textContent = State.fps.toFixed(0);
  teleNodes.k2.textContent = treats ? String(treats.given) : '0';
}
let toastT=null;
function toast(msg){
  const el=$('#toast'); el.textContent=msg; el.classList.add('on');
  clearTimeout(toastT); toastT=setTimeout(()=>el.classList.remove('on'), 1800);
}

/*──────────────────────────── input ───────────────────────────────────────*/
function bindInput(){
  const cv = renderer.domElement;
  addEventListener('keydown', e=>{
    walker.keys[e.code]=true;
    if(e.code>='Digit1' && e.code<='Digit4') setQuality(+e.code.slice(5)-1);
    if(e.code==='KeyH'){
      const on = $('#panel').classList.toggle('on');
      // with the pointer locked the browser sends no cursor to the DOM at all,
      // so the settings panel could be opened but never actually clicked
      if(on && document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
      toast(on ? 'settings — click the view to look again' : '');
    }
    if(e.code==='KeyC'){ walker.cinematic=!walker.cinematic; walker.cineT=0;
      toast(walker.cinematic?'cinematic':'free walk'); }
    if(e.code==='KeyP'){ State.paused=!State.paused; toast(State.paused?'paused':'running'); }
    if(e.code==='KeyF'){ walker.fly=!walker.fly; toast(walker.fly?'flight — space/ctrl, look to steer':'walking'); }
    if(e.code==='Space') e.preventDefault();
    if(e.code==='KeyT'){ train.start(); audio.whistle(0.18); nextTrain=tAcc+110;
      toast('train approaching'); }
    if(e.code==='KeyG' && treats){
      toast(treats.toggle() ? 'treat out — walk up to a corgi' : 'treat away'); }
    if(e.code==='Escape' && document.exitPointerLock) document.exitPointerLock();
  });
  addEventListener('keyup', e=>{ walker.keys[e.code]=false; });
  // While the settings panel is open the cursor belongs to the panel; grabbing
  // it back on every canvas click made the controls impossible to hit.
  cv.addEventListener('click', ()=>{
    audio.resume();
    if($('#panel').classList.contains('on')) return;
    if(cv.requestPointerLock) cv.requestPointerLock();
  });
  addEventListener('mousemove', e=>{
    if(document.pointerLockElement===cv) walker.look(e.movementX, e.movementY);
  });
  addEventListener('blur', ()=>{ walker.keys={}; });

  const bind=(id, f, fmt)=>{ const el=$('#'+id), out=$('#'+id+'V');
    const go=()=>{ const v=+el.value; f(v); if(out) out.textContent = fmt?fmt(v):String(v); };
    el.addEventListener('input', go); go(); };
  // rebuilding the field is a ~200 ms hitch; never do it per slider tick
  let densT=null;
  bind('qDens', v=>{ State.density=v/100;
    // bind() fires once at startup to sync the readout, so guard on an actual
    // change — otherwise every load pays a rebuild to arrive where it already is
    if(grass && grass.built && grass.density !== State.density){ clearTimeout(densT);
      densT = setTimeout(()=>{ grass.density=State.density; rebuildGrass(); }, 280); } });
  let scaleT=null;
  bind('qScale', v=>{ State.scale=v/100;
    if(sceneRT){ clearTimeout(scaleT); scaleT=setTimeout(buildTargets, 220); } });
  bind('wSpd', v=>{ WindSys.baseSpeed=v/10; WindSys.tgtSpeed=v/10; }, v=>(v/10).toFixed(1));
  bind('wGust', v=>{ WindSys.gustiness=v/100; }, v=>(v/100).toFixed(2));
  bind('pExp', v=>{ State.exposure=v/100; }, v=>(v/100).toFixed(2));
  bind('pBloom', v=>{ State.bloom=v/100; }, v=>(v/100).toFixed(2));
  bind('pPaint', v=>{ State.paint=v/100; }, v=>(v/100).toFixed(2));
  bind('aVol', v=>{ audio.vol=v/100; });
  $('#aMus').addEventListener('change', e=>{ audio.music=e.target.checked; });
  $('#dWind').addEventListener('change', e=>{ State.showWind=e.target.checked; });
  $('#qPreset').addEventListener('click', e=>{
    const b = e.target.closest('button'); if(!b) return; setQuality(+b.dataset.q);
  });
  $('#enter').addEventListener('click', ()=>{
    audio.init(); audio.resume();
    $('#veil').classList.add('gone');
    $('#hud').classList.add('on');
    setTimeout(()=>{ $('#veil').style.display='none'; }, 1700);
    if(cv.requestPointerLock) cv.requestPointerLock();
  });
}

/*──────────────────────────── go ──────────────────────────────────────────*/
boot().catch(e=>{
  const el=document.getElementById('err'); el.style.display='block';
  el.textContent += '\n' + (e.stack||e);
});
