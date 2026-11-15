/**
 * server.js — Backend de LineRelay, carte temps réel des transports en
 * commun de Dijon Métropole (projet indépendant, non affilié à l'exploitant).
 *
 * Multi-lignes : expose le catalogue de TOUTES les lignes (bus + tram) ; le
 * frontend n'en affiche qu'une à la fois (sélecteur), ce qui limite les
 * requêtes, évite les superpositions de tracés et les bugs d'affichage.
 *
 * Sources (sans clé API) :
 *   - divia-api (proxy Navitia)      : lignes, arrêts, horaires
 *   - flux GTFS-RT (transport.gouv)  : positions des véhicules (décodé en Node)
 *   - GTFS statique (traces.json)    : tracé réel de chaque ligne
 *   - fallback Python GTFS-RT        : repli horaires (ligne L5) si Navitia
 *                                      est en erreur ou ne renvoie aucun passage
 *
 * Robustesse : cache par ressource avec TTL ; en cas d'échec réseau on
 * renvoie la dernière valeur connue (drapeau `stale`).
 */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const express = require("express");
const divia = require("divia-api");
const GtfsRT = require("gtfs-realtime-bindings");

/**
 * Charge le fichier `.env` du projet s'il existe, sans dépendance externe
 * (Node 18 ne connaît pas encore `--env-file`). Les variables déjà présentes
 * dans l'environnement restent prioritaires : `PORT=8080 npm start`, Docker
 * Compose ou systemd gagnent toujours sur le fichier.
 *
 * Format accepté : `CLE=valeur`, guillemets simples ou doubles optionnels,
 * `#` en début de ligne ou après la valeur pour un commentaire. Les valeurs
 * sur plusieurs lignes ne sont pas gérées (aucun besoin ici).
 */
function loadDotEnv(file = path.join(__dirname, ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // pas de .env : on s'en tient aux valeurs par défaut
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue; // ligne vide ou commentaire
    const key = m[1];
    let value = m[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

// Configuration : tout est surchargeable par variable d'environnement
// (cf. .env.example). Les valeurs par défaut ciblent le réseau de Dijon.
//
// PORT est le seul réglage à changer pour déplacer le serveur : il vaut pour
// `npm start`, `npm run dev`, Docker (port interne) et Compose (port publié
// sur l'hôte, sauf si HOST_PORT le dissocie).
// PORT=0 est accepté : le système attribue alors un port libre, affiché au
// démarrage. Une valeur non numérique est une erreur de configuration, pas un
// retour silencieux à 3000 : on s'arrête tout de suite.
const PORT =
  process.env.PORT === undefined || process.env.PORT.trim() === ""
    ? 3000
    : Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`PORT invalide : « ${process.env.PORT} » (attendu : 0-65535).`);
  process.exit(1);
}

const VEHICLE_FEED =
  process.env.VEHICLE_FEED_URL ||
  "https://proxy.transport.data.gouv.fr/resource/divia-dijon-gtfs-rt-vehicle-position";
const TRIPUPDATE_FEED =
  process.env.TRIPUPDATE_FEED_URL ||
  "https://proxy.transport.data.gouv.fr/resource/divia-dijon-gtfs-rt-trip-update";
// Disponibilités temps réel des vélos en libre-service (backend Cykleo,
// organization_id=1 = Dijon). Les anciens flux open data ne répondent plus.
// VELODI_FEED_URL="" désactive proprement la couche vélos.
const VELODI_BASE =
  process.env.VELODI_FEED_URL !== undefined
    ? process.env.VELODI_FEED_URL
    : "https://portail.cykleo.fr/pu/stations/availability";
const VELODI_ORG_ID = process.env.VELODI_ORG_ID || "1";
const VELODI_FEED = VELODI_BASE
  ? `${VELODI_BASE}?organization_id=${encodeURIComponent(VELODI_ORG_ID)}`
  : null;
const GTFS_LINE_TOTEM = { L5: "87" }; // ids TOTEM connus pour le fallback Python

// Garde-fous (cf. .env.example). Un entier positif est attendu ; toute autre
// valeur ramène au défaut plutôt que de désactiver la protection par erreur.
function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
const RATE_LIMIT_MAX = intEnv("RATE_LIMIT_MAX", 120); // requêtes /api par minute et par adresse
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = intEnv("CACHE_MAX_ENTRIES", 2000);

/** Erreur portant un statut HTTP (404 pour une ressource inconnue, etc.). */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const app = express();
app.disable("x-powered-by");
// Derrière un reverse proxy, TRUST_PROXY=1 fait lire l'adresse du client dans
// X-Forwarded-For ; sans cela la limite de débit s'appliquerait au proxy.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

/* ------------------------------------------------------------------ */
/*  En-têtes de sécurité                                               */
/* ------------------------------------------------------------------ */
// La page ne charge que ses propres fichiers, Leaflet (unpkg, avec SRI) et
// les tuiles OpenStreetMap : la politique de contenu n'autorise rien d'autre.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' https://unpkg.com",
  "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  next();
}

/* ------------------------------------------------------------------ */
/*  Limite de débit de l'API (fenêtre fixe, par adresse, en mémoire)   */
/* ------------------------------------------------------------------ */
// Chaque appel d'API peut déclencher une requête vers une source open data :
// la limite protège ces sources autant que le serveur. Le front en émet
// trois à quatre par demi-minute ; 120 par minute laisse une marge large.
function createRateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map(); // adresse -> { count, resetAt }
  const check = (key) => {
    const t = now();
    let h = hits.get(key);
    if (!h || t >= h.resetAt) {
      h = { count: 0, resetAt: t + windowMs };
      hits.set(key, h);
    }
    h.count++;
    return { allowed: h.count <= max, remaining: Math.max(0, max - h.count), resetAt: h.resetAt };
  };
  const sweep = () => {
    const t = now();
    for (const [key, h] of hits) if (t >= h.resetAt) hits.delete(key);
  };
  return { check, sweep, size: () => hits.size };
}

const apiLimiter = createRateLimiter({ max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });
setInterval(apiLimiter.sweep, RATE_LIMIT_WINDOW_MS).unref();

function rateLimit(req, res, next) {
  if (req.path === "/health") return next(); // la sonde de santé n'est jamais limitée
  const r = apiLimiter.check(req.ip || "inconnu");
  res.setHeader("RateLimit-Limit", String(RATE_LIMIT_MAX));
  res.setHeader("RateLimit-Remaining", String(r.remaining));
  if (r.allowed) return next();
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000))));
  res.status(429).json({ error: "Trop de requêtes", detail: "Limite de débit atteinte, réessayez dans un instant." });
}

/* ------------------------------------------------------------------ */
/*  Tracés statiques (traces.json) : route_id GTFS -> polylignes        */
/* ------------------------------------------------------------------ */
let TRACES = {};
let SHORT_TO_ROUTE = {}; // route_short_name -> route_id GTFS
try {
  TRACES = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "traces.json"), "utf8"));
  for (const [rid, t] of Object.entries(TRACES)) {
    if (t.short_name) SHORT_TO_ROUTE[t.short_name] = rid;
  }
  console.log(`[traces] ${Object.keys(TRACES).length} tracés de lignes chargés`);
} catch (e) {
  console.warn("[traces] traces.json absent — tracés désactivés (lancez tools/build_traces.py)");
}

// Relie un code de ligne Navitia (ex "B10", "L5", "T1") à son route_id GTFS.
function resolveGtfsRouteId(code) {
  if (SHORT_TO_ROUTE[code]) return SHORT_TO_ROUTE[code];
  const stripped = code.replace(/^[A-Za-z]+/, ""); // B10->10, R30->30, BC61->61
  if (stripped && SHORT_TO_ROUTE[stripped]) return SHORT_TO_ROUTE[stripped];
  // Repli sans tracé (build SKIP_TRACES=1) : l'identifiant est construit, pour
  // que les véhicules restent retrouvés. Tramways et lianes gardent leur code
  // (T1 -> 4-T1, L5 -> 4-L5) ; les autres lignes numérotées perdent leur
  // préfixe (B10 -> 4-10) ; un code sans chiffre est repris tel quel.
  return "4-" + (/^[TL]\d+$/.test(code) ? code : stripped || code);
}

/* ------------------------------------------------------------------ */
/*  Cache générique avec TTL + repli sur valeur périmée                */
/* ------------------------------------------------------------------ */
const store = new Map();

// Écrit une entrée en la plaçant en fin de Map, puis évince les plus
// anciennes au-delà de la borne : la mémoire reste bornée quel que soit le
// nombre de clés distinctes demandées.
function storeSet(key, entry, max = CACHE_MAX_ENTRIES) {
  store.delete(key);
  store.set(key, entry);
  while (store.size > max) store.delete(store.keys().next().value);
}

const inflight = new Map(); // clé -> promesse du producteur en cours
const failures = new Map(); // clé -> { err, until } : échec récent, non retenté
const FAILURE_TTL_MS = 5000;

// Un seul appel au producteur par clé à la fois : les requêtes simultanées
// attendent le même résultat. Un échec est retenu quelques secondes, pour
// qu'une source en panne ne soit pas rappelée à chaque requête entrante.
function produce(key, producer, now) {
  const failed = failures.get(key);
  if (failed && now < failed.until) return Promise.reject(failed.err);
  let pending = inflight.get(key);
  if (!pending) {
    pending = Promise.resolve()
      .then(producer)
      .then(
        (value) => {
          failures.delete(key);
          return value;
        },
        (err) => {
          failures.set(key, { err, until: Date.now() + FAILURE_TTL_MS });
          while (failures.size > CACHE_MAX_ENTRIES) failures.delete(failures.keys().next().value);
          console.warn(`[source] ${key.slice(0, 120)} : ${err.message}`);
          throw err;
        }
      )
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

async function cached(key, ttlMs, producer) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < ttlMs) return { value: hit.value, stale: false, cachedAt: hit.ts };
  try {
    const value = await produce(key, producer, now);
    storeSet(key, { value, ts: now });
    return { value, stale: false, cachedAt: now };
  } catch (err) {
    // Repli sur la dernière valeur connue, signalée par le drapeau `stale`.
    if (hit) return { value: hit.value, stale: true, cachedAt: hit.ts, error: err.message };
    throw err;
  }
}

// Toutes les sources externes ont un délai maximal : sans lui, une source
// muette garderait la requête du visiteur ouverte indéfiniment.
const SOURCE_TIMEOUT_MS = 5000;
function fetchSource(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
}

/* ------------------------------------------------------------------ */
/*  Catalogue des lignes (bus + tram)                                  */
/* ------------------------------------------------------------------ */
// Heures de service : divia-api renvoie un objet Date construit en heure
// locale du processus (05h05 de service = 05:05 locales, quel que soit TZ).
// On lit donc les composantes locales ; lire les composantes UTC décalait
// l'affichage d'une heure (deux en été) avec TZ=Europe/Paris.
// Renvoie "HH:MM" ou null si absent.
function fmtServiceTime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

async function getCatalog() {
  const { value } = await cached("catalog", 60 * 60 * 1000, async () => {
    const [tram, bus] = await Promise.all([
      divia.listLines("tramway").catch(() => []),
      divia.listLines("bus").catch(() => []),
    ]);
    const mk = (l, mode) => {
      const gtfsRouteId = resolveGtfsRouteId(l.code);
      return {
        id: l.id,
        code: l.code,
        name: l.name,
        color: l.color ? `#${l.color}` : (TRACES[gtfsRouteId] || {}).color || "#888888",
        textColor: l.text_color ? `#${l.text_color}` : "#FFFFFF",
        openingTime: fmtServiceTime(l.opening_time),
        closingTime: fmtServiceTime(l.closing_time),
        mode,
        gtfsRouteId,
        hasTrace: !!TRACES[gtfsRouteId],
      };
    };
    const lines = [...tram.map((l) => mk(l, "tram")), ...bus.map((l) => mk(l, "bus"))];
    if (!lines.length) throw new Error("aucune ligne renvoyée par Navitia");
    return lines;
  });
  return value;
}

async function getLine(lineId) {
  const line = (await getCatalog()).find((l) => l.id === lineId);
  if (!line) throw new HttpError(404, `ligne inconnue : ${lineId}`);
  return line;
}

/* ------------------------------------------------------------------ */
/*  Arrêts / horaires (divia-api)                                      */
/* ------------------------------------------------------------------ */
function gtfsStopCode(stopArea) {
  for (const c of [stopArea.id, ...(stopArea.codes || []).map((c) => c.value)]) {
    const m = String(c).match(/4-(\d+)/);
    if (m) return m[1];
  }
  return null;
}

async function getStops(lineId) {
  const line = await getLine(lineId);
  const { value, cachedAt } = await cached(`stops:${lineId}`, 60 * 60 * 1000, async () => {
    const stops = await divia.listStops(line.id);
    return stops
      .filter((s) => s.coord && s.coord.lat && s.coord.lon)
      .map((s) => ({ id: s.id, name: s.name, lat: s.coord.lat, lon: s.coord.lon, gtfsCode: gtfsStopCode(s) }));
  });
  return { line, stops: value, cachedAt };
}

function transformSchedules(schedules) {
  const now = Date.now();
  const passages = [];
  for (const s of schedules || []) {
    const direction = (s.display_informations && s.display_informations.direction) || "—";
    for (const dt of s.date_times || []) {
      const t = new Date(dt.date_time).getTime();
      if (isNaN(t) || t < now - 60000) continue;
      passages.push({
        time: new Date(t).toISOString(),
        minutes: Math.max(0, Math.round((t - now) / 60000)),
        direction,
        realtime: dt.data_freshness === "realtime",
      });
    }
  }
  passages.sort((a, b) => new Date(a.time) - new Date(b.time));
  return passages;
}

// Seuls les arrêts de la ligne sont acceptés : un identifiant arbitraire ne
// peut ni remplir le cache ni être relayé vers Navitia.
async function assertStopOfLine(lineId, stopId) {
  const { stops } = await getStops(lineId);
  if (!stops.some((s) => s.id === stopId)) {
    throw new HttpError(404, `arrêt inconnu sur cette ligne : ${String(stopId).slice(0, 80)}`);
  }
}

// Le repli sert dans deux cas : la source principale répond sans passage, ou
// elle est en erreur. Sans repli utilisable, l'erreur d'origine remonte (et
// cached() sert alors la dernière valeur connue).
async function schedulesWithFallback(primary, fallback) {
  let passages = [];
  let primaryError = null;
  try {
    passages = (await primary()) || [];
  } catch (err) {
    primaryError = err;
  }
  if (passages.length) return { passages, source: "divia-api" };
  const fb = await fallback();
  if (fb && fb.length) return { passages: fb, source: "gtfs-rt-fallback" };
  if (primaryError) throw primaryError;
  return { passages, source: "divia-api" };
}

async function getStopSchedules(lineId, stopId, limit = 3) {
  const line = await getLine(lineId);
  const { value, stale, cachedAt, error } = await cached(`sched:${lineId}:${stopId}`, 30 * 1000, async () => {
    return schedulesWithFallback(
      async () => transformSchedules(await divia.getSchedules(line.id, stopId)),
      () => pythonFallback(line.code, stopId)
    );
  });
  return { stopId, passages: value.passages.slice(0, limit), source: value.source, stale: !!stale, cachedAt, error };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getAllSchedules(lineId, limit = 3) {
  const { stops, line } = await getStops(lineId);
  const { value, cachedAt, stale } = await cached(`all:${lineId}:${limit}`, 45 * 1000, async () =>
    mapLimit(stops, 5, async (s) => {
      try {
        const r = await getStopSchedules(lineId, s.id, limit);
        return { stopId: s.id, name: s.name, passages: r.passages, source: r.source };
      } catch (e) {
        return { stopId: s.id, name: s.name, passages: [], error: e.message };
      }
    })
  );
  return { line, schedules: value, cachedAt, stale: !!stale };
}

/* ------------------------------------------------------------------ */
/*  Cap des véhicules (fonctions pures)                                */
/* ------------------------------------------------------------------ */
// En dessous de cette distance entre deux relevés, le bruit GPS domine : ni
// cap estimé, ni déplacement constaté.
const HEADING_MIN_DISTANCE_M = 15;
// Une position de référence plus ancienne ne sert plus à estimer un cap.
const HEADING_MEMORY_MS = 5 * 60 * 1000;
// Le flux publie parfois des vitesses aberrantes (plus de 130 km/h en ville) :
// au-delà de ce seuil, la valeur est signalée comme non fiable.
const SPEED_MAX_PLAUSIBLE_KMH = 100;
const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

const own = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);
const validPos = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

// Ramène un cap dans [0, 360). null si la valeur n'est pas un nombre fini.
// 0 est un cap valide (plein nord) et ne doit jamais être confondu avec l'absence.
function normalizeBearing(deg) {
  if (deg == null || deg === "" || typeof deg === "boolean") return null;
  const n = Number(deg);
  if (!Number.isFinite(n)) return null;
  return (Math.round((((n % 360) + 360) % 360) * 10) / 10) % 360;
}

// Distance en mètres entre deux positions { lat, lon } (formule de haversine).
function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Azimut initial de `from` vers `to`, en degrés dans [0, 360) : 0 = nord,
// 90 = est. atan2 renvoie (-180, 180] ; le modulo gère le passage par le nord.
function bearingBetween(from, to) {
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Écart angulaire entre deux caps, dans [0, 180] (359° et 1° sont à 2°).
function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
const HEADING_CONTRADICTION_MIN_M = 40;
const HEADING_CONTRADICTION_DEG = 120;

// Cap d'un véhicule et provenance de l'information :
//   "bearing" : champ bearing du flux ;
//   "estimé"  : azimut entre deux positions successives assez éloignées ;
//   "inconnu" : information insuffisante, heading vaut null.
//
// Le bearing du flux est prioritaire, sauf s'il est démenti par un déplacement
// net : il arrive que le flux annonce le cap opposé au sens de marche réel
// (tramway constaté à 251° alors qu'il avançait à 71°). Un écart d'au moins
// 120° sur au moins 40 m ne s'explique ni par un virage ni par le bruit GPS :
// le cap estimé l'emporte alors, et il est signalé comme tel.
function computeHeading({ bearing, prev, cur, minDistanceM = HEADING_MIN_DISTANCE_M } = {}) {
  const fromFeed = normalizeBearing(bearing);
  const moved = validPos(prev) && validPos(cur) ? distanceMeters(prev, cur) : 0;
  const estimated = moved >= minDistanceM ? normalizeBearing(Math.round(bearingBetween(prev, cur))) : null;
  if (fromFeed != null) {
    const contradicted =
      estimated != null && moved >= HEADING_CONTRADICTION_MIN_M && angleDiff(fromFeed, estimated) >= HEADING_CONTRADICTION_DEG;
    return contradicted ? { heading: estimated, source: "estimé" } : { heading: fromFeed, source: "bearing" };
  }
  if (estimated != null) return { heading: estimated, source: "estimé" };
  return { heading: null, source: "inconnu" };
}

// Terminus de chaque sens : nom de l'arrêt le plus proche du dernier point de
// la polyligne du sens (la plus détaillée si plusieurs variantes). Renvoie
// { direction_id -> nom } ; un sens sans arrêt assez proche est omis.
function terminusByDirection(polylines, stops, maxDistanceM = 500) {
  const longest = {};
  for (const pl of polylines || []) {
    const pts = (pl && pl.points) || [];
    if (pts.length < 2 || pl.direction == null) continue;
    const d = String(pl.direction);
    if (!longest[d] || pts.length > longest[d].length) longest[d] = pts;
  }
  const out = {};
  for (const [d, pts] of Object.entries(longest)) {
    const last = pts[pts.length - 1];
    const end = { lat: Number(last[0]), lon: Number(last[1]) };
    if (!validPos(end)) continue;
    let best = null;
    for (const s of stops || []) {
      if (!validPos(s)) continue;
      const dist = distanceMeters(end, s);
      if (dist <= maxDistanceM && (!best || dist < best.dist)) best = { dist, name: s.name };
    }
    if (best && best.name) out[d] = best.name;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Positions des véhicules (GTFS-RT, décodage natif Node)             */
/*  Le flux est décodé une fois et indexé par route_id (TTL 10 s),     */
/*  donc changer de ligne ne déclenche pas de nouvelle requête.        */
/* ------------------------------------------------------------------ */
// Indexe un flux décodé par route_id. `memory` (id -> { lat, lon, ts }) garde
// une position de référence par véhicule d'un relevé à l'autre : elle sert à
// estimer le cap quand le flux ne le donne pas, et à constater l'immobilité.
// La référence n'avance que lorsque le véhicule s'est réellement déplacé, pour
// qu'une progression lente finisse par être mesurable.
function buildVehicleIndex(feed, memory = new Map(), now = Date.now()) {
  const byRoute = {};
  const stats = { total: 0, bearing: 0, estimated: 0, unknown: 0, stopped: 0, unreliableSpeed: 0 };
  for (const e of (feed && feed.entity) || []) {
    const v = e.vehicle;
    if (!v || !v.trip || !v.trip.routeId || !v.position) continue;
    const id = (v.vehicle && (v.vehicle.label || v.vehicle.id)) || e.id;
    const cur = { lat: v.position.latitude, lon: v.position.longitude };
    // Ce flux publie la vitesse en km/h (entiers de 0 à 65 environ), et non
    // en m/s comme le prévoit la spécification GTFS-RT : transmise telle quelle.
    const speed = own(v.position, "speed") ? v.position.speed : null;

    let ref = id != null ? memory.get(id) : null;
    if (ref && now - ref.ts > HEADING_MEMORY_MS) ref = null;
    const moved = ref && validPos(cur) ? distanceMeters(ref, cur) : null;
    if (id != null && validPos(cur) && (!ref || moved >= HEADING_MIN_DISTANCE_M)) {
      memory.set(id, { lat: cur.lat, lon: cur.lon, ts: now });
    }

    // Un champ absent du message protobuf vaut 0 par défaut : seule sa
    // présence réelle distingue « plein nord » de « non renseigné ».
    const { heading, source } = computeHeading({
      bearing: own(v.position, "bearing") ? v.position.bearing : null,
      prev: ref,
      cur,
    });
    // « 0 km/h » seul ne suffit pas (le flux l'annonce pour des véhicules qui
    // avancent) : à l'arrêt = vitesse nulle et aucun déplacement constaté.
    const stopped = speed === 0 && !(moved != null && moved >= HEADING_MIN_DISTANCE_M);
    const speedReliable = speed == null ? null : speed >= 0 && speed <= SPEED_MAX_PLAUSIBLE_KMH;

    stats.total++;
    stats[source === "bearing" ? "bearing" : source === "estimé" ? "estimated" : "unknown"]++;
    if (stopped) stats.stopped++;
    if (speedReliable === false) stats.unreliableSpeed++;

    (byRoute[v.trip.routeId] = byRoute[v.trip.routeId] || []).push({
      id,
      lat: cur.lat,
      lon: cur.lon,
      bearing: v.position.bearing || null, // champ historique, inchangé (0 y devient null)
      speed,
      tripId: v.trip.tripId || null,
      // Champs ajoutés, tous optionnels pour un client existant :
      heading, // cap en degrés [0, 360), ou null
      headingSource: source, // "bearing" | "estimé" | "inconnu"
      stopped,
      speedReliable, // false : vitesse aberrante, à ne pas afficher ; null : vitesse absente
      directionId: own(v.trip, "directionId") ? v.trip.directionId : null,
    });
  }
  for (const [id, ref] of memory) if (now - ref.ts > HEADING_MEMORY_MS) memory.delete(id);
  return { byRoute, stats };
}

const vehicleMemory = new Map(); // id véhicule -> position de référence
let lastHeadingLog = "";

// Signale dans les logs les caps estimés ou inconnus et les vitesses
// écartées, seulement quand le décompte change (le flux est relu toutes les 10 s).
function logHeadingStats(stats) {
  const line =
    stats.estimated || stats.unknown || stats.unreliableSpeed
      ? `[cap] ${stats.total} véhicules : ${stats.bearing} cap(s) du flux, ${stats.estimated} estimé(s), ` +
        `${stats.unknown} inconnu(s), ${stats.unreliableSpeed} vitesse(s) non fiable(s)`
      : "";
  if (line && line !== lastHeadingLog) console.log(line);
  lastHeadingLog = line;
}

async function getVehicleIndex() {
  const { value, cachedAt, stale } = await cached("veh-index", 10 * 1000, async () => {
    const res = await fetchSource(VEHICLE_FEED);
    if (!res.ok) throw new Error(`flux véhicules HTTP ${res.status}`);
    const feed = GtfsRT.transit_realtime.FeedMessage.decode(Buffer.from(await res.arrayBuffer()));
    const { byRoute, stats } = buildVehicleIndex(feed, vehicleMemory);
    logHeadingStats(stats);
    return byRoute;
  });
  return { byRoute: value, cachedAt, stale: !!stale };
}

async function getVehicles(lineId) {
  const line = await getLine(lineId);
  const { byRoute, cachedAt, stale } = await getVehicleIndex();
  const list = byRoute[line.gtfsRouteId] || [];
  // Destination (« vers … ») : terminus du sens annoncé par le flux. Les arrêts
  // viennent du cache d'une heure ; en cas d'échec, pas de destination plutôt
  // qu'une erreur sur les positions.
  let terminus = {};
  if (list.some((v) => v.directionId != null)) {
    try {
      terminus = terminusByDirection((TRACES[line.gtfsRouteId] || {}).polylines, (await getStops(lineId)).stops);
    } catch {
      terminus = {};
    }
  }
  const vehicles = list.map((v) => ({
    ...v,
    destination: v.directionId != null ? terminus[String(v.directionId)] || null : null,
  }));
  return { vehicles, cachedAt, stale };
}

/* ------------------------------------------------------------------ */
/*  Retards temps réel (GTFS-RT trip-update, décodage natif Node)      */
/*  Décodé une fois, indexé par arrêt (code GTFS) : toutes lignes       */
/*  confondues, et ligne par ligne. Cache 30 s, délai maximal 5 s.      */
/* ------------------------------------------------------------------ */
const STU_SKIPPED = 1; // ScheduleRelationship.SKIPPED

// Agrège un flux trip-update décodé. Pour chaque arrêt on retient le pire
// retard annoncé et l'éventuelle suppression. Renvoie deux index :
//   all     : codeGTFS -> { delay (minutes), skipped }, toutes lignes
//   byRoute : route_id GTFS -> le même index, limité à cette ligne
// Un arrêt partagé ne porte ainsi que les retards de la ligne affichée.
function buildDelayIndex(feed) {
  const add = (index, code, stu) => {
    const cur = index[code] || (index[code] = { delaySec: null, skipped: false });
    if (stu.scheduleRelationship === STU_SKIPPED) cur.skipped = true;
    const arr = stu.arrival, dep = stu.departure;
    const d = arr && arr.delay != null ? arr.delay : dep && dep.delay != null ? dep.delay : null;
    if (d != null && (cur.delaySec == null || d > cur.delaySec)) cur.delaySec = d;
  };
  const all = {};
  const byRoute = {};
  for (const e of (feed && feed.entity) || []) {
    const tu = e.tripUpdate;
    if (!tu) continue;
    const routeId = tu.trip && tu.trip.routeId;
    for (const stu of tu.stopTimeUpdate || []) {
      const m = String(stu.stopId || "").match(/4-(\d+)/); // aligné sur gtfsCode du front
      if (!m) continue;
      add(all, m[1], stu);
      if (routeId) add(byRoute[routeId] || (byRoute[routeId] = {}), m[1], stu);
    }
  }
  const finish = (index) => {
    const out = {};
    for (const [code, v] of Object.entries(index)) {
      out[code] = { delay: v.delaySec == null ? null : Math.round(v.delaySec / 60), skipped: v.skipped };
    }
    return out;
  };
  const routes = {};
  for (const [routeId, index] of Object.entries(byRoute)) routes[routeId] = finish(index);
  return { all: finish(all), byRoute: routes };
}

async function getDelayIndex() {
  const { value, cachedAt, stale } = await cached("delays", 30 * 1000, async () => {
    const res = await fetchSource(TRIPUPDATE_FEED);
    if (!res.ok) throw new Error(`flux trip-update HTTP ${res.status}`);
    return buildDelayIndex(GtfsRT.transit_realtime.FeedMessage.decode(Buffer.from(await res.arrayBuffer())));
  });
  return { stops: value.all, byRoute: value.byRoute, cachedAt, stale: !!stale };
}

async function getLineDelays(lineId) {
  const line = await getLine(lineId);
  const { byRoute, cachedAt, stale } = await getDelayIndex();
  return { stops: byRoute[line.gtfsRouteId] || {}, cachedAt, stale };
}

/* ------------------------------------------------------------------ */
/*  Stations DiviaVélodi (vélos en libre-service, backend Cykleo)      */
/*  La dispo change vite : cache court (20 s) + repli sur valeur périmée.*/
/* ------------------------------------------------------------------ */
async function getVelodiStations() {
  if (!VELODI_FEED) return { stations: [], cachedAt: Date.now(), stale: false };
  const { value, cachedAt, stale } = await cached("velodi", 20 * 1000, async () => {
    const res = await fetchSource(VELODI_FEED, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Mozilla/5.0",
        Referer: new URL(VELODI_FEED).origin + "/",
      },
    });
    if (!res.ok) throw new Error(`flux Vélodi HTTP ${res.status}`);
    const raw = await res.json();
    return raw
      .map((s) => {
        const a = (s.station && s.station.assetStation) || {};
        const c = a.coordinate || {};
        const classic = s.availableClassicBikeCount || 0;
        const electric = s.availableElectricBikeCount || 0;
        return {
          id: s.id,
          number: a.commercialNumber || null,
          name: a.commercialName || `Station ${s.id}`,
          lat: c.y,
          lon: c.x,
          bikes: classic + electric,
          classicBikes: classic,
          ebikes: electric,
          docks: s.availableDockCount || 0,
          status: (s.station && s.station.status) || null,
          online: (s.station && s.station.status) === "IN_SERVICE",
        };
      })
      .filter((s) => typeof s.lat === "number" && typeof s.lon === "number");
  });
  return { stations: value, cachedAt, stale: !!stale };
}

/* ------------------------------------------------------------------ */
/*  Repli Python GTFS-RT (best-effort, optionnel)                      */
/* ------------------------------------------------------------------ */
function pythonFallback(lineCode, stopId) {
  return new Promise((resolve) => {
    const totem = GTFS_LINE_TOTEM[lineCode];
    const code = (stopId.match(/4-(\d+)/) || [])[1];
    if (!totem || !code) return resolve(null);
    const py = spawn("python3", [path.join(__dirname, "fallback_gtfs.py"), totem, code, "3"], { timeout: 12000 });
    let out = "";
    py.stdout.on("data", (d) => (out += d));
    py.on("error", () => resolve(null));
    py.on("close", () => {
      try {
        const parsed = JSON.parse(out);
        resolve(Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Routes HTTP                                                        */
/* ------------------------------------------------------------------ */
// `limit` : entier de 1 à 10, 3 par défaut. Une valeur négative, nulle ou non
// numérique ramène au défaut au lieu de contourner le plafond.
function parseLimit(raw, { fallback = 3, max = 10 } = {}) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// Réponse d'erreur uniforme : 404 pour une ressource inconnue, 502 quand une
// source externe est en cause.
function sendError(res, err, message) {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: status === 404 ? "Ressource inconnue" : message, detail: err.message });
}

app.use(securityHeaders);
// Cache navigateur court en production ; aucun en développement, pour que le
// rechargement à chaud du front reste immédiat.
app.use(express.static(path.join(__dirname, "public"), { maxAge: process.env.NODE_ENV === "production" ? "5m" : 0 }));
app.use("/api", rateLimit);

app.get("/api/lines", async (req, res) => {
  try {
    const lines = await getCatalog();
    res.json({ count: lines.length, lines, updatedAt: new Date().toISOString() });
  } catch (e) {
    sendError(res, e, "Impossible de récupérer les lignes");
  }
});

// Métadonnées légères de toutes les lignes (couleurs officielles), servies
// depuis le cache catalogue déjà en mémoire — aucune requête réseau ajoutée.
app.get("/api/lines/meta", async (req, res) => {
  try {
    const lines = await getCatalog();
    const meta = lines.map((l) => ({
      id: l.id,
      code: l.code,
      color: l.color,
      text_color: l.textColor,
      opening_time: l.openingTime,
      closing_time: l.closingTime,
    }));
    res.json({ count: meta.length, lines: meta, updatedAt: new Date().toISOString() });
  } catch (e) {
    sendError(res, e, "Impossible de récupérer les métadonnées des lignes");
  }
});

app.get("/api/lines/:lineId/stops", async (req, res) => {
  try {
    const { line, stops, cachedAt } = await getStops(req.params.lineId);
    res.json({ line, count: stops.length, stops, updatedAt: new Date(cachedAt).toISOString() });
  } catch (e) {
    sendError(res, e, "Impossible de récupérer les arrêts");
  }
});

app.get("/api/lines/:lineId/route", async (req, res) => {
  try {
    const line = await getLine(req.params.lineId);
    const trace = TRACES[line.gtfsRouteId];
    if (!trace) return res.json({ line, polylines: [], color: line.color });
    res.json({ line, color: line.color, polylines: trace.polylines });
  } catch (e) {
    sendError(res, e, "Impossible de récupérer le tracé");
  }
});

app.get("/api/lines/:lineId/schedules/:stopId", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    await assertStopOfLine(req.params.lineId, req.params.stopId);
    const data = await getStopSchedules(req.params.lineId, req.params.stopId, limit);
    res.json({ ...data, updatedAt: new Date().toISOString() });
  } catch (e) {
    sendError(res, e, "Impossible de récupérer les horaires");
  }
});

app.get("/api/lines/:lineId/all-schedules", async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    const data = await getAllSchedules(req.params.lineId, limit);
    res.json({ ...data, updatedAt: new Date().toISOString() });
  } catch (e) {
    sendError(res, e, "Impossible de récupérer les horaires");
  }
});

app.get("/api/lines/:lineId/vehicles", async (req, res) => {
  try {
    const data = await getVehicles(req.params.lineId);
    res.json({ ...data, updatedAt: new Date().toISOString() });
  } catch (e) {
    sendError(res, e, "Impossible de récupérer les véhicules");
  }
});

app.get("/api/lines/delays", async (req, res) => {
  try {
    const { stops, cachedAt, stale } = await getDelayIndex();
    res.json({ stops, stale, updatedAt: new Date(cachedAt).toISOString() });
  } catch (e) {
    // Dégradation silencieuse : pas de retard plutôt qu'une erreur qui casserait le front.
    res.json({ stops: {}, error: e.message, updatedAt: new Date().toISOString() });
  }
});

// Retards de la seule ligne demandée. Ligne inconnue : 404 ; flux
// indisponible : même dégradation silencieuse que ci-dessus.
app.get("/api/lines/:lineId/delays", async (req, res) => {
  try {
    const { stops, cachedAt, stale } = await getLineDelays(req.params.lineId);
    res.json({ stops, stale, updatedAt: new Date(cachedAt).toISOString() });
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e, "Impossible de récupérer les retards");
    res.json({ stops: {}, error: e.message, updatedAt: new Date().toISOString() });
  }
});

app.get("/api/velodi/stations", async (req, res) => {
  try {
    const { stations, cachedAt, stale } = await getVelodiStations();
    res.json({ count: stations.length, stations, stale, updatedAt: new Date(cachedAt).toISOString() });
  } catch (e) {
    sendError(res, e, "Impossible de récupérer les stations DiviaVélodi");
  }
});

// Compatibilité ascendante : anciennes routes /api/line5/* → ligne L5.
async function l5Id() {
  const l5 = (await getCatalog()).find((l) => l.code === "L5");
  if (!l5) throw new HttpError(404, "ligne L5 absente du catalogue");
  return l5.id;
}
app.get("/api/line5/stops", (req, res, next) => l5Id().then((id) => res.redirect(307, `/api/lines/${encodeURIComponent(id)}/stops`)).catch(next));
app.get("/api/line5/vehicles", (req, res, next) => l5Id().then((id) => res.redirect(307, `/api/lines/${encodeURIComponent(id)}/vehicles`)).catch(next));
app.get("/api/line5/all-schedules", (req, res, next) => l5Id().then((id) => res.redirect(307, `/api/lines/${encodeURIComponent(id)}/all-schedules`)).catch(next));
app.get("/api/line5/schedules/:stopId", (req, res, next) => l5Id().then((id) => res.redirect(307, `/api/lines/${encodeURIComponent(id)}/schedules/${encodeURIComponent(req.params.stopId)}`)).catch(next));

app.get("/api/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Route d'API inconnue : même format JSON que les autres erreurs.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Ressource inconnue", detail: `${req.method} ${req.originalUrl.slice(0, 200)}` });
});

// Dernier filet : URL mal encodée (400), erreur portée par une redirection
// historique, ou défaut imprévu. Jamais de pile d'appels dans la réponse.
// (les quatre paramètres sont requis : c'est ainsi qu'Express reconnaît un gestionnaire d'erreur)
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(`[http] ${req.method} ${req.originalUrl.slice(0, 200)} : ${err.message}`);
  const error = status === 404 ? "Ressource inconnue" : status < 500 ? "Requête invalide" : "Erreur interne";
  res.status(status).json({ error, detail: status < 500 ? err.message : "erreur interne du serveur" });
});

// Les écouteurs sont posés en dehors de `app.listen` : un callback passé à
// `listen` serait aussi appelé en cas d'échec, avant que l'adresse existe.
function start(port = PORT) {
  const server = app.listen(port);
  server.on("listening", () => {
    // PORT=0 : le port réellement attribué n'est connu qu'ici.
    console.log(`LineRelay → http://localhost:${server.address().port}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} déjà occupé. Changez PORT (dans .env, ou PORT=8080 npm start).`);
    } else if (err.code === "EACCES") {
      console.error(`Port ${port} interdit sans privilèges. Choisissez un PORT >= 1024.`);
    } else {
      console.error(`Impossible d'écouter sur le port ${port} :`, err.message);
    }
    process.exit(1);
  });
  return server;
}

// Lancé directement (`node server.js`) : on écoute. Chargé par les tests
// (`require`) : rien ne démarre, ils pilotent `app` et les fonctions exportées.
if (require.main === module) start();

module.exports = {
  app,
  start,
  HttpError,
  cached,
  storeSet,
  store,
  failures,
  createRateLimiter,
  parseLimit,
  fmtServiceTime,
  resolveGtfsRouteId,
  gtfsStopCode,
  transformSchedules,
  schedulesWithFallback,
  buildDelayIndex,
  normalizeBearing,
  distanceMeters,
  bearingBetween,
  computeHeading,
  terminusByDirection,
  buildVehicleIndex,
};
