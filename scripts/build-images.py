"""Builds the README images from the captured PNGs: an animated WebP hero and compressed stills.
Usage: python3 scripts/build-images.py <capture dir> images  (needs Pillow)"""
import sys
from pathlib import Path

from PIL import Image

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)

frames = [Image.open(p).convert('RGB') for p in sorted((src / 'frames').glob('f*.png'))]
if frames:
    frames[0].save(dst / 'hero.webp', save_all=True, append_images=frames[1:], duration=125, loop=0,
                   quality=82, method=6)
    print('hero.webp', len(frames), 'frames', (dst / 'hero.webp').stat().st_size // 1024, 'KB')

for name in ['hero-dark', 'light', 'german', 'playground', 'editor', 'editor-entity']:
    p = src / f'{name}.png'
    if not p.exists():
        continue
    img = Image.open(p).convert('RGB')
    # 256-colour PNGs keep text sharp at a fraction of the size
    img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(dst / f'{name}.png', optimize=True)
    print(f'{name}.png', img.size, (dst / f'{name}.png').stat().st_size // 1024, 'KB')
