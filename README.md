# Hoshi-no-Tani — The Valley of Stars

A procedural Ghibli-style valley rendered in real time with WebGL and Three.js.
Terrain, grass, sky, water, stone, the steam train, the village and the entire
soundtrack are generated at runtime — no textures, no models, no audio samples.

## Attribution

This is a fork. The original work was created by **Lentils** on CodePen:

- Original pen: <https://codepen.io/editor/lentils801/pen/019f9b4b-10d7-7f77-817f-f4eb83fdb289>
- Original author: Lentils (<https://codepen.io/lentils801>)

Released under the MIT License, `Copyright (c) 2026 Lentils`. The full text and
the original copyright notice are retained verbatim in [LICENSE.txt](LICENSE.txt)
and must be preserved in any copy or substantial portion of this software,
including derivative works.

## Running it

**Just open `dist/index.html` in a browser.** It is a single self-contained
file and runs straight from `file://` — no server, no install. Three.js comes
from a CDN, so an internet connection is needed, but nothing else is.

Click **Enter the valley** once loading completes.

### Developing

The source lives as ES modules under `src/modules/`. Those need a server,
because relative imports are blocked under `file://`:

```bash
cd src && python3 -m http.server 8000
```

Then open <http://localhost:8000>. After editing, regenerate the
single-file build:

```bash
python3 tools/build.py
```

`tools/build.py --check` verifies `dist/` is up to date without writing.

### Controls

| Key | Action |
| --- | --- |
| `WASD` | Walk |
| `Shift` | Run |
| Mouse | Look (click to capture the pointer) |
| `F` | Toggle flight — `Space` / `Ctrl` for up and down |
| `T` | Summon the train |
| `C` | Cinematic camera |
| `H` | Settings panel |
| `P` | Pause time-of-day drift |
| `1`–`4` | Quality presets (low / medium / high / ultra) |
| `Esc` | Release the pointer |

The scene also responds to URL parameters: `?q=0..3` sets the quality preset
(and disables auto-adjustment), `?d=` grass density, `?s=` render scale,
`?post=0` bypasses the post-processing chain, and `?cam=x,z,heading,pitch`
overrides the spawn position — useful for returning to a specific view while
iterating.

## Layout

```
src/index.html     the HTML shell — markup, CSS, import map
src/modules/*.js   the application, as ES modules
src/package.json   declares the Three.js version pinned in the import map
tools/build.py     bundles src/ into the single-file dist/
dist/index.html    GENERATED — the file:// build. Run it; don't edit it.
```

The application is organised into numbered sections. `config.js`, `palette.js`,
`scene-contract.js` and `math.js` have been extracted so far; `main.js` still
holds the rest — the GLSL library, terrain, sky and clouds, wind, grass, river,
trees, structures, train, particles, post-processing, camera, audio, and the
boot sequence — and is being carved up section by section.

`dist/index.html` exists because the demo must stay double-clickable. An inline
module script can run from `file://`; relative imports between local modules
cannot, since they are same-origin fetches from an opaque `null` origin. The
build concatenates the modules back into one inline script. See
`tools/file-protocol-test/` for the evidence.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
