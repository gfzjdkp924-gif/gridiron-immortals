#!/usr/bin/env python3
"""
Compare the launcher-icon files INSIDE a built .aab against the icon set our own
generator renders — on what a person can SEE, not on the bytes a packager happened
to write.

WHY THIS EXISTS. `aapt2` re-compresses and re-encodes every PNG it packages. For
fully-transparent pixels it normalises the colour channels to zero, so a
byte-for-byte (md5) comparison of a packaged icon against the file our generator
produced reports a difference that no eye and no launcher can ever see. The old
icon check in tools/aab-independent-verify.sh counted those as "UNMATCHED", which
read as "the wrong launcher icon is in the bundle" when the icon was in fact
exactly ours. That is the failure mode this tool removes: it compares the two
images as RENDERED, compositing each over white and over black, and it keeps the
raw-byte result as an annotation so a real byte change is never hidden — merely
never mistaken for a wrong icon.

WHAT IT DOES, per expected icon file:
  * find its twin in the bundle by resource name (aapt2 renames `mipmap-hdpi` to
    `mipmap-hdpi-v4`, so any version/qualifier suffix is accepted);
  * if the dimensions differ                       → VISIBLE-DIFFERENT (FAIL);
  * if the bytes are identical                     → VISIBLE-IDENTICAL, annotated
                                                     "byte-identical";
  * otherwise composite both over WHITE and over BLACK and compare the resulting
    RGB bytes:
        identical over both  → VISIBLE-IDENTICAL, annotated with exactly how the
                               raw bytes differ (e.g. "re-encoded by aapt2: N
                               differing pixels, every one fully transparent in
                               both files"), plus an explicit NOTE if any pixel's
                               ALPHA differs — that is the one raw difference that
                               can matter, so it is never quietly folded away;
        not identical        → VISIBLE-DIFFERENT (FAIL) with the pixel count and
                               the largest channel delta.

Exit code: 0 when every expected icon is present and visibly identical, 1
otherwise (a visibly different icon can never pass).

    python3 aab-icon-visible-diff.py --bundle-root DIR --expected DIR \
        [--icons-tool tools/android-icons.py] [--verbose]

`--bundle-root` is an unpacked .aab (the script reads any PNG under it);
`--expected` is a directory holding the generator's own output (produce it with
`python3 tools/android-icons.py install <dir>`); `--icons-tool` is used only to
reuse that tool's PNG decoder, so the two tools can never disagree about what a
file contains.

Everything is Python 3 standard library: this box and the CI runner have no
Pillow, and the point is that the check cannot be skipped for want of one.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from pathlib import Path

PNG_SUFFIX = ".png"

# `mipmap-hdpi`, `mipmap-hdpi-v4`, `mipmap-xhdpi-v4` … all name the hdpi bucket.
DENSITY_RE = re.compile(r"^mipmap-([a-z]+)(?:-.*)?$")


def load_png_reader(tool: Path):
    """Reuse the generator's own PNG decoder rather than writing a second one."""
    sys.dont_write_bytecode = True  # never litter tools/ with __pycache__
    spec = importlib.util.spec_from_file_location("gi_android_icons", tool)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load the icon tool at {tool}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.read_png


def flat(pixels) -> bytes:
    out = bytearray(len(pixels) * 4)
    i = 0
    for r, g, b, a in pixels:
        out[i] = r
        out[i + 1] = g
        out[i + 2] = b
        out[i + 3] = a
        i += 4
    return bytes(out)


def over(channel: int, alpha: int, background: int) -> int:
    """One channel of `channel` at `alpha`/255 composited over `background`."""
    return (channel * alpha + background * (255 - alpha) + 127) // 255


def bundle_index(root: Path) -> dict[tuple[str, str], Path]:
    """(density, filename) -> path, for every PNG anywhere under `root`."""
    index: dict[tuple[str, str], Path] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() != PNG_SUFFIX:
            continue
        match = DENSITY_RE.match(path.parent.name)
        if match:
            index.setdefault((match.group(1), path.name), path)
    return index


def rel_expected(path: Path, root: Path) -> tuple[str, str] | None:
    """'mipmap-hdpi/ic_launcher.png' -> ('hdpi', 'ic_launcher.png')."""
    match = DENSITY_RE.match(path.parent.name)
    if not match:
        return None
    return match.group(1), path.name


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--bundle-root", required=True)
    ap.add_argument("--expected", required=True)
    ap.add_argument("--icons-tool", default=str(Path(__file__).with_name("android-icons.py")))
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    bundle_root = Path(args.bundle_root)
    expected_root = Path(args.expected)
    icons_tool = Path(args.icons_tool)
    if not icons_tool.is_file():
        raise SystemExit(f"--icons-tool: {icons_tool} does not exist")
    read_png = load_png_reader(icons_tool)

    expected = [p for p in sorted(expected_root.rglob(f"*{PNG_SUFFIX}")) if p.is_file()]
    if not expected:
        raise SystemExit(f"no PNGs under --expected {expected_root}")
    index = bundle_index(bundle_root)

    identical = 0
    different = 0
    missing = 0
    failures: list[str] = []

    for path in expected:
        rel = path.relative_to(expected_root)
        key = rel_expected(path, expected_root)
        if key is None:
            continue
        density, name = key
        twin = index.get((density, name))
        shown = str(rel)

        if twin is None:
            missing += 1
            failures.append(shown)
            print(
                f"  MISSING            {shown:<48} no {name} under a mipmap-{density}* "
                "directory in the bundle"
            )
            continue

        eb = path.read_bytes()
        bb = twin.read_bytes()
        if eb == bb:
            identical += 1
            print(f"  VISIBLE-IDENTICAL  {shown:<48} (byte-identical)")
            continue

        # Only files aapt2 rewrote need decoding — everything else already matched.
        ew, eh, e_px = read_png(path)
        bw, bh, b_px = read_png(twin)
        if (ew, eh) != (bw, bh):
            different += 1
            failures.append(shown)
            print(
                f"  VISIBLE-DIFFERENT  {shown:<48} ← FAIL: size differs — the bundle has "
                f"{bw}×{bh}, ours is {ew}×{eh}"
            )
            continue

        e = flat(e_px)
        b = flat(b_px)
        n = ew * eh
        raw_diff = 0
        invisible = 0
        alpha_diff = 0
        vis_white = 0
        vis_black = 0
        max_delta = 0
        first: tuple[int, int] | None = None
        for i in range(n):
            o = i * 4
            if e[o : o + 4] == b[o : o + 4]:
                continue
            raw_diff += 1
            ea, ba = e[o + 3], b[o + 3]
            if ea == 0 and ba == 0:
                invisible += 1
            elif ea != ba:
                alpha_diff += 1
            worst = 0
            for ch in range(3):
                w = abs(over(e[o + ch], ea, 255) - over(b[o + ch], ba, 255))
                k = abs(over(e[o + ch], ea, 0) - over(b[o + ch], ba, 0))
                if w:
                    vis_white += 1
                if k:
                    vis_black += 1
                worst = max(worst, w, k)
            max_delta = max(max_delta, worst)
            if worst and first is None:
                first = (i % ew, i // ew)

        if vis_white == 0 and vis_black == 0:
            identical += 1
            if raw_diff == 0:
                detail = (
                    "re-encoded by aapt2: the pixel data is identical, only the PNG "
                    "encoding differs"
                )
            elif invisible == raw_diff:
                detail = (
                    f"re-encoded by aapt2: {raw_diff} differing pixels, every one fully "
                    "transparent in both files"
                )
            else:
                detail = (
                    f"{raw_diff} differing pixels, none of which change the image over "
                    "white or over black"
                )
            print(f"  VISIBLE-IDENTICAL  {shown:<48} ({detail})")
            if alpha_diff:
                note = (
                    f"NOTE: {shown} also differs in the ALPHA channel on {alpha_diff} "
                    "pixel(s) — composited identically over white and black here, but "
                    "worth a look"
                )
                print(f"    {note}")
            if args.verbose and raw_diff:
                print(f"    raw bytes differ; max channel delta in invisible pixels: {max_delta}")
        else:
            different += 1
            failures.append(shown)
            where = f"first at x={first[0]},y={first[1]}" if first else "—"
            print(
                f"  VISIBLE-DIFFERENT  {shown:<48} ← FAIL: {vis_white} visible pixel(s) over "
                f"white, {vis_black} over black, largest channel delta {max_delta} ({where}); "
                f"{raw_diff} differing pixels, {alpha_diff} of them in alpha"
            )
        del e, b, e_px, b_px

    total = identical + different + missing
    print(
        f"-- composited-over-white-and-black identical for {identical}/{total} files "
        f"(visible differences: {different})"
    )
    print(f"-- visible-identical: {identical}  visibly-different: {different}  missing: {missing}")
    for shown in failures:
        print(f"-- the bundle's {shown} is NOT our icon (or is not there at all)")
    if failures:
        print(
            "-- ICON-CHECK: FAIL — " + str(len(failures)) + " icon file(s) are not visibly our artwork: "
            + ", ".join(failures)
        )
        return 1
    print("-- ICON-CHECK: PASS — every icon in the bundle is visibly our artwork")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
