#!/usr/bin/env python3
"""Uploaded profile pictures -> cut-outs without background, for .github/workflows/photos.yml.

  python worker/photo-cut.py pending.json OUT_DIR

pending.json is the worker's GET /photos/pending {pending: [{pid, v}], current: {pid: v}}. For each pending photo:
the uploaded 800x1000 JPEG from the worker, the background removed (rembg, isnet-general-use), written as
OUT_DIR/<pid>-<v>.webp (800x1000) and OUT_DIR/<pid>-<v>-av.webp (150x150: the circle the phone showed when cropping,
centre 400,300, radius 230). Prints the files written.
"""
import io
import json
import sys
import urllib.request

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage

API = "https://padel-push.holmberg-padel.workers.dev"
AV_BOX = (170, 70, 630, 530)   # the avatar circle's square in the 800x1000 frame


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
    if not d.get("pending"):
        return
    session = new_session("isnet-general-use")
    for x in d["pending"]:
        pid, v = int(x["pid"]), str(x["v"])
        if not v.isalnum():
            continue
        req = urllib.request.Request(f"{API}/photo/{pid}.jpg?v={v}", headers={"User-Agent": "padel photos"})
        try:
            raw = urllib.request.urlopen(req, timeout=30).read()
        except Exception as e:   # removed or replaced since the list was made
            print(f"skip {pid}: {e}", file=sys.stderr)
            continue
        im = Image.open(io.BytesIO(raw)).convert("RGB").resize((800, 1000))
        cut = main_figure(remove(im, session=session, post_process_mask=True).convert("RGBA"))
        cut.save(f"{out}/{pid}-{v}.webp", "WEBP", quality=85, method=6)
        cut.crop(AV_BOX).resize((150, 150), Image.LANCZOS).save(f"{out}/{pid}-{v}-av.webp", "WEBP", quality=85, method=6)
        print(f"{pid}-{v}.webp")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
