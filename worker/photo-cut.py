#!/usr/bin/env python3
"""Uploaded profile pictures -> cut-outs without background, for .github/workflows/photos.yml.

  python worker/photo-cut.py pending.json OUT_DIR

pending.json is the worker's GET /photos/pending {pending: [{pid, v}], ri: [{pid, v, url}], current: {...}}. For each
pending photo: the uploaded 800x1000 JPEG from the worker, the background removed (rembg, isnet-general-use), written as
OUT_DIR/<pid>-<v>.webp (800x1000) and OUT_DIR/<pid>-<v>-av.webp (150x150: the circle the phone showed when cropping,
centre 400,300, radius 230). The club members' RankedIn photos ("ri"): fetched from RankedIn's CDN, cropped to 4:5,
cut out the same way, written as OUT_DIR/r<pid>-<v>.webp and -av.webp (the avatar around the head of the figure).
Prints the files written.
"""
import re
import io
import json
import sys
import urllib.request

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage

API = "https://padel-push.holmberg-padel.workers.dev"
Image.MAX_IMAGE_PIXELS = 2_000_000   # no decompression bombs
AV_BOX = (170, 70, 630, 530)   # the avatar circle's square in the 800x1000 frame
RI_IMG = re.compile(r"^https://(cdn\.rankedin\.com|rankedin-prod-cdn-[a-z0-9]+\.[a-z0-9]+\.azurefd\.net)/[^\s\"'<>]{1,400}$")
RI_MAX_BYTES = 12_000_000
RI_MAX_PIXELS = 40_000_000   # a phone photo; more is no photo


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "padel photos"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read(RI_MAX_BYTES + 1)
    if len(raw) > RI_MAX_BYTES:
        raise ValueError("too big")
    return raw


def frame45(im):
    """Any RankedIn photo -> 800x1000: the middle across, a little above the middle down (heads are at the top)."""
    w, h = im.size
    if w / h > 0.8:
        cw = round(h * 0.8)
        box = ((w - cw) // 2, 0, (w - cw) // 2 + cw, h)
    else:
        ch = round(w / 0.8)
        y = round((h - ch) * 0.3)
        box = (0, y, w, y + ch)
    return im.crop(box).resize((800, 1000), Image.LANCZOS)


def head_box(cut):
    """The avatar's square around the top of the figure (the head), or the uploaded photos' fixed one."""
    a = np.array(cut)[:, :, 3] > 24
    rows = np.where(a.any(axis=1))[0]
    if not len(rows):
        return AV_BOX
    top = int(rows[0])
    cols = np.where(a.any(axis=0))[0]
    size = int(min(520, max(260, 0.55 * (cols[-1] - cols[0] + 1))))
    band = a[top:top + size]
    xs = np.where(band.any(axis=0))[0]
    cx = int((xs[0] + xs[-1]) / 2) if len(xs) else 400
    x0 = min(max(cx - size // 2, 0), 800 - size)
    y0 = min(max(top - size // 10, 0), 1000 - size)
    return (x0, y0, x0 + size, y0 + size)


def main_figure(cut):
    """Only the largest connected figure (another player at the edge of the photo goes)."""
    a = np.array(cut)
    lab, n = ndimage.label(a[:, :, 3] > 24)
    if n > 1:
        sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        keep = ndimage.binary_dilation(lab == 1 + int(np.argmax(sizes)), iterations=3)
        a[:, :, 3] = np.where(keep, a[:, :, 3], 0)
    return Image.fromarray(a)


def main(src, out):
    d = json.load(open(src))
    if not d.get("pending") and not d.get("ri"):
        return
    session = new_session("isnet-general-use")
    for x in d.get("ri") or []:
        pid, v, url = int(x["pid"]), str(x["v"]), str(x.get("url") or "")
        if not v.isalnum() or not RI_IMG.match(url):
            continue
        try:
            Image.MAX_IMAGE_PIXELS = RI_MAX_PIXELS
            im = Image.open(io.BytesIO(fetch(url)))
            im.draft("RGB", (1600, 2000))   # a big JPEG decoded at a smaller size
            im = frame45(im.convert("RGB"))
        except Exception as e:   # gone, too big, no image
            print(f"skip r{pid}: {e}", file=sys.stderr)
            continue
        finally:
            Image.MAX_IMAGE_PIXELS = 2_000_000
        cut = main_figure(remove(im, session=session, post_process_mask=True).convert("RGBA"))
        cut.save(f"{out}/r{pid}-{v}.webp", "WEBP", quality=85, method=6)
        cut.crop(head_box(cut)).resize((150, 150), Image.LANCZOS).save(f"{out}/r{pid}-{v}-av.webp", "WEBP", quality=85, method=6)
        print(f"r{pid}-{v}.webp")
    for x in d.get("pending") or []:
        pid, v = int(x["pid"]), str(x["v"])
        if not v.isalnum():
            continue
        req = urllib.request.Request(f"{API}/photo/{pid}.jpg?v={v}", headers={"User-Agent": "padel photos"})
        try:
            raw = urllib.request.urlopen(req, timeout=30).read()
        except Exception as e:   # removed or replaced since the list was made
            print(f"skip {pid}: {e}", file=sys.stderr)
            continue
        im = Image.open(io.BytesIO(raw))
        if im.width > 1000 or im.height > 1250:   # the worker only takes the phone's 800x1000; anything else is skipped
            print(f"skip {pid}: {im.width}x{im.height}", file=sys.stderr)
            continue
        im = im.convert("RGB").resize((800, 1000))
        cut = main_figure(remove(im, session=session, post_process_mask=True).convert("RGBA"))
        cut.save(f"{out}/{pid}-{v}.webp", "WEBP", quality=85, method=6)
        cut.crop(AV_BOX).resize((150, 150), Image.LANCZOS).save(f"{out}/{pid}-{v}-av.webp", "WEBP", quality=85, method=6)
        print(f"{pid}-{v}.webp")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
