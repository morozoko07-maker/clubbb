#!/usr/bin/env python3
"""Load demo clubs and events from seed.json. Safe to run twice."""
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

from app import BANNERS, CATEGORIES, KINDS, connect, hash_password, init_db, now, token_hash

ROOT = Path(__file__).resolve().parent


def main() -> int:
    init_db()
    data = json.loads((ROOT / "seed.json").read_text(encoding="utf-8"))
    con = connect()
    if con.execute("select count(*) from clubs").fetchone()[0]:
        print("Database already has clubs; nothing to do.")
        return 0

    # seed.json holds fixed dates; slide them so the first event is two days from now
    def parse(v):
        return datetime.fromisoformat(v) if v else None
    first = min(parse(e["starts_at"]) for e in data["events"])
    shift = (datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=2)) - first.replace(hour=0, minute=0)
    def moved(v):
        d = parse(v)
        return (d + shift).strftime("%Y-%m-%dT%H:%M") if d else ""

    ids = {}
    links = []
    for club in data["clubs"]:
        slug = club["slug"]
        token = f"demo-{slug}"
        con.execute(
            "insert into clubs(slug,name,category,tagline,about,accent,banner,email,instagram,"
            "website,join_open,status,manage_hash,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                slug, club["name"], club.get("category", "technical"),
                club.get("tagline", ""), club.get("about", ""),
                club.get("accent", "#8fa68e"),
                club.get("banner") if club.get("banner") in BANNERS else "solid",
                club.get("email", ""), club.get("instagram", ""), club.get("website", ""),
                1 if club.get("join_open", True) else 0,
                "approved", token_hash(token), now(),
            ),
        )
        ids[slug] = con.execute("select id from clubs where slug=?", (slug,)).fetchone()[0]
        links.append(f"/manage/{token}")

    for ev in data["events"]:
        con.execute(
            "insert into events(club_id,title,kind,starts_at,ends_at,venue,description,link,"
            "capacity,created_at) values(?,?,?,?,?,?,?,?,?,?)",
            (
                ids[ev["club_slug"]], ev["title"],
                ev.get("kind") if ev.get("kind") in KINDS else "meetup",
                moved(ev["starts_at"]), moved(ev.get("ends_at", "")), ev.get("venue", ""),
                ev.get("description", ""), ev.get("link", ""),
                int(ev.get("capacity") or 0), now(),
            ),
        )
    # a finished event with winners, and an outside win, so "Moments" has something to show
    past = (datetime.now() - timedelta(days=4)).replace(hour=10, minute=0, second=0, microsecond=0)
    con.execute(
        "insert into events(club_id,title,kind,starts_at,ends_at,venue,description,capacity,created_at) values(?,?,?,?,?,?,?,?,?)",
        (ids["codecell"], "Autumn Hack Night", "hackathon", past.strftime("%Y-%m-%dT%H:%M"),
         (past + timedelta(hours=10)).strftime("%Y-%m-%dT%H:%M"), "CS Lab 2, Block C",
         "Twelve hours, forty builders, one very tired coffee machine.", 60, now()))
    hack_id = con.execute("select max(id) from events").fetchone()[0]
    until14 = (datetime.now() + timedelta(days=14)).replace(microsecond=0).isoformat()
    until7 = (datetime.now() + timedelta(days=7)).replace(microsecond=0).isoformat()
    con.execute(
        "insert into highlights(club_id,event_id,kind,title,caption,winners,photos,created_at,home_until) values(?,?,?,?,?,?,?,?,?)",
        (ids["codecell"], hack_id, "event", "Autumn Hack Night", "Forty builders, twelve hours, nine demos that actually ran.",
         json.dumps([{"place": "1st", "name": "Team Null Pointer (Asha, Ravi, Meera)"}, {"place": "2nd", "name": "Byte Club"},
                     {"place": "3rd", "name": "Late Commit"}, {"place": "Also", "name": "Best design: Team Loop"}]), "[]", now(), until14))
    con.execute(
        "insert into highlights(club_id,event_id,kind,title,caption,winners,photos,created_at,home_until) values(?,?,?,?,?,?,?,?,?)",
        (ids["torque-robotics"], None, "outside", "Inter-college Robo Race", "Our line follower finished second out of 23 teams.",
         json.dumps([{"place": "2nd", "name": "Torque Robotics (Kiran, Divya)"}]), "[]", now(), until7))

    demo_pw = hash_password("clubbb-demo")
    con.execute("update clubs set pw_hash=?", (demo_pw,))
    con.commit()
    print(f"Seeded {len(data['clubs'])} clubs and {len(data['events'])} events.")
    print("Demo club login: any demo club's email, password  clubbb-demo")
    print("Demo manage links:")
    for link in links:
        print("  http://localhost:8770" + link)
    return 0


if __name__ == "__main__":
    sys.exit(main())
