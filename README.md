# LineRelay

**LineRelay** est une carte web interactive des transports en commun de
Dijon Métropole : tracé des lignes, arrêts, prochains passages et **position
des véhicules en temps réel**, affichés sur une carte Leaflet.

Toutes les lignes (bus et tram) sont disponibles, mais la carte n'en affiche
**qu'une seule à la fois**, choisie dans un menu déroulant. Ce choix limite le
nombre de requêtes, évite les superpositions de tracés et les artefacts
d'affichage. Une couche optionnelle montre les stations de vélos en libre-service.

> **Projet indépendant.** LineRelay n'est **affilié ni à Keolis ni à Divia**,
> et n'est ni approuvé ni soutenu par ces entités. Il s'appuie uniquement sur
> des données publiques. Aucun logo ni élément de marque n'est utilisé ou
> redistribué ici.

## Stack

| Couche | Technologies |
|---|---|
| Backend | Node.js ≥ 18, Express 5 |
| Données temps réel | `gtfs-realtime-bindings` (décodage protobuf GTFS-RT), `divia-api` (proxy Navitia) |
| Tracés | Python 3 (stdlib uniquement), GTFS statique |
| Frontend | JavaScript vanilla, Leaflet 1.9.4 (CDN), fonds de carte OpenStreetMap |

Aucune clé d'API n'est nécessaire.

## Installation

### Avec Docker (recommandé)

```bash
git clone git@github.com:tritrifix/linerelay.git
cd linerelay
make dev          # ou : docker compose up --build
# puis ouvrir http://localhost:3000   (PORT=8080 make dev pour un autre port)
```

Le code est monté depuis l'hôte et le serveur redémarre à chaque sauvegarde.
Le workflow complet — développement local, publication de l'image sur GHCR,
déploiement en production — est décrit dans **[docs/DOCKER.md](docs/DOCKER.md)**.

### Sans Docker

```bash
git clone git@github.com:tritrifix/linerelay.git
cd linerelay
npm install
npm run build:traces    # télécharge le GTFS statique et génère public/traces.json
npm start               # http://localhost:3000
```

`public/traces.json` n'est pas versionné : c'est un fichier **généré** à partir
d'un jeu de données open data. Sans lui, l'application fonctionne, mais sans les
polylignes des lignes.

Un script `install.sh` automatise une installation complète sur une Ubuntu
fraîche (paquets système via `apt` et `sudo`, Node 20 LTS, dépendances Python,
tâche `cron @reboot`, démarrage). Il modifie le système : à utiliser en
connaissance de cause.

```bash
./install.sh                 # installation complète
SKIP_APT=1 ./install.sh      # saute l'étape système
SKIP_CRON=1 ./install.sh     # n'installe pas le démarrage au boot
```

## Variables d'environnement

Copiez `.env.example` en `.env` et adaptez si besoin. Aucune de ces variables
n'est un secret ; elles existent pour pouvoir viser un autre réseau ou un autre
fournisseur de flux sans toucher au code. Toutes ont une valeur par défaut.

| Variable | Rôle |
|---|---|
| `PORT` | port d'écoute du serveur HTTP (défaut `3000`), voir [Changer le port](#changer-le-port) |
| `VEHICLE_FEED_URL` | flux GTFS-RT « vehicle position » |
| `TRIPUPDATE_FEED_URL` | flux GTFS-RT « trip update » (retards, arrêts supprimés) |
| `VELODI_FEED_URL` | API de disponibilité des vélos en libre-service ; vide = couche désactivée |
| `VELODI_ORG_ID` | identifiant d'organisation côté fournisseur vélos (`1` = Dijon) |
| `GTFS_STATIC_URL` | jeu de données GTFS statique utilisé par `npm run build:traces` |

Le serveur lit `.env` au démarrage. Une variable déjà présente dans
l'environnement l'emporte sur le fichier, ce qui permet une surcharge
ponctuelle sans l'éditer :

```bash
PORT=8080 npm start
```

### Changer le port

`PORT` est le seul réglage à toucher, en développement comme en production :
une même valeur dans `.env` sert au serveur Node, au conteneur Docker et au
port publié sur la machine hôte.

```bash
# durablement, pour tous les modes de lancement
sed -i 's/^PORT=.*/PORT=8080/' .env

# ponctuellement, le temps d'un lancement
PORT=8080 npm start                                  # dev local
PORT=8080 ./start.sh                                 # dev local, en arrière-plan
PORT=8080 make dev                                   # dev Docker
PORT=8080 docker compose up --build                  # idem, sans make
PORT=8080 make deploy                                # production
PORT=8080 docker compose -f compose.prod.yaml up -d  # idem, sans make
```

En Docker, `PORT` change à la fois le port écouté dans le conteneur et le port
publié sur l'hôte. `HOST_PORT` ne sert qu'à dissocier les deux — par exemple
publier sur `80` derrière un reverse proxy alors que le conteneur écoute sur
`PORT` :

```bash
HOST_PORT=80 docker compose -f compose.prod.yaml up -d
```

`PORT=0` laisse le système attribuer un port libre, affiché au démarrage.

## Lancement et exploitation

```bash
npm start             # premier plan
./start.sh            # démarre / redémarre (PM2 si présent, sinon nohup + PID-file)
./start.sh status     # état
./start.sh stop       # arrêt
PORT=8080 ./start.sh  # autre port (voir « Changer le port »)
```

## API HTTP

| Endpoint | Description |
|---|---|
| `GET /api/lines` | catalogue de toutes les lignes (bus + tram) |
| `GET /api/lines/meta` | métadonnées légères : `{ id, code, color, text_color, opening_time, closing_time }` |
| `GET /api/lines/delays` | retards temps réel par arrêt : `{ stops: { codeGTFS: { delay, skipped } } }` |
| `GET /api/lines/:lineId/stops` | arrêts de la ligne |
| `GET /api/lines/:lineId/route` | tracé (une polyligne par sens) |
| `GET /api/lines/:lineId/schedules/:stopId?limit=3` | prochains passages d'un arrêt |
| `GET /api/lines/:lineId/all-schedules?limit=3` | passages de tous les arrêts |
| `GET /api/lines/:lineId/vehicles` | positions temps réel des véhicules |
| `GET /api/velodi/stations` | stations de vélos en libre-service (position, vélos et places disponibles) |
| `GET /api/health` | sonde de santé |

`:lineId` est l'identifiant Navitia (par exemple `line:CGD:L5`), encodé dans
l'URL. Les anciennes routes `/api/line5/*` restent disponibles et redirigent.

## Architecture

```
linerelay/
├── server.js              backend Express : catalogue, API par ligne, cache TTL, statique
├── fallback_gtfs.py       repli horaires GTFS-RT (Python, best-effort)
├── tools/build_traces.py  génère public/traces.json depuis le GTFS statique
├── public/
│   ├── index.html         page + menu déroulant + Leaflet (CDN)
│   ├── style.css
│   ├── app.js             carte, sélecteur, arrêts, popups, véhicules, MàJ 30 s
│   └── traces.json        généré, non versionné
├── Dockerfile             image multi-étages (npm, tracés GTFS, runtime)
├── compose.yaml           développement local, rechargement à chaud
├── compose.prod.yaml      déploiement : tire l'image publiée sur GHCR
├── Makefile               raccourcis : dev, build, smoke, push, deploy
├── docker/                requirements Python du repli
├── docs/DOCKER.md          workflow dev → image → production
├── .github/workflows/     build et publication de l'image sur GHCR
├── install.sh / start.sh  installation hors conteneur
└── .env.example
```

Chaque ressource est mise en cache avec un TTL ; en cas d'échec réseau, le
serveur renvoie la dernière valeur connue avec un drapeau `stale`. Le flux des
véhicules est décodé une fois puis indexé par ligne (TTL 10 s) : changer de
ligne ne déclenche aucune requête réseau supplémentaire.

**Correspondance ligne Navitia ↔ route GTFS** — le `route_id` GTFS vaut
`4-<short_name>`. Le code Navitia s'y relie en retirant son préfixe
alphabétique quand le reste est numérique (`B10`→`4-10`, `R30`→`4-30`,
`BC61`→`4-61`), sinon à l'identique (`L5`→`4-L5`, `T1`→`4-T1`).

## Sources de données

| Donnée | Source |
|---|---|
| Lignes, arrêts, horaires | API Navitia via le paquet npm `divia-api` |
| Positions des véhicules | flux GTFS-RT *vehicle position*, proxy [transport.data.gouv.fr](https://transport.data.gouv.fr) |
| Retards, arrêts supprimés | flux GTFS-RT *trip update*, même proxy |
| Tracés des lignes | GTFS statique (`shapes.txt`) publié sur [data.gouv.fr](https://www.data.gouv.fr) |
| Fonds de carte | [OpenStreetMap](https://www.openstreetmap.org/copyright) — © les contributeurs OpenStreetMap, ODbL |
| Vélos en libre-service | API de disponibilité de l'exploitant (backend Cykleo) |

Les jeux de données GTFS et GTFS-RT de Dijon Métropole sont publiés en open
data sur transport.data.gouv.fr et data.gouv.fr.

> ⚠️ **À vérifier avant toute diffusion publique :** la licence exacte de
> chaque jeu de données utilisé (fiche du producteur sur data.gouv.fr —
> généralement ODbL ou Licence Ouverte, avec obligation d'attribution), ainsi
> que les conditions d'usage de l'API de disponibilité des vélos, qui n'est pas
> un flux open data documenté.

## Licence

Code sous licence ISC (voir `package.json`). Les données affichées restent
soumises aux licences de leurs producteurs respectifs.
