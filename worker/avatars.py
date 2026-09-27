#!/usr/bin/env python3
# Small square avatars for the .av circles (24-50 CSS px, so 150 px covers 3x screens):
#   img/<name>.jpg -> img/av/<name>.jpg, cropped like object-fit:cover + object-position (x% y%).
# Run from the repo root after adding or replacing a photo: python3 worker/avatars.py img/<name>.jpg [x% y%]
# (club players: players.json "avatar" points at img/av/...; opponents: PHOTOS in index.html, same pos).
import sys, os
from PIL import Image

def make(src, pos="50% 30%", size=150):
    px, py = [float(v.rstrip("%")) / 100 for v in pos.split()]
    im = Image.open(src).convert("RGB")
    w, h = im.size
    s = min(w, h)
    left, top = round((w - s) * px), round((h - s) * py)
    im = im.crop((left, top, left + s, top + s)).resize((size, size), Image.LANCZOS)
    out = os.path.join(os.path.dirname(src), "av", os.path.basename(src))
    im.save(out, "JPEG", quality=80, optimize=True, progressive=True)
    return out

if __name__ == "__main__":
    print(make(sys.argv[1], " ".join(sys.argv[2:4]) if len(sys.argv) > 3 else "50% 30%"))
