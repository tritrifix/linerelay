# LineRelay dans Docker

Ce document décrit l'environnement conteneurisé : développement sur ta machine,
construction d'une image, puis déploiement de cette même image en production.

## Vue d'ensemble

```
  Ta machine de développement                GitHub                 Serveur de prod
  ───────────────────────────────────        ──────                 ───────────────
  make dev                                                        
   └─ compose.yaml, code monté,                                   
      rechargement à chaud                                        
                                                                   
  git push ──────────────────────────► Actions                     
                                        └─ build, vérification,    
                                           publication             
                                           ghcr.io/tritrifix/      
                                           linerelay:<tag> ───────► make deploy
                                                                     └─ compose.prod.yaml
                                                                        pull + up -d
```

L'image déployée en production est **exactement** celle qui a été construite et
testée : rien n'est recompilé sur le serveur.

Les deux modes utilisent le même service Compose, `app`, et le même projet,
`linerelay` ; seul le fichier change.

| | Développement | Production |
|---|---|---|
| Fichier Compose | `compose.yaml` (pris par défaut) | `compose.prod.yaml` (à passer avec `-f`) |
| Image | construite sur place, `linerelay:dev` | tirée de GHCR, `ghcr.io/tritrifix/linerelay:latest` par défaut |
| Code | cinq fichiers montés depuis l'hôte, `node --watch` | figé dans l'image |
| `NODE_ENV` | `development` | `production` |
| Système de fichiers | inscriptible | lecture seule, `/tmp` en mémoire (16 Mo) |
| Privilèges | ceux par défaut de Docker | `cap_drop: ALL`, `no-new-privileges` |
| Mémoire | non limitée | 512 Mo |
| Logs | sortie standard | `json-file`, 3 fichiers de 10 Mo |
| Cache navigateur des fichiers statiques | aucun | 5 minutes |

## Ce que contient l'image

Trois étages de build, pour que l'image finale ne contienne ni compilateur, ni
cache, ni dépendances de développement :

| Étage | Base | Rôle |
|---|---|---|
| `npmdeps` | `node:20-bookworm-slim` | `npm ci --omit=dev`, puis élagage de `node_modules` (voir ci-dessous) |
| `assets` | `python:3.12-slim-bookworm` | télécharge le GTFS statique et génère `public/traces.json` ; récupère le paquet `divia_api` du dépôt public `tritrifix/scripts-divia` pour le repli horaires |
| `runtime` | `node:20-bookworm-slim` | Node + un virtualenv Python isolé, l'application, utilisateur non privilégié `node` (uid 1000) |

Détails utiles :

- **Aucun secret dans l'image.** Toute la configuration passe par des variables
  d'environnement au démarrage (voir `.env.example`).
- **`traces.json` est figé dans l'image.** Le GTFS statique bouge rarement ;
  pour rafraîchir les tracés, reconstruis l'image. Build sans réseau possible :
  `docker build --build-arg SKIP_TRACES=1 .` (carte sans polylignes).
- **Le repli Python est actif** : `python3` vient d'un virtualenv dans
  `/opt/venv` (jamais le Python système, cf. PEP 668) et le module `divia_api`
  est copié dans `/app/divia-scripts/`. Seul ce paquet est repris du dépôt
  amont, pas le reste de ses scripts.
- **Build reproductible.** Les images de base sont épinglées par empreinte
  (`@sha256:…`), le dépôt du repli par commit (`FALLBACK_REF`), les paquets
  Python par version exacte, et les actions GitHub par SHA. Dependabot
  (`.github/dependabot.yml`) propose les mises à jour chaque semaine ; le
  commit du dépôt de repli se met à jour à la main (voir le `Dockerfile`).
- **Sonde de santé intégrée** : `HEALTHCHECK` interroge `/api/health` avec
  Node, sans `curl` ni outil supplémentaire.
- **`node_modules` est élagué** par `docker/prune-node-modules.mjs` :
  `gtfs-realtime-bindings` déclare `protobufjs-cli` en dépendance normale, qui
  tire `jsdoc` et toute sa chaîne (`@babel`, `lodash`, `underscore`,
  `markdown-it`…) alors que seul le décodeur `protobufjs` sert à l'exécution.
  Le script calcule la fermeture transitive des dépendances de production à
  partir de `package.json` et supprime le reste — soit 24 Mo sur 35. Le calcul
  étant refait à chaque build, il ne se périme pas quand les dépendances
  changent. En local : `DRY_RUN=1 node docker/prune-node-modules.mjs .` montre
  ce qui serait supprimé sans rien toucher.
- En production le conteneur tourne en **lecture seule**, sans capacité Linux
  (`cap_drop: ALL`), `no-new-privileges`, avec `/tmp` en mémoire et une limite
  de 512 Mo de mémoire. L'application n'écrit rien sur disque : son cache et la
  mémoire des positions de véhicules vivent dans le processus.

## Développement local

Prérequis : Docker Engine et **Compose v2.24 ou plus récent** (Docker Desktop
sous Windows ou macOS fournit les deux ; la version de Compose est nécessaire
pour la syntaxe `env_file: required: false`, qui rend le fichier `.env`
optionnel). Vérifie avec `docker compose version`.

```bash
cp .env.example .env     # facultatif : rien n'est obligatoire
docker compose up --build
```

Le `Makefile` ne sert qu'à raccourcir ces commandes ; il demande `make`, absent
de Windows par défaut. Chaque cible a un équivalent portable dans
`package.json` :

| Makefile | npm | docker compose |
|---|---|---|
| `make dev` | `npm run docker:dev` | `docker compose up --build` |
| `make down` | `npm run docker:down` | `docker compose down` |
| `make logs` | `npm run docker:logs` | `docker compose logs -f` |
| `make build` | `npm run docker:build` | `docker build -t linerelay:dev .` (avec `make`, l'image s'appelle `ghcr.io/tritrifix/linerelay:dev`) |
| `make deploy` | `npm run docker:deploy` | `docker compose -f compose.prod.yaml pull && … up -d` |

La carte répond sur <http://localhost:3000>. Si ce port est déjà pris :

```bash
PORT=8080 make dev                     # ou : PORT=8080 docker compose up --build
```

`PORT` vaut pour le conteneur **et** pour le port publié sur l'hôte, en dev
comme en prod. Pour le changer durablement, mettez `PORT=8080` dans `.env` :
Compose, `make` et le serveur Node le lisent tous. `HOST_PORT` ne sert qu'à
dissocier les deux côtés (voir *Variables d'environnement*).

Le code est monté depuis l'hôte **fichier par fichier** (`server.js`,
`public/app.js`, `public/index.html`, `public/style.css`,
`fallback_gtfs.py`) et lancé avec `node --watch` : sauvegarder dans ton éditeur
redémarre le serveur. Les fichiers sont montés en lecture seule — le conteneur
ne peut pas modifier tes sources.

> **Après un changement de branche, rétablis les montages.** Un montage fichier
> par fichier suit le fichier d'origine, pas son nom : quand Git (`git switch`,
> `git merge`, `git pull`) ou un outil qui écrit par remplacement (*safe write*
> de WebStorm, assistant de code) remplace le fichier, le conteneur garde
> l'ancien. Les modifications ne sont plus vues, et le serveur peut s'arrêter
> sur `ENOENT: no such file or directory, open '/app/server.js'`.
> `docker compose restart app` ou `docker compose up -d --force-recreate`
> rétablit les montages. `make up` ne suffit pas : il ne recrée pas un
> conteneur dont la configuration n'a pas changé.

> Le dossier `public/` n'est volontairement **pas** monté en entier : cela
> masquerait le `public/traces.json` généré dans l'image, et la carte perdrait
> ses tracés. Un nouveau fichier statique doit donc être ajouté à la liste des
> volumes de `compose.yaml` (et au `Dockerfile`).

Commandes courantes (via `make`, ou leurs équivalents du tableau ci-dessus) :

```bash
make up        # arrière-plan
make logs      # suivre les logs
make sh        # shell dans le conteneur
make down      # arrêt
make smoke     # construit l'image de prod et vérifie /api/health
```

### Côté WebStorm

- *Settings → Build, Execution, Deployment → Docker* : connecte le daemon local.
- `compose.yaml` est reconnu : WebStorm propose une configuration *Docker
  Compose* exécutable directement (bouton ▶).
- Pour déboguer avec des points d'arrêt, lance plutôt l'application hors
  conteneur (`npm start`) et garde Docker pour la validation avant déploiement :
  l'attachement du débogueur Node à un conteneur demande d'exposer le port
  d'inspection, ce qui n'est pas configuré ici.

## Publier une image

### Par GitHub Actions (recommandé)

`.github/workflows/docker-publish.yml` construit l'image, vérifie qu'elle
démarre sous les contraintes de la production (lecture seule, sans capacité
Linux, sonde `/api/health`), puis la publie sur GHCR. Aucun secret à
configurer : le workflow utilise le `GITHUB_TOKEN` fourni par Actions, avec la
permission `packages: write`.

| Déclencheur | Tags publiés |
|---|---|
| push sur `main` | `:main`, `:sha-<court>` |
| tag Git `v1.2.3` | `:1.2.3`, `:1.2`, `:1`, `:latest`, `:sha-<court>` |
| pull request vers `main` | build et vérification, **sans** publication |

Les tags d'image n'ont **pas** le préfixe `v` du tag Git : le tag Git `v1.1.0`
publie l'image `:1.1.0`. Un push sur `main` ne déplace pas `:latest` ; seul un
tag de version le fait.

Pour sortir une version, aligne d'abord `version` dans `package.json`
(`npm version <X.Y.Z> --no-git-tag-version`, dans une pull request), complète
`CHANGELOG.md`, puis, une fois le tout fusionné dans `main` :

```bash
git tag v<X.Y.Z> && git push origin v<X.Y.Z>     # par exemple v1.1.0
```

> Le dépôt `tritrifix/linerelay` et son paquet GHCR sont **publics** : tirer
> l'image ne demande aucune authentification. Seule la publication à la main
> (ci-dessous) demande un `docker login`.

### À la main depuis ta machine

```bash
echo "<TON_TOKEN>" | docker login ghcr.io -u <TON_COMPTE_GITHUB> --password-stdin
TAG=<X.Y.Z> make push                            # par exemple TAG=1.1.0
```

`<TON_TOKEN>` est un *personal access token* (classique) avec la portée
`write:packages`. Ne l'écris jamais dans un fichier du dépôt ni dans
l'historique du shell : préfère une variable d'environnement ou
`docker login` en mode interactif. `make push` publie le seul tag demandé, sans
la vérification de démarrage ni les tags `:1.1`, `:1` et `:latest` du workflow.

## Déployer en production

### Une fois, sur le serveur

1. **Installer Docker** (dépôt officiel, Ubuntu) :

   ```bash
   sudo apt-get update && sudo apt-get install -y ca-certificates curl
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt-get update
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   sudo usermod -aG docker "$USER"   # puis se reconnecter
   ```

2. **Récupérer le dépôt** (seuls `compose.prod.yaml` et, si tu en as un, ton
   `.env` servent au déploiement) :

   ```bash
   git clone https://github.com/tritrifix/linerelay.git <DOSSIER_DEPLOIEMENT>
   cd <DOSSIER_DEPLOIEMENT>
   ```

   Le dépôt et l'image étant publics, ni clé SSH ni `docker login` ne sont
   nécessaires.

3. **Libérer le port 3000** s'il est occupé par une ancienne installation hors
   Docker :

   ```bash
   cd <ANCIENNE_INSTALLATION> && ./start.sh stop
   crontab -l | grep -v 'start.sh' | crontab -   # retire le démarrage au boot
   ```

   Relis l'entrée `crontab -l` avant de la supprimer : elle pointe vers le
   dossier de l'ancienne installation, qui peut porter un autre nom. Tu peux
   aussi garder les deux en parallèle le temps de la bascule, avec `PORT=3001`
   pour le conteneur.

### À chaque déploiement

```bash
cd <DOSSIER_DEPLOIEMENT>
git pull
docker compose -f compose.prod.yaml pull
docker compose -f compose.prod.yaml up -d
```

(`make deploy` ou `npm run docker:deploy` font la même chose. `make` n'est pas
installé sur le serveur par défaut : `sudo apt-get install -y make` si tu veux
les raccourcis.)

`restart: unless-stopped` fait repartir le conteneur au démarrage de la
machine : la tâche `cron @reboot` de l'installation hors Docker n'est plus
nécessaire.

Déployer une version précise, et revenir en arrière si besoin :

```bash
export LINERELAY_IMAGE=ghcr.io/tritrifix/linerelay:1.1.0
docker compose -f compose.prod.yaml up -d
```

Pour revenir en arrière, la même commande avec le tag précédent
(`:1.0.0`). Les versions publiées sont listées dans
[CHANGELOG.md](../CHANGELOG.md).

> **Architecture de l'image.** Le workflow publie une image `linux/amd64`, qui
> correspond au serveur. Si tu développes sur un Mac Apple Silicon, tes builds
> locaux seront en `arm64` : c'est transparent en local, mais l'image testée
> chez toi n'est alors pas exactement celle déployée. Pour une image
> multi-architecture, ajoute `platforms: linux/amd64,linux/arm64` aux étapes
> *Construire* et *Publier* du workflow, avec l'action
> `docker/setup-qemu-action` juste avant Buildx, épinglée par SHA comme les
> autres (le build devient nettement plus long).

### Surveiller

```bash
docker compose -f compose.prod.yaml ps        # état et santé
docker compose -f compose.prod.yaml logs -f   # logs (10 Mo × 3 fichiers max)
curl -s localhost:3000/api/health             # adaptez si PORT n'est pas 3000
```

## Variables d'environnement

Toutes sont optionnelles et ont une valeur par défaut. Celles lues par Compose
(`PORT`, `HOST_PORT`, `TZ`, `LINERELAY_IMAGE`, `SKIP_TRACES`, `GTFS_STATIC_URL`)
viennent du fichier `.env` à la racine ; celles lues par l'application lui sont
transmises par `env_file`.

| Variable | Portée | Rôle |
|---|---|---|
| `PORT` | Compose et application | port d'écoute, et port publié sur l'hôte par défaut (défaut `3000`) |
| `HOST_PORT` | Compose | port publié sur l'hôte **uniquement** s'il doit différer de `PORT` |
| `TZ` | Compose | fuseau du conteneur (défaut `Europe/Paris`) |
| `LINERELAY_IMAGE` | Compose (prod) | image à déployer (défaut `:latest`) |
| `SKIP_TRACES` | build | `1` pour construire sans réseau |
| `VEHICLE_FEED_URL`, `TRIPUPDATE_FEED_URL` | application | flux GTFS-RT |
| `VELODI_FEED_URL`, `VELODI_ORG_ID` | application | couche vélos ; URL vide = désactivée |
| `GTFS_STATIC_URL` | build et `build:traces` | jeu de données GTFS statique |
| `RATE_LIMIT_MAX`, `CACHE_MAX_ENTRIES` | application | garde-fous de l'API (défauts `120` par minute et `2000` entrées) |
| `TRUST_PROXY` | application | derrière un reverse proxy : nombre de proxys de confiance, pour limiter le débit par visiteur |

## Ce que Docker ne reprend pas

`install.sh` et `start.sh` restent dans le dépôt pour l'installation hors
conteneur, mais ne servent plus en mode Docker : plus de PM2, plus de PID-file,
plus de `cron @reboot`, plus de `server.log` (les logs vont sur la sortie
standard, gérée par Docker).
