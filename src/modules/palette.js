import * as THREE from 'three';

/*──────────────────────────────── §0b PALETTE ────────────────────────────────*/
// Every colour in the film, in one place.  sRGB hex -> linear at load.

export const P = {
  // sky & air
  skyZenith:'#4E80B4', skyUpper:'#7BA9CE', skyMid:'#A8CAE0', skyHorizon:'#E4DAC2',
  skyHorizonSun:'#FBE2AE', sunGlow:'#FFF1CE', sunDisc:'#FFFAEA', skyAnti:'#C8D4D6',
  haze:'#A9BCC7', mist:'#D6DDD4',
  // clouds
  cloudTop:'#FFF8EC', cloudBody:'#F6E7D2', cloudTerm:'#E8CFB4', cloudUnder:'#B7ACC3',
  cloudCore:'#9791B0', cloudRim:'#FFEFBE', cirrus:'#F3E6D6',
  // grass
  gTip:'#C6D46B', gUpper:'#93B84E', gMid:'#6C9A47', gLow:'#436E4F', gBase:'#2B564F',
  gTrans:'#E9EE7C', gSheen:'#EDF0C8', gDry:'#D9C079',
  gPatchA:'#87AC4B', gPatchB:'#6C9A56', gPatchC:'#9DBC5E', gPatchD:'#5F8A5A',
  // terrain
  tLit:'#93B159', tMid:'#6A924F', tShade:'#456A54', tHollow:'#33564F',
  ridgeNear:'#8FA9A2', ridgeMid:'#9CB0B4', ridgeFar:'#AEBCC9', ridgeFurthest:'#BFC8D4',
  pathLit:'#C9AD80', pathShade:'#7A664D', rockLit:'#B4A794', rockShade:'#5F5C58',
  bounce:'#AA9C64',
  // river
  wShallow:'#A5CBBE', wMid:'#5F9CA0', wDeep:'#2F5F6C', wDeepShade:'#274E5C',
  wSpark:'#FFFCEC', wFoam:'#EEF5EF', wetStone:'#6E7E75',
  // stone
  sA:'#CBB99E', sB:'#BDA98C', sC:'#D6C6AA', sD:'#B2A490',
  sShade:'#6C6355', sDeep:'#585A62', mortar:'#AB9C85', moss:'#6F8C4E', lichen:'#B3BE96',
  // trees
  cLit:'#84A94C', cMid:'#5A8148', cShade:'#2F5546', cDeep:'#254A44', cTrans:'#BED063',
  cVarA:'#98AC43', cVarB:'#6E9440', cVarC:'#A9B65C',
  trunkLit:'#8E7659', trunkShade:'#4C3F34',
  // village
  roofA:'#B96A4C', roofB:'#A05C46', roofSlate:'#6E7583', thatch:'#BC9E66',
  wallA:'#EFE4D0', wallB:'#E4D5BA', timber:'#7C5D46', windowGlow:'#FFD98C',
  // train
  boiler:'#2B333C', boilerLit:'#4E5763', boilerRim:'#8794A0', livery:'#94403A',
  brass:'#CBA44E', carBody:'#3C6152', carBand:'#EADEC2', carWin:'#FFDE9E',
  smokeNew:'#F4EDE3', smokeOld:'#B5ACB6',
  // corgis — the four Pembroke coats, plus the parts every coat shares
  dogRed:'#C4763F', dogSable:'#9C5A33', dogFawn:'#D9A469', dogBlack:'#3B3A42',
  dogTan:'#B87A45', dogCream:'#F2E7D2', dogWhite:'#FBF6EC',
  dogNose:'#2B2A30', dogTongue:'#D4707C',
  // the treat, the hand offering it, and the hearts that follow
  treatBiscuit:'#C9A063', treatBiscuitDark:'#A87F46',
  handSkin:'#C08A63', handCuff:'#8FA4B8',
  heartCore:'#F58CA0', heartEdge:'#D6455F',
  // light
  sun:'#FFD79C', ambSky:'#9EC6E6', ambGround:'#AA9C64', shadowTint:'#5C6E9E',
};

// hex -> THREE.Color (linear) and -> vec3 literal for glsl injection
export const LIN = {};
for (const k in P) LIN[k] = new THREE.Color(P[k]).convertSRGBToLinear();
const v3 = c => `vec3(${c.r.toFixed(5)},${c.g.toFixed(5)},${c.b.toFixed(5)})`;
export const C = {}; for (const k in LIN) C[k] = v3(LIN[k]);
