#!/usr/bin/env bash
#
# start.sh — Démarre / redémarre le serveur LineRelay.
#
# Utilise PM2 s'il est installé (gestion de process robuste), sinon lance
# `node server.js` en arrière-plan avec un PID-file et un log.
#
#   ./start.sh          démarre (ou redémarre) sur le port $PORT (défaut 3000)
#   ./start.sh stop     arrête le serveur
#   ./start.sh status   affiche l'état
#
set -euo pipefail
cd "$(dirname "$0")"

# Rend `node`/`npm`/`pm2` disponibles même hors session interactive
# (cron @reboot n'hérite pas du PATH du .bashrc). On ajoute toute install
# Node en espace utilisateur trouvée, ainsi que les emplacements système.
for d in "${HOME:-$PWD}"/.local/node-*/bin /usr/local/bin /usr/bin; do
  if [ -d "$d" ]; then
    case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
  fi
done
export PATH

PORT="${PORT:-3000}"
APP_NAME="divia-ligne5"
PID_FILE=".server.pid"
LOG_FILE="server.log"
export PORT

use_pm2() { command -v pm2 >/dev/null 2>&1; }

stop_plain() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")" && echo "Serveur arrêté (PID $(cat "$PID_FILE"))."
  fi
  rm -f "$PID_FILE"
}

case "${1:-start}" in
  stop)
    if use_pm2; then pm2 delete "$APP_NAME" 2>/dev/null || true; else stop_plain; fi
    ;;
  status)
    if use_pm2; then pm2 describe "$APP_NAME" || echo "non géré par pm2"; \
    elif [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then \
      echo "en marche (PID $(cat "$PID_FILE")) sur le port $PORT"; \
    else echo "arrêté"; fi
    ;;
  start|"")
    if use_pm2; then
      echo "Démarrage via PM2 (port $PORT)…"
      pm2 delete "$APP_NAME" 2>/dev/null || true
      pm2 start server.js --name "$APP_NAME"
      pm2 save || true
    else
      echo "PM2 absent — démarrage de node en arrière-plan (port $PORT)…"
      stop_plain
      nohup node server.js > "$LOG_FILE" 2>&1 &
      echo $! > "$PID_FILE"
      sleep 1
      echo "Serveur lancé (PID $(cat "$PID_FILE")). Logs : $LOG_FILE"
    fi
    echo "→ http://localhost:$PORT"
    # Affiche les adresses LAN courantes (utile si l'IP DHCP change)
    ips=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
    for ip in $ips; do echo "→ http://$ip:$PORT"; done
    host=$(hostname -f 2>/dev/null || hostname)
    [ -n "$host" ] && echo "→ http://$host:$PORT  (si le DNS résout ce nom)"
    ;;
  *)
    echo "Usage: $0 [start|stop|status]" >&2; exit 1 ;;
esac
