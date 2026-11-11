#!/usr/bin/env python3
"""
build_traces.py — Génère public/traces.json : le tracé réel de TOUTES les
lignes du réseau Divia (bus + tram), une polyligne par sens de circulation.

Source : GTFS statique officiel de DiviaMobilités (transport.data.gouv.fr).
Clé du dictionnaire de sortie : le route_id GTFS (ex. "4-L5", "4-T1", "4-12").
Le backend relie chaque ligne Navitia à son route_id GTFS (cf. server.js) puis
sert le tracé correspondant — la carte n'affiche qu'une ligne à la fois.

Pur stdlib Python (aucune dépendance pip). Idempotent.
Usage : python3 tools/build_traces.py
"""
import csv, io, json, os, sys, urllib.request, zipfile, socket

# Jeu de données GTFS statique à utiliser ; surchargeable par variable
# d'environnement (cf. .env.example). Défaut : réseau de Dijon Métropole.
GTFS_URL = (
    os.environ.get("GTFS_STATIC_URL")
    or "https://www.data.gouv.fr/api/1/datasets/r/e0dbd217-15cd-4e28-9459-211a27511a34"
)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "traces.json")


def log(*a):
    print("[build_traces]", *a, file=sys.stderr)


def read_csv(zf, name):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def main():
    log("Téléchargement du GTFS statique Divia…")
    socket.setdefaulttimeout(90)
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "divia-map/2.0"})
    zf = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req).read()))

    # Métadonnées des routes
    routes = {}
    for r in read_csv(zf, "routes.txt"):
        routes[r["route_id"]] = {
            "short_name": r.get("route_short_name", ""),
            "long_name": r.get("route_long_name", ""),
            "color": "#" + (r.get("route_color") or "888888").strip(),
        }

    # shape_id(s) par route et par sens
    shapes_by_route = {}  # route_id -> { direction_id -> set(shape_id) }
    for t in read_csv(zf, "trips.txt"):
        rid, sid = t["route_id"], t.get("shape_id")
        if not sid:
            continue
        d = t.get("direction_id", "0")
        shapes_by_route.setdefault(rid, {}).setdefault(d, set()).add(sid)

    wanted = {sid for dirs in shapes_by_route.values() for sids in dirs.values() for sid in sids}
    log(f"{len(routes)} routes, {len(wanted)} shapes à extraire…")

    # Points de chaque shape
    pts = {sid: [] for sid in wanted}
    for s in read_csv(zf, "shapes.txt"):
        sid = s["shape_id"]
        if sid in wanted:
            pts[sid].append(
                (int(s["shape_pt_sequence"]), float(s["shape_pt_lat"]), float(s["shape_pt_lon"]))
            )

    out = {}
    for rid, dirs in shapes_by_route.items():
        polylines = []
        for d, sids in sorted(dirs.items()):
            best = max(sids, key=lambda sid: len(pts.get(sid, [])))
            ordered = [[lat, lon] for _, lat, lon in sorted(pts.get(best, []))]
            if ordered:
                polylines.append({"direction": d, "points": ordered})
        if polylines:
            meta = routes.get(rid, {})
            out[rid] = {
                "route_id": rid,
                "short_name": meta.get("short_name", ""),
                "long_name": meta.get("long_name", ""),
                "color": meta.get("color", "#888888"),
                "polylines": polylines,
            }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    total_pts = sum(len(pl["points"]) for r in out.values() for pl in r["polylines"])
    size = os.path.getsize(OUT) // 1024
    log(f"Écrit : {os.path.relpath(OUT)} — {len(out)} lignes, {total_pts} points, {size} Ko")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("ÉCHEC :", e)
        log("Les tracés sont optionnels ; l'application fonctionnera sans traces.json.")
        sys.exit(1)
