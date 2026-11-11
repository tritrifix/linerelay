#!/usr/bin/env python3
"""
fallback_gtfs.py — Repli GTFS-RT pour les horaires de la ligne 5.

Appelé par server.js UNIQUEMENT si la source principale (divia-api / Navitia)
échoue ou ne renvoie aucun passage. S'appuie sur le module
`divia_api.gtfs_realtime` du dépôt tritrifix/scripts-divia, cloné par
install.sh dans ./divia-scripts/.

Usage : python3 fallback_gtfs.py <ligne_totem> <code_arret> [count]
   ex. : python3 fallback_gtfs.py 87 1370 3

Sortie : JSON sur stdout — liste de passages au même format que le backend :
   [{"time": ISO8601, "minutes": int, "direction": str, "realtime": true}, ...]

En cas d'indisponibilité (module/dep manquant, réseau KO), renvoie [] et
sort en code 0 : le backend dégrade alors proprement vers le cache.
"""
import json
import os
import sys
from datetime import datetime, timezone

# Le module GTFS-RT du dépôt cloné
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "divia-scripts"))


def main():
    if len(sys.argv) < 3:
        print("[]")
        return
    line_id, stop_code = sys.argv[1], sys.argv[2]
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 3

    try:
        from divia_api.gtfs_realtime import GTFSRealtimeAPI
    except Exception:
        print("[]")  # dépendances/dépôt absents → repli silencieux
        return

    try:
        deps = GTFSRealtimeAPI.get_next_departures(line_id, stop_code, limit=count)
    except Exception:
        print("[]")
        return

    out = []
    for d in deps:
        t = d["time"]
        if t.tzinfo is None:
            t = t.astimezone()  # horloge locale -> aware
        out.append(
            {
                "time": t.astimezone(timezone.utc).isoformat(),
                "minutes": d["minutes"],
                "direction": "—",
                "realtime": True,
            }
        )
    print(json.dumps(out))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("[]")
