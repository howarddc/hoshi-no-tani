/*───────────────────────────────── §0  CONFIG ─────────────────────────────────*/

export const CFG = {
  world:        2400,      // heightmap extent, metres
  hmRes:        1024,      // heightmap texels per side
  dataRes:      512,       // splat/mask texture
  sunElev:      13.5,      // degrees above horizon
  sunAzim:      292.0,     // degrees, 0=+Z(N) increasing toward +X(E)
  fov:          52,
  eyeHeight:    1.68,
  spawn:        { x:-46.5, z:92.1, heading:278.0, pitch:-4.0 },
  bridge:       { x:-195,  z:113 },
  shadowRes:    2048,
  // 210 m put the shadow horizon barely past the near trees.  480 m carries it
  // to the far bank; at 2304 texels that is 0.21 m/texel, and since the edge is
  // defined by the painterly wobble rather than by the filter width, the extra
  // coarseness is invisible while the reach more than doubles.
  shadowSpan:   480,
  windRTRes:    256,
  windRTSpan:   440,       // metres covered by the wind render target
  cloudDeck:    980,       // altitude of the cumulus layer, metres
  fogNear:      70,
  fogFar:       1700,
};

// `blades` is the number of Bezier segments per blade -> (2n+1) vertices.
// The chunk grid per ring is NOT listed here: it is derived from the ring's own
// far distance (ceil(2·far/chunk)+1) so that a ring can always physically reach
// the distance it claims to cover.  Hand-picked grids were too small for rings
// 1-3, which left an un-grassed annulus between every pair of rings — that is
// what made dense grass "only appear when you get closer".
// `px` is the supersample factor ON TOP of the device pixel ratio, so it is
// always >= 1.0 above Low and the composite always resolves DOWN to the canvas.
// The composite runs a luma FXAA, which is what lets 1.12x do the job the old
// 1.30x brute-force supersample was doing, for 1.35x fewer fragments.
export const QUALITY = [
  { grass:[0.30,0.28,0.26,0.24], shadow:1280, wind:160, px:0.85, bloomLv:4, blades:[3,1,1,1] },
  { grass:[0.58,0.55,0.52,0.48], shadow:1536, wind:224, px:1.00, bloomLv:5, blades:[3,2,1,1] },
  { grass:[1.00,1.00,1.00,1.00], shadow:2048, wind:288, px:1.12, bloomLv:5, blades:[4,2,1,1] },
  { grass:[1.45,1.38,1.30,1.20], shadow:2560, wind:352, px:1.32, bloomLv:6, blades:[5,3,2,1] },
];

// Four overlapping grass rings carry blades from underfoot to the far ridge.
// chunk = metres per chunk, blades = per chunk at density 1.0,
// near/far = the distance band this ring occupies (with soft overlaps).
/*  The four rings exist only to switch blade tessellation.  Density is ONE
    continuous law across all of them:

        blades/m²(d) = B_i · min(1, (dn_i / d)^1.45)

    with K = B_i·dn_i^1.45 held constant between rings (K ≈ 17600 here), so
    there is no density step anywhere.  The exponent matters enormously: at
    1.7 the blade count per steradian *falls* with distance and the far field
    dissolves into painted ground; at 1.45 it rises slightly, which is what
    makes the horizon read as a meadow rather than as a green plane.  Against
    the previous 1.7 law this is 1.4x denser at 20 m, 2.1x at 100 m and 3.3x
    at 500 m.

    The thinning happens twice.  Coarsely on the CPU, by lowering a chunk's
    *instance count* — the instance buffer is shuffled, so any prefix is a fair
    sample of the chunk and a thinned blade costs nothing at all, not even a
    vertex shader invocation.  Then finely in the vertex shader, per blade,
    against its own true distance: the CPU deliberately over-draws using the
    chunk's NEAREST corner so the shader can only ever remove.  That is what
    lets the far ring use 330 m chunks (few draw calls) with no banding.       */
/*  The exponent is 1.5 rather than 1.7 or 1.45 for a reason beyond taste: at
    exactly 1.5 the shader evaluates (dn/d)^1.5 as x·x·inversesqrt(x), three
    single-cycle instructions, where a general pow() is closer to ten — and this
    runs on every one of ~12 M grass vertices in a frame.

    What actually has to stay constant is not the blade COUNT but the screen
    COVERAGE, and coverage is density x width x height.  Since the angular floor
    widens a far blade in proportion to its distance, the far rings can trade
    count for width one-for-one and look identical: ring 3 now draws a quarter
    fewer blades at a proportionally wider stroke, which is both cheaper and,
    at eight hundred metres, more like a brush mark and less like a hair.      */
export const DENS_POW = 1.5;
export const RINGS = [
  { chunk:  9,  blades:  89000, near:0,    far:26,   dn:7,   wpx:1.70, hs:1.00 }, // 1100/m²
  { chunk: 30,  blades: 177000, near:22,   far:84,   dn:22,  wpx:2.00, hs:1.08 }, //  197/m²
  { chunk:100,  blades: 307000, near:76,   far:290,  dn:76,  wpx:2.75, hs:1.36 }, //   31/m²
  { chunk:250,  blades: 231000, near:260,  far:1250, dn:260, wpx:4.00, hs:1.95 }, //  3.7/m²
];
