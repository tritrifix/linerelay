# syntax=docker/dockerfile:1
#
# LineRelay — image de production.
#
# Trois étages :
#   1. npmdeps  — dépendances npm de production uniquement
#   2. assets   — tracés GTFS (public/traces.json) + module Python du repli
#   3. runtime  — Node + Python, utilisateur non privilégié, rien d'autre
#
# L'étage « assets » a besoin du réseau au moment du build : il télécharge le
# GTFS statique et clone le module de repli. Pour construire sans réseau :
#   docker build --build-arg SKIP_TRACES=1 .
# (l'application fonctionne alors sans les polylignes des lignes)

ARG NODE_IMAGE=node:20-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

# --------------------------------------------------------------------------- #
# 1. Dépendances npm                                                          #
# --------------------------------------------------------------------------- #
FROM ${NODE_IMAGE} AS npmdeps
WORKDIR /app
COPY package.json package-lock.json ./
COPY docker/prune-node-modules.mjs ./docker/
# `gtfs-realtime-bindings` déclare protobufjs-cli (et donc jsdoc, @babel,
# lodash, underscore…) en dépendance normale alors que seul le décodeur
# protobufjs sert à l'exécution : l'élagage retire cette chaîne d'outillage,
# soit environ 24 Mo sur 35.
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && node docker/prune-node-modules.mjs . \
 && rm -rf docker

# --------------------------------------------------------------------------- #
# 2. Assets générés : tracés des lignes + module Python du repli              #
# --------------------------------------------------------------------------- #
FROM ${PYTHON_IMAGE} AS assets
WORKDIR /build

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# -- tracés des lignes (GTFS statique) -------------------------------------- #
COPY tools/build_traces.py tools/
ARG GTFS_STATIC_URL=""
ARG SKIP_TRACES=0
RUN mkdir -p public \
 && if [ "$SKIP_TRACES" = "1" ]; then \
      echo "SKIP_TRACES=1 — traces.json non généré" >&2; echo '{}' > public/traces.json; \
    else \
      GTFS_STATIC_URL="$GTFS_STATIC_URL" python3 tools/build_traces.py; \
    fi

# -- module Python du repli GTFS-RT ----------------------------------------- #
# Dépôt public tritrifix/scripts-divia : on ne garde que le paquet divia_api,
# le reste du dépôt n'est pas utilisé par LineRelay.
ARG FALLBACK_REPO=https://github.com/tritrifix/scripts-divia
ARG FALLBACK_REF=main
RUN git clone --depth 1 --branch "$FALLBACK_REF" "$FALLBACK_REPO" /tmp/scripts-divia \
 && mkdir -p /build/divia-scripts \
 && cp -r /tmp/scripts-divia/divia_api /build/divia-scripts/divia_api \
 && find /build/divia-scripts -name '__pycache__' -type d -prune -exec rm -rf {} + \
 && rm -rf /tmp/scripts-divia

# --------------------------------------------------------------------------- #
# 3. Image finale                                                             #
# --------------------------------------------------------------------------- #
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Python pour le repli horaires GTFS-RT, isolé dans un virtualenv (PEP 668).
COPY docker/requirements-fallback.txt /tmp/requirements-fallback.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements-fallback.txt \
 && rm -f /tmp/requirements-fallback.txt

WORKDIR /app

COPY --from=npmdeps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js fallback_gtfs.py ./
COPY tools/ ./tools/
COPY public/index.html public/style.css public/app.js ./public/
COPY --from=assets /build/public/traces.json ./public/traces.json
COPY --from=assets /build/divia-scripts/ ./divia-scripts/

# L'image node fournit déjà l'utilisateur `node` (uid 1000). Les fichiers
# restent la propriété de root : l'application les lit mais ne peut pas les
# modifier, et on évite une couche de `chown` sur tout node_modules.
USER node

# Port par défaut de l'image, surchargeable au lancement :
#   docker run -e PORT=8080 -p 8080:8080 linerelay
# EXPOSE est purement déclaratif : il documente 3000 sans figer PORT.
EXPOSE 3000

# La sonde interroge l'application elle-même ; aucun outil externe requis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
