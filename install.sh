#!/usr/bin/env bash
#
# install.sh — Installation « from scratch » de LineRelay sur une Ubuntu propre.
#
#   1. Met à jour les paquets système
#   2. Installe Node.js 20 LTS (NodeSource) + npm
#   3. Installe Python 3 + pip (pour le repli GTFS-RT)
#   4. Clone le dépôt de scripts GTFS-RT dans ./divia-scripts/
#   5. Installe les dépendances npm + génère les tracés des lignes
#   6. Installe une tâche cron @reboot, puis lance l'application
#
# Ce script modifie le système (apt, sudo, crontab). Pour une installation
# manuelle, voir le README : npm install && npm run build:traces && npm start.
#
# Usage :  ./install.sh            (installation complète, nécessite sudo)
#          SKIP_APT=1 ./install.sh  (saute l'étape système si déjà fait)
#          SKIP_CRON=1 ./install.sh (n'installe pas le démarrage au boot)
#
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

REPO_DIR="divia-scripts"
SCRIPTS_REPO="https://github.com/tritrifix/scripts-divia"

# ---------------------------------------------------------------- système ---
if [ "${SKIP_APT:-0}" != "1" ]; then
  log "Mise à jour des paquets système (apt)…"
  sudo apt-get update -y
  sudo apt-get upgrade -y

  log "Installation des outils de base (curl, git, python3, pip, unzip)…"
  sudo apt-get install -y curl git python3 python3-pip python3-venv unzip ca-certificates

  if ! command -v node >/dev/null 2>&1; then
    log "Installation de Node.js 20 LTS via NodeSource…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi

log "Versions détectées :"
node --version && npm --version
python3 --version || true

# ----------------------------------------------------- dépôt fallback GTFS ---
if [ ! -d "$REPO_DIR/.git" ] && [ ! -d "$REPO_DIR/divia_api" ]; then
  log "Clonage de $SCRIPTS_REPO → ./$REPO_DIR/"
  git clone --depth 1 "$SCRIPTS_REPO" "$REPO_DIR" || \
    echo "Avertissement : clonage impossible — le repli Python sera désactivé."
else
  log "Dépôt fallback déjà présent (./$REPO_DIR), on ne reclone pas."
fi

# Dépendances Python du repli (best-effort : l'app marche sans).
if [ -d "$REPO_DIR" ]; then
  log "Installation des dépendances Python du repli GTFS-RT…"
  python3 -m pip install --user --quiet requests gtfs-realtime-bindings protobuf 2>/dev/null \
    || echo "Avertissement : dépendances Python non installées — repli désactivé, source principale OK."
fi

# ------------------------------------------------------------ configuration ---
# Un .env présent dès l'installation rend la configuration (port en tête)
# modifiable sans toucher au code : server.js et start.sh le lisent tous deux.
if [ ! -f .env ] && [ -f .env.example ]; then
  log "Création de .env à partir de .env.example…"
  cp .env.example .env
  echo "→ Éditez .env pour changer le port (PORT=…) ou les flux de données."
fi

# ---------------------------------------------------------------- node app ---
log "Installation des dépendances npm…"
npm install

log "Génération des tracés réels de toutes les lignes (GTFS statique)…"
python3 tools/build_traces.py || echo "Avertissement : tracés non générés — la carte fonctionnera sans les polylignes."

# ----------------------------------------------------------------- start -----
# ----------------------------------------------- démarrage auto au boot -----
APP_DIR="$(pwd)"
if [ "${SKIP_CRON:-0}" != "1" ]; then
  log "Configuration du démarrage automatique au boot (cron @reboot)…"
  CRON_LINE="@reboot sleep 5 && $APP_DIR/start.sh start >> $APP_DIR/boot.log 2>&1"
  if command -v crontab >/dev/null 2>&1; then
    TMP="$(mktemp)"
    crontab -l 2>/dev/null | grep -v "$APP_DIR/start.sh" > "$TMP" || true
    echo "$CRON_LINE" >> "$TMP"
    crontab "$TMP" && echo "→ entrée cron @reboot installée."
    rm -f "$TMP"
  else
    echo "Avertissement : crontab indisponible — démarrage auto non configuré."
  fi
else
  log "SKIP_CRON=1 — démarrage automatique au boot non configuré."
fi

log "Démarrage de l'application…"
./start.sh

APP_PORT="${PORT:-$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]\{1,5\}\).*/\1/p' .env 2>/dev/null | tail -n1 || true)}"
log "Terminé. Carte disponible sur http://localhost:${APP_PORT:-3000}"
log "Pour changer de port : modifiez PORT dans .env, puis ./start.sh"
if [ "${SKIP_CRON:-0}" != "1" ]; then
  log "Le service redémarrera automatiquement à chaque boot (cron @reboot)."
fi
