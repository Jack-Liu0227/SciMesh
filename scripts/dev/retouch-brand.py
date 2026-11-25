"""Repaint the old product name in the showcase screenshots with the current brand.

The screenshots under docs/assets were captured before the SciMesh rename and
still read "Open Science" in the sidebar brand row. This script replaces just
that text run and leaves every other pixel untouched.

It calibrates font, size, ink colour and sub-pixel offset against the pixels that
are already in the image, so the new name sits on the same baseline with the same
weight and colour as the old one.

Usage:
    python scripts/dev/retouch-brand.py           # repaint docs/assets screenshots
    python scripts/dev/retouch-brand.py --check   # report calibration, do not write
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docs" / "assets"
BUILD = ROOT / ".tmp-retouch"

OLD = "Open Science"
NEW = "SciMesh"

# The brand row in a 1600x1000 screenshot. The name itself occupies
# columns 49..164 and rows 60..77.
PATCH = (44, 55, 200, 84)
TEXT_LEFT, TEXT_TOP = 49, 60
BACKGROUND = (239, 241, 243)
SUPERSAMPLE = 4

FONTS = [
    ("source-serif-4", "apps/desktop/dist/assets/source-serif-4-latin-600-normal-DMD1h6_f.woff"),
    ("georgia-bold", "C:/Windows/Fonts/georgiab.ttf"),
    ("times-bold", "C:/Windows/Fonts/timesbd.ttf"),
]


def font_file(relative_or_absolute: str) -> Path | None:
    """Resolve a .woff in the repo (converted once) or a system font file."""
    source = Path(relative_or_absolute)
    if not source.is_absolute():
        source = ROOT / source
        if not source.exists():
            return None
        BUILD.mkdir(exist_ok=True)
        cached = BUILD / (source.stem + ".ttf")
        if not cached.exists():
            TTFont(str(source)).save(str(cached))
        return cached
    return source if source.exists() else None


def draw(text: str, font: ImageFont.FreeTypeFont, size: float, ink: tuple[int, int, int]) -> Image.Image:
    """Render text on a transparent canvas, supersampled and box-downsampled."""
    pad = 12
    font = ImageFont.truetype(str(font), size=size * SUPERSAMPLE)
    probe = Image.new("L", (10, 10))
    box = ImageDraw.Draw(probe).textbbox((0, 0), text, font=font)
    canvas = Image.new("L", (box[2] + 2 * pad, box[3] + 2 * pad), 0)
    ImageDraw.Draw(canvas).text((pad - box[0], pad - box[1]), text, font=font, fill=255)
    canvas = canvas.resize((canvas.width // SUPERSAMPLE, canvas.height // SUPERSAMPLE), Image.LANCZOS)
    ink_layer = Image.new("RGBA", canvas.size, ink + (0,))
    ink_layer.putalpha(canvas)
    return ink_layer


def ink_box(layer: Image.Image) -> tuple[int, int, int, int]:
    alpha = np.array(layer.split()[3])
    ys, xs = np.where(alpha > 6)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def compose(patch: np.ndarray, layer: Image.Image, offset: tuple[int, int]) -> np.ndarray:
    """Alpha-composite one glyph layer onto a flat-background patch."""
    x, y = offset
    canvas = Image.new("RGBA", (patch.shape[1], patch.shape[0]), tuple(BACKGROUND) + (255,))
    canvas.alpha_composite(layer, (x, y))
    return np.array(canvas.convert("RGB")).astype(float)


def score(rendered: np.ndarray, target: np.ndarray, ink_mask: np.ndarray) -> float:
    return float(np.abs(rendered - target)[ink_mask].mean())


def calibrate(patch: np.ndarray) -> dict:
    """Find the rendering that reproduces the existing name most closely."""
    target = patch.astype(float)
    dark = target.sum(axis=2) < 620  # text antialiasing and interior only
    mask = dark.copy()
    for shift in (1, -1):
        mask |= np.roll(dark, shift, axis=0) | np.roll(dark, shift, axis=1)

    want_left = TEXT_LEFT - PATCH[0]
    want_top = TEXT_TOP - PATCH[1]

    best = None
    for name, path in FONTS:
        font_path = font_file(path)
        if font_path is None:
            continue
        for step in range(12):
            size = 15.5 + 0.25 * step
            for ink in [(17, 21, 27), (24, 27, 33), (32, 36, 42), (12, 15, 20)]:
                layer = draw(OLD, font_path, size, ink)
                bx0, by0, bx1, by1 = ink_box(layer)
                if abs((bx1 - bx0) - 115) > 6:
                    continue
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        offset = (want_left - bx0 + dx, want_top - by0 + dy)
                        err = score(compose(patch, layer, offset), target, mask)
                        if best is None or err < best["err"]:
                            best = {
                                "font": name,
                                "path": font_path,
                                "size": size,
                                "ink": ink,
                                "err": err,
                            }
    if best is None:
        raise RuntimeError("no candidate matched the existing brand text")
    return best


def repaint(path: Path, check: bool) -> float:
    image = Image.open(path).convert("RGB")
    pixels = np.array(image)
    x0, y0, x1, y1 = PATCH
    patch = pixels[y0:y1, x0:x1].copy()

    best = calibrate(patch)
    layer = draw(NEW, best["path"], best["size"], best["ink"])
    bx0, by0, _, _ = ink_box(layer)
    offset = (TEXT_LEFT - PATCH[0] - bx0, TEXT_TOP - PATCH[1] - by0)

    # Erase the whole old run, not just the width of the new name.
    old_left = TEXT_LEFT - PATCH[0] - 3
    old_right = TEXT_LEFT - PATCH[0] + 118

    # Every column takes the median of the clean rows above and below it, so the
    # sidebar's flat colour and any compression noise stay consistent.
    for column in range(old_left, old_right):
        if not 0 <= column < x1 - x0:
            continue
        above = pixels[y0 - 12 : y0 - 2, x0 + column]
        below = pixels[y1 : y1 + 10, x0 + column]
        pixels[y0:y1, x0 + column] = np.median(np.concatenate([above, below]), axis=0)

    repainted = Image.fromarray(pixels).convert("RGBA")
    repainted.alpha_composite(layer, (x0 + offset[0], y0 + offset[1]))
    result = repainted.convert("RGB")

    if not check:
        result.save(path, "WEBP", quality=92, method=6)

    print(
        f"{path.name}: font={best['font']} size={best['size']:.2f} "
        f"ink={best['ink']} calibration_error={best['err']:.2f}"
    )
    return best["err"]


def main() -> int:
    check = "--check" in sys.argv
    failures = 0
    for path in sorted(ASSETS.glob("showcase-*.webp")):
        if Image.open(path).size[0] < 1000:
            continue  # phone screenshots carry no brand row
        err = repaint(path, check)
        if err > 12:
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
