#!/usr/bin/env python3
"""Independent reader for the protobuf AndroidManifest.xml inside an .aab.

No aapt2/bundletool required: an .aab stores base/manifest/AndroidManifest.xml as
an aapt2 protobuf (XmlNode, see aapt2's Resources.proto). This walks the wire
format directly and prints every attribute, resolving string / primitive / reference
values, so package, versionCode, versionName, targetSdkVersion and minSdkVersion can
be read out of the artifact itself.

usage: aab_manifest.py <path-to-.aab> [--all]
"""
from __future__ import annotations
import sys, zipfile, struct

# ---------------------------------------------------------------- wire format
def read_varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = 0
    val = 0
    while True:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, i
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def fields(buf: bytes):
    """Yield (field_number, wire_type, payload) for a protobuf message body."""
    i = 0
    n = len(buf)
    while i < n:
        key, i = read_varint(buf, i)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = read_varint(buf, i)
            yield fn, wt, v
        elif wt == 1:
            yield fn, wt, buf[i:i + 8]
            i += 8
        elif wt == 2:
            ln, i = read_varint(buf, i)
            yield fn, wt, buf[i:i + ln]
            i += ln
        elif wt == 5:
            yield fn, wt, buf[i:i + 4]
            i += 4
        else:  # pragma: no cover - malformed
            raise ValueError(f"unsupported wire type {wt} at {i}")


def as_str(b) -> str:
    if isinstance(b, int):
        return str(b)
    return b.decode("utf-8", "replace")


# --------------------------------------------------- aapt2 item / primitive
PRIMITIVE_INT = 3          # Primitive.int_decimal_value   (int32)
PRIMITIVE_UINT_HEX = 4     # Primitive.int_hexadecimal_value (uint32)


def canonical_item(buf: bytes) -> str:
    """Item { ref=1 | str=2 | raw_str=3 | styled_str=4 | file=5 | id=6 | primitive=7 }"""
    out = []
    for fn, wt, p in fields(buf):
        if fn == 1 and wt == 2:                       # Reference
            ref_id, ref_name = None, None
            for f2, w2, p2 in fields(p):
                if f2 == 2 and w2 == 0:
                    ref_id = p2
                elif f2 == 3 and w2 == 2:
                    ref_name = as_str(p2)
            out.append(f"@{ref_name or '?'}" + (f"(0x{ref_id:08x})" if ref_id else ""))
        elif fn == 2 and wt == 2:                     # String
            for f2, w2, p2 in fields(p):
                if f2 == 1 and w2 == 2:
                    out.append(repr(as_str(p2)))
        elif fn == 3 and wt == 2:                     # RawString
            for f2, w2, p2 in fields(p):
                if f2 == 1 and w2 == 2:
                    out.append(repr(as_str(p2)))
        elif fn == 5 and wt == 2:                     # FileReference
            out.append(f"file:{p.decode('utf-8', 'replace')}")
        elif fn == 6 and wt == 2:                     # Id
            out.append("id")
        elif fn == 7 and wt == 2:                     # Primitive
            for f2, w2, p2 in fields(p):
                if f2 in (PRIMITIVE_INT, PRIMITIVE_UINT_HEX) and w2 == 0:
                    out.append(str(p2))
                elif f2 == 5 and w2 == 0:
                    out.append("true" if p2 else "false")
                elif f2 == 2 and w2 == 0:
                    out.append("(empty)")
                elif f2 == 1 and w2 == 0:
                    out.append("null")
                else:
                    out.append(f"prim(f{f2}={p2!r})")
        else:
            out.append(f"(item field {fn})")
    return " ".join(out) if out else "(empty)"


# ------------------------------------------------------------------ XmlNode
def attribute(attr_bytes: bytes) -> tuple[str, str]:
    name, value, compiled = None, None, None
    for fn, wt, p in fields(attr_bytes):
        if fn == 2 and wt == 2:
            name = as_str(p)
        elif fn == 3 and wt == 2:
            value = as_str(p)
        elif fn == 6 and wt == 2:
            compiled = canonical_item(p)
    return name or "?", (value if value is not None else (compiled or "(unset)"))


def walk(node_bytes: bytes, depth: int, sink: list):
    for fn, wt, p in fields(node_bytes):
        if fn == 1 and wt == 2:                      # XmlElement
            el_name, attrs, children = None, [], []
            for f2, w2, p2 in fields(p):
                if f2 == 2 and w2 == 2:
                    el_name = as_str(p2)
                elif f2 == 4 and w2 == 2:
                    attrs.append(attribute(p2))
                elif f2 == 5 and w2 == 2:
                    children.append(p2)
            indent = "  " * depth
            sink.append(f"{indent}<{el_name}>")
            for an, av in attrs:
                sink.append(f"{indent}  {an} = {av}")
            for ch in children:
                walk(ch, depth + 1, sink)
        elif fn == 2 and wt == 2:                    # text node
            sink.append("  " * depth + repr(as_str(p)))


MANIFEST_ENTRY = "base/manifest/AndroidManifest.xml"


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    aab = argv[1]
    with zipfile.ZipFile(aab) as z:
        names = z.namelist()
        entry = MANIFEST_ENTRY if MANIFEST_ENTRY in names else next(
            (n for n in names if n.endswith("/manifest/AndroidManifest.xml")), None)
        if entry is None:
            print("no manifest entry found in the bundle", file=sys.stderr)
            return 1
        data = z.read(entry)
    print(f"# entry: {entry} ({len(data)} bytes)")
    sink: list = []
    walk(data, 0, sink)
    print("\n".join(sink))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
