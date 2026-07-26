/*───────────────────────── §0c  THE SCENE CONTRACT ──────────────────────────*/
/*  Whether a mesh casts a shadow is decided by collectShadowSet() (§15) from
    exactly one fact: does it carry a `userData.depth` material?  If so, the
    shadow pass re-draws it with that material; if not, the mesh is hidden for
    the duration of the pass.  Nothing else is consulted.

    That makes an omission SILENT.  Forget the depth material on a new building
    and it quietly stops casting — and under a 13.5° sun, where the shadow
    carries most of the form, a missing shadow reads as a lighting bug rather
    than as a missing property, so you go looking in the wrong place entirely.

    Meshes are therefore never handed to `scene.add` directly.  addMesh() takes
    the shadow behaviour as a REQUIRED argument and NO_CAST is a value you have
    to type, so the decision cannot be skipped — only made, one way or another. */

export const NO_CAST = Symbol('no shadow');

export function addMesh(parent, obj, depth){
  if(depth === undefined) throw new Error(
    `addMesh(${obj.name || obj.type}): pass a depth material or NO_CAST. `+
    `A mesh with neither casts no shadow, and says nothing about it — §0c.`);
  if(depth !== NO_CAST) obj.userData.depth = depth;
  parent.add(obj);
  return obj;
}

/*  Bulk containers — the grass field, the particle systems — are hidden
    wholesale by a single flag rather than walked mesh by mesh, so their
    children never reach the test above and declare nothing individually.     */
export function addBulk(parent, group){
  group.userData.bulk = true;
  parent.add(group);
  return group;
}

/*  For a rig that assembles its own meshes internally and wants one depth
    material across all of them — the locomotive — the declaration is made in
    a single sweep after construction rather than at each internal .add().    */
export function setDepth(root, mat){
  root.traverse(o=>{ if(o.isMesh) o.userData.depth = mat; });
  return root;
}

