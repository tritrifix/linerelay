# Journal des modifications

Les changements notables de LineRelay, version par version. Le format suit
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et les numéros de
version le [versionnage sémantique](https://semver.org/lang/fr/).

Un tag Git `vX.Y.Z` publie l'image `ghcr.io/tritrifix/linerelay` sous les tags
`X.Y.Z`, `X.Y`, `X` et `latest` (voir [docs/DOCKER.md](docs/DOCKER.md)).

## [1.1.0] - 2026-11-15

### Ajouté

- **Direction des véhicules** : flèche de sens de marche autour de chaque
  véhicule, tournée selon son cap ; creuse quand le cap est estimé, absente
  quand le véhicule est à l'arrêt ou que son sens est inconnu. La fiche du
  véhicule donne sa destination et son cap en toutes lettres, et la légende
  explique la flèche.
- `GET /api/lines/:lineId/vehicles` : champs optionnels `heading`,
  `headingSource` (`bearing`, `estimé`, `inconnu`), `stopped`, `speedReliable`,
  `directionId` et `destination`. Les champs existants sont inchangés.
- Estimation du cap à partir de deux positions successives quand le flux ne le
  fournit pas, ou quand son `bearing` est démenti par le déplacement constaté.
- Interface adaptée aux téléphones, aux tablettes et aux grands écrans ;
  légende repliable sur petit écran.
- Limite de débit de l'API (`RATE_LIMIT_MAX`, réponse `429`), borne du cache en
  mémoire (`CACHE_MAX_ENTRIES`), prise en charge d'un reverse proxy
  (`TRUST_PROXY`) et en-têtes de sécurité HTTP.
- `GET /api/lines/:lineId/delays` : retards limités à la ligne demandée.
- Suite de tests `node:test`, sans dépendance ni appel réseau, lancée par
  GitHub Actions sous Node 18 et Node 20.
- Vérification de l'image sous les contraintes de production avant sa
  publication sur GHCR.

### Modifié

- Les véhicules ne sont plus redessinés à chaque rafraîchissement : les
  marqueurs sont conservés, et une fiche ouverte le reste.
- Une vitesse supérieure à 100 km/h, valeur aberrante du flux, n'est plus
  affichée.
- Build reproductible : images de base, dépôt du repli, paquets Python et
  actions GitHub épinglés ; mises à jour proposées par Dependabot.
- Dépendances mises à jour, dont `express` 5.3.0, `divia-api` 3.0.4 et
  `gtfs-realtime-bindings` 2.2.0.

### Corrigé

- Validation des entrées de l'API : `limit` borné, arrêt étranger à la ligne
  refusé, erreurs renvoyées en JSON sans pile d'appels.
- Appels aux sources externes : délai maximal, mutualisation des appels
  simultanés, échec non retenté pendant quelques secondes.
- Heures de service décalées d'une à deux heures.
- Retards d'un arrêt partagé attribués à la mauvaise ligne.
- Affichage sur écran étroit, navigation au clavier et contrastes.
- Véhicules introuvables pour les tramways et les lianes dans une image
  construite sans tracés.

## [1.0.0] - 2026-11-12

Première version publiée : carte Leaflet d'une ligne à la fois (tracé, arrêts,
prochains passages, véhicules en temps réel), retards, stations de vélos en
libre-service, image Docker et déploiement par Compose.

[1.1.0]: https://github.com/tritrifix/linerelay/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tritrifix/linerelay/releases/tag/v1.0.0
