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

The demo is a single self-contained HTML file. Three.js is loaded from a CDN via
an import map, so an internet connection is needed — but nothing else is.

**Just open `src/index.html` in a browser.** This works straight from `file://`:
the module script is inline, so no local file is ever fetched, and the one
import is a remote CDN URL that sends permissive CORS headers.

Serving over HTTP also works, and is the nicer option while editing:

```bash
cd src && python3 -m http.server 8000
```

Either way, click **Enter the valley** once loading completes.

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
src/index.html    the entire application (~6,100 lines, 15 numbered sections)
src/package.json  declares the Three.js version pinned in the import map
```

`src/index.html` is organised into numbered sections with a table of contents at
the top of its module script — config and palette, math and noise, the GLSL
library, terrain, sky and clouds, wind, grass, river, trees, structures, train,
particles, post-processing, camera, audio, and the boot sequence.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
