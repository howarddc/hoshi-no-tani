# AGENTS.md

Orientation for coding agents working on this repository. Read this before
touching `src/index.html`.

---

## 1. What this is

**Hoshi-no-Tani ("The Valley of Stars")** — a real-time procedural Ghibli-style
valley in WebGL, built on Three.js. Terrain, grass, sky, water, stone, the
steam train, the village and the entire soundtrack are generated at runtime.

The whole application is **one file**: `src/index.html`, ~6,180 lines, a single
`<script type="module">` with Three.js loaded from a CDN via an import map.
There is no build step, no bundler, no test suite, and no framework.

### Three hard rules

**1. This is a fork with two copyright holders. Do not touch either notice.**
The valley itself was written by **Lentils** (codepen.io/lentils801); the work
of modularising it, the build system, the scene contract, the docs and CI is by
**Rob Howard**. Both are MIT, and `LICENSE.txt` carries both notices plus a
provenance breakdown. MIT requires those notices survive verbatim in all copies
and derivative works — never edit, reword, reorder or "tidy" them, and do not
drop Lentils' line on the grounds that the file has since been rewritten.

The notices also live in the banner `tools/build.py` writes into
`dist/index.html`, because that file is built to be distributed on its own and
is therefore a "copy" in the sense the licence means. If you change the banner,
keep them.

**2. Nothing may be loaded from a file. Everything is generated.**
The loading screen promises "no textures, no models, no recordings," and that
constraint is the entire point of the project. Do not add an image, a `.glb`,
an audio sample, a font file, or a lookup texture baked offline. If you need a
texture, generate it into a render target at boot (see `PUFFATLAS_FS`, which
bakes four cloud-puff profiles into a 1024² atlas at startup). If you need a
sound, synthesise it (§14 is oscillators, noise buffers, biquads, and a
convolution reverb whose impulse response is decaying noise).

**3. Commit after each batch of work.**
Standing instruction from the repo owner — do not ask each time. Do **not**
`push` unless explicitly asked; `origin` points at a GitHub remote and
publishing is a separate, outward-facing decision.

---

## 2. Layout

```
AGENTS.md            this file
README.md            user-facing: what it is, attribution, controls, URL params
LICENSE.txt          MIT, Copyright (c) 2026 Lentils — DO NOT EDIT
src/index.html       the HTML shell — markup, CSS, import map, error handler
src/modules/*.js     the application, as ES modules
src/package.json     declares three@0.180.0 — matches the import map pin
tools/build.py       bundles src/ -> dist/index.html
tools/file-protocol-test/   evidence for why the bundle exists
dist/index.html      GENERATED, and tracked. Never hand-edit — rebuild.
```

**`dist/index.html` is generated but committed.** It is the artefact a user
double-clicks, so a fresh clone must contain it. It carries a DO-NOT-EDIT
banner. After changing anything under `src/`, run `python3 tools/build.py` and
commit the result alongside the source; `--check` fails if `dist/` is stale.

`src/package.json` is **not** read by anything at runtime; there is no bundler.
It exists to record the version the import map pins. If you change one, change
both. Do not bump Three.js casually — this codebase is dense with
`RawShaderMaterial` and GLSL3, and Three makes breaking changes in minor
releases.

---

## 3. Running and verifying

**`dist/index.html` runs straight from `file://`** — double-click it. The
bundled module script is inline, so no local file is fetched, and the single
`three` import resolves to a CDN URL sending `Access-Control-Allow-Origin: *`,
which an opaque `null` origin may read.

**`src/` needs a server.** Relative imports between modules *are* same-origin
fetches from a `null` origin and are blocked under `file://` — confirmed by
running `tools/file-protocol-test/` in Chrome on 2026-07-26 (test A passed,
test B failed). That asymmetry is the entire reason `tools/build.py` exists.

```bash
cd src && python3 -m http.server 8000   # develop here
python3 tools/build.py                  # then regenerate dist/
```

### If you are an agent in a sandboxed environment, read this

Two environment traps have cost real time before:

- **Serving from the repo path may fail.** A tool-spawned server process may be
  unable to `getcwd` or read `~/Desktop`. `python3 -m http.server` fails at
  argparse time on `os.getcwd()` even with `--directory`. Workaround: copy
  `src/index.html` into a scratchpad directory and serve it with a small script
  using `SimpleHTTPRequestHandler(directory=...)`.
- **Boot stalls unless you pump it.** `boot()` awaits `idle()` (a
  `requestAnimationFrame` + `setTimeout`) between stages. Automated browser
  panes suspend rAF while hidden, so loading parks partway. Each `screenshot`
  call advances roughly one frame — about six gets you from 4% to READY. The
  same limit makes interactive camera work impractical: one frame per
  screenshot, so flying to a vantage point is not realistic.

- **Close the preview tab when you finish.** This is a heavy real-time scene —
  a million-blade grass field, planar reflections, a full post chain — and its
  `requestAnimationFrame` loop runs for as long as the page is loaded, pinning
  the machine's GPU and CPU. **Stopping the dev server does not stop it:** the
  page is already in memory and keeps rendering. Verify with `tabs_context`
  that nothing is left holding the scene, and do it *before* writing your
  summary so it is not skipped if the turn ends early.

**`dist/` is deployed, not just committed.** `.github/workflows/pages.yml`
publishes it to GitHub Pages on every push to `main`, so it is live at
<https://howarddc.github.io/hoshi-no-tani/>. A stale or broken `dist/` is
therefore visible to every visitor, not merely wrong in the repo — which is why
both workflows gate on `tools/build.py --check`. Always rebuild after touching
anything in `src/`.

Node is not installed on the owner's machine (`node`/`npx` absent), so there is
no offline syntax check. **A full boot to READY in a browser is the
parse-and-execute check.** The `#err` overlay catches both `window.onerror` and
the `boot().catch`, so a thrown error is visible on screen rather than silent.

### URL parameters (useful for iterating)

| Param | Effect |
| --- | --- |
| `?cam=x,z,heading,pitch` | Override spawn position — return to a specific view |
| `?q=0..3` | Quality preset; also disables auto-downgrade |
| `?d=` | Grass density multiplier |
| `?s=` | Render scale |
| `?post=0` | Bypass the post chain (raw Reinhard + gamma) |

`?t=` is **dead** — assigned to `window.__startT` and never read.

Also exposed for debugging: `window.__dbg` (height range, spawn height, water
and deck levels, sun vector, float-vs-half texture path), `window.__ready`,
`window.__W` (the walker), `window.__H` (`sampleHeight`).

---

## 4. Architecture

`src/index.html` is organised into numbered sections with a table of contents
at the top of the module script. **Line numbers below are as of commit
`9b5c849` and will drift — the `§` banner comments are the durable anchor.**

| § | Line | Contents |
| --- | --- | --- |
| §0 | 178 | `CFG`, `QUALITY` presets, `RINGS` (grass LOD bands) |
| §0b | 262 | `P` — every colour in the film, sRGB hex → linear |
| §0c | 310 | **The scene contract** — `addMesh` / `addBulk` / `setDepth` |
| §1 | 354 | Math, mulberry32 PRNG, gradient noise, fbm / ridged / billow |
| §2 | 408 | GLSL library — shared chunks injected into every shader |
| §3 | 798 | Terrain bake, river spline, distance fields, clipmap mesh |
| §4 | 1398 | Sky, cloud coverage field, procedural cumulus |
| §5 | 1645 | Wind — GPU field pass and its CPU mirror |
| §6 | 1879 | Grass — blade geometry, instancing, `GrassField` ring manager |
| §7 | 2466 | River — swept ribbon, flow-aligned streaks, glitter |
| §8 | 2668 | Trees — swept tubes, noise-pushed canopy clumps |
| §9 | 3027 | Viaduct — arches, voussoirs, piers |
| §9b | 3261 | Railway — graded formation, ballast, sleepers, bullhead rail |
| §9c | 3735 | Village — the painted-mesh toolkit and the buildings |
| §10 | 3893 | The train — 2-6-0 with solved valve gear; `Particles` |
| §12 | 4321 | Post chain — bloom, watercolour soften, print curve, FXAA |
| §13 | 4513 | `Walker` — gait clock, head bob, collision |
| §14 | 4669 | `Audio` — fully synthesised |
| §15 | 5024 | Boot, render targets, render passes, frame loop, input |

**Note:** the table of contents lists a `§11 life (pollen, birds, butterflies)`
that does not exist as a section — there is no `§11` banner, and there are no
butterflies anywhere in the code. The particle systems live at the end of §10
and the mote/bird logic sits inside §15. Don't go looking.

### The two ideas that carry the whole design

**One heightmap is the single source of truth, shared by CPU and GPU.**
`heightData` is baked once and uploaded as an R32F (or R16F) texture.
`sampleHeight()` mirrors the GPU's bilinear filter *exactly*, so collision,
audio, particle placement and rendering can never disagree. The same discipline
applies to wind: `WIND_FS` on the GPU, `windAtJS()` on the CPU. **If you change
one side of either pair, you must change the other.**

**Work is deferred, baked, or interleaved rather than done per fragment.**
The frame loop runs three auxiliary passes on a `frameNo % 3` rotation — wind
field, sun shadow, cloud shadow — so no frame pays for more than one and
nothing updates below 20 Hz. The planar reflection runs only on phase 0, only
at quality ≥ 2, and only when `riverOnScreen()` confirms water is both visible
and within 380 m.

### The two optimisations you must not accidentally undo

- **The grass depth prepass.** The two near rings are drawn twice: once with
  `colorWrite:false` to lay down depth at rasteriser speed, then normally, so
  early-Z rejects the ~30 blades of overdraw at every pixel. The prepass uses
  the *full-tessellation* blade deliberately — a cheaper occluder under-covers
  and hands back millions of shaded fragments through the gaps. The beauty pass
  keeps `LESS-EQUAL` rather than `EQUAL`, so no blade can be dropped.
- **The baked cloud-shadow map.** The coverage field is thirteen octaves of
  domain-warped fbm (~250 ALU). It is evaluated **once per frame into a 512²
  map**, not per fragment — six different shaders read it. Never inline
  `cloudShadow()` back into a fragment shader.

---

## 5. Invariants

### 5.1 The scene contract (§0c) — read this before adding anything visible

Shadow casting is decided by `collectShadowSet()` from exactly one fact: does
the mesh carry a `userData.depth` material?

```js
if(o.userData.proxy){ o.visible = true; o.material = o.userData.depth; }
else if(o.userData.depth) o.material = o.userData.depth;
else o.visible = false;
```

An omission is therefore **silent** — a mesh without a depth material simply
stops casting, and under a 13.5° sun where shadow carries most of the form,
that reads as a lighting bug rather than a missing property.

So meshes are never handed to `scene.add` directly:

```js
addMesh(scene, mesh, someDepthMaterial);  // casts
addMesh(scene, mesh, NO_CAST);            // deliberately does not
addBulk(scene, group);                    // container hidden wholesale
setDepth(rig.group, mat);                 // rig that builds its own meshes
```

`addMesh` throws if the third argument is omitted. `NO_CAST` is a value you
have to type, so the decision cannot be skipped — only made.

A historical note, so nobody reintroduces it: there used to be a
`userData.noCast` flag, written on six meshes and **read by nothing**. It was
documentation masquerading as a mechanism. It was removed in `9b5c849`.

### 5.2 Render order is a fixed ladder

| Order | Object |
| --- | --- |
| `-500` | Distant ridge silhouettes |
| `-20 + ring` | Grass depth prepass |
| `1` | Terrain (and the proxy) |
| `2` | Viaduct, railway, village, trees |
| `3` | Water |
| `4 + ring` | Grass beauty pass |
| `9` | Sky |
| `10` | Clouds |
| `20+` | Particles |

**The sky is drawn last on purpose.** `SKY_VS` forces every vertex to the far
plane, so an ordinary less-equal depth test discards it wherever the valley
already painted — for free, in hardware. Drawing it first shaded a full screen
of gradient, Mie halo and warped cirrus that was then painted over.

### 5.3 Uniform plumbing

`G` is the shared uniform block — time, sun, camera, wind, textures, shadow
matrix. `U(extra)` returns a shallow copy with additions; because it is
shallow, every material shares the *same uniform objects* for the globals, so
writing `G.uTime.value` updates all of them at once. Materials are built by
`RSM(vs, fs, uniforms, opts)`; depth-only variants by `DSM(...)`, which sets
`colorWrite:false` — this both saves ~16 MB/pass of pointless bandwidth and
lets the hardware take its double-speed depth-only path.

A depth material that needs its own value (e.g. trees carry a shadow-volume
cull radius the beauty pass must not inherit) needs its **own** uniform object.
See the `uni` / `dUni` pair in the tree setup.

### 5.4 Other things that will bite

- Palette colours are injected into GLSL as `const vec3` **literals at shader
  build time**. Anything that needs to change at runtime (a day/night cycle,
  for instance) must first be promoted from a literal to a uniform. `SUN` is
  likewise a module-level constant.
- `reflectSet` opts a mesh into the planar reflection. Adding to it costs a
  second full render of that object.
- `pushSolid(x, z, hx, hz, yaw)` registers an oriented box for walker
  collision. A new building that skips it can be walked through.
- The bake buffers (`heightData`, `splatData`, `meadowData`, `TRACK`, `BR`,
  `SOLIDS`, `RIVER_PTS`, `PATH_PTS`) are module-level mutable state written in
  a specific order during `boot()`. Order matters: `bakeMeadow()` must run
  after `bakeSplat()`; the railway grade is stamped into `heightData` before
  `carveTrackBed()`.

---

## 6. Where to extend

| Want to add | Go to |
| --- | --- |
| A building or prop | The painted-mesh toolkit in §9c (`PB`/`pv`/`pbox`/`pcyl`/`proof`/`finishPainted`), then `pushSolid` |
| A particle type | Write a fragment shader, instantiate `Particles` (see `SMOKE_FS`/`MOTE_FS`/`BIRD_FS`) |
| A colour change | `P` in §0b — everything derives from it |
| A new shader | Build via `RSM`/`DSM` and compose `GL_LIGHT`, `GL_AIR`, `GL_SHADOW`, `GL_TERRAIN`, `GL_WIND` so lighting stays consistent |
| A sound | `Audio` in §14 — synthesis only |
| A boot stage | `boot()` in §15 is a linear script with progress callbacks |

The classes are already dependency-injected — `GrassField(scene, uniforms,
quality)`, `Train(scene, uni)`, `Particles(parent, uni, max, frag, order,
sort)`, `Walker(cam)` — which is what makes the module split (below) tractable.

### Worked example: adding a building to the village

The shortest path that touches every rule that matters.

1. **Model it** in `village.js`, using the painted-mesh toolkit — `PB()` to open
   a buffer, then `pbox` / `pcyl` / `proof` to add boxes, cylinders and gabled
   roofs, then `finishPainted(M)`. Colours come from `LC('wallA')` and friends,
   never from literals: everything derives from `P` in `palette.js`.
2. **Register collision** with `pushSolid(x, z, hx, hz, yaw)` as you place it.
   Skip this and the walker strolls straight through the wall.
3. **Sit it on the ground** with `sampleHeight(x, z)`. Do not re-derive terrain
   height any other way — `sampleHeight` mirrors the GPU's bilinear filter
   exactly, and that agreement is what keeps geometry, collision and shading
   from drifting apart (§4).
4. **Add it to the scene** with `addMesh(scene, mesh, someDepthMaterial)` — or
   `NO_CAST` if it genuinely should not cast. There is no third option; the
   call throws without it (§5.1). The village already builds a `paintedDepth`
   you can share.
5. **Set `renderOrder = 2`**, the ladder position for solid world geometry
   (§5.2).
6. **Rebuild and verify**:

   ```bash
   python3 tools/build.py          # fails on stale dist, bad imports, cycles
   cd src && python3 -m http.server 8000    # then boot it and look
   ```

   Booting the un-bundled `src/` is not optional — it is the only check that
   catches a missing import or a cycle (§9).
7. **Close the browser tab** when you are done (§3), and commit.

The same shape applies to a new prop, a new tree species, or a new particle
type; only step 1 changes.

---

## 7. Known dead code

Confirmed by grep; safe to remove, listed so nobody assumes they are load-bearing.

- `State.adapt`, `State.frameMs` — declared, never read.
- `window.__startT` / the `?t=` URL parameter — assigned, never read.
- `acc` in `Walker.update` — computed, discarded.
- `MOTE_N` is 2200 while the `Particles` pool is allocated at 2400. Harmless
  headroom, not a bug.

---

## 8. House style

**Comments explain *why*, including what was tried and rejected.** This is the
most distinctive thing about the codebase and it is worth preserving. Example:
`DENS_POW` is 1.5 rather than 1.45 because at exactly 1.5 the shader evaluates
`(dn/d)^1.5` as `x*x*inversesqrt(x)` — three single-cycle instructions against
roughly ten for a general `pow()` — and it runs on ~12 M grass vertices per
frame. Match that density and that register of prose. Do not strip these
comments as "verbose"; they are the design record.

**Commit messages follow the same rule** — what changed, why, and what was
rejected. Co-author trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

**Verify before claiming.** Boot the thing. If you could not verify something,
say so explicitly rather than implying it works.

---

## 9. State and roadmap

Agreed plan with the repo owner:

1. ~~`git init` and commit the baseline~~ — done
2. ~~Drop the duplicated `dist/`, the vestigial CodePen artifacts, fix
   attribution, pin Three.js~~ — done (`25c614f`)
3. ~~Replace the inert `noCast` flag with the enforced §0c contract~~ — done
   (`9b5c849`)
4. **Split `src/index.html` into ES modules** — *in progress*

### On step 4

Decided: plain ES modules plus `tools/build.py`, a dependency-free Python
bundler. Node and esbuild were considered and rejected — Node is not installed,
and the project's only dependency is one CDN URL, so a toolchain would be a
large addition for a small benefit. The bundler can be swapped for esbuild
later without touching the source.

Concatenation is sound here *because* the app was one file: every top-level
name is already unique and there are no circular imports. `build.py` asserts
that and refuses to emit if the source drifts from the rules in its docstring
(imports/exports at column 0, one per line, no `export default`, no
`export {}`, `three` the only bare specifier). **Keep the source obeying those
rules** rather than loosening the parser.

**Done.** 22 modules, none over 610 lines; `main.js` is 1,149 and holds the
boot sequence, render passes, frame loop and input.

Four modules exist for reasons that are not obvious from their contents, and
merging them back would reintroduce the bug they were created to fix:

| Module | Why it is separate |
| --- | --- |
| `field.js` | `makeDF` lived in the viaduct, but the terrain needs it while baking the splat map — `terrain → viaduct → terrain` was a cycle |
| `track-ref.js` | Owns the `TRACK` slot. It was in `railway.js`, making `terrain → railway → viaduct → terrain` a cycle. An importer cannot assign to an imported binding, hence the `setTrack` setter |
| `materials.js` | `G`/`U`/`RSM`/`TRANSP` were in §15; `train.js` builds materials during construction and nothing can import from the entry module |
| `config.js` | Also owns `HM`/`WS`/`HALF`, moved off `terrain.js` so `field.js` can reach them without importing the terrain |

`DSM` deliberately stayed in `main.js`: only main uses it, and it depends on
`DEPTH_FS` from `post.js`.

`tools/build.py` enforces three things on every run, and CI runs it with
`--check` on every push and pull request:

- `dist/index.html` is in sync with `src/` (the easiest thing to forget)
- every imported name is actually exported by the module it comes from
- there are no import cycles

**Two further checks, and you need both — they catch different things.**

1. *Diff the bundle.* Because it is a concatenation in a fixed order, a correct
   change produces **zero difference in executable code**. This catches
   reordering and dropped lines instantly.
2. *Boot the un-bundled `src/` over HTTP.* The bundle shares one scope, so it
   runs fine with imports missing or cyclic. **Only the module path can catch a
   missing import or an import cycle.** Every cycle above was found this way,
   and never by the bundle.

### Not yet verified

The demo has been booted to READY and confirmed rendering correctly (grass,
viaduct, village, cumulus, live HUD, ~33–43 fps in an automated browser). What
has *not* been done is an isolated before/after comparison of a cast shadow
following the §0c refactor — the behaviour was verified statically from the
diff instead, since the automated pane advances one frame per screenshot. If
you are running in a real browser, walking to the viaduct and confirming it
lays a shadow across the meadow is a worthwhile ten-second check.
