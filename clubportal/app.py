#!/usr/bin/env python3
"""Clubbb — a self-hostable club portal.

Python standard library only. Run:  python3 app.py  → http://localhost:8770
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import os
import re
import secrets
import smtplib
import sqlite3
import threading
import time
import traceback
import urllib.parse
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("PORTAL_DB", ROOT / "portal.db"))
STATIC = ROOT / "static"
DATA = Path(os.environ.get("PORTAL_DATA", ROOT / "data"))
UPLOADS = DATA / "uploads"
PORT = int(os.environ.get("PORT", "8770"))
HOST = os.environ.get("HOST", "127.0.0.1")

SITE_URL = os.environ.get("SITE_URL", "").rstrip("/") or f"http://localhost:{PORT}"
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER or "reminders@clubbb.example")
EMAIL_ON = bool(SMTP_HOST)

CATEGORIES = ["technical", "cultural", "sports", "social", "academic", "media"]
KINDS = ["hackathon", "talk", "workshop", "interview", "meetup", "sports", "cultural"]
BANNERS = ["solid", "grid", "dots"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  category TEXT NOT NULL, tagline TEXT DEFAULT '', about TEXT DEFAULT '',
  accent TEXT DEFAULT '#8fa68e', banner TEXT DEFAULT 'solid',
  email TEXT DEFAULT '', instagram TEXT DEFAULT '', website TEXT DEFAULT '',
  join_open INTEGER DEFAULT 1, status TEXT DEFAULT 'pending',
  manage_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, club_id INTEGER NOT NULL, title TEXT NOT NULL,
  kind TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT DEFAULT '',
  venue TEXT DEFAULT '', description TEXT DEFAULT '', link TEXT DEFAULT '',
  capacity INTEGER DEFAULT 0, cover TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, name TEXT NOT NULL,
  email TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(event_id, email)
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, email TEXT NOT NULL, token TEXT NOT NULL,
  sent_day INTEGER DEFAULT 0, sent_hour INTEGER DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE(event_id, email)
);
CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY, club_id INTEGER NOT NULL, event_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'event', title TEXT NOT NULL, caption TEXT DEFAULT '',
  winners TEXT DEFAULT '[]', photos TEXT DEFAULT '[]',
  created_at TEXT NOT NULL, home_until TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY, club_id INTEGER NOT NULL, name TEXT NOT NULL,
  email TEXT NOT NULL, year TEXT DEFAULT '', message TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
"""


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------
def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def admin_key() -> str:
    key = os.environ.get("ADMIN_KEY")
    if key:
        return key
    f = ROOT / ".admin_key"
    if not f.exists():
        f.write_text(secrets.token_urlsafe(18))
        f.chmod(0o600)
    return f.read_text().strip()


# --------------------------------------------------------------------------
# access: a campus code for students, a password login for club organisers
# --------------------------------------------------------------------------
REQ = threading.local()          # per-request cookies in, cookies out


def _secret_file(name: str, make) -> str:
    f = ROOT / name
    if not f.exists():
        f.write_text(make())
        f.chmod(0o600)
    return f.read_text().strip()


def secret_key() -> bytes:
    return _secret_file(".secret_key", lambda: secrets.token_hex(32)).encode()


def campus_code() -> str:
    """The code students type once to RSVP, apply, set reminders or register a club."""
    env = os.environ.get("CAMPUS_CODE", "").strip()
    if env:
        return env
    words = ["ROSE", "BLOOM", "PETAL", "STEM", "THORN", "IVY", "FERN", "LILY"]
    return _secret_file(".campus_code", lambda: f"{secrets.choice(words)}-{secrets.randbelow(9000) + 1000}")


def set_campus_code(code: str) -> None:
    f = ROOT / ".campus_code"
    f.write_text(code)
    f.chmod(0o600)


def sign(msg: str) -> str:
    return hmac.new(secret_key(), msg.encode(), hashlib.sha256).hexdigest()[:40]


def hash_password(pw: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex()
    return f"pbkdf2$200000${salt}${h}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, it, salt, h = (stored or "").split("$")
        got = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it)).hex()
        return hmac.compare_digest(got, h)
    except ValueError:
        return False


def cookie(name: str) -> str:
    c = getattr(REQ, "cookies", None)
    return c[name].value if c is not None and name in c else ""


def set_cookie(name: str, value: str, max_age: int) -> None:
    secure = "; Secure" if SITE_URL.startswith("https") else ""
    REQ.out.append(f"{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}")


def student_token() -> str:
    return sign("student:" + campus_code().strip().lower())


def session_club(con):
    """The club whose organiser is logged in on this browser, or None."""
    raw = cookie("cb_club")
    if "." not in raw:
        return None
    cid, sig = raw.split(".", 1)
    if not cid.isdigit():
        return None
    club = con.execute("select * from clubs where id=?", (int(cid),)).fetchone()
    if club and club["pw_hash"] and hmac.compare_digest(sig, sign(f"club:{club['id']}:{club['pw_hash']}")):
        return club
    return None


def login_club(club) -> None:
    cid, pw = club["id"], club["pw_hash"]
    set_cookie("cb_club", f"{cid}.{sign(f'club:{cid}:{pw}')}", 30 * 86400)
    set_cookie("cb_student", student_token(), 180 * 86400)   # organisers are students too
    REQ.student_now = True


def is_student(con=None) -> bool:
    if hmac.compare_digest(cookie("cb_student"), student_token()):
        return True
    return bool(con is not None and session_club(con))


def student_ok(con, form) -> bool:
    """True if this browser already has access, or the form carries the right campus code (then remember it)."""
    if is_student(con):
        return True
    typed = (form.get("campus_code") or "").strip().lower()
    if typed and hmac.compare_digest(typed, campus_code().strip().lower()):
        set_cookie("cb_student", student_token(), 180 * 86400)
        REQ.student_now = True
        return True
    return False


def code_field() -> str:
    if getattr(REQ, "student_now", False) or hmac.compare_digest(cookie("cb_student"), student_token()) or getattr(REQ, "club_now", False):
        return ""
    return ('<label class="field"><span>Campus code</span><input name="campus_code" required maxlength="40" autocomplete="off" '
            'placeholder="From the posters or your class group"></label>')


CODE_ERR = '<p class="notice err">That campus code is not right. Ask a club or check the posters around campus.</p>'

_fails: dict = {}


def too_many_fails(ip: str) -> bool:
    nowt = time.time()
    _fails[ip] = [t for t in _fails.get(ip, []) if nowt - t < 600]
    return len(_fails[ip]) >= 10


def init_db() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    con = connect()
    con.executescript(SCHEMA)
    cols = [r[1] for r in con.execute("pragma table_info(events)")]
    if "cover" not in cols:
        con.execute("ALTER TABLE events ADD COLUMN cover TEXT DEFAULT ''")
    ccols = [r[1] for r in con.execute("pragma table_info(clubs)")]
    if "cover" not in ccols:
        con.execute("ALTER TABLE clubs ADD COLUMN cover TEXT DEFAULT ''")
    if "pw_hash" not in ccols:
        con.execute("ALTER TABLE clubs ADD COLUMN pw_hash TEXT DEFAULT ''")
    con.commit()
    con.close()


def save_uploads(files, field: str, limit: int = 8) -> list:
    out = []
    for item in (files or {}).get(field + "[]", [])[:limit]:
        url = save_upload({"cover": item})
        if url:
            out.append(url)
    return out


def save_upload(files) -> str:
    item = files.get("cover")
    if not item:
        return ""
    _filename, ctype, data = item
    if len(data) > 5 * 1024 * 1024:
        return ""
    sig = data[:12]
    if sig.startswith(b"\xff\xd8\xff"):
        ext = ".jpg"
    elif sig.startswith(b"\x89PNG"):
        ext = ".png"
    elif sig.startswith(b"GIF8"):
        ext = ".gif"
    elif sig[:4] == b"RIFF" and sig[8:12] == b"WEBP":
        ext = ".webp"
    else:
        return ""
    name = secrets.token_hex(10) + ext
    (UPLOADS / name).write_bytes(data)
    return f"/uploads/{name}"


def now() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48]
    return s or "club"


def unique_slug(con: sqlite3.Connection, name: str) -> str:
    base = slugify(name)
    slug, n = base, 2
    while con.execute("select 1 from clubs where slug=?", (slug,)).fetchone():
        slug = f"{base}-{n}"
        n += 1
    return slug


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def club_by_slug(con, slug):
    return con.execute("select * from clubs where slug=? and status='approved'", (slug,)).fetchone()


def club_by_token(con, token):
    if isinstance(token, int):           # logged-in organiser: the club id from the session
        return con.execute("select * from clubs where id=?", (token,)).fetchone()
    return con.execute("select * from clubs where manage_hash=?", (token_hash(token),)).fetchone()


def base_url(token) -> str:
    return "/club" if isinstance(token, int) else f"/manage/{token}"


def approved_clubs(con):
    return con.execute("select * from clubs where status='approved' order by name").fetchall()


def upcoming_events(con, limit=50, since=None):
    since = since or datetime.now().strftime("%Y-%m-%dT%H:%M")
    return con.execute(
        "select e.*, c.name as club_name, c.slug as club_slug, c.accent as club_accent, "
        "(select count(*) from rsvps r where r.event_id=e.id) as going "
        "from events e join clubs c on c.id=e.club_id "
        "where e.starts_at >= ? and c.status='approved' order by e.starts_at limit ?",
        (since, limit),
    ).fetchall()


def event_by_id(con, eid):
    return con.execute(
        "select e.*, c.name as club_name, c.slug as club_slug, c.accent as club_accent "
        "from events e join clubs c on c.id=e.club_id where e.id=?",
        (eid,),
    ).fetchone()


def parse_dt(value):
    try:
        return datetime.fromisoformat(value) if value else None
    except ValueError:
        return None


def event_span(starts: str, ends: str):
    """(start, end) datetimes; an event with no end is treated as one hour long."""
    a = parse_dt(starts)
    b = parse_dt(ends)
    if not a:
        return None, None
    if not b or b <= a:
        b = a + timedelta(hours=1)
    return a, b


def same_venue(x: str, y: str) -> bool:
    norm = lambda v: re.sub(r"[^a-z0-9]+", " ", (v or "").lower()).strip()
    return bool(norm(x)) and norm(x) == norm(y)


def find_clashes(con, starts: str, ends: str = "", venue: str = "", exclude_id=None, include_club=None):
    """Events that overlap the given time, across every approved club (plus include_club's own).
    Each result says whether it is in the same venue, which is the serious kind of clash."""
    a, b = event_span(starts, ends)
    if not a:
        return []
    lo, hi = (a - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M"), b.strftime("%Y-%m-%dT%H:%M")
    rows = con.execute(
        "select e.*, c.name as club_name, c.slug as club_slug, c.accent as club_accent from events e "
        "join clubs c on c.id=e.club_id where (c.status='approved' or c.id=?) and e.starts_at >= ? and e.starts_at < ? "
        "order by e.starts_at", (include_club or -1, lo, hi)).fetchall()
    out = []
    for r in rows:
        if exclude_id and r["id"] == exclude_id:
            continue
        ra, rb = event_span(r["starts_at"], r["ends_at"])
        if ra and ra < b and rb > a:
            out.append({"id": r["id"], "title": r["title"], "club": r["club_name"], "club_slug": r["club_slug"],
                        "starts_at": r["starts_at"], "ends_at": r["ends_at"], "venue": r["venue"],
                        "same_venue": same_venue(r["venue"], venue)})
    out.sort(key=lambda c: (not c["same_venue"], c["starts_at"]))
    return out


def clash_html(clashes, own_club_name="") -> str:
    if not clashes:
        return ""
    items = "".join(
        f'<li class="{"hard" if c["same_venue"] else "soft"}"><strong>{esc(c["title"])}</strong> · {esc(c["club"])}'
        f' · {fmt_dt(c["starts_at"])}{(" · " + esc(c["venue"])) if c["venue"] else ""}'
        f'{" · <em>same venue</em>" if c["same_venue"] else ""}</li>' for c in clashes)
    hard = any(c["same_venue"] for c in clashes)
    head = "Venue double-booked" if hard else "Other events at the same time"
    return f'<div class="clash{" is-hard" if hard else ""}"><p class="mono">{head}</p><ul>{items}</ul></div>'


def ics_stamp(dt: datetime) -> str:
    return dt.strftime("%Y%m%dT%H%M%S")


def google_calendar_link(ev) -> str:
    a, b = event_span(ev["starts_at"], ev["ends_at"])
    q = urllib.parse.urlencode({
        "action": "TEMPLATE", "text": ev["title"], "dates": f"{ics_stamp(a)}/{ics_stamp(b)}",
        "details": f"{ev['club_name']} · {SITE_URL}/e/{ev['id']}\n\n{(ev['description'] or '')[:600]}",
        "location": ev["venue"] or "",
    })
    return "https://calendar.google.com/calendar/render?" + q


def when_label(starts: str) -> str:
    """'Today', 'Tomorrow', or '' — used for the soon tag on cards."""
    a = parse_dt(starts)
    if not a:
        return ""
    d = (a.date() - date.today()).days
    return "Today" if d == 0 else "Tomorrow" if d == 1 else ""


def rsvp_count(con, eid):
    return con.execute("select count(*) from rsvps where event_id=?", (eid,)).fetchone()[0]


# --------------------------------------------------------------------------
# html helpers
# --------------------------------------------------------------------------
def esc(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def paragraphs(text: str) -> str:
    blocks = [b.strip() for b in (text or "").split("\n\n") if b.strip()]
    return "".join(f"<p>{esc(b)}</p>" for b in blocks) or "<p>No description yet.</p>"


def fmt_dt(value: str, with_time=True) -> str:
    try:
        dt = datetime.fromisoformat(value)
    except Exception:
        return esc(value)
    return dt.strftime("%a %d %b · %H:%M") if with_time else dt.strftime("%a %d %b %Y")


def safe_accent(value: str) -> str:
    return value if re.fullmatch(r"#[0-9a-fA-F]{6}", value or "") else "#8fa68e"


# Seasonal looks. One entry per month (Jan..Dec). Each month picks a theme;
# visitors can still switch in the menu. Rose noir everywhere for now.
SEASONS = ["rosenoir"] * 12
THEMES = [("rosenoir", "Rose noir"), ("mono", "Mono")]

# href, label in the row, big word on the stage, script word over it
MENU = [
    ("/clubs", "Clubs", "Clubs", "find your people"),
    ("/events", "Events", "Events", "what is on"),
    ("/register", "How to register", "Register", "start one"),
    ("/contact", "Contact us", "Contact", "say hello"),
    ("/login", "Club login", "Login", "organisers"),
]


def initials(name: str) -> str:
    return "".join(w[0] for w in (name or "?").split()[:2]).upper()


def layout(title: str, body: str, active: str = "", description: str = "", home: bool = False) -> str:
    cur = lambda href: " aria-current=page" if href.strip("/") == active else ""
    listed = "".join(
        f'<li style="--i:{i}"><a href="{href}" data-bloom{cur(href)}><span class="m-num">0{i + 1}</span>'
        f'<span class="m-label">{label}</span><span class="m-sub">{script}</span></a></li>'
        for i, (href, label, word, script) in enumerate(MENU)
    )
    items = "".join(
        f'<a href="{href}" data-bloom data-word="{word}" data-script="{script}" style="--i:{i}"{cur(href)}>{label}</a>'
        for i, (href, label, word, script) in enumerate(MENU)
    )
    first = MENU[0]
    themes = "".join(f'<button type="button" data-theme-set="{k}">{lab}</button>' for k, lab in THEMES)
    seasons = json.dumps(SEASONS)
    return f"""<!DOCTYPE html>
<html lang="en" data-theme="rosenoir">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{esc(title)} · Clubbb</title>
<meta name="description" content="{esc(description or "Every club on campus, in one place.")}">
<meta name="theme-color" content="#000000">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;1,6..96,400&family=DM+Mono:wght@400;500&family=JetBrains+Mono:wght@300;400&family=Pinyon+Script&family=Playfair+Display:ital,wght@0,700;1,400&family=Unbounded:wght@400;800&display=swap" rel="stylesheet">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css">
<script>
window.CLUBBB_SEASONS={seasons};
(function(){{var t=window.CLUBBB_SEASONS[new Date().getMonth()]||"rosenoir";try{{var s=localStorage.getItem("clubbb-theme");if(s==="signal")s="mono";if(s==="rosenoir"||s==="mono")t=s;}}catch(e){{}}document.documentElement.setAttribute("data-theme",t);
var p=null;try{{p=localStorage.getItem("clubbb-potato");}}catch(e){{}}
var n=navigator,c=n.connection||{{}},low=(n.deviceMemory&&n.deviceMemory<=2)||c.saveData||/(^|-)2g$/.test(c.effectiveType||"")||matchMedia("(prefers-reduced-motion: reduce)").matches||(n.hardwareConcurrency&&n.hardwareConcurrency<=2);
if(p==="on"||(p!=="off"&&low))document.documentElement.setAttribute("data-potato","");}})();
</script>
</head>
<body{' data-home' if home else ''}>
<canvas id="bg" aria-hidden="true"></canvas>
<header class="top">
  <button class="menu-btn" type="button" aria-expanded="false" aria-controls="menu" aria-label="Open menu"><span class="bars"><span></span><span></span><span></span></span><span class="label">Menu</span></button>
  <a class="brand" href="/" data-bloom>Clubbb<span class="potato-mark" title="Potato mode"><svg viewBox="0 0 40 28" aria-hidden="true"><path d="M6 15c-2-7 5-12 14-12s16 3 16 10-7 13-17 12S8 22 6 15z"/><circle cx="14" cy="11" r="1.4"/><circle cx="24" cy="9" r="1.2"/><circle cx="29" cy="16" r="1.4"/><circle cx="18" cy="19" r="1.1"/></svg>potato</span></a>
</header>
<nav id="menu" class="menu" aria-hidden="true" inert>
  <ol class="menu-list">{listed}</ol>
  <div class="menu-mono">
    <a class="stage" href="{first[0]}" data-bloom tabindex="-1" aria-hidden="true">
      <span class="stage-word">{first[2]}</span>
      <span class="stage-script">{first[3]}</span>
    </a>
    <div class="menu-row">{items}</div>
  </div>
  <div class="menu-foot">
    <div class="themes" role="group" aria-label="Look">{themes}</div>
    <div class="themes potato-set" role="group" aria-label="Potato mode"><span class="mono">Potato mode</span><button type="button" data-potato-set="auto">Auto</button><button type="button" data-potato-set="on">On</button><button type="button" data-potato-set="off">Off</button></div>
    <p class="mono">Looks change with the seasons. Pick one to override.</p>
  </div>
</nav>
<main>
{body}
</main>
<footer class="foot mono">
  <span>Clubbb · student run · not affiliated with any institution<span class="potato-note"> · Potato mode: a lighter, still version for this phone. Switch it in the menu.</span></span>
  <a href="/contact" data-bloom>Contact</a>
</footer>
<canvas id="fx" aria-hidden="true"></canvas>
<canvas id="curtain" aria-hidden="true"></canvas>
<script src="/static/garden.js"></script>
<script src="/static/portal.js"></script>
</body>
</html>"""


def hero(word: str, kicker: str = "", fill: float = 0.34, tall: bool = False, cue: str = "Scroll", script: str = "") -> str:
    return f"""<section class="intro{' intro-tall' if tall else ''}" data-intro>
  <div class="intro-stage">
    {f'<p class="kicker mono">{esc(kicker)}</p>' if kicker else ''}
    <h1 class="sr-only">{esc(word)}</h1>
    <canvas class="hero-garden" data-garden-text="{esc(word)}" data-script="{esc(script)}" data-fill="{fill}" aria-hidden="true"></canvas>
    {f'<p class="cue mono"><span>{cue}</span></p>' if cue else ''}
  </div>
</section>"""


def page_hero(word: str, kicker: str = "", script: str = "") -> str:
    """Short garden heading for inner pages (no scroll stage)."""
    return f"""<section class="page-hero">
  {f'<p class="kicker mono">{esc(kicker)}</p>' if kicker else ''}
  <h1 class="sr-only">{esc(word)}</h1>
  <canvas class="hero-garden" data-garden-text="{esc(word)}" data-script="{esc(script)}" data-fill="0.42" aria-hidden="true"></canvas>
</section>"""


HOME_DAYS = {"event": 14, "outside": 7}   # how long a highlight stays on the home page
PLACES = ["1st", "2nd", "3rd"]


def hl_rows(con, where: str, args=()):
    return con.execute(
        "select h.*, c.name as club_name, c.slug as club_slug, c.accent as club_accent, e.starts_at as event_start "
        "from highlights h join clubs c on c.id=h.club_id left join events e on e.id=h.event_id "
        f"where {where} order by h.created_at desc", args).fetchall()


def hl_card(h, show_club=True, i=0) -> str:
    photos = json.loads(h["photos"] or "[]")
    winners = json.loads(h["winners"] or "[]")
    when = fmt_dt(h["event_start"], with_time=False) if h["event_start"] else fmt_dt(h["created_at"], with_time=False)
    if photos:
        more = f'<span class="hl-more mono">+{len(photos) - 1}</span>' if len(photos) > 1 else ""
        vis = (f'<button type="button" class="hl-photo" data-gallery=\'{esc(json.dumps(photos))}\' aria-label="Open photos">'
               f'<img src="{esc(photos[0])}" alt="" loading="lazy">{more}</button>')
    else:
        top = next((w["place"] for w in winners if w["place"] in PLACES), "")
        vis = f'<span class="hl-photo hl-empty"><canvas data-card-text="{top or "Wow"}" aria-hidden="true"></canvas></span>'
    wl = "".join(f'<li><span class="mono">{esc(w["place"])}</span>{esc(w["name"])}</li>' for w in winners[:6])
    kind = "Outside event" if h["kind"] == "outside" else "Club event"
    by = f'<a href="/c/{esc(h["club_slug"])}" data-bloom>{esc(h["club_name"])}</a>' if show_club else ""
    return f"""<article class="hl" data-reveal style="--club:{safe_accent(h['club_accent'])};--i:{i}">
  {vis}
  <div class="hl-body">
    <p class="hl-kick mono">{kind} · {when}{(' · ' + by) if by else ''}</p>
    <h3>{esc(h['title'])}</h3>
    {f'<ol class="hl-winners">{wl}</ol>' if wl else ''}
    {f'<p class="hl-cap">{esc(h["caption"])}</p>' if h['caption'] else ''}
  </div>
</article>"""


def moments_section(rows, title="Moments", sub="", show_club=True) -> str:
    if not rows:
        return ""
    return f"""<section class="moments" id="moments" data-branch data-label="{esc(title)}">
  <div class="moments-head" data-reveal><h2>{esc(title)}</h2><p class="mono">{esc(sub)}</p></div>
  <div class="moments-row">{''.join(hl_card(h, show_club, i) for i, h in enumerate(rows))}</div>
</section>"""


def club_event_counts(con) -> dict:
    nowiso = datetime.now().strftime("%Y-%m-%dT%H:%M")
    return {r[0]: r[1] for r in con.execute("select club_id, count(*) from events where starts_at>=? group by club_id", (nowiso,))}


def excerpt(text: str, n: int = 150) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[:n].rsplit(" ", 1)[0] + "…"


def card_reveal(cover: str, lines: list, desc: str) -> str:
    """The panel that slides up on hover: details over the photo, or over a bed of roses."""
    pic = '<span class="reveal-shade"></span>' if cover else '<canvas class="reveal-field" aria-hidden="true"></canvas>'
    meta = "".join(f'<span class="mono">{l}</span>' for l in lines if l)
    return f'<span class="card-reveal">{pic}<span class="reveal-text">{meta}<span class="reveal-desc">{esc(desc)}</span><span class="reveal-go mono">Open →</span></span></span>'


def club_card3d(c, n_events: int = 0) -> str:
    keys = c.keys()
    cover = c["cover"] if "cover" in keys else ""
    lines = [esc(c["category"]), f"{n_events} upcoming event{'s' if n_events != 1 else ''}" if n_events else "",
             "Taking applications" if c["join_open"] else ""]
    return f"""<a class="card3d{' has-img' if cover else ''}" href="/c/{esc(c['slug'])}" data-bloom style="--club:{safe_accent(c['accent'])}">
  <span class="card-vis" data-initials="{esc(initials(c['name']))}">{f'<img class="card-img" src="{esc(cover)}" alt="" loading="lazy" decoding="async">' if cover else f'<canvas data-card-text="{esc(initials(c['name']))}" aria-hidden="true"></canvas>'}
  {card_reveal(cover, lines, excerpt(c['about']) or c['tagline'])}</span>
  <span class="card-copy">
    <span class="card-kick mono">Club · {esc(c['category'])}</span>
    <strong>{esc(c['name'])}</strong>
    <span class="card-desc">{esc(c['tagline'] or 'A student club on campus.')}</span>
  </span>
</a>"""


def event_card3d(e) -> str:
    try:
        dt = datetime.fromisoformat(e["starts_at"])
        day, mon = dt.strftime("%d"), dt.strftime("%b · %H:%M")
    except Exception:
        day, mon = "··", ""
    soon = when_label(e["starts_at"])
    a, b = event_span(e["starts_at"], e["ends_at"])
    when = f"{a:%a %d %b · %H:%M}–{b:%H:%M}" if a else ""
    going = e["going"] if "going" in e.keys() else 0
    lines = [when, esc(e["venue"] or "Venue to be announced"),
             f"{going} going" + (f" of {e['capacity']}" if e["capacity"] else "") if going or e["capacity"] else ""]
    cover = e["cover"] or ""
    return f"""<a class="card3d{' has-img' if cover else ''}" href="/e/{e['id']}" data-bloom style="--club:{safe_accent(e['club_accent'])}">
  <span class="card-vis" data-initials="{day}">{f'<img class="card-img" src="{esc(cover)}" alt="" loading="lazy" decoding="async">' if cover else f'<canvas data-card-text="{day}" aria-hidden="true"></canvas>'}<span class="card-date mono">{esc(mon)}</span>{f'<span class="card-soon mono">{soon}</span>' if soon else ''}
  {card_reveal(cover, lines, excerpt(e["description"]))}</span>
  <span class="card-copy">
    <span class="card-kick mono">Event · {esc(e['kind'])}</span>
    <strong>{esc(e['title'])}</strong>
    <span class="card-desc">{esc(e['club_name'])}</span>
  </span>
</a>"""


def spiral(cards: list, title: str, empty: str) -> str:
    if not cards:
        return f'<section class="spiral-empty"><p class="mono">{esc(empty)}</p></section>'
    n = len(cards)
    return f"""<section class="spiral" data-spiral style="--n:{n}">
  <div class="spiral-stage">
    <p class="spiral-title" aria-hidden="true">{esc(title)}</p>
    <div class="helix">{''.join(cards)}</div>
    <div class="spiral-hud mono"><span class="spiral-idx">01 / {n:02d}</span><span class="spiral-track"><span class="spiral-bar"></span></span></div>
  </div>
</section>"""


def page_home(con):
    clubs = approved_clubs(con)
    events = upcoming_events(con, 40)
    counts = club_event_counts(con)
    mixed = []
    for i in range(max(len(clubs), len(events[:8]))):
        if i < len(clubs):
            mixed.append(club_card3d(clubs[i], counts.get(clubs[i]["id"], 0)))
        if i < len(events[:8]):
            mixed.append(event_card3d(events[i]))
    body = f"""
{hero("Welcome", "Clubbb · the campus portal", 0.36, tall=True, script="to the portal")}
{spiral(mixed, "Clubs & Events", "Nothing here yet. Register the first club.")}
{moments_section(hl_rows(con, "h.home_until >= ? and c.status='approved'", (now(),))[:12], "Moments", "Winners and memories from the last two weeks")}
<section class="doors" data-branch data-label="Enter">
  <a class="door" href="/clubs" data-bloom data-reveal>
    <span class="door-num mono">01</span>
    <span class="door-word">Clubs</span>
    <span class="door-desc">{len(clubs)} clubs, each with a page of its own. Find your people, see what they make, and apply to join.</span>
    <span class="door-go mono">Enter →</span>
  </a>
  <a class="door" href="/events" data-bloom data-reveal>
    <span class="door-num mono">02</span>
    <span class="door-word">Events</span>
    <span class="door-desc">{len(events)} upcoming hackathons, talks, workshops and meets, in one place. Save a seat in a few seconds.</span>
    <span class="door-go mono">Enter →</span>
  </a>
</section>
"""
    return 200, layout("Welcome", body, "", home=True)


def page_clubs(con, query):
    clubs = approved_clubs(con)
    counts = club_event_counts(con)
    body = hero("Clubs", "", 0.4, script="find your people") + spiral([club_card3d(c, counts.get(c["id"], 0)) for c in clubs], "Clubs", "No clubs yet.")
    return 200, layout("Clubs", body, "clubs")


def page_events(con, query):
    events = upcoming_events(con, 60)
    body = (hero("Events", "", 0.4, script="what is on")
            + spiral([event_card3d(e) for e in events], "Events", "No upcoming events.")
            + '<p class="after mono" data-reveal><a href="/calendar.ics">Subscribe to the calendar (.ics)</a></p>')
    return 200, layout("Events", body, "events")


def page_club(con, slug, notice=""):
    club = club_by_slug(con, slug)
    if not club:
        return 404, layout("Not found", page_hero("Not found") + '<p class="after mono">This club does not exist or is awaiting approval.</p>')
    events = con.execute(
        "select e.*, c.name as club_name, c.slug as club_slug, c.accent as club_accent "
        "from events e join clubs c on c.id=e.club_id where e.club_id=? and e.starts_at>=? "
        "order by e.starts_at",
        (club["id"], datetime.now().strftime("%Y-%m-%dT%H:%M")),
    ).fetchall()
    links = []
    if club["website"]:
        links.append(f'<a href="{esc(club["website"])}" rel="noopener">Website</a>')
    if club["instagram"]:
        handle = club["instagram"].lstrip("@")
        links.append(f'<a href="https://instagram.com/{esc(handle)}" rel="noopener">@{esc(handle)}</a>')
    if club["email"]:
        links.append(f'<a href="mailto:{esc(club["email"])}">Email</a>')
    join = ""
    if club["join_open"]:
        join = f"""
<details class="sheet" id="join" data-reveal data-branch data-label="Join"{' open' if notice else ''}>
  <summary class="mono">Apply to join →</summary>
  {notice}
  <form class="form" method="post" action="/c/{esc(club['slug'])}/apply">
    <label class="field"><span>Name</span><input name="name" required maxlength="80" autocomplete="name"></label>
    <label class="field"><span>Email</span><input name="email" type="email" required maxlength="120" autocomplete="email"></label>
    <label class="field"><span>Year</span><select name="year"><option>1st</option><option>2nd</option><option>3rd</option><option>4th</option></select></label>
    <label class="field"><span>Why this club?</span><textarea name="message" rows="3" maxlength="800"></textarea></label>
    {code_field()}
    <button class="btn" type="submit">Send application</button>
  </form>
</details>"""
    body = f"""
<div style="--club:{safe_accent(club['accent'])}">
{hero(club['name'], club['category'], 0.36, cue="")}
{f'<figure class="cover-wide" data-reveal><img src="{esc(club["cover"])}" alt="" decoding="async"></figure>' if club['cover'] else ''}
<section class="club-info" data-reveal data-branch data-label="About">
  <p class="club-tag">{esc(club['tagline'] or '')}</p>

  <div class="prose">{paragraphs(club['about'])}</div>
  <p class="links mono">{' · '.join(links)}</p>
</section>
{spiral([event_card3d(e) for e in events], "Events", "No upcoming events from this club.") if events else ''}
{moments_section(hl_rows(con, "h.club_id=? and h.kind='event'", (club["id"],)), "Memories", "Past events and their winners", show_club=False)}
{join}
</div>"""
    return 200, layout(club["name"], body, "clubs", description=club["tagline"] or "")


def page_event(con, eid, notice=""):
    ev = event_by_id(con, eid)
    if not ev or ev["club_name"] is None:
        return 404, layout("Not found", page_hero("Not found"))
    count = rsvp_count(con, eid)
    cap = ev["capacity"] or 0
    capacity_line = f"{count}/{cap} seats" if cap else f"{count} going"
    full = bool(cap and count >= cap)
    ends = (' – ' + fmt_dt(ev['ends_at'])[-5:]) if ev['ends_at'] and ev['ends_at'] != ev['starts_at'] else ''
    form = '<p class="notice">This event is full.</p>' if full else f'''
  <form class="form" method="post" action="/e/{eid}/rsvp">
    <label class="field"><span>Name</span><input name="name" required maxlength="80" autocomplete="name"></label>
    <label class="field"><span>Email</span><input name="email" type="email" required maxlength="120" autocomplete="email"></label>
    {code_field()}
    <button class="btn" type="submit">Save my seat</button>
  </form>'''
    clashes = [c for c in find_clashes(con, ev["starts_at"], ev["ends_at"], ev["venue"], exclude_id=eid)]
    also = ""
    if clashes:
        also = '<section class="club-info also" data-reveal data-branch data-label="Same time"><p class="mono">Also happening at the same time</p><ul class="also-list">' + "".join(
            f'<li><a href="/e/{c["id"]}" data-bloom>{esc(c["title"])}</a> <span class="muted">· {esc(c["club"])} · {fmt_dt(c["starts_at"])}</span></li>'
            for c in clashes[:6]) + "</ul></section>"
    remind_email = f"""
    <form class="form remind-form" method="post" action="/e/{eid}/remind">
      <label class="field"><span>Email me a reminder</span><input name="email" type="email" required maxlength="120" autocomplete="email" placeholder="you@college.edu"></label>
      {code_field()}
      <button class="btn btn-ghost" type="submit">Remind me</button>
    </form>
    <p class="muted small">One email a day before, one an hour before. Every email has a one-click stop link.</p>""" if EMAIL_ON else ""
    upcoming = (parse_dt(ev["starts_at"]) or datetime.min) > datetime.now()
    remind = f"""
<section class="sheet open remind" id="remind" data-reveal data-branch data-label="Reminders">
  <p class="mono sheet-h">Reminders</p>
  <div class="remind-row">
    <a class="btn btn-ghost" href="{esc(google_calendar_link(ev))}" target="_blank" rel="noopener">Google Calendar</a>
    <a class="btn btn-ghost" href="/e/{eid}.ics">Apple / Outlook (.ics)</a>
    <button class="btn btn-ghost" type="button" data-remind data-id="{eid}" data-title="{esc(ev['title'])}" data-start="{esc(ev['starts_at'])}" data-venue="{esc(ev['venue'])}">Remind me on this site</button>
  </div>
  <p class="muted small">Calendar files come with alerts a day and an hour before.</p>
  {remind_email}
</section>""" if upcoming else ""
    body = f"""
<div style="--club:{safe_accent(ev['club_accent'])}">
{page_hero(ev['title'], ev['kind'])}
{f'<figure class="cover-wide" data-reveal><img src="{esc(ev["cover"])}" alt="" decoding="async"></figure>' if ev['cover'] else ''}
<section class="club-info" data-reveal data-branch data-label="Details">
  <p class="meta mono">{fmt_dt(ev['starts_at'])}{ends} · {esc(ev['venue'] or 'Venue TBA')} · {capacity_line}</p>
  <p class="mono"><a href="/c/{esc(ev['club_slug'])}" data-bloom>{esc(ev['club_name'])} →</a></p>

  <div class="prose">{paragraphs(ev['description'])}</div>
  {f'<p class="mono"><a href="{esc(ev["link"])}" rel="noopener">External registration →</a></p>' if ev['link'] else ''}
</section>
{moments_section(hl_rows(con, "h.event_id=?", (eid,)), "Moments", "From this event", show_club=False)}
{also}
<section class="sheet open" id="rsvp" data-reveal data-branch data-label="RSVP">
  <p class="mono sheet-h">RSVP</p>
  {notice}{form}
</section>
{remind}
</div>"""
    return 200, layout(ev["title"], body, "events")


def page_register(con, error=""):
    body = f"""
{page_hero("Register", "How to register", "start one")}
<section class="steps" data-reveal data-branch data-label="Steps">
  <ol>
    <li><span class="mono">01</span><strong>Fill the form</strong><p>Name, category, one line about the club, a club email and a password. You need the campus code from the posters or your class group.</p></li>
    <li><span class="mono">02</span><strong>Log in any time</strong><p>Use Club login with your club email and password. You also get a one-time backup link; keep it safe.</p></li>
    <li><span class="mono">03</span><strong>Wait for approval</strong><p>An administrator checks the club is real, then it joins the spiral.</p></li>
    <li><span class="mono">04</span><strong>Post events</strong><p>From the manage link, publish events and read applications and RSVPs.</p></li>
  </ol>
</section>
<section class="sheet open" data-reveal data-branch data-label="Register">
{error}
<form class="form" method="post" action="/register">
  <label class="field"><span>Club name</span><input name="name" required maxlength="80" placeholder="Robotics Club"></label>
  <label class="field"><span>Category</span><select name="category">{''.join(f'<option>{c}</option>' for c in CATEGORIES)}</select></label>
  <label class="field"><span>Tagline</span><input name="tagline" maxlength="120" placeholder="One line students will remember"></label>
  <label class="field"><span>About</span><textarea name="about" rows="5" maxlength="2000" placeholder="Two short paragraphs. Leave a blank line between them."></textarea></label>
  <label class="field"><span>Club colour</span><input name="accent" type="color" value="#ff1400"></label>
  <label class="field"><span>Club email (you log in with this)</span><input name="email" type="email" required maxlength="120" placeholder="club@example.com" autocomplete="email"></label>
  <div class="grid two">
    <label class="field"><span>Password (8+ characters)</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
    <label class="field"><span>Repeat password</span><input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
  </div>
  <label class="field"><span>Instagram</span><input name="instagram" maxlength="60" placeholder="@club"></label>
  <label class="field"><span>Website</span><input name="website" type="url" maxlength="160" placeholder="https://example.com"></label>
  <input type="hidden" name="banner" value="solid">
  <label class="check"><input type="checkbox" name="join_open" value="1" checked> Show an application form on the page</label>
  {code_field()}
  <button class="btn" type="submit">Create club page</button>
</form>
</section>
"""
    return 200, layout("How to register", body, "register")


CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "hello@clubbb.example")


def page_contact(con):
    body = f"""
{page_hero("Contact", "Contact us", "say hello")}
<section class="steps" data-reveal data-branch data-label="Steps">
  <ol>
    <li><span class="mono">01</span><strong>Write to us</strong><p><a href="mailto:{esc(CONTACT_EMAIL)}">{esc(CONTACT_EMAIL)}</a></p></li>
    <li><span class="mono">02</span><strong>Lost your manage link?</strong><p>Email from the club address on your page and we will issue a new one.</p></li>
    <li><span class="mono">03</span><strong>Something wrong on a page?</strong><p>Tell us the address of the page and what needs to change.</p></li>
  </ol>
</section>
"""
    return 200, layout("Contact", body, "contact")


def page_registered(con, club, token):
    body = f"""
<section class="hero compact">
  <p class="eyebrow">Saved</p>
  <h1>{esc(club['name'])} is registered.</h1>
  <p class="lede">It is pending administrator approval. You are logged in on this device. Next time, use
     <a href="/login">Club login</a> with {esc(club['email'])} and your password.</p>
</section>
<section class="card">
  <p class="mono muted">Backup link (works if you forget the password; shown only once)</p>
  <p class="copyline"><code id="manage-url">/manage/{esc(token)}</code>
     <button class="btn btn-ghost" type="button" data-copy="/manage/{esc(token)}">Copy</button></p>
  <p class="muted">Open it on this device now so you do not lose it.</p>
  <p><a class="btn" href="/club">Open dashboard</a></p>
</section>
"""
    return 201, layout("Registered", body)


def page_manage(con, token, notice="", error="", draft=None, clashes=None):
    club = club_by_token(con, token)
    if not club:
        return 404, layout("Not found", '<h1>Invalid manage link</h1>')
    apps = con.execute("select count(*) from applications where club_id=?", (club["id"],)).fetchone()[0]
    evs = con.execute("select count(*) from events where club_id=?", (club["id"],)).fetchone()[0]
    status = (
        '<p class="notice ok">Live in the directory.</p>'
        if club["status"] == "approved"
        else '<p class="notice">Pending approval. The page is not public yet.</p>'
    )
    d = draft or {}
    v = lambda k, default="": esc(d.get(k, default))
    mine = con.execute(
        "select e.*, (select count(*) from reminders r where r.event_id=e.id) as reminders, "
        "(select count(*) from rsvps r where r.event_id=e.id) as going from events e "
        "where e.club_id=? and e.starts_at>=? order by e.starts_at",
        (club["id"], datetime.now().strftime("%Y-%m-%dT%H:%M"))).fetchall()
    rows = []
    for e in mine:
        cl = find_clashes(con, e["starts_at"], e["ends_at"], e["venue"], exclude_id=e["id"], include_club=club["id"])
        mark = ""
        if cl:
            hard = [c for c in cl if c["same_venue"]]
            mark = (f'<span class="tag hard">venue clash: {esc(hard[0]["title"])}</span>' if hard
                    else f'<span class="tag">overlaps {len(cl)} event{"s" if len(cl) != 1 else ""}</span>')
        rows.append(f'<tr><td><a href="/e/{e["id"]}">{esc(e["title"])}</a> {mark}</td><td class="mono">{fmt_dt(e["starts_at"])}</td>'
                    f'<td>{esc(e["venue"])}</td><td class="mono">{e["going"]}</td><td class="mono">{e["reminders"]}</td></tr>')
    own = ('<div class="tablewrap"><table><thead><tr><th>Event</th><th>When</th><th>Venue</th><th>RSVPs</th><th>Reminders</th></tr></thead><tbody>'
           + "".join(rows) + "</tbody></table></div>") if rows else '<p class="muted">No upcoming events yet.</p>'
    past = con.execute("select id,title,starts_at from events where club_id=? and starts_at<? order by starts_at desc limit 40",
                       (club["id"], datetime.now().strftime("%Y-%m-%dT%H:%M"))).fetchall()
    hls = con.execute("select * from highlights where club_id=? order by created_at desc", (club["id"],)).fetchall()
    mine_hl = ""
    if hls:
        mine_hl = '<div class="tablewrap"><table><thead><tr><th>Shared</th><th>On home page until</th><th>Photos</th><th></th></tr></thead><tbody>' + "".join(
            f'<tr><td>{esc(h["title"])} <span class="tag">{"outside" if h["kind"] == "outside" else "club event"}</span></td>'
            f'<td class="mono">{fmt_dt(h["home_until"], with_time=False)}</td><td class="mono">{len(json.loads(h["photos"] or "[]"))}</td>'
            f'<td><form method="post" action="{base_url(token)}/highlight/{h["id"]}/delete"><button class="btn btn-ghost" type="submit">Delete</button></form></td></tr>'
            for h in hls) + "</tbody></table></div>"
    confirm = ""
    if clashes:
        confirm = (clash_html(clashes) + '<label class="check"><input type="checkbox" name="confirm_clash" value="1"> '
                   'I have seen the clash and still want to publish</label>'
                   '<p class="muted small">Choose the cover image again if you picked one.</p>')
    body = f"""
<section class="hero compact">
  <p class="eyebrow">Dashboard</p>
  <h1 data-garden="{esc(club['name'])}">{esc(club['name'])}</h1>
  <p class="lede">Edit the page, add events, and read applications. {evs} events · {apps} applications.</p>
  {status}{notice}{error}
</section>

<section class="section">
  <h2>Page</h2>
  <form class="form card" method="post" action="{base_url(token)}/profile" enctype="multipart/form-data">
    <div class="grid two">
      <label class="field"><span>Name</span><input name="name" value="{esc(club['name'])}" required maxlength="80"></label>
      <label class="field"><span>Category</span>
        <select name="category">{''.join(f'<option{" selected" if c == club["category"] else ""}>{c}</option>' for c in CATEGORIES)}</select></label>
    </div>
    <label class="field"><span>Tagline</span><input name="tagline" value="{esc(club['tagline'])}" maxlength="120"></label>
    <label class="field"><span>About</span><textarea name="about" rows="7" maxlength="2000">{esc(club['about'])}</textarea></label>
    <div class="grid two">
      <label class="field"><span>Accent colour</span><input name="accent" type="color" value="{safe_accent(club['accent'])}"></label>
      <label class="field"><span>Page style</span>
        <select name="banner">{''.join(f'<option value="{b}"{" selected" if b == club["banner"] else ""}>{b}</option>' for b in BANNERS)}</select></label>
      <label class="field"><span>Email</span><input name="email" value="{esc(club['email'])}" maxlength="120"></label>
      <label class="field"><span>Instagram</span><input name="instagram" value="{esc(club['instagram'])}" maxlength="60"></label>
      <label class="field"><span>Website</span><input name="website" value="{esc(club['website'])}" maxlength="160"></label>
    </div>
    <label class="field"><span>Club photo, landscape works best (any size; big photos are shrunk before upload)</span><input name="cover" type="file" accept="image/jpeg,image/png,image/webp" data-shrink></label>
    {f'<p class="muted small">Current photo: <a href="{esc(club["cover"])}">view</a>. Upload a new one to replace it.</p>' if club["cover"] else '<p class="muted small">Shown when someone hovers your card, and on your club page.</p>'}
    <label class="check"><input type="checkbox" name="join_open" value="1" {"checked" if club["join_open"] else ""}> Accept applications</label>
    <button class="btn" type="submit">Save page</button>
  </form>
</section>

<section class="section">
  <h2>Your upcoming events</h2>
  {own}
</section>

<section class="section" id="add-event">
  <h2>Add an event</h2>
  <form class="form card" method="post" action="{base_url(token)}/event" enctype="multipart/form-data" data-clash-check>
    <div class="grid two">
      <label class="field"><span>Title</span><input name="title" required maxlength="120" value="{v('title')}"></label>
      <label class="field"><span>Kind</span><select name="kind">{''.join(f'<option{" selected" if k == d.get("kind") else ""}>{k}</option>' for k in KINDS)}</select></label>
      <label class="field"><span>Starts</span><input name="starts_at" type="datetime-local" required value="{v('starts_at')}"></label>
      <label class="field"><span>Ends</span><input name="ends_at" type="datetime-local" value="{v('ends_at')}"></label>
      <label class="field"><span>Venue</span><input name="venue" maxlength="120" value="{v('venue')}"></label>
      <label class="field"><span>Capacity (0 = unlimited)</span><input name="capacity" type="number" min="0" value="{v('capacity', '0')}"></label>
    </div>
    <div class="clash-live" aria-live="polite"></div>
    {confirm}
    <label class="field"><span>Description</span><textarea name="description" rows="4" maxlength="1500">{v('description')}</textarea></label>
    <label class="field"><span>Registration link</span><input name="link" maxlength="200" placeholder="https://" value="{v('link')}"></label>
    <label class="field"><span>Cover photo, landscape works best (any size; big photos are shrunk before upload)</span><input name="cover" type="file" accept="image/jpeg,image/png,image/webp" data-shrink></label>
    <p class="muted small">The cover is shown at the top of the event page.</p>
    <button class="btn" type="submit">Publish event</button>
  </form>
</section>

<section class="section" id="highlights">
  <h2>Share moments and winners</h2>
  <form class="form card" method="post" action="{base_url(token)}/highlight" enctype="multipart/form-data">
    <label class="field"><span>Which event?</span>
      <select name="event_id">{''.join(f'<option value="{e["id"]}">{esc(e["title"])} · {fmt_dt(e["starts_at"], with_time=False)}</option>' for e in past)}
        <option value="outside">An outside event (not run by our club)</option></select></label>
    <label class="field"><span>Outside event name (only for outside events)</span><input name="outside_title" maxlength="120" placeholder="e.g. Inter-college Robo Race 2026"></label>
    <div class="grid two">
      <label class="field"><span>1st place</span><input name="w1" maxlength="120" placeholder="Team or names"></label>
      <label class="field"><span>2nd place</span><input name="w2" maxlength="120"></label>
      <label class="field"><span>3rd place</span><input name="w3" maxlength="120"></label>
      <label class="field"><span>Other mentions</span><input name="w4" maxlength="160" placeholder="e.g. Best design: Team Loop"></label>
    </div>
    <label class="field"><span>Caption</span><textarea name="caption" rows="2" maxlength="300" placeholder="One or two lines about the day"></textarea></label>
    <label class="field"><span>Photos (up to 8; big photos are shrunk before upload)</span><input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple data-shrink></label>
    <p class="muted small">Your own events: on the home page for two weeks, then kept on your club page. Outside events: on the home page for one week.</p>
    <button class="btn" type="submit">Share</button>
  </form>
  {mine_hl}
</section>

<section class="section" id="login">
  <h2>Club login</h2>
  <form class="form card" method="post" action="{base_url(token)}/password">
    <p class="muted small">{"Change the password for <strong>" + esc(club["email"]) + "</strong>." if club["pw_hash"] else "Set a password so you can log in at <a href='/login'>Club login</a> with <strong>" + (esc(club["email"]) or "your club email") + "</strong>."}</p>
    {'<label class="field"><span>Current password</span><input name="current" type="password" required autocomplete="current-password"></label>' if club["pw_hash"] and isinstance(token, int) else ''}
    <div class="grid two">
      <label class="field"><span>New password (8+ characters)</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label class="field"><span>Repeat it</span><input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
    </div>
    <button class="btn" type="submit">Save password</button>
  </form>
  {'<form method="post" action="/logout"><button class="btn btn-ghost" type="submit">Log out</button></form>' if isinstance(token, int) else ''}
</section>

<section class="section">
  <div class="section-head"><h2>People</h2><a class="mono" href="{base_url(token)}/people">Applications and RSVPs →</a></div>
</section>
"""
    return 200, layout("Dashboard", body)


def page_people(con, token):
    club = club_by_token(con, token)
    if not club:
        return 404, layout("Not found", '<h1>Invalid manage link</h1>')
    apps = con.execute("select * from applications where club_id=? order by created_at desc", (club["id"],)).fetchall()
    rsvps = con.execute(
        "select r.*, e.title from rsvps r join events e on e.id=r.event_id "
        "where e.club_id=? order by r.created_at desc", (club["id"],)
    ).fetchall()
    app_rows = "".join(
        f"<tr><td>{esc(a['name'])}</td><td>{esc(a['email'])}</td><td>{esc(a['year'])}</td>"
        f"<td>{esc(a['message'])}</td><td class=mono>{esc(a['created_at'][:10])}</td></tr>"
        for a in apps
    ) or '<tr><td colspan="5" class="muted">No applications yet.</td></tr>'
    rsvp_rows = "".join(
        f"<tr><td>{esc(r['title'])}</td><td>{esc(r['name'])}</td><td>{esc(r['email'])}</td>"
        f"<td class=mono>{esc(r['created_at'][:10])}</td></tr>"
        for r in rsvps
    ) or '<tr><td colspan="4" class="muted">No RSVPs yet.</td></tr>'
    body = f"""
<p class="crumb"><a href="{base_url(token)}">Dashboard</a> / People</p>
<h1>{esc(club['name'])} · people</h1>
<section class="section"><h2>Applications</h2>
<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Year</th><th>Message</th><th>Date</th></tr></thead>
<tbody>{app_rows}</tbody></table></div></section>
<section class="section"><h2>RSVPs</h2>
<div class="tablewrap"><table><thead><tr><th>Event</th><th>Name</th><th>Email</th><th>Date</th></tr></thead>
<tbody>{rsvp_rows}</tbody></table></div></section>
"""
    return 200, layout("People", body)


def page_admin(con, key, notice=""):
    if not secrets.compare_digest((key or "").encode(), admin_key().encode()):
        return 403, layout("Admin", '<h1>Admin</h1><p class="empty">Add <code>?key=…</code> with the admin key.</p>')
    pending = con.execute("select * from clubs where status='pending' order by created_at").fetchall()
    live = con.execute("select count(*) from clubs where status='approved'").fetchone()[0]
    rows = "".join(
        f"<tr><td><strong>{esc(c['name'])}</strong><br><span class=muted>{esc(c['category'])} · {esc(c['email'])}</span></td>"
        f"<td>{esc(c['tagline'])}</td><td class=mono>{esc(c['created_at'][:10])}</td>"
        f'<td><form method="post" action="/admin/approve"><input type="hidden" name="key" value="{esc(key)}">'
        f'<input type="hidden" name="id" value="{c["id"]}"><button class="btn" type="submit">Approve</button></form></td></tr>'
        for c in pending
    ) or '<tr><td colspan="4" class="muted">Nothing pending.</td></tr>'
    body = f"""
<p class="eyebrow">Admin</p>
<h1>Approvals</h1>
<p class="lede">{len(pending)} pending · {live} live.</p>
{notice}
<section class="card">
  <p class="mono muted">Recent highlights (delete anything that should not be there)</p>
  {''.join(f'<form class="copyline" method="post" action="/admin/highlight/{h["id"]}/delete"><input type="hidden" name="key" value="{esc(key)}"><span>{esc(h["title"])} · {esc(h["club_name"])} · {fmt_dt(h["created_at"], with_time=False)}</span><button class="btn btn-ghost" type="submit">Delete</button></form>' for h in hl_rows(con, "1=1")[:30]) or '<p class="muted">Nothing shared yet.</p>'}
</section>
<section class="card">
  <p class="mono muted">Campus code (students type it once to RSVP, apply, set reminders or register a club)</p>
  <form class="copyline" method="post" action="/admin/code">
    <input type="hidden" name="key" value="{esc(key)}">
    <input name="code" value="{esc(campus_code())}" maxlength="30" style="max-width:240px">
    <button class="btn btn-ghost" type="submit">Change code</button>
  </form>
  <p class="muted small">Change it each semester. Everyone who had the old one types the new one once.</p>
</section>
<div class="tablewrap"><table><thead><tr><th>Club</th><th>Tagline</th><th>Registered</th><th></th></tr></thead>
<tbody>{rows}</tbody></table></div>
"""
    return 200, layout("Admin", body)


# --------------------------------------------------------------------------
# POST handlers
# --------------------------------------------------------------------------
def read_form(handler):
    ctype = handler.headers.get("Content-Type", "")
    length = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(length)
    if "multipart/form-data" not in ctype:
        parsed = urllib.parse.parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True)
        return {k: v[0] for k, v in parsed.items()}, {}
    m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', ctype)
    if not m:
        return {}, {}
    boundary = (m.group(1) or m.group(2)).strip().encode()
    fields, files = {}, {}
    for part in raw.split(b"--" + boundary):
        # trim exactly the CRLF framing, never bytes that belong to an uploaded file
        if part.startswith(b"\r\n"):
            part = part[2:]
        if part.endswith(b"\r\n"):
            part = part[:-2]
        if not part or part.startswith(b"--") or b"\r\n\r\n" not in part:
            continue
        head, data = part.split(b"\r\n\r\n", 1)
        head_s = head.decode("utf-8", "replace")
        nm = re.search(r'name="([^"]+)"', head_s)
        if not nm:
            continue
        fn = re.search(r'filename="([^"]*)"', head_s)
        if fn and fn.group(1):
            ct = re.search(r"Content-Type:\s*([^\r\n]+)", head_s, re.I)
            item = (fn.group(1), (ct.group(1) if ct else "").strip(), data)
            files.setdefault(nm.group(1), item)
            files.setdefault(nm.group(1) + "[]", []).append(item)
        else:
            fields[nm.group(1)] = data.decode("utf-8", "replace")
    return fields, files


def to_int(value, default=0) -> int:
    try:
        return max(0, int(str(value or default).strip()))
    except ValueError:
        return default


def clean(value: str, limit: int = 500) -> str:
    return (value or "").strip()[:limit]


def handle_register(con, form):
    if not student_ok(con, form):
        return 403, page_register(con, CODE_ERR)[1]
    name = clean(form.get("name", ""), 80)
    if len(name) < 2:
        return 400, page_register(con, '<p class="notice err">A club name is required.</p>')[1]
    email = clean(form.get("email", ""), 120)
    pw = form.get("password", "")
    if "@" not in email:
        return 400, page_register(con, '<p class="notice err">A club email is required: it is how you log in.</p>')[1]
    if len(pw) < 8 or pw != form.get("password2", ""):
        return 400, page_register(con, '<p class="notice err">The password must be 8+ characters and both boxes must match.</p>')[1]
    category = form.get("category", "technical")
    if category not in CATEGORIES:
        category = "technical"
    token = secrets.token_urlsafe(18)
    slug = unique_slug(con, name)
    con.execute(
        "insert into clubs(slug,name,category,tagline,about,accent,banner,email,instagram,website,join_open,status,manage_hash,created_at) "
        "values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            slug, name, category, clean(form.get("tagline", ""), 120),
            clean(form.get("about", ""), 2000), safe_accent(form.get("accent", "")),
            form.get("banner") if form.get("banner") in BANNERS else "solid",
            clean(form.get("email", ""), 120), clean(form.get("instagram", ""), 60),
            clean(form.get("website", ""), 160), 1 if form.get("join_open") else 0,
            "pending", token_hash(token), now(),
        ),
    )
    con.execute("update clubs set pw_hash=?, email=? where slug=?", (hash_password(pw), email.lower(), slug))
    con.commit()
    club = con.execute("select * from clubs where slug=?", (slug,)).fetchone()
    login_club(club)
    return page_registered(con, club, token)


def handle_profile(con, token, form, files=None):
    club = club_by_token(con, token)
    if not club:
        return 404, layout("Not found", "<h1>Invalid manage link</h1>")
    con.execute(
        "update clubs set name=?,category=?,tagline=?,about=?,accent=?,banner=?,email=?,instagram=?,website=?,join_open=? where id=?",
        (
            clean(form.get("name", club["name"]), 80), form.get("category") if form.get("category") in CATEGORIES else club["category"],
            clean(form.get("tagline", ""), 120), clean(form.get("about", ""), 2000),
            safe_accent(form.get("accent", "")), form.get("banner") if form.get("banner") in BANNERS else club["banner"],
            clean(form.get("email", ""), 120), clean(form.get("instagram", ""), 60),
            clean(form.get("website", ""), 160), 1 if form.get("join_open") else 0, club["id"],
        ),
    )
    cover = save_upload(files or {})
    if cover:
        con.execute("update clubs set cover=? where id=?", (cover, club["id"]))
    con.commit()
    return page_manage(con, token, notice='<p class="notice ok">Page saved.</p>')


def handle_event(con, token, form, files=None):
    club = club_by_token(con, token)
    if not club:
        return 404, layout("Not found", "<h1>Invalid manage link</h1>")
    title = clean(form.get("title", ""), 120)
    starts = clean(form.get("starts_at", ""), 20)
    if not title or not starts:
        return 400, page_manage(con, token, error='<p class="notice err">A title and start time are required.</p>')[1]
    kind = form.get("kind") if form.get("kind") in KINDS else "meetup"
    ends = clean(form.get("ends_at", ""), 20) or starts
    if not parse_dt(starts) or (form.get("ends_at") and not parse_dt(ends)):
        return 400, page_manage(con, token, error='<p class="notice err">That date and time could not be read.</p>', draft=form)[1]
    if parse_dt(ends) < parse_dt(starts):
        return 400, page_manage(con, token, error='<p class="notice err">The event ends before it starts.</p>', draft=form)[1]
    venue = clean(form.get("venue", ""), 120)
    clashes = find_clashes(con, starts, ends, venue, include_club=club["id"])
    if clashes and not form.get("confirm_clash"):
        hard = any(c["same_venue"] for c in clashes)
        msg = ('<p class="notice err">Not published yet: the venue is already booked at that time.</p>' if hard
               else '<p class="notice">Not published yet: other events run at the same time.</p>')
        return 409, page_manage(con, token, error=msg, draft=form, clashes=clashes)[1]
    cover = save_upload(files or {})
    con.execute(
        "insert into events(club_id,title,kind,starts_at,ends_at,venue,description,link,capacity,cover,created_at) values(?,?,?,?,?,?,?,?,?,?,?)",
        (club["id"], title, kind, starts, ends or starts, clean(form.get("venue", ""), 120),
         clean(form.get("description", ""), 1500), clean(form.get("link", ""), 200),
         to_int(form.get("capacity")), cover, now()),
    )
    con.commit()
    note = f'<p class="notice">Published despite {len(clashes)} overlapping event{"s" if len(clashes) != 1 else ""}.</p>' if clashes else ""
    return page_manage(con, token, notice='<p class="notice ok">Event published.</p>' + note)


def handle_apply(con, slug, form):
    club = club_by_slug(con, slug)
    if not club:
        return 404, layout("Not found", "<h1>Club not found</h1>")
    if not student_ok(con, form):
        return 403, page_club(con, slug, CODE_ERR)[1]
    name, email = clean(form.get("name", ""), 80), clean(form.get("email", ""), 120)
    if not name or "@" not in email:
        return 400, page_club(con, slug, '<p class="notice err">Name and a valid email are required.</p>')[1]
    con.execute(
        "insert into applications(club_id,name,email,year,message,created_at) values(?,?,?,?,?,?)",
        (club["id"], name, email, clean(form.get("year", ""), 10), clean(form.get("message", ""), 800), now()),
    )
    con.commit()
    return page_club(con, slug, '<p class="notice ok">Application sent. The club will reach out by email.</p>')


def handle_rsvp(con, eid, form):
    ev = event_by_id(con, eid)
    if not ev:
        return 404, layout("Not found", "<h1>Event not found</h1>")
    if not student_ok(con, form):
        return 403, page_event(con, eid, CODE_ERR)[1]
    name, email = clean(form.get("name", ""), 80), clean(form.get("email", ""), 120)
    if not name or "@" not in email:
        return 400, page_event(con, eid, '<p class="notice err">Name and a valid email are required.</p>')[1]
    if ev["capacity"] and rsvp_count(con, eid) >= ev["capacity"]:
        return 400, page_event(con, eid, '<p class="notice err">This event just filled up.</p>')[1]
    try:
        con.execute("insert into rsvps(event_id,name,email,created_at) values(?,?,?,?)", (eid, name, email, now()))
        add_reminder(con, eid, email)
        con.commit()
        msg = ('<p class="notice ok">You are on the list. We will email a reminder a day and an hour before.</p>' if EMAIL_ON
               else '<p class="notice ok">You are on the list. Add it to your calendar below so you get a reminder.</p>')
    except sqlite3.IntegrityError:
        msg = '<p class="notice">That email is already on the list.</p>'
    return page_event(con, eid, msg)


def add_reminder(con, eid, email):
    try:
        con.execute("insert into reminders(event_id,email,token,created_at) values(?,?,?,?)",
                    (eid, email.lower(), secrets.token_urlsafe(16), now()))
        return True
    except sqlite3.IntegrityError:
        return False


def handle_remind(con, eid, form):
    ev = event_by_id(con, eid)
    if not ev:
        return 404, layout("Not found", page_hero("Not found"))
    if not student_ok(con, form):
        return 403, page_event(con, eid, CODE_ERR)[1]
    email = clean(form.get("email", ""), 120)
    if not EMAIL_ON:
        return 400, page_event(con, eid, '<p class="notice">Email reminders are not switched on here. Use a calendar button below.</p>')[1]
    if "@" not in email or "." not in email.split("@")[-1]:
        return 400, page_event(con, eid, '<p class="notice err">That email does not look right.</p>')[1]
    added = add_reminder(con, eid, email)
    con.commit()
    msg = ('<p class="notice ok">Done. You will get an email a day and an hour before.</p>' if added
           else '<p class="notice">That email already has a reminder for this event.</p>')
    return page_event(con, eid, msg)


def page_stop(con, token):
    r = con.execute("select r.*, e.title from reminders r join events e on e.id=r.event_id where r.token=?", (token,)).fetchone()
    if r:
        con.execute("delete from reminders where id=?", (r["id"],))
        con.commit()
        text = f"No more reminders for “{esc(r['title'])}”."
    else:
        text = "That reminder was already removed."
    return 200, layout("Reminder stopped", page_hero("Stopped") + f'<p class="after mono">{text}</p>')


def handle_highlight(con, token, form, files):
    club = club_by_token(con, token)
    if not club:
        return 404, layout("Not found", page_hero("Not found"))
    choice = form.get("event_id", "")
    if choice == "outside":
        kind, event_id, title = "outside", None, clean(form.get("outside_title", ""), 120)
        if not title:
            return 400, page_manage(con, token, error='<p class="notice err">Give the outside event a name.</p>')[1]
    else:
        ev = con.execute("select * from events where id=? and club_id=?", (to_int(choice), club["id"])).fetchone()
        if not ev:
            return 400, page_manage(con, token, error='<p class="notice err">Pick one of your events.</p>')[1]
        if ev["starts_at"] > datetime.now().strftime("%Y-%m-%dT%H:%M"):
            return 400, page_manage(con, token, error='<p class="notice err">That event has not happened yet.</p>')[1]
        kind, event_id, title = "event", ev["id"], ev["title"]
    winners = [{"place": PLACES[i], "name": clean(form.get(f"w{i+1}", ""), 120)} for i in range(3) if clean(form.get(f"w{i+1}", ""), 120)]
    if clean(form.get("w4", ""), 160):
        winners.append({"place": "Also", "name": clean(form.get("w4", ""), 160)})
    photos = save_uploads(files, "photos", 8)
    caption = clean(form.get("caption", ""), 300)
    if not photos and not winners and not caption:
        return 400, page_manage(con, token, error='<p class="notice err">Add at least a photo, a winner or a caption.</p>')[1]
    until = (datetime.now() + timedelta(days=HOME_DAYS[kind])).replace(microsecond=0).isoformat()
    con.execute("insert into highlights(club_id,event_id,kind,title,caption,winners,photos,created_at,home_until) values(?,?,?,?,?,?,?,?,?)",
                (club["id"], event_id, kind, title, caption, json.dumps(winners), json.dumps(photos), now(), until))
    con.commit()
    where = "on the home page for a week" if kind == "outside" else "on the home page for two weeks and on your club page"
    return page_manage(con, token, notice=f'<p class="notice ok">Shared. It shows {where}.</p>')


def delete_highlight(con, hid, club_id=None):
    h = con.execute("select * from highlights where id=?", (hid,)).fetchone()
    if not h or (club_id is not None and h["club_id"] != club_id):
        return False
    for url in json.loads(h["photos"] or "[]"):
        f = (UPLOADS / url.rsplit("/", 1)[-1]).resolve()
        if str(f).startswith(str(UPLOADS.resolve())) and f.is_file():
            f.unlink()
    con.execute("delete from highlights where id=?", (hid,))
    con.commit()
    return True


def page_login(con, error="", email=""):
    body = f"""
{page_hero("Login", "Club login", "organisers")}
<section class="sheet open" data-reveal data-branch data-label="Login">
  <p class="mono sheet-h">For club organisers</p>
  {error}
  <form class="form" method="post" action="/login">
    <label class="field"><span>Club email</span><input name="email" type="email" required maxlength="120" autocomplete="username" value="{esc(email)}"></label>
    <label class="field"><span>Password</span><input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn" type="submit">Log in</button>
  </form>
  <p class="muted small">No club yet? <a href="/register">Register one</a>. Forgot the password? Open your backup link and set a new one, or ask the admin.</p>
</section>"""
    return 200, layout("Club login", body, "login")


def handle_login(con, form, ip):
    if too_many_fails(ip):
        return 429, page_login(con, '<p class="notice err">Too many tries. Wait ten minutes.</p>')[1], None
    email = clean(form.get("email", ""), 120).lower()
    pw = form.get("password", "")
    for club in con.execute("select * from clubs where lower(email)=? and pw_hash!=''", (email,)):
        if check_password(pw, club["pw_hash"]):
            login_club(club)
            return 303, "", "/club"
    _fails.setdefault(ip, []).append(time.time())
    return 401, page_login(con, '<p class="notice err">That email and password do not match a club.</p>', email)[1], None


def handle_password(con, token, form):
    club = club_by_token(con, token)
    if not club:
        return 404, layout("Not found", page_hero("Not found"))
    if isinstance(token, int) and club["pw_hash"] and not check_password(form.get("current", ""), club["pw_hash"]):
        return 403, page_manage(con, token, error='<p class="notice err">The current password is not right.</p>')[1]
    pw = form.get("password", "")
    if len(pw) < 8 or pw != form.get("password2", ""):
        return 400, page_manage(con, token, error='<p class="notice err">The password must be 8+ characters and both boxes must match.</p>')[1]
    con.execute("update clubs set pw_hash=? where id=?", (hash_password(pw), club["id"]))
    con.commit()
    login_club(con.execute("select * from clubs where id=?", (club["id"],)).fetchone())
    return page_manage(con, token, notice='<p class="notice ok">Password saved. You are logged in on this device.</p>')


def handle_code(con, form):
    key = form.get("key", "")
    if not secrets.compare_digest((key or "").encode(), admin_key().encode()):
        return 403, layout("Admin", "<h1>Forbidden</h1>")
    code = re.sub(r"[^A-Za-z0-9-]", "", form.get("code", ""))[:30]
    if os.environ.get("CAMPUS_CODE"):
        return page_admin(con, key, '<p class="notice">The code is set by the CAMPUS_CODE setting; change it there.</p>')
    if len(code) < 4:
        return page_admin(con, key, '<p class="notice err">Use at least 4 letters or numbers.</p>')
    set_campus_code(code)
    return page_admin(con, key, f'<p class="notice ok">Campus code is now {esc(code)}. Everyone types it again once.</p>')


def handle_approve(con, form):
    key = form.get("key", "")
    if not secrets.compare_digest((key or "").encode(), admin_key().encode()):
        return 403, layout("Admin", "<h1>Forbidden</h1>")
    con.execute("update clubs set status='approved' where id=?", (form.get("id"),))
    con.commit()
    return page_admin(con, key, '<p class="notice ok">Club approved.</p>')


# --------------------------------------------------------------------------
# ICS
# --------------------------------------------------------------------------
def ics_escape(text: str) -> str:
    return (text or "").replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", "\\n")


def ics_events(events, name="Clubbb") -> str:
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Clubbb//EN", "CALSCALE:GREGORIAN",
             f"X-WR-CALNAME:{ics_escape(name)}"]
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    for ev in events:
        a, b = event_span(ev["starts_at"], ev["ends_at"])
        if not a:
            continue
        lines += [
            "BEGIN:VEVENT", f"UID:event-{ev['id']}@clubbb", f"DTSTAMP:{stamp}",
            f"DTSTART:{ics_stamp(a)}", f"DTEND:{ics_stamp(b)}",
            f"SUMMARY:{ics_escape(ev['title'])}", f"LOCATION:{ics_escape(ev['venue'])}",
            f"DESCRIPTION:{ics_escape((ev['club_name'] or '') + ' - ' + (ev['description'] or ''))}",
            f"URL:{SITE_URL}/e/{ev['id']}",
            # reminders a day and an hour before
            "BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{ics_escape(ev['title'])} is tomorrow", "TRIGGER:-P1D", "END:VALARM",
            "BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{ics_escape(ev['title'])} starts in an hour", "TRIGGER:-PT1H", "END:VALARM",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines)


def ics_calendar(con) -> str:
    return ics_events(upcoming_events(con, 200), "Clubbb events")


# --------------------------------------------------------------------------
# email reminders (optional: set SMTP_HOST and friends)
# --------------------------------------------------------------------------
def send_mail(to: str, subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = SMTP_FROM, to, subject
    msg.set_content(body)
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
        s.starttls()
        if SMTP_USER:
            s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


def reminder_pass() -> int:
    """Send whatever reminders are due. Day reminder: 1-24 h before. Hour reminder: 0-60 min before."""
    con = connect()
    sent = 0
    try:
        nowdt = datetime.now()
        rows = con.execute(
            "select r.*, e.title, e.starts_at, e.ends_at, e.venue, c.name as club_name from reminders r "
            "join events e on e.id=r.event_id join clubs c on c.id=e.club_id "
            "where (r.sent_day=0 or r.sent_hour=0) and e.starts_at >= ? and e.starts_at <= ?",
            (nowdt.strftime("%Y-%m-%dT%H:%M"), (nowdt + timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M"))).fetchall()
        for r in rows:
            start = parse_dt(r["starts_at"])
            left = (start - nowdt).total_seconds() / 3600
            kind = "hour" if left <= 1 and not r["sent_hour"] else "day" if left > 1 and not r["sent_day"] else None
            if not kind:
                continue
            mins = max(1, round(left * 60))
            when = (f"in {mins} minutes" if mins < 55 else "in an hour") if kind == "hour" else \
                "tomorrow" if start.date() != nowdt.date() else "later today"
            body = (f"{r['title']} starts {when}.\n\n{fmt_dt(r['starts_at'])} · {r['venue'] or 'Venue to be announced'}\n"
                    f"Run by {r['club_name']}.\n\nDetails: {SITE_URL}/e/{r['event_id']}\n\n"
                    f"Stop reminders for this event: {SITE_URL}/r/{r['token']}/stop\n")
            try:
                send_mail(r["email"], f"Reminder: {r['title']} {when}", body)
            except Exception as exc:  # keep going; try again next pass
                print("reminder email failed:", exc)
                continue
            col = "sent_hour" if kind == "hour" else "sent_day"
            con.execute(f"update reminders set {col}=1{', sent_day=1' if kind == 'hour' else ''} where id=?", (r["id"],))
            con.commit()
            sent += 1
    finally:
        con.close()
    return sent


def reminder_loop() -> None:
    while True:
        try:
            reminder_pass()
        except Exception:
            traceback.print_exc()
        time.sleep(60)


# --------------------------------------------------------------------------
# server
# --------------------------------------------------------------------------
class App(BaseHTTPRequestHandler):
    server_version = "Clubbb/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def send(self, status, body, ctype="text/html; charset=utf-8", extra=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        for c in getattr(REQ, "out", []):
            self.send_header("Set-Cookie", c)
        REQ.out = []
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location):
        self.send(303, "", extra={"Location": location})

    def start_request(self):
        REQ.cookies = SimpleCookie()
        try:
            REQ.cookies.load(self.headers.get("Cookie", ""))
        except Exception:
            pass
        REQ.out = []
        REQ.student_now = False

    def do_GET(self):
        self.start_request()
        try:
            parts = urllib.parse.urlsplit(self.path)
            path, query = parts.path, urllib.parse.parse_qs(parts.query, keep_blank_values=True)
            con = connect()
            try:
                if path.startswith("/static/"):
                    return self.serve_static(path)
                if path.startswith("/uploads/"):
                    name = path[len("/uploads/"):]
                    target = (UPLOADS / name).resolve()
                    if str(target).startswith(str(UPLOADS.resolve())) and target.is_file():
                        ext = target.suffix.lower()
                        return self.send(200, target.read_bytes(), {".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}.get(ext, "application/octet-stream"))
                    return self.send(404, "not found", "text/plain")
                if path == "/":
                    return self.send(*page_home(con))
                if path == "/clubs":
                    return self.send(*page_clubs(con, query))
                if path == "/events":
                    return self.send(*page_events(con, query))
                if path == "/register":
                    return self.send(*page_register(con))
                if path == "/contact":
                    return self.send(*page_contact(con))
                if path == "/login":
                    if session_club(con):
                        return self.redirect("/club")
                    return self.send(*page_login(con))
                if path in ("/club", "/club/people"):
                    club = session_club(con)
                    if not club:
                        return self.redirect("/login")
                    return self.send(*(page_people(con, club["id"]) if path.endswith("people") else page_manage(con, club["id"])))
                if path == "/admin":
                    return self.send(*page_admin(con, (query.get("key", [""])[0] or "")))
                if path == "/calendar.ics":
                    return self.send(200, ics_calendar(con), "text/calendar; charset=utf-8")
                if path == "/api/clashes":
                    g = lambda k: (query.get(k, [""])[0] or "").strip()
                    club = club_by_token(con, g("token")) if g("token") else session_club(con)
                    data = find_clashes(con, g("starts")[:20], g("ends")[:20], g("venue")[:120],
                                        include_club=club["id"] if club else None)
                    return self.send(200, json.dumps({"clashes": data}), "application/json")
                m = re.fullmatch(r"/e/(\d+)\.ics", path)
                if m:
                    ev = event_by_id(con, int(m.group(1)))
                    if not ev:
                        return self.send(404, "not found", "text/plain")
                    return self.send(200, ics_events([ev], ev["title"]), "text/calendar; charset=utf-8",
                                     {"Content-Disposition": f'attachment; filename="event-{ev["id"]}.ics"'})
                m = re.fullmatch(r"/c/([a-z0-9-]+)/calendar\.ics", path)
                if m:
                    club = club_by_slug(con, m.group(1))
                    if not club:
                        return self.send(404, "not found", "text/plain")
                    evs = [e for e in upcoming_events(con, 200) if e["club_slug"] == club["slug"]]
                    return self.send(200, ics_events(evs, club["name"]), "text/calendar; charset=utf-8")
                m = re.fullmatch(r"/r/([A-Za-z0-9_-]+)/stop", path)
                if m:
                    return self.send(*page_stop(con, m.group(1)))
                m = re.fullmatch(r"/c/([a-z0-9-]+)", path)
                if m:
                    return self.send(*page_club(con, m.group(1)))
                m = re.fullmatch(r"/e/(\d+)", path)
                if m:
                    return self.send(*page_event(con, int(m.group(1))))
                m = re.fullmatch(r"/manage/([A-Za-z0-9_-]+)", path)
                if m:
                    return self.send(*page_manage(con, m.group(1)))
                m = re.fullmatch(r"/manage/([A-Za-z0-9_-]+)/people", path)
                if m:
                    return self.send(*page_people(con, m.group(1)))
                return self.send(404, layout("Not found", page_hero("Not found")))
            finally:
                con.close()
        except Exception:
            traceback.print_exc()
            self.send(500, layout("Error", "<h1>Something broke</h1><p>The error was logged in the terminal.</p>"))

    def do_POST(self):
        self.start_request()
        if int(self.headers.get("Content-Length") or 0) > 45 * 1024 * 1024:
            return self.send(413, layout("Too large", page_hero("Too large") + '<p class="after mono">That upload is too big. Try fewer or smaller photos.</p>'))
        try:
            path = urllib.parse.urlsplit(self.path).path
            form, files = read_form(self)
            con = connect()
            try:
                if path == "/register":
                    status, body = handle_register(con, form)
                    return self.send(status, body)
                if path == "/login":
                    status, body, loc = handle_login(con, form, self.client_address[0])
                    return self.redirect(loc) if loc else self.send(status, body)
                if path == "/logout":
                    set_cookie("cb_club", "", 0)
                    return self.redirect("/")
                if path == "/admin/code":
                    return self.send(*handle_code(con, form))
                m = re.fullmatch(r"/admin/highlight/(\d+)/delete", path)
                if m:
                    key = form.get("key", "")
                    if not secrets.compare_digest(key.encode(), admin_key().encode()):
                        return self.send(403, layout("Admin", "<h1>Forbidden</h1>"))
                    delete_highlight(con, int(m.group(1)))
                    return self.send(*page_admin(con, key, '<p class="notice ok">Deleted.</p>'))
                m = re.fullmatch(r"/(?:club|manage/([A-Za-z0-9_-]+))/highlight(?:/(\d+)/(delete))?", path)
                if m:
                    token = m.group(1)
                    if token is None:
                        club = session_club(con)
                        if not club:
                            return self.redirect("/login")
                        token = club["id"]
                    club = club_by_token(con, token)
                    if not club:
                        return self.send(404, layout("Not found", page_hero("Not found")))
                    if m.group(3):
                        ok = delete_highlight(con, int(m.group(2)), club["id"])
                        return self.send(*page_manage(con, token, notice='<p class="notice ok">Deleted.</p>' if ok else ""))
                    return self.send(*handle_highlight(con, token, form, files))
                m = re.fullmatch(r"/club/(profile|event|password)", path)
                if m:
                    club = session_club(con)
                    if not club:
                        return self.redirect("/login")
                    fn = {"profile": lambda: handle_profile(con, club["id"], form, files),
                          "event": lambda: handle_event(con, club["id"], form, files),
                          "password": lambda: handle_password(con, club["id"], form)}[m.group(1)]
                    return self.send(*fn())
                m = re.fullmatch(r"/manage/([A-Za-z0-9_-]+)/password", path)
                if m:
                    return self.send(*handle_password(con, m.group(1), form))
                if path == "/admin/approve":
                    return self.send(*handle_approve(con, form))
                m = re.fullmatch(r"/manage/([A-Za-z0-9_-]+)/profile", path)
                if m:
                    return self.send(*handle_profile(con, m.group(1), form, files))
                m = re.fullmatch(r"/manage/([A-Za-z0-9_-]+)/event", path)
                if m:
                    return self.send(*handle_event(con, m.group(1), form, files))
                m = re.fullmatch(r"/c/([a-z0-9-]+)/apply", path)
                if m:
                    return self.send(*handle_apply(con, m.group(1), form))
                m = re.fullmatch(r"/e/(\d+)/rsvp", path)
                if m:
                    return self.send(*handle_rsvp(con, int(m.group(1)), form))
                m = re.fullmatch(r"/e/(\d+)/remind", path)
                if m:
                    return self.send(*handle_remind(con, int(m.group(1)), form))
                return self.send(404, layout("Not found", page_hero("Not found")))
            finally:
                con.close()
        except Exception:
            traceback.print_exc()
            self.send(500, layout("Error", "<h1>Something broke</h1>"))

    def serve_static(self, path):
        name = path[len("/static/"):]
        target = (STATIC / name).resolve()
        if not str(target).startswith(str(STATIC.resolve())) or not target.is_file():
            return self.send(404, "not found", "text/plain")
        types = {".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml",
                 ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".webm": "video/webm",
                 ".woff2": "font/woff2", ".json": "application/json"}
        return self.send(200, target.read_bytes(), types.get(target.suffix.lower(), "application/octet-stream"),
                         {"Cache-Control": "no-cache"})


def main() -> int:
    init_db()
    print(f"Clubbb on http://{HOST}:{PORT}")
    print(f"Admin: http://{HOST}:{PORT}/admin?key={admin_key()}")
    print(f"Campus code for students: {campus_code()}")
    if EMAIL_ON:
        threading.Thread(target=reminder_loop, daemon=True).start()
        print(f"Email reminders: on (via {SMTP_HOST})")
    else:
        print("Email reminders: off (set SMTP_HOST to switch on; calendar and on-site reminders still work)")
    ThreadingHTTPServer((HOST, PORT), App).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
