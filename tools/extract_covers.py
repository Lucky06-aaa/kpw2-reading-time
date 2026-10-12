# -*- coding: utf-8 -*-
"""Extract embedded covers from Kindle / EPUB books and emit covers.js.

Run on the PC with the Kindle mounted (default Windows drive E:/).
For each matched book it writes:
    <DEVICE>/kpw2-reading-time/dashboard/covers/<book_id>.<ext>
    <DEVICE>/kpw2-reading-time/dashboard/covers.js   (window.READING_COVERS)
and mirrors the same into a local dashboard folder for development.

Pure stdlib: parses PDB/PalmDOC+MOBI EXTH (type 129 cover / 201 thumbnail)
and EPUB (container.xml -> OPF -> cover-image item, else largest portrait image).

Configuration (environment variables; sensible defaults for Windows):
    KPW_DEV       device mount root          (default: E:/)
    KPW_DASH      dashboard folder on device  (default: <DEV>/kpw2-reading-time/dashboard)
    KPW_LOCAL     local dashboard mirror      (default: ./dashboard  relative to this script)
    --force       wipe existing covers before re-extracting

Usage:
    python tools/extract_covers.py            # normal run
    python tools/extract_covers.py --force    # re-extract everything
"""
import os, re, struct, zipfile, sys

DEV = os.environ.get("KPW_DEV", "E:/")
DASH = os.environ.get("KPW_DASH", os.path.join(DEV, "kpw2-reading-time", "dashboard"))
LOCAL = os.environ.get("KPW_LOCAL", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kpw2-reading-time", "dashboard"))
DOCS = os.path.join(DEV, "documents")
COVER_DIR = os.path.join(DASH, "covers")
COVERS_JS = os.path.join(DASH, "covers.js")
LOCAL_COVER_DIR = os.path.join(LOCAL, "covers")
LOCAL_COVERS_JS = os.path.join(LOCAL, "covers.js")
THUMBS = os.path.join(DEV, "system", "thumbnails")
HEX32 = re.compile(r"^[0-9A-Fa-f]{32}$")

os.makedirs(COVER_DIR, exist_ok=True)
os.makedirs(LOCAL_COVER_DIR, exist_ok=True)


def pdb_records(data):
    """Return list of (offset, size) for each PDB record."""
    if len(data) < 78:
        return []
    n = struct.unpack(">H", data[76:78])[0]
    recs = []
    for i in range(n):
        off = 78 + 8 * i
        if off + 8 > len(data):
            break
        o = struct.unpack(">I", data[off:off + 4])[0]
        recs.append(o)
    for i in range(len(recs)):
        end = recs[i + 1] if i + 1 < len(recs) else len(data)
        recs[i] = (recs[i], end)
    return recs


def exth_cover_record(data):
    """Parse record0, return (cover_rec_idx, thumbnail_rec_idx)."""
    recs = pdb_records(data)
    if not recs:
        return None, None
    r0 = data[recs[0][0]:recs[0][1]]
    i = r0.find(b"EXTH")
    if i < 0:
        return None, None
    count = struct.unpack(">I", r0[i + 8:i + 12])[0]
    p = i + 12
    cover = thumb = None
    for _ in range(count):
        if p + 8 > len(r0):
            break
        t, ln = struct.unpack(">II", r0[p:p + 8])
        body = r0[p + 8:p + ln]
        if t == 129 and len(body) >= 4:
            cover = struct.unpack(">I", body[:4])[0]
        elif t == 201 and len(body) >= 4:
            thumb = struct.unpack(">I", body[:4])[0]
        p += ln
    return cover, thumb


def image_from_record(data, idx):
    recs = pdb_records(data)
    if idx is None or idx <= 0 or idx >= len(recs):
        return None
    o, e = recs[idx]
    blob = data[o:e]
    for magic, ext in ((b"\xff\xd8\xff", "jpg"), (b"\x89PNG", "png")):
        j = blob.find(magic)
        if j >= 0:
            return blob[j:], ext
    return None


def img_dims(b):
    """(w, h) of a jpeg/png blob, or None. Pure stdlib."""
    try:
        if b[:3] == b"\xff\xd8\xff":
            i = 2
            while i < len(b) - 9:
                if b[i] != 0xFF:
                    i += 1
                    continue
                m = b[i + 1]
                if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", b[i + 5:i + 9])
                    return w, h
                if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7:
                    i += 2
                    continue
                i += 2 + struct.unpack(">H", b[i + 2:i + 4])[0]
        elif b[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", b[16:24])
    except Exception:
        return None
    return None


def _is_img(b):
    return b[:3] == b"\xff\xd8\xff" or b[:8] == b"\x89PNG\r\n\x1a\n"


def scan_records_for_image(data, limit=0):
    """Pick the best cover-shaped portrait image among embedded images."""
    recs = pdb_records(data)
    rng = range(1, len(recs)) if not limit else range(1, min(limit, len(recs)))
    cands = []
    for k in rng:
        o, e = recs[k]
        blob = data[o:e]
        if _is_img(blob):
            d = img_dims(blob)
            if d and d[0] > 0 and d[1] > 0:
                cands.append((k, blob, d[0], d[1]))
    if not cands:
        return None
    big = [c for c in cands if c[2] >= 150 and c[3] >= 150] or cands
    port = [c for c in big if 1.10 <= c[3] / c[2] <= 2.10]
    maxport = max((c[2] * c[3] for c in port), default=0)
    coverish = [c for c in port if 1.15 <= c[3] / c[2] <= 1.95 and c[2] * c[3] >= 0.30 * maxport]
    pick = coverish[0] if coverish else (max(port, key=lambda c: c[2] * c[3]) if port
                                        else max(big, key=lambda c: c[2] * c[3]))
    blob = pick[1]
    return blob, ("png" if blob[:8] == b"\x89PNG\r\n\x1a\n" else "jpg")


def extract_mobi(path):
    try:
        with open(path, "rb") as f:
            data = f.read()
        cover, thumb = exth_cover_record(data)
        for idx in (thumb, cover):
            r = image_from_record(data, idx)
            if r:
                return r
        return scan_records_for_image(data)
    except Exception:
        return None


def extract_epub(path):
    try:
        z = zipfile.ZipFile(path)
        names = z.namelist()
        cover_name = None
        if "META-INF/container.xml" in names:
            c = z.read("META-INF/container.xml").decode("utf-8", "ignore")
            m = re.search(r'full-path="([^"]+)"', c)
            if m and m.group(1) in names:
                opf = z.read(m.group(1)).decode("utf-8", "ignore")
                opfdir = m.group(1).rsplit("/", 1)[0] if "/" in m.group(1) else ""
                mm = re.search(r'<item\b[^>]*properties="[^"]*cover-image[^"]*"[^>]*href="([^"]+)"', opf)
                if not mm:
                    mm = re.search(r'<item\b[^>]*href="([^"]+)"[^>]*properties="[^"]*cover-image[^"]*"', opf)
                if not mm:
                    mc = re.search(r'<meta\b[^>]*name="cover"[^>]*content="([^"]+)"', opf)
                    mc2 = None
                    if mc:
                        mc2 = re.search(r'<item\b[^>]*id="' + re.escape(mc.group(1)) + r'"[^>]*href="([^"]+)"', opf)
                    mm = mc2
                if mm:
                    href = mm.group(1)
                    cover_name = (opfdir + "/" + href) if opfdir and not href.startswith("/") else href.lstrip("/")
        if cover_name and cover_name in names:
            return z.read(cover_name), os.path.splitext(cover_name)[1].lstrip(".").lower()
        cands = []
        for n in names:
            if re.search(r"\.(jpe?g|png)$", n, re.I):
                try:
                    blob = z.read(n)
                except Exception:
                    continue
                d = img_dims(blob)
                if d and d[0] > 0 and d[1] > 0:
                    cands.append((blob, d[0], d[1], n))
        if cands:
            big = [c for c in cands if c[1] >= 150 and c[2] >= 150] or cands
            port = [c for c in big if 1.10 <= c[2] / c[1] <= 2.10]
            maxport = max((c[1] * c[2] for c in port), default=0)
            coverish = [c for c in port if 1.15 <= c[2] / c[1] <= 1.95 and c[1] * c[2] >= 0.30 * maxport]
            pick = coverish[0] if coverish else (max(port, key=lambda c: c[1] * c[2]) if port
                                                else max(big, key=lambda c: c[1] * c[2]))
            return pick[0], ("png" if pick[3].lower().endswith("png") else "jpg")
    except Exception:
        return None
    return None


def sniff(blob):
    if blob[:3] == b"\xff\xd8\xff":
        return "jpg"
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    return None


mapping = {}
done = fail = 0
FORCE = "--force" in sys.argv
if FORCE:
    for d in (COVER_DIR, LOCAL_COVER_DIR):
        for fn in os.listdir(d):
            if fn.lower().endswith((".jpg", ".png")):
                os.remove(os.path.join(d, fn))
    print("--force: cleared existing covers")

for root, dirs, files in os.walk(DOCS):
    dirs[:] = [d for d in dirs if not d.endswith(".sdr")]
    for fn in files:
        m = re.search(r"_([0-9A-Fa-f]{32}|B0[A-Z0-9]{8})\.(azw3|azw|mobi|prc|epub|kfx)$", fn, re.I)
        if not m:
            continue
        bid, ext = m.group(1), m.group(2).lower()
        out = os.path.join(COVER_DIR, bid + ".jpg")
        out_local = os.path.join(LOCAL_COVER_DIR, bid + ".jpg")
        if os.path.exists(out):
            mapping[bid] = "covers/" + bid + ".jpg"
            done += 1
            continue
        blob = None
        src = os.path.join(root, fn)
        if ext in ("azw3", "azw", "mobi", "prc"):
            blob = extract_mobi(src)
        elif ext == "epub":
            r = extract_epub(src)
            if r:
                blob = (r[0], r[1])
        if blob is None and not HEX32.match(bid):
            tp = os.path.join(THUMBS, "thumbnail_" + bid + "_EBOK_portrait.jpg")
            if os.path.exists(tp):
                with open(tp, "rb") as f:
                    blob = (f.read(), "jpg")
        if blob and sniff(blob[0]):
            b, e = blob
            if e == "png":
                out = os.path.join(COVER_DIR, bid + ".png")
                out_local = os.path.join(LOCAL_COVER_DIR, bid + ".png")
                mapping[bid] = "covers/" + bid + ".png"
            else:
                mapping[bid] = "covers/" + bid + ".jpg"
            with open(out, "wb") as f:
                f.write(b)
            with open(out_local, "wb") as f:
                f.write(b)
            done += 1
        else:
            fail += 1

js = "window.READING_COVERS={" + ",".join(
    '"%s":"%s"' % (k, v) for k, v in sorted(mapping.items())) + "};\n"
for dest in (COVERS_JS, LOCAL_COVERS_JS):
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        f.write(js)

print("covers extracted:", done, "| failed:", fail, "| map size:", len(mapping))
