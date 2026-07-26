/*  The railway's solved geometry, published where both the terrain and the
    railway can reach it.

    The terrain reads TRACK while baking the splat map and carving the track
    bed; the railway produces it in buildTrack().  Holding it in railway.js made
    terrain -> railway -> viaduct -> terrain a cycle, which real ES modules
    resolve by evaluating the viaduct first — before the terrain has
    initialised BRIDGE.  A leaf module owning the slot breaks that.

    An importer cannot assign to an imported binding, so the owner exports a
    setter.  Importers see the live binding, i.e. they observe the new value
    after setTrack() runs; every read happens during boot, well after.        */

export let TRACK = null;
export function setTrack(t){ TRACK = t; return TRACK; }
