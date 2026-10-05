#!/usr/bin/env python3
"""
THE ANDROID LAUNCHER ICON TOOL — install our icon set into the generated Android
project, and then prove the icon in that project is ours rather than the Android
Studio placeholder that `npx cap add android` ships.

WHY THIS EXISTS. `npx cap add android` copies Capacitor's `android-template`,
which carries **Android Studio's default placeholder launcher icon** (a blue and
white cross on a light grid — the artwork Android Studio generates for every new
project). Nothing in our build opens Android Studio or the Image Asset wizard, so
without this tool the AAB uploaded to Google Play would wear that placeholder.
It is the Android twin of the iOS workflow's icon steps, and like them it is
written to be run on a machine that has **no image library at all**: no Pillow or
ImageMagick, only a Python 3 standard library, so nothing depends on which
packages a GitHub runner image happens to ship.

TWO MODES, and the second one is the point:

    python3 tools/android-icons.py install <res-dir>   # write our icons into res/
    python3 tools/android-icons.py verify  <res-dir>   # FAIL unless that res/ is
                                                       # exactly what install writes

`verify` re-renders the whole set into a temporary directory and compares it to
the project, file by file, byte for byte — so it is not an assertion about our
generator, it is an assertion about the files the build is about to compile. It
also fails if any file in the resource tree is a known Capacitor/Android Studio
placeholder by md5 (the values are in PLACEHOLDER_MD5 below, read out of
@capacitor/android 8.5.2), or if a leftover `ic_launcher*` file of any name is
still sitting anywhere under res/ — which is how a placeholder normally survives
an icon replacement.

WHAT IT WRITES (the same file names, sizes and resource names as Capacitor's own
template — deliberately, so nothing else in the project has to change):

    res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png          48…192
    …/ic_launcher_round.png                                              48…192
    …/ic_launcher_foreground.png (adaptive, 108dp scale)               108…432
    res/mipmap-anydpi-v26/ic_launcher.xml, ic_launcher_round.xml   adaptive-icon
    res/values/ic_launcher_background.xml                          the layer colour

`AndroidManifest.xml` already points at `@mipmap/ic_launcher` and
`@mipmap/ic_launcher_round`, which is why those two names are kept exactly.

    python3 tools/android-icons.py print-md5s            # the source artwork's md5
"""

from __future__ import annotations

import hashlib
import math
import shutil
import struct
import sys
import tempfile
import zlib
from pathlib import Path

# ---------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------

# The artwork inside the repository. `appstore/icons/play-icon-512.png` (the file
# Google Play's listing uses) sits OUTSIDE the repository, so CI cannot see it;
# this is a byte-identical copy, exactly as `wrapper/ios/AppIcon-1024.png` is for
# iOS. 512×512, 8-bit RGBA.
DEFAULT_SOURCE = Path("wrapper/android/play-icon-512.png")

DENSITIES = [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]
LEGACY_DP = 48  # ic_launcher.png / ic_launcher_round.png
FOREGROUND_DP = 108  # adaptive foreground layer

# The adaptive foreground is the artwork as a disc, inset so that it fits inside
# Android's 66dp "safe zone" (the part of the 108dp adaptive canvas that is never
# cropped or clipped, whatever shape the launcher masks it to). 0.58 × 108dp ≈
# 63dp, i.e. the disc sits inside the safe zone with a little margin to spare for
# the parallax some launchers apply to the foreground layer.
# https://developer.android.com/develop/ui/views/launch/icon_design_adaptive
FOREGROUND_FILL = 0.58

ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
"""

# md5 of every launcher image in @capacitor/android 8.5.2's android-template —
# i.e. the Android Studio placeholder. Copied out of the template itself, not
# guessed. Finding any of these in the project is a build failure.
PLACEHOLDER_MD5 = {
    "1956941339dd5fe36d5c66601c89a08d": "mipmap-hdpi/ic_launcher.png",
    "73b1e06d769fa08a9c3b8328cc15fd75": "mipmap-hdpi/ic_launcher_foreground.png",
    "f43e5674865a00186dd76183cf1f2f8e": "mipmap-hdpi/ic_launcher_round.png",
    "7ed1b3739b83215d0c4a0b4a7f2dcab4": "mipmap-mdpi/ic_launcher.png",
    "5b77e8aec8b17eed320a97567c7cb8bf": "mipmap-mdpi/ic_launcher_foreground.png",
    "a49547a32c7d9b529af607b033811d81": "mipmap-mdpi/ic_launcher_round.png",
    "5689511ee4e41a367d0342f37ac48bdf": "mipmap-xhdpi/ic_launcher.png",
    "15cdded29b9877ac98c5931024c5da5d": "mipmap-xhdpi/ic_launcher_foreground.png",
    "c890fa4af62a63486d5dea62441ce7ab": "mipmap-xhdpi/ic_launcher_round.png",
    "a3285eeaedda8201f04e7737b9df8421": "mipmap-xxhdpi/ic_launcher.png",
    "4e9584ecc16d1fc75afb798688ce576f": "mipmap-xxhdpi/ic_launcher_foreground.png",
    "14cde87848553e24d7106f56eb8ceb6f": "mipmap-xxhdpi/ic_launcher_round.png",
    "9e029293ab1ae8e3a6a7b7d0b7177e46": "mipmap-xxxhdpi/ic_launcher.png",
    "ed3696b7c52d9747411a475dbe3fa34a": "mipmap-xxxhdpi/ic_launcher_foreground.png",
    "85addb4159ecd3f76f02fbacd5ec86de": "mipmap-xxxhdpi/ic_launcher_round.png",
}

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


# ---------------------------------------------------------------------------------
# PNG reading (8-bit, non-interlaced, colour types 2/4/6 — all this artwork needs)
# ---------------------------------------------------------------------------------


def read_png(path: Path) -> tuple[int, int, list[tuple[int, int, int, int]]]:
    data = path.read_bytes()
    if data[:8] != PNG_SIGNATURE:
        raise SystemExit(f"{path} is not a PNG (bad signature)")
    pos, idat = 8, b""
    w = h = depth = ctype = None
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            w, h, depth, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body[:13])
            if interlace:
                raise SystemExit(f"{path}: interlaced PNGs are not supported")
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
        pos += 12 + length
    if depth != 8:
        raise SystemExit(f"{path}: only 8-bit PNGs are supported (this one is {depth}-bit)")
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * channels
    out = bytearray(w * h * channels)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p : p + stride])
        p += stride
        if ftype == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif ftype != 0:
            raise SystemExit(f"{path}: unknown PNG filter type {ftype} on row {y}")
        out[y * stride : (y + 1) * stride] = line
        prev = line
    pixels: list[tuple[int, int, int, int]] = []
    if channels == 4:
        for i in range(w * h):
            o = i * 4
            pixels.append((out[o], out[o + 1], out[o + 2], out[o + 3]))
    elif channels == 3:
        for i in range(w * h):
            o = i * 3
            pixels.append((out[o], out[o + 1], out[o + 2], 255))
    elif channels == 2:
        for i in range(w * h):
            o = i * 2
            pixels.append((out[o], out[o], out[o], out[o + 1]))
    else:
        for i in range(w * h):
            v = out[i]
            pixels.append((v, v, v, 255))
    return w, h, pixels


def write_png(path: Path, w: int, h: int, pixels: list[tuple[int, int, int, int]]) -> None:
    """Deterministic PNG writer: 8-bit RGBA, zlib level 9, no timestamps."""
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0 (None) on every row
        for x in range(w):
            r, g, b, a = pixels[y * w + x]
            raw += bytes((r, g, b, a))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        PNG_SIGNATURE
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


# ---------------------------------------------------------------------------------
# Resampling: separable area-average (box) filter, integer weights
# ---------------------------------------------------------------------------------


def area_weights(src_len: int, dst_len: int) -> list[list[tuple[int, int]]]:
    """Per output position: [(source index, weight/65536), …], weights summing to 65536."""
    scale = src_len / dst_len
    table: list[list[tuple[int, int]]] = []
    for j in range(dst_len):
        start, end = j * scale, (j + 1) * scale
        taps: list[tuple[int, int]] = []
        total = 0.0
        for i in range(max(0, math.floor(start)), min(src_len, math.ceil(end))):
            overlap = min(end, i + 1) - max(start, i)
            if overlap > 0:
                taps.append((i, overlap))
                total += overlap
        table.append([(i, int(round(ov / total * 65536))) for i, ov in taps])
    return table


def resize(
    src: list[tuple[int, int, int, int]], sw: int, sh: int, dw: int, dh: int
) -> list[tuple[int, int, int, int]]:
    """High-quality downscale (the targets are all smaller than the 512px source)."""
    if (sw, sh) == (dw, dh):
        return list(src)
    horiz = area_weights(sw, dw)
    vert = area_weights(sh, dh)
    # Horizontal pass into sh × dw.
    tmp: list[tuple[int, int, int, int]] = [None] * (sh * dw)  # type: ignore[list-item]
    for y in range(sh):
        row = y * sw
        for x in range(dw):
            r = g = b = a = 0
            for i, w in horiz[x]:
                pr, pg, pb, pa = src[row + i]
                r += w * pr
                g += w * pg
                b += w * pb
                a += w * pa
            tmp[y * dw + x] = (
                (r + 32768) >> 16,
                (g + 32768) >> 16,
                (b + 32768) >> 16,
                (a + 32768) >> 16,
            )
    # Vertical pass into dh × dw.
    out: list[tuple[int, int, int, int]] = [None] * (dw * dh)  # type: ignore[list-item]
    for y in range(dh):
        for x in range(dw):
            r = g = b = a = 0
            for i, w in vert[y]:
                pr, pg, pb, pa = tmp[i * dw + x]
                r += w * pr
                g += w * pg
                b += w * pb
                a += w * pa
            out[y * dw + x] = (
                (r + 32768) >> 16,
                (g + 32768) >> 16,
                (b + 32768) >> 16,
                (a + 32768) >> 16,
            )
    return out


# ---------------------------------------------------------------------------------
# Masks
# ---------------------------------------------------------------------------------


def mask_coverage(size: int, *, circle: bool, radius_fraction: float = 0.0) -> list[float]:
    """Anti-aliased coverage (0..1) for a circle or a rounded square, on a
    `size`×`size` canvas. One 1px-wide linear ramp at the edge — no supersampling,
    which would cost seconds in pure Python for no visible gain at these sizes."""
    cov = [0.0] * (size * size)
    half = size / 2.0
    # A rounded square with corner radius r is the Minkowski sum of a square of
    # side (size-2r) and a disc of radius r; the distance function below is the
    # exact one, so the same ramp code serves both shapes.
    r = (radius_fraction or 0.0) * size
    for y in range(size):
        py = y + 0.5 - half
        for x in range(size):
            px = x + 0.5 - half
            if circle:
                dist = math.hypot(px, py)
            else:
                qx = max(abs(px) - (half - r), 0.0)
                qy = max(abs(py) - (half - r), 0.0)
                dist = math.hypot(qx, qy) + r if r > 0 else max(abs(px), abs(py))
            limit = half
            c = 0.5 + (limit - dist)  # ramp: 1 inside, 0 outside, linear over 1px
            cov[y * size + x] = 0.0 if c <= 0.0 else (1.0 if c >= 1.0 else c)
    return cov


# ---------------------------------------------------------------------------------
# Rendering the set
# ---------------------------------------------------------------------------------


def sample_corner_colour(pixels: list[tuple[int, int, int, int]], w: int, h: int) -> str:
    """The artwork's own outer colour, averaged over the four corners. Not
    hand-picked: if the artwork is ever replaced, this follows it, and it is what
    the cut corners of the foreground disc blend into."""
    spots = [(1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2)]
    r = sum(pixels[y * w + x][0] for x, y in spots) // 4
    g = sum(pixels[y * w + x][1] for x, y in spots) // 4
    b = sum(pixels[y * w + x][2] for x, y in spots) // 4
    return f"#{r:02X}{g:02X}{b:02X}"


def render(source: Path) -> dict[str, bytes]:
    """Render every file this tool owns, as {path relative to res/: bytes}."""
    sw, sh, src = read_png(source)
    if sw != sh:
        raise SystemExit(f"{source} must be square; it is {sw}×{sh}")
    corner = sample_corner_colour(src, sw, sh)
    files: dict[str, bytes] = {}

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)

        def scaled(size: int) -> list[tuple[int, int, int, int]]:
            return resize(src, sw, sh, size, size)

        for name, scale in DENSITIES:
            folder = f"mipmap-{name}"
            legacy = int(round(LEGACY_DP * scale))
            fg = int(round(FOREGROUND_DP * scale))

            # Legacy square icon: the artwork full-bleed, masked to a rounded
            # square (radius 18% — the shape Android Studio's own launcher icons
            # use), transparent outside. This is what Android < 8 shows and what
            # some launchers use as a fallback.
            art = scaled(legacy)
            cov = mask_coverage(legacy, circle=False, radius_fraction=0.18)
            masked = [
                (p[0], p[1], p[2], int(round(p[3] * c))) for p, c in zip(art, cov)
            ]
            p = tmpdir / folder / "ic_launcher.png"
            write_png(p, legacy, legacy, masked)
            files[f"{folder}/ic_launcher.png"] = p.read_bytes()

            # Round icon: the same artwork with a circular mask.
            cov = mask_coverage(legacy, circle=True)
            masked = [
                (p[0], p[1], p[2], int(round(p[3] * c))) for p, c in zip(art, cov)
            ]
            p = tmpdir / folder / "ic_launcher_round.png"
            write_png(p, legacy, legacy, masked)
            files[f"{folder}/ic_launcher_round.png"] = p.read_bytes()

            # Adaptive foreground: the artwork as a disc that fits inside the
            # 66dp safe zone, centred on an otherwise transparent 108dp canvas.
            side = int(round(fg * FOREGROUND_FILL))
            disc = scaled(side)
            cov = mask_coverage(side, circle=True)
            canvas = [(0, 0, 0, 0)] * (fg * fg)
            off = (fg - side) // 2
            for y in range(side):
                base = (y + off) * fg + off
                for x in range(side):
                    pr, pg, pb, pa = disc[y * side + x]
                    a = int(round(pa * cov[y * side + x]))
                    if a:
                        canvas[base + x] = (pr, pg, pb, a)
            p = tmpdir / folder / "ic_launcher_foreground.png"
            write_png(p, fg, fg, canvas)
            files[f"{folder}/ic_launcher_foreground.png"] = p.read_bytes()

    for xml_name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        files[f"mipmap-anydpi-v26/{xml_name}"] = ADAPTIVE_XML.encode()
    files["values/ic_launcher_background.xml"] = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        f'    <color name="ic_launcher_background">{corner}</color>\n'
        "</resources>\n"
    ).encode()
    return files


# ---------------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------------


def list_ic_launcher_files(res: Path) -> list[str]:
    """Every file under res/ whose name begins with `ic_launcher`, at any depth."""
    return sorted(
        str(p.relative_to(res))
        for p in res.rglob("ic_launcher*")
        if p.is_file()
    )


def install(res: Path, files: dict[str, bytes]) -> None:
    if not res.is_dir():
        raise SystemExit(
            f"{res} does not exist — run `npx cap add android` (or `npx cap sync android`) first"
        )
    removed = []
    for rel in list_ic_launcher_files(res):
        if rel not in files:
            (res / rel).unlink()
            removed.append(rel)
    for rel, body in sorted(files.items()):
        target = res / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    print(f"android-icons: wrote {len(files)} files into {res}/")
    for rel in removed:
        print(f"  removed the template's own file: {rel}")
    for rel in sorted(files):
        print(f"  {rel}  {len(files[rel])} bytes  md5 {hashlib.md5(files[rel]).hexdigest()}")


def verify(res: Path, files: dict[str, bytes]) -> None:
    problems: list[str] = []
    if not res.is_dir():
        raise SystemExit(f"{res} does not exist")

    # 1. Nothing that is not ours may sit under res/ wearing an ic_launcher name.
    present = set(list_ic_launcher_files(res))
    expected = set(files)
    for rel in sorted(present - expected):
        problems.append(
            f"{rel} is in the Android project but is not part of our icon set — "
            "that is a leftover (the Capacitor/Android Studio placeholder, or a file "
            "from an older run) and it would be packaged alongside our icon"
        )
    # 2. Every file we expect must be there, byte for byte.
    for rel in sorted(expected):
        target = res / rel
        if not target.is_file():
            problems.append(f"{rel} is MISSING from the Android project")
            continue
        body = target.read_bytes()
        if body != files[rel]:
            problems.append(
                f"{rel} is not what this tool renders from our artwork "
                f"(on disk: md5 {hashlib.md5(body).hexdigest()}, "
                f"ours: md5 {hashlib.md5(files[rel]).hexdigest()})"
            )
    # 3. And nothing anywhere under res/ may still be the placeholder by md5.
    for path in sorted(res.rglob("*")):
        if not path.is_file():
            continue
        md5 = hashlib.md5(path.read_bytes()).hexdigest()
        if md5 in PLACEHOLDER_MD5:
            problems.append(
                f"{path.relative_to(res)} is byte-identical to the placeholder "
                f"Capacitor's template ships ({PLACEHOLDER_MD5[md5]})"
            )
    if problems:
        print("android-icons: the Android project's launcher icon is NOT ours:", file=sys.stderr)
        for line in problems:
            print(f"  - {line}", file=sys.stderr)
        raise SystemExit(1)
    total = sum(len(files[rel]) for rel in files)
    print(
        f"android-icons: PASS — all {len(files)} icon files in {res}/ are the ones "
        f"rendered from our own artwork ({total} bytes total), and no placeholder is "
        "left anywhere in the resource tree"
    )


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    mode = argv[1]
    source = DEFAULT_SOURCE
    args = argv[2:]
    if mode == "print-md5s":
        print(f"{source}  md5 {hashlib.md5(source.read_bytes()).hexdigest()}")
        return 0
    if not args:
        print(f"usage: android-icons.py {mode} <res-dir> [--source PATH]", file=sys.stderr)
        return 2
    res = Path(args[0])
    if "--source" in args:
        source = Path(args[args.index("--source") + 1])
    if not source.is_file():
        raise SystemExit(
            f"{source} is missing. It is the copy of appstore/icons/play-icon-512.png "
            "that lives inside the repository so CI can reach it."
        )
    files = render(source)
    if mode == "install":
        install(res, files)
        return 0
    if mode == "verify":
        verify(res, files)
        return 0
    print(f"unknown mode {mode!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
