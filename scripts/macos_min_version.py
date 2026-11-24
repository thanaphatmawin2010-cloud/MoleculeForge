#!/usr/bin/env python3
"""Find the macOS version an installer payload really needs, from its Mach-O binaries.

Every executable and library records the oldest macOS it runs on (LC_BUILD_VERSION ``minos``, or
LC_VERSION_MIN_MACOSX in older binaries); dyld refuses to load one built for a newer system. This
scans a directory (fat/universal binaries included), reports the highest requirement and the files
that set it, and, when that is above ``--minimum``, writes a Tauri configuration overlay raising
``bundle.macOS.minimumSystemVersion`` so macOS shows a clear "requires macOS X" message instead of
the app failing at launch.

    python3 scripts/macos_min_version.py app-shell/src-tauri/resources --minimum 14.0 \\
        --write-config app-shell/src-tauri/tauri.macos.conf.json

Standard library only; it runs on any build host.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

LC_VERSION_MIN_MACOSX = 0x24
LC_BUILD_VERSION = 0x32
PLATFORM_MACOS = 1
THIN = {b"\xcf\xfa\xed\xfe": ("<", 32), b"\xce\xfa\xed\xfe": ("<", 28),
        b"\xfe\xed\xfa\xcf": (">", 32), b"\xfe\xed\xfa\xce": (">", 28)}
FAT = {b"\xca\xfe\xba\xbe": 20, b"\xca\xfe\xba\xbf": 32}


def version(encoded: int) -> tuple[int, int, int]:
    return encoded >> 16, (encoded >> 8) & 0xFF, encoded & 0xFF


def thin_minos(data: bytes, offset: int) -> tuple[int, int, int] | None:
    kind = THIN.get(data[offset:offset + 4])
    if kind is None:
        return None
    order, header_size = kind
    ncmds, sizeofcmds = struct.unpack_from(order + "II", data, offset + 16)
    cursor, end = offset + header_size, offset + header_size + sizeofcmds
    found = None
    for _ in range(ncmds):
        if cursor + 8 > min(end, len(data)):
            break
        cmd, size = struct.unpack_from(order + "II", data, cursor)
        if cmd == LC_BUILD_VERSION:
            platform, minos = struct.unpack_from(order + "II", data, cursor + 8)
            if platform == PLATFORM_MACOS:
                found = version(minos)
        elif cmd == LC_VERSION_MIN_MACOSX:
            found = version(struct.unpack_from(order + "I", data, cursor + 8)[0])
        if size < 8:
            break
        cursor += size
    return found


def minos_of(path: Path) -> tuple[int, int, int] | None:
    """The highest minimum macOS version among the architectures in a Mach-O file, if it is one."""
    with path.open("rb") as fh:
        head = fh.read(8)
        if head[:4] not in THIN and head[:4] not in FAT:
            return None
        data = head + fh.read()
    if data[:4] in THIN:
        return thin_minos(data, 0)
    count = struct.unpack_from(">I", data, 4)[0]
    if count > 32:  # 0xCAFEBABE is also the Java class-file magic; real fat headers hold few slices
        return None
    entry_size = FAT[data[:4]]
    slices = []
    for i in range(count):
        base = 8 + i * entry_size
        offset = (struct.unpack_from(">Q", data, base + 8)[0] if entry_size == 32
                  else struct.unpack_from(">I", data, base + 8)[0])
        found = thin_minos(data, offset)
        if found:
            slices.append(found)
    return max(slices) if slices else None


def scan(root: Path) -> dict[Path, tuple[int, int, int]]:
    return {p: v for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink() and (v := minos_of(p))}


def text(v: tuple[int, int, int]) -> str:
    return f"{v[0]}.{v[1]}" + (f".{v[2]}" if v[2] else "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", type=Path)
    parser.add_argument("--minimum", default="11.0", help="the minimum the app already declares")
    parser.add_argument("--write-config", type=Path, help="Tauri config overlay to write when more is needed")
    opts = parser.parse_args()
    found = scan(opts.root)
    if not found:
        print(f"no Mach-O binaries under {opts.root}")
        return 0
    highest = max(found.values())
    declared = tuple(int(x) for x in [*opts.minimum.split("."), "0", "0"][:3])
    print(f"{len(found)} Mach-O files; highest minimum macOS {text(highest)} (declared {opts.minimum})")
    setters = [path for path, v in found.items() if v == highest]
    for path in setters[:15]:
        print(f"  {text(highest)}  {path.relative_to(opts.root)}")
    if len(setters) > 15:
        print(f"  ... and {len(setters) - 15} more")
    if highest > declared:
        print(f"WARNING: the payload needs macOS {text(highest)}, above the declared {opts.minimum}")
        if opts.write_config:
            overlay = {"bundle": {"macOS": {"minimumSystemVersion": text(highest)}}}
            opts.write_config.write_text(json.dumps(overlay, indent=2) + "\n", encoding="utf-8")
            print(f"wrote {opts.write_config}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
