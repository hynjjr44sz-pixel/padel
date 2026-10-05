# MATCHi TV match starts, step 2 (GitHub Action tvstarts.yml): when a match actually began in its court's recording.
# One frame pair per minute (the first and last frame of a 4 s HLS segment, 480p) from 75 min before to 40 min after the
# scheduled time; the share of moving pixels on the court says empty (< 0.8 %) or in play (>= 1 %). The start is the
# first minute in play after at least 5 empty minutes, with play in 3 of the next 5: the one nearest the scheduled time.
# Back-to-back matches (no empty court between) give no start (o: null): the app keeps the scheduled time then.
#   python3 tvstarts.py jobs.json tvstarts.json
import cv2, json, re, sys, tempfile, os, time, urllib.request
from datetime import datetime

def get(u):
    for k in range(4):
        try:
            return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "padel.holmberg.st tvstarts"}), timeout=30).read()
        except Exception:
            if k == 3: raise
            time.sleep(2 ** k)

def motion(data):
    f = tempfile.NamedTemporaryFile(suffix=".ts", delete=False); f.write(data); f.close()
    cap = cv2.VideoCapture(f.name); first = last = None
    while True:
        ok, x = cap.read()
        if not ok: break
        if first is None: first = x
        last = x
    cap.release(); os.unlink(f.name)
    if first is None or last is None: return None
    a = cv2.GaussianBlur(cv2.cvtColor(first, cv2.COLOR_BGR2GRAY), (9, 9), 0)
    b = cv2.GaussianBlur(cv2.cvtColor(last, cv2.COLOR_BGR2GRAY), (9, 9), 0)
    h = a.shape[0]
    return float((cv2.absdiff(a, b)[int(h * .15):, :] > 25).mean() * 100)

def iso(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))

def start_of(scores, tm):
    ms = sorted(m for m in scores if scores[m] is not None)
    st = {m: ("E" if scores[m] < 0.8 else "O" if scores[m] >= 1.0 else "M") for m in ms}
    best = None
    for i, m in enumerate(ms):
        if st[m] != "O" or i < 5: continue
        if not all(st[ms[j]] == "E" for j in range(i - 5, i)): continue
        if sum(1 for j in range(i, min(i + 5, len(ms))) if st[ms[j]] == "O") < 3: continue
        if best is None or abs(m - tm) < abs(best - tm): best = m
    return best

def analyse(job):
    base = "https://streamrecordings.padelgo.tv/" + job["g"] + "/480p/"
    pl = get(base + "video.m3u8").decode()
    segs, t = [], 0.0
    for d, name in re.findall(r"#EXTINF:([\d.]+),\s*\n(\S+)", pl):
        segs.append((t, name)); t += float(d)
    if not segs: return None
    tm = (iso(job["t"]) - iso(job["a"])).total_seconds() / 60
    lo, hi = max(0, int(tm - 75)), min(int(t / 60) - 1, int(tm + 40))
    scores = {}
    for m in range(lo, hi + 1):
        i = max(k for k, (s, _) in enumerate(segs) if s <= m * 60)
        try: scores[m] = motion(get(base + segs[i][1]))
        except Exception as e: scores[m] = None
    m = start_of(scores, tm)
    return None if m is None else int(m * 60)

if __name__ == "__main__":
    jobs = json.load(open(sys.argv[1]))
    out = json.load(open(sys.argv[2])) if os.path.exists(sys.argv[2]) and os.path.getsize(sys.argv[2]) else {}
    for job in jobs:
        try: o = analyse(job)
        except Exception as e:
            print("skip", job["mid"], e); continue
        out[job["mid"]] = {"x": job["x"], "o": o}
        print(job["what"], "->", "no start found" if o is None else "%d min in" % (o // 60))
    json.dump(out, open(sys.argv[2], "w"), separators=(",", ":"))
