"""Generate the web-app and Android launcher icons from the desktop app icon.

Source: app-shell/src-tauri/icons/icon.png (512 px, the same artwork as ui/public/icon.svg).
Outputs (committed):
  ui/public-lite/icons/icon-192.png, icon-512.png   web app manifest icons
  ui/public-lite/icons/maskable-512.png             full-bleed icon for Android home screens
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png
                                                    adaptive-icon foreground (108 dp per density)
  android/app/src/main/res/mipmap-*/ic_launcher_monochrome.png
                                                    the artwork alone, for Android 13+ themed icons

Run: compute/.venv/bin/python scripts/gen_app_icons.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "app-shell" / "src-tauri" / "icons" / "icon.png"
WEB = ROOT / "ui" / "public-lite" / "icons"
ANDROID_RES = ROOT / "android" / "app" / "src" / "main" / "res"
BACKGROUND = (23, 24, 28, 255)  # #17181C, the icon's own tile colour
# Adaptive icons are 108 dp with a 66 dp safe zone; the tile fills 72 dp so the mask never clips the hexagon.
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}


def scaled(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.LANCZOS)


def on_background(image: Image.Image, size: int, fraction: float, background: tuple[int, int, int, int]) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), background)
    inner = round(size * fraction)
    offset = (size - inner) // 2
    canvas.alpha_composite(scaled(image, inner), (offset, offset))
    return canvas


def artwork_only(image: Image.Image) -> Image.Image:
    """The hexagon and sparks as white on transparent (themed icons tint it): every pixel of the tile
    that differs from the tile colour, with opacity from that difference."""
    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    src = image.load()
    dst = out.load()
    for y in range(image.size[1]):
        for x in range(image.size[0]):
            r, g, b, a = src[x, y]
            distance = max(abs(r - BACKGROUND[0]), abs(g - BACKGROUND[1]), abs(b - BACKGROUND[2]))
            alpha = min(255, distance * 2) * a // 255
            if alpha > 24:
                dst[x, y] = (255, 255, 255, alpha)
    return out


def main() -> int:
    icon = Image.open(SOURCE).convert("RGBA")
    if icon.size != (512, 512):
        print(f"expected a 512 px source icon, got {icon.size}", file=sys.stderr)
        return 1
    WEB.mkdir(parents=True, exist_ok=True)
    scaled(icon, 192).save(WEB / "icon-192.png", optimize=True)
    icon.save(WEB / "icon-512.png", optimize=True)
    # Maskable: the safe zone is a centred circle of 80 % diameter; the logo's sparks reach 38 % of
    # the tile from its centre, so the tile is drawn at 82 % on a full-bleed background.
    on_background(icon, 512, 0.82, BACKGROUND).save(WEB / "maskable-512.png", optimize=True)
    for density, factor in DENSITIES.items():
        folder = ANDROID_RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        size = round(108 * factor)
        on_background(icon, size, 72 / 108, (0, 0, 0, 0)).save(folder / "ic_launcher_foreground.png", optimize=True)
        on_background(artwork_only(icon), size, 72 / 108, (0, 0, 0, 0)).save(folder / "ic_launcher_monochrome.png", optimize=True)
    print(f"wrote web icons to {WEB.relative_to(ROOT)} and launcher icons to {ANDROID_RES.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
