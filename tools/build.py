#!/usr/bin/env python3
"""Bundle src/ into a single self-contained dist/index.html.

Why this exists
───────────────
Hoshi-no-Tani must keep running from file:// (double-click to run). An inline
module script can do that, because its only import is a remote CDN URL that
sends permissive CORS headers. Relative imports of local files cannot: they are
same-origin fetches from an opaque `null` origin, and browsers block them.

So the source lives as real ES modules (nice to edit, reviewable diffs) and this
script concatenates them back into one inline script (double-clickable).

Why concatenation is sound here
───────────────────────────────
The app was a single 6,000-line file, so every top-level name is already unique
and there are no circular imports. Emitting the modules in dependency order and
deleting the import/export bookkeeping reproduces the original program exactly.

That only holds while the source obeys the rules below, so this script asserts
every one of them and refuses to emit a bundle if any is broken. A loud failure
here is much cheaper than a silently mis-ordered bundle.

    * imports and exports start at column 0, one statement per line
    * `export` may only prefix const / let / function / class / async function
    * no `export default`, no `export { ... }`, no re-exports
    * the only bare specifier is `three`; everything else is relative
    * no circular imports
    * no duplicate top-level names across modules

Usage:  python3 tools/build.py [--check]
        --check verifies dist/ is up to date without writing (exit 1 if stale).
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHELL = ROOT / "src" / "index.html"
OUT = ROOT / "dist" / "index.html"

# `import ... from './x.js';`  |  `import './x.js';`
IMPORT_RE = re.compile(r"""^import\s+(?:(.+?)\s+from\s+)?['"]([^'"]+)['"]\s*;?\s*$""")
EXPORT_RE = re.compile(r"^export\s+(?=(?:const|let|var|function|class|async)\b)")
BAD_EXPORT_RE = re.compile(r"^export\s*(?:\{|default\b|\*)")
# best-effort top-level declaration names, including `const a = 1, b = 2;`
DECL_RE = re.compile(
    r"^(?:export\s+)?(?:const|let|var|function|class|async\s+function)\s+"
    r"([A-Za-z_$][\w$]*)"
)
EXTRA_DECL_RE = re.compile(r"[,(]\s*([A-Za-z_$][\w$]*)\s*=")
SCRIPT_TAG_RE = re.compile(
    r"""<script\s+type=["']module["']\s+src=["']([^"']+)["']\s*>\s*</script>"""
)


class BuildError(Exception):
    pass


def named(clause: str):
    """'{ a, b as c }' -> ['a', 'b']; '* as THREE' / 'X' -> []"""
    clause = (clause or "").strip()
    if not clause.startswith("{"):
        return []
    out = []
    for part in clause.strip("{}").split(","):
        part = part.strip()
        if part:
            out.append(part.split(" as ")[0].strip())
    return out


def exports_of(path: Path):
    names, in_tpl = set(), False
    for line in path.read_text().splitlines():
        was = in_tpl
        if (line.count("`") - line.count("\\`")) % 2:
            in_tpl = not in_tpl
        if was or not line.startswith("export "):
            continue
        m = DECL_RE.match(line)
        if not m:
            continue
        names.add(m.group(1))
        if re.match(r"^export\s+(const|let|var)\b", line):
            names.update(EXTRA_DECL_RE.findall(line))
    return names


def parse(path: Path):
    """-> (relative deps, bare imports, body lines with export/import stripped)

    deps are (resolved_path, [imported names]) so the caller can verify that
    every name actually exists in the target module.
    """
    deps, bare, body = [], [], []
    for n, line in enumerate(path.read_text().splitlines(), 1):
        where = f"{path.relative_to(ROOT)}:{n}"

        if BAD_EXPORT_RE.match(line):
            raise BuildError(
                f"{where}: `export {{...}}`, `export default` and re-exports are "
                f"not supported by this bundler.\n  {line.strip()}"
            )

        m = IMPORT_RE.match(line)
        if m:
            spec = m.group(2)
            if spec.startswith("."):
                if not spec.endswith(".js"):
                    raise BuildError(f"{where}: relative import must end in .js")
                deps.append(((path.parent / spec).resolve(), named(m.group(1)), where))
            else:
                if spec != "three":
                    raise BuildError(
                        f"{where}: the only bare specifier allowed is 'three' "
                        f"(the import map resolves it); got '{spec}'"
                    )
                bare.append(line.rstrip())
            continue  # import lines never reach the bundle

        body.append(EXPORT_RE.sub("", line))
    return deps, bare, body


def collect(entry: Path):
    """Emission order is the order main.js imports things, with main.js last.

    Order is taken from the entry's import list rather than inferred from the
    dependency graph, for two reasons.

    First, the graph genuinely has cycles: the terrain is carved to accept the
    railway (it reads TRACK) and the railway is graded against the terrain (it
    calls terrainAt). Real ES modules resolve that fine, because every
    cross-reference sits inside a function body evaluated long afterwards during
    boot — but a cycle leaves a topological sort undefined, so there would be no
    single "correct" concatenation to derive.

    Second, and more useful: keeping the entry's order means the bundle stays in
    the same order as the original single file. Every extraction can then be
    verified by diffing the new bundle against the previous one and requiring
    ZERO change in executable code, which is a far stronger check than booting.

    The cost is one rule: every module must be imported by main.js directly,
    even if another module already imports it.
    """
    if not entry.exists():
        raise BuildError(f"missing entry module: {entry}")

    entry_deps, bare, entry_body = parse(entry)
    order, modules = [], {}

    seen = set()
    for path, _, _ in entry_deps:  # keep first occurrence, drop duplicates
        if path not in seen:
            seen.add(path)
            order.append(path)

    graph, all_deps = {}, list(entry_deps)
    for path in order:
        if not path.exists():
            raise BuildError(f"missing module: {path}")
        deps, b, body = parse(path)
        modules[path] = body
        bare.extend(b)
        graph[path] = [d for d, _, _ in deps]
        all_deps.extend(deps)
        for d, _, _ in deps:
            if d not in seen and d != entry:
                raise BuildError(
                    f"{path.relative_to(ROOT)} imports {d.name}, which main.js does "
                    f"not.\n  Add it to main.js's imports too — bundle order comes "
                    f"from there, so every module must appear in that list."
                )
    graph[entry] = [d for d, _, _ in entry_deps]

    check_imports(all_deps)
    check_acyclic(graph, entry)

    modules[entry] = entry_body
    order.append(entry)
    return order, modules, bare


def check_imports(deps):
    """Every imported name must actually be exported by the target module.

    The bundle shares one scope, so it runs happily with a name imported from
    the wrong module — the mistake only shows up when the un-bundled modules
    are loaded. Catching it here means `build.py` fails instead.
    """
    cache, bad = {}, []
    for path, names, where in deps:
        if path not in cache:
            cache[path] = exports_of(path)
        for n in names:
            if n not in cache[path]:
                bad.append(f"  {where}: {path.name} does not export `{n}`")
    if bad:
        raise BuildError("imported names that do not exist:\n" + "\n".join(bad))


def check_acyclic(graph, entry):
    """Reject import cycles.

    A cycle does not disturb the bundle — order comes from main.js and one
    shared scope hides everything — but it breaks the un-bundled module path,
    where the browser evaluates a cycle in an order that can leave a `const`
    still in its temporal dead zone. That is a genuinely confusing failure
    ("Cannot access 'BRIDGE' before initialization"), and it is invisible to
    every check except actually loading the modules. There are currently no
    cycles; this keeps it that way. If you hit it, move the shared thing down
    into a leaf module — see field.js and track-ref.js, which exist for exactly
    this reason.
    """
    stack, done, found = [], set(), []

    def visit(n):
        if n in stack:
            found.append(" -> ".join(p.name for p in stack[stack.index(n):] + [n]))
            return
        if n in done:
            return
        stack.append(n)
        for d in graph.get(n, ()):
            visit(d)
        stack.pop()
        done.add(n)

    visit(entry)
    if found:
        raise BuildError("import cycle:\n  " + "\n  ".join(sorted(set(found))))


def check_unique(order, modules):
    """Reject names declared at top level in more than one module.

    Shaders are embedded as template literals full of GLSL, and GLSL declares
    things like `const float W_SIZE = ...` at column 0 — which looks exactly
    like a JS declaration of a variable named `float`. Every shader module
    would then collide with every other on `float`, `vec3`, `mat2` and friends.
    So template-literal bodies are skipped by tracking backtick parity. That is
    a heuristic, not a parser: it can miss a real duplicate, in which case the
    browser still reports the redeclaration as a SyntaxError at load.
    """
    seen = {}
    dupes = []
    for path in order:
        in_template = False
        for line in modules[path]:
            was_inside = in_template
            if (line.count("`") - line.count("\\`")) % 2:
                in_template = not in_template
            if was_inside:
                continue
            m = DECL_RE.match(line)
            if not m:
                continue
            names = [m.group(1)]
            if line.startswith(("const", "let", "var")):
                names += EXTRA_DECL_RE.findall(line)
            for name in names:
                if name in seen and seen[name] != path:
                    dupes.append(f"  {name}: {seen[name].name} and {path.name}")
                seen.setdefault(name, path)
    if dupes:
        raise BuildError(
            "duplicate top-level names across modules — concatenation would "
            "produce a redeclaration:\n" + "\n".join(sorted(set(dupes)))
        )


def build() -> str:
    shell = SHELL.read_text()
    m = SCRIPT_TAG_RE.search(shell)
    if not m:
        raise BuildError(
            f"{SHELL.relative_to(ROOT)}: no <script type=\"module\" src=\"...\">"
        )
    entry = (SHELL.parent / m.group(1)).resolve()

    order, modules, bare = collect(entry)
    check_unique(order, modules)

    if not bare:
        raise BuildError("expected an `import ... from 'three'` somewhere")
    if len(set(bare)) != 1:
        raise BuildError("conflicting three imports:\n  " + "\n  ".join(sorted(set(bare))))

    chunks = [bare[0], ""]
    for path in order:
        rel = path.relative_to(ROOT)
        chunks.append(f"/* ═══ {rel} " + "═" * max(0, 74 - len(str(rel))) + " */")
        chunks.append("\n".join(modules[path]).strip("\n"))
        chunks.append("")

    # This file is designed to be downloaded and passed around on its own, so
    # it is a "copy" in the sense the MIT licence means: the notice has to
    # travel with it. Keep this banner in the output.
    banner = (
        "<!-- ══════════════════════════════════════════════════════════════════\n"
        "     Hoshi-no-Tani — The Valley of Stars\n"
        "     A procedural Ghibli valley in WebGL.\n"
        "\n"
        "     Original work copyright (c) 2026 Lentils\n"
        "         https://codepen.io/lentils801\n"
        "     Modifications and additions copyright (c) 2026 Rob Howard\n"
        "         https://github.com/howarddc/hoshi-no-tani\n"
        "\n"
        "     Released under the MIT License. Permission is hereby granted, free\n"
        "     of charge, to any person obtaining a copy of this software and\n"
        "     associated documentation files (the \"Software\"), to deal in the\n"
        "     Software without restriction, including without limitation the\n"
        "     rights to use, copy, modify, merge, publish, distribute,\n"
        "     sublicense, and/or sell copies of the Software, and to permit\n"
        "     persons to whom the Software is furnished to do so, subject to\n"
        "     the following conditions: the above copyright notice and this\n"
        "     permission notice shall be included in all copies or substantial\n"
        "     portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\",\n"
        "     WITHOUT WARRANTY OF ANY KIND. See LICENSE.txt for the full text.\n"
        "\n"
        "     ── GENERATED FILE — DO NOT EDIT ──\n"
        "     Built from src/ by tools/build.py. Edit the modules in\n"
        "     src/modules/ and re-run:  python3 tools/build.py\n"
        "     This bundled form exists so the demo runs from file://, which\n"
        "     the un-bundled modules cannot (CORS blocks relative imports\n"
        "     from an opaque null origin).\n"
        "     ══════════════════════════════════════════════════════════════ -->"
    )
    body = "\n".join(chunks).rstrip() + "\n"
    html = shell[: m.start()] + '<script type="module">\n' + body + "</script>" + shell[m.end() :]
    return html.replace("<!DOCTYPE html>", "<!DOCTYPE html>\n" + banner, 1)


def main():
    try:
        html = build()
    except BuildError as e:
        print(f"build failed: {e}", file=sys.stderr)
        return 1

    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != html:
            print("dist/index.html is stale — run: python3 tools/build.py", file=sys.stderr)
            return 1
        print("dist/index.html is up to date")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html)
    kb = len(html) / 1024
    print(f"wrote {OUT.relative_to(ROOT)}  ({kb:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
