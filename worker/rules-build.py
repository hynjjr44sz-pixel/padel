#!/usr/bin/env python3
"""Svenska Padelförbundets regler for the app's "Regler" view: rules.json (sections of paragraphs, searchable).

Sources (all from svenskpadel.se): the international rules in Swedish (PDF), the federation's clarifications (pages
under Om padel / Regler), the competition handbook and the youth rules (the newest PDFs linked from the page
Tävlingsbestämmelser), accumulated warnings (PDF) and the short guide (page Regler). Run every Sunday by
.github/workflows/rules.yml; "checked" is the run, a document's "changed" the first run that saw its current text.

usage: rules-build.py OUT.json [PREVIOUS.json]
"""
import hashlib, html, io, json, re, sys, urllib.request
from datetime import datetime, timezone
from pdfminer.high_level import extract_text

SITE = "https://svenskpadel.se"
UA = {"User-Agent": "Mozilla/5.0 (padel.holmberg.st rules)"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def wp_page(slug):
    d = json.loads(get(SITE + "/wp-json/wp/v2/pages?slug=" + slug + "&_fields=title,modified,link,content"))
    if not d:
        raise SystemExit("page missing: " + slug)
    return d[0]


def text_of(fragment):
    t = re.sub(r"<[^>]+>", "", fragment)
    return re.sub(r"\s+", " ", html.unescape(t)).replace(" ", " ").strip()


def wp_sections(content, title, sid):
    """A page's HTML -> sections at its headings; paragraphs and list items as paragraphs ("• " for list items)."""
    out, cur = [], {"id": sid, "t": title, "p": []}
    for m in re.finditer(r"(?s)<(h[1-6]|p|li)\b[^>]*>(.*?)</\1>", content):
        tag, body = m.group(1), text_of(m.group(2))
        if not body:
            continue
        if tag.startswith("h"):
            if cur["p"]:
                out.append(cur)
            cur = {"id": sid + "-" + str(len(out) + 1), "t": body, "p": []}
        elif tag == "li":
            cur["p"].append("• " + body)
        else:   # a paragraph with line breaks: "• " lines are list items
            for part in re.split(r"<br\s*/?>", m.group(2)):
                t = text_of(part)
                if t:
                    cur["p"].append("• " + t.lstrip("•· ").strip() if t[0] in "•·" else t)
    if cur["p"]:
        out.append(cur)
    return out


def pdf_lines(url):
    t = extract_text(io.BytesIO(get(url)))
    t = t.replace("\x0c", "\n").replace(" ", " ")
    return [l.rstrip() for l in t.split("\n")]


def paragraphs(lines):
    """PDF lines -> paragraphs: blank lines split, page numbers dropped, bullets start a new paragraph."""
    out, cur = [], []
    def flush():
        if cur:
            s = re.sub(r"\s+", " ", " ".join(cur)).strip()
            s = re.sub(r"(\w)- (\w)", r"\1\2", s) if re.search(r"\w- \w", s) and not re.search(r"\w- (och|eller) ", s) else s
            if s:
                out.append(s)
            cur.clear()
    for l in lines:
        s = l.strip()
        if not s or re.fullmatch(r"\d{1,3}", s):
            flush(); continue
        if re.match(r"^[•\-–]\s|^\d+\.\s", s):
            flush(); s = "• " + re.sub(r"^[•\-–]\s*", "", s) if s[0] in "•-–" else s
        cur.append(s)
    flush()
    return out


def numbered(lines, sid):
    """A handbook with numbered headings ("4.3  Reservlista"); the table of contents (dot leaders) is skipped."""
    head = re.compile(r"^(\d+(?:\.\d+){0,3})\s{2,}(\S.{1,90})$")
    start = 0
    for i, l in enumerate(lines):
        if "....." in l:
            start = i + 1
    secs, cur, buf = [], None, []
    for l in lines[start:]:
        m = head.match(l.strip())
        if m and not re.search(r"\.{4}|\d$", m.group(2)) and len(m.group(2)) < 90:
            if cur:
                cur["p"] = paragraphs(buf); secs.append(cur)
            n = m.group(1)
            cur, buf = {"id": sid + "-" + n.replace(".", "-"), "n": n, "t": m.group(2).strip().rstrip(".").capitalize() if m.group(2).isupper() else m.group(2).strip()}, []
        else:
            buf.append(l)
    if cur:
        cur["p"] = paragraphs(buf); secs.append(cur)
    return [s for s in secs if s["p"] or "." not in s.get("n", "")]


def plain(lines, sid):
    """No numbered headings (the youth rules): a short line on its own between blank lines starts a section."""
    secs, cur, buf = [], None, []
    for i, l in enumerate(lines):
        s = l.strip()
        prev_blank = i == 0 or not lines[i - 1].strip()
        next_blank = i + 1 >= len(lines) or not lines[i + 1].strip()
        if prev_blank and next_blank and 3 <= len(s) <= 45 and s[0].isupper() and not re.search(r"[.:,]$|\d", s) and len(s.split()) <= 6 and not s.startswith("•"):
            if cur and buf:
                cur["p"] = paragraphs(buf); secs.append(cur); buf = []
            if not cur or cur.get("p") is not None:
                cur = {"id": sid + "-" + str(len(secs) + 1), "t": s}
            else:
                cur["t"] = s   # two heading-like lines in a row: the later one
            continue
        buf.append(l)
    if cur and buf:
        cur["p"] = paragraphs(buf); secs.append(cur)
    return [x for x in secs if x.get("p")]


def cap(s):
    """ "1. DIMENSIONS." -> "1. Dimensions" (only the first letter upper)"""
    s = re.sub(r"^[^\w(“\"]+", "", s).strip().rstrip(".").lower()
    return re.sub(r"[a-zåäöéü]", lambda m: m.group(0).upper(), s, count=1)


def capitals(lines, sid):
    """The international rules: headings in capitals ("REGEL 6. SERVE", "PADELRACKET"), after the page index."""
    start = 0
    for i, l in enumerate(lines):
        if "…" in l:
            start = i + 1
    secs, cur, buf = [], None, []
    def is_head(s):
        letters = [c for c in s if c.isalpha()]
        return 4 <= len(s) <= 70 and len(letters) >= 4 and all(not c.islower() for c in letters) and not s.endswith(",")
    for l in lines[start:]:
        s = re.sub(r"\s+", " ", re.sub(r"^[\uf0b7•\s]+", "", l.strip()))
        if is_head(s):
            if cur and not any(x.strip() for x in buf) and not re.match(r"(REGEL|RULE) \d", s):   # a heading on two lines, or a rule's first subheading
                cur["t"] += (" · " if re.match(r"(Regel|Rule) \d", cur["t"]) else " ") + cap(s); buf = []; continue
            if cur:
                cur["p"] = paragraphs(buf); secs.append(cur)
            m = re.match(r"(REGEL|RULE) (\d+)\.?\s*(.*)", s)
            t = (m.group(1).capitalize() + " " + m.group(2) + ". " + cap(m.group(3))) if m else cap(s)
            cur, buf = {"id": sid + "-" + str(len(secs) + 1), "t": t}, []
            if m:
                cur["n"] = m.group(2)
        else:
            buf.append(l)
    if cur:
        cur["p"] = paragraphs(buf); secs.append(cur)
    return [s for s in secs if s["p"]]


def attach_notes(docs):
    """Info boxes where FIP's rules (in force) differ from the Swedish texts (rules-notes.json). A note is kept only while
    FIP's section still has its check phrase; a section gets "notes": [note ids]."""
    import os
    spec = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "rules-notes.json")))["notes"]
    fip = next((d for d in docs if d["id"] == "fip"), None)
    out = []
    for n in spec:
        ref = next((x for x in (fip or {}).get("sections", []) if re.search(n["fip"], x["t"])), None)
        ok = bool(ref) and n["check"].lower() in re.sub(r"\s+", " ", " ".join(ref["p"])).lower()
        if not ok:
            print("note not confirmed by FIP's text, left out:", n["id"], file=sys.stderr)
            continue
        hit = 0
        for doc, title, text in n["on"]:
            for d in docs:
                if d["id"] != doc:
                    continue
                for x in d["sections"]:
                    if (title and re.search(title, x["t"])) or (text and any(re.search(text, p) for p in x["p"])):
                        x.setdefault("notes", []).append(n["id"]); hit += 1
                        break
        out.append({"id": n["id"], "text": n["text"], "ref": ref["id"], "rt": ref["t"], "on": hit})
    return out


def pdf_links(slug):
    c = wp_page(slug)["content"]["rendered"]
    return [html.unescape(u) for u in re.findall(r'href="([^"]+\.pdf)"', c)]


def build(prev):
    docs = []
    g = wp_page("regler")
    docs.append({"id": "guide", "title": "I korthet", "sub": "Förbundets korta guide till reglerna", "src": g["link"],
                 "sections": [x for x in wp_sections(g["content"]["rendered"], text_of(g["title"]["rendered"]), "guide") if not re.match(r"Hela regelverket|Padelregler –", x["t"])]})
    # The rulebook in force: FIP's Rules of Padel (English; the federation refers to it, there is no current Swedish translation)
    fip = sorted(set(re.findall(r'href="(https://www\.padelfip\.com/[^"]*Rules-of-Padel[^"]*\.pdf)"', get("https://www.padelfip.com/documents/").decode("utf-8", "replace"))))
    if not fip:
        raise SystemExit("FIP Rules of Padel not found")
    fl = pdf_lines(fip[-1])
    m = re.search(r"application\s+(\d\d)\.(\d\d)\.(\d{4})", " ".join(fl), re.I)
    docs.append({"id": "fip", "title": "Regelboken", "sub": "FIP Rules of Padel, gällande regler (engelska). Förbundet hänvisar hit.", "src": fip[-1], "lang": "en",
                 **({"ver": m.group(3) + "-" + m.group(2) + "-" + m.group(1)} if m else {}), "sections": capitals(fl, "fip")})
    rules_pdf = SITE + "/wp-content/uploads/2019/05/Regelverk-Padel.pdf"
    docs.append({"id": "spel", "title": "På svenska", "sub": "Förbundets svenska översättning (revision 2017). Äldre: kan skilja sig från regelboken.", "src": rules_pdf, "old": True,
                 "sections": capitals(pdf_lines(rules_pdf), "spel")})
    clar = []
    for slug in ["serven", "boll-pa-overliggaren", "sakerhetsomrade-och-spel-utanfor-banan"]:
        pg = wp_page(slug)
        clar += wp_sections(pg["content"]["rendered"], text_of(pg["title"]["rendered"]), "fort-" + slug)
    docs.append({"id": "fort", "title": "Förtydliganden", "sub": "Förbundets senare texter om serven, överliggaren och spel utanför banan. Gäller före regelverket.",
                 "src": SITE + "/om-padel/regler/", "sections": clar})
    tb = pdf_links("tavlingsbestammelser")
    main = [u for u in tb if "bu" not in u.lower().rsplit("/", 1)[-1].replace("bestammelser", "")] or tb
    young = [u for u in tb if u not in main]
    newest = lambda l: sorted(l)[-1]
    docs.append({"id": "tavling", "title": "Tävlingsbestämmelser", "sub": "Tävlingshandbok: anmälan, klasser, ranking, matchregler", "src": newest(main),
                 "sections": numbered(pdf_lines(newest(main)), "tavling")})
    if young:
        yl = pdf_lines(newest(young))
        docs.append({"id": "ungdom", "title": "Barn och ungdom", "sub": "Tävlingsbestämmelser för barn- och ungdomsklasser", "src": newest(young),
                     "sections": numbered(yl, "ungdom") or plain(yl, "ungdom")})
    warn = [u for u in pdf_links("regler") if "varning" in u.lower()]
    if warn:
        docs.append({"id": "varning", "title": "Varningar", "sub": "Ackumulerade varningar", "src": warn[0],
                     "sections": [{"id": "varning-1", "t": "Ackumulerade varningar", "p": paragraphs(pdf_lines(warn[0]))}]})
    for d in docs:   # cover pages and index leftovers: a section of a few words only
        d["sections"] = [x for x in d["sections"] if sum(len(p.split()) for p in x["p"]) >= 6]
        for x in d["sections"]:
            x["t"] = re.sub(r"[.:]+$", "", x["t"]).strip()
    notes = attach_notes(docs)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    old = {d["id"]: d for d in (prev or {}).get("docs", [])}
    for d in docs:
        if not d["sections"]:
            raise SystemExit("no sections: " + d["id"])
        d["hash"] = hashlib.sha256(json.dumps(d["sections"], ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
        o = old.get(d["id"])
        d["changed"] = o["changed"] if o and o.get("hash") == d["hash"] and o.get("changed") else now
    return {"v": 1, "checked": now, "docs": docs, "notes": notes}


if __name__ == "__main__":
    prev = None
    if len(sys.argv) > 2:
        try:
            prev = json.load(open(sys.argv[2]))
        except Exception:
            prev = None
    out = build(prev)
    json.dump(out, open(sys.argv[1], "w"), ensure_ascii=False, separators=(",", ":"))
    print(" ".join(d["id"] + ":" + str(len(d["sections"])) for d in out["docs"]))
