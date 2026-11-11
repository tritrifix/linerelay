/**
 * server.js — Backend de la carte temps réel du réseau Divia (Dijon).
 *
 * Multi-lignes : expose le catalogue de TOUTES les lignes (bus + tram) ; le
 * frontend n'en affiche qu'une à la fois (sélecteur), ce qui limite les
 * requêtes, évite les superpositions de tracés et les bugs d'affichage.
 *
 * Sources (sans clé API) :
 *   - divia-api (proxy Navitia)      : lignes, arrêts, horaires
 *   - flux GTFS-RT (transport.gouv)  : positions des véhicules (décodé en Node)
 *   - GTFS statique (traces.json)    : tracé réel de chaque ligne
 *   - fallback Python GTFS-RT        : repli horaires si Navitia tombe
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

// Configuration : tout est surchargeable par variable d'environnement
// (cf. .env.example). Les valeurs par défaut ciblent le réseau de Dijon.
const PORT = process.env.PORT || 3000;
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

const app = express();

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
  // Repli : construit l'id même sans tracé (utile pour les véhicules)
  return "4-" + (SHORT_TO_ROUTE[code] ? code : stripped || code);
}

/* ------------------------------------------------------------------ */
/*  Cache générique avec TTL + repli sur valeur périmée                */
/* ------------------------------------------------------------------ */
const store = new Map();

async function cached(key, ttlMs, producer) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < ttlMs) return { value: hit.value, stale: false, cachedAt: hit.ts };
  try {
    const value = await producer();
    store.set(key, { value, ts: now });
    return { value, stale: false, cachedAt: now };
  } catch (err) {
    if (hit) {
      console.warn(`[cache] ${key}: repli cache périmé (${err.message})`);
      return { value: hit.value, stale: true, cachedAt: hit.ts, error: err.message };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/*  Catalogue des lignes (bus + tram)                                  */
/* ------------------------------------------------------------------ */
// Heures de service Navitia : l'heure locale est encodée en UTC (ex.
// "2026-…T05:05:00.000Z" = 05h05). On lit donc les composantes UTC pour
// éviter tout décalage de fuseau. Renvoie "HH:MM" ou null si absent.
function fmtServiceTime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
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
  if (!line) throw new Error(`ligne inconnue : ${lineId}`);
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

async function getStopSchedules(lineId, stopId, limit = 3) {
  const line = await getLine(lineId);
  const { value, stale, cachedAt, error } = await cached(`sched:${lineId}:${stopId}`, 30 * 1000, async () => {
    let passages = transformSchedules(await divia.getSchedules(line.id, stopId));
    let source = "divia-api";
    if (!passages.length) {
      const fb = await pythonFallback(line.code, stopId);
      if (fb && fb.length) {
        passages = fb;
        source = "gtfs-rt-fallback";
      }
    }
    return { passages, source };
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
  const { value, cachedAt, stale } = await cached(`all:${lineId}`, 45 * 1000, async () =>
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
/*  Positions des véhicules (GTFS-RT, décodage natif Node)             */
/*  Le flux est décodé une fois et indexé par route_id (TTL 10 s),     */
/*  donc changer de ligne ne déclenche pas de nouvelle requête.        */
/* ------------------------------------------------------------------ */
async function getVehicleIndex() {
  const { value, cachedAt, stale } = await cached("veh-index", 10 * 1000, async () => {
    const res = await fetch(VEHICLE_FEED);
    if (!res.ok) throw new Error(`flux véhicules HTTP ${res.status}`);
    const feed = GtfsRT.transit_realtime.FeedMessage.decode(Buffer.from(await res.arrayBuffer()));
    const byRoute = {};
    for (const e of feed.entity) {
      const v = e.vehicle;
      if (!v || !v.trip || !v.trip.routeId || !v.position) continue;
      (byRoute[v.trip.routeId] = byRoute[v.trip.routeId] || []).push({
        id: (v.vehicle && (v.vehicle.label || v.vehicle.id)) || e.id,
        lat: v.position.latitude,
        lon: v.position.longitude,
        bearing: v.position.bearing || null,
        speed: Object.prototype.hasOwnProperty.call(v.position, "speed") ? v.position.speed : null,
        tripId: v.trip.tripId || null,
      });
    }
    return byRoute;
  });
  return { byRoute: value, cachedAt, stale: !!stale };
}

async function getVehicles(lineId) {
  const line = await getLine(lineId);
  const { byRoute, cachedAt, stale } = await getVehicleIndex();
  return { vehicles: byRoute[line.gtfsRouteId] || [], cachedAt, stale };
}

/* ------------------------------------------------------------------ */
/*  Retards temps réel (GTFS-RT trip-update, décodage natif Node)      */
/*  Décodé une fois et indexé par arrêt (code GTFS). Cache 30 s,        */
/*  timeout 5 s ; en cas d'échec on dégrade vers {} (aucun badge).      */
/* ------------------------------------------------------------------ */
const STU_SKIPPED = 1; // ScheduleRelationship.SKIPPED

async function getDelayIndex() {
  const { value, cachedAt, stale } = await cached("delays", 30 * 1000, async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000); // timeout dur 5 s
    let feed;
    try {
      const res = await fetch(TRIPUPDATE_FEED, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`flux trip-update HTTP ${res.status}`);
      feed = GtfsRT.transit_realtime.FeedMessage.decode(Buffer.from(await res.arrayBuffer()));
    } finally {
      clearTimeout(timer);
    }
    // Agrège par arrêt : on retient le pire retard à venir et l'éventuel saut.
    const byStop = {}; // codeGTFS -> { delaySec, skipped }
    for (const e of feed.entity) {
      const tu = e.tripUpdate;
      if (!tu) continue;
      for (const stu of tu.stopTimeUpdate || []) {
        const m = String(stu.stopId || "").match(/4-(\d+)/); // aligné sur gtfsCode du front
        if (!m) continue;
        const code = m[1];
        const cur = byStop[code] || { delaySec: null, skipped: false };
        if (stu.scheduleRelationship === STU_SKIPPED) cur.skipped = true;
        const arr = stu.arrival, dep = stu.departure;
        const d = arr && arr.delay != null ? arr.delay : dep && dep.delay != null ? dep.delay : null;
        if (d != null && (cur.delaySec == null || d > cur.delaySec)) cur.delaySec = d;
        byStop[code] = cur;
      }
    }
    const out = {};
    for (const [code, v] of Object.entries(byStop)) {
      out[code] = { delay: v.delaySec == null ? null : Math.round(v.delaySec / 60), skipped: v.skipped };
    }
    return out;
  });
  return { stops: value, cachedAt, stale: !!stale };
}

/* ------------------------------------------------------------------ */
/*  Stations DiviaVélodi (vélos en libre-service, backend Cykleo)      */
/*  La dispo change vite : cache court (20 s) + repli sur valeur périmée.*/
/* ------------------------------------------------------------------ */
async function getVelodiStations() {
  if (!VELODI_FEED) return { stations: [], cachedAt: Date.now(), stale: false };
  const { value, cachedAt, stale } = await cached("velodi", 20 * 1000, async () => {
    const res = await fetch(VELODI_FEED, {
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
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/lines", async (req, res) => {
  try {
    const lines = await getCatalog();
    res.json({ count: lines.length, lines, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "Impossible de récupérer les lignes", detail: e.message });
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
    res.status(502).json({ error: "Impossible de récupérer les métadonnées des lignes", detail: e.message });
  }
});

app.get("/api/lines/:lineId/stops", async (req, res) => {
  try {
    const { line, stops, cachedAt } = await getStops(req.params.lineId);
    res.json({ line, count: stops.length, stops, updatedAt: new Date(cachedAt).toISOString() });
  } catch (e) {
    res.status(502).json({ error: "Impossible de récupérer les arrêts", detail: e.message });
  }
});

app.get("/api/lines/:lineId/route", async (req, res) => {
  try {
    const line = await getLine(req.params.lineId);
    const trace = TRACES[line.gtfsRouteId];
    if (!trace) return res.json({ line, polylines: [], color: line.color });
    res.json({ line, color: line.color, polylines: trace.polylines });
  } catch (e) {
    res.status(502).json({ error: "Impossible de récupérer le tracé", detail: e.message });
  }
});

app.get("/api/lines/:lineId/schedules/:stopId", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 3, 10);
    const data = await getStopSchedules(req.params.lineId, req.params.stopId, limit);
    res.json({ ...data, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "Impossible de récupérer les horaires", detail: e.message });
  }
});

app.get("/api/lines/:lineId/all-schedules", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 3, 10);
    const data = await getAllSchedules(req.params.lineId, limit);
    res.json({ ...data, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "Impossible de récupérer les horaires", detail: e.message });
  }
});

app.get("/api/lines/:lineId/vehicles", async (req, res) => {
  try {
    const data = await getVehicles(req.params.lineId);
    res.json({ ...data, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "Impossible de récupérer les véhicules", detail: e.message });
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

app.get("/api/velodi/stations", async (req, res) => {
  try {
    const { stations, cachedAt, stale } = await getVelodiStations();
    res.json({ count: stations.length, stations, stale, updatedAt: new Date(cachedAt).toISOString() });
  } catch (e) {
    res.status(502).json({ error: "Impossible de récupérer les stations DiviaVélodi", detail: e.message });
  }
});

// Compatibilité ascendante : anciennes routes /api/line5/* → ligne L5.
async function l5Id() {
  return (await getCatalog()).find((l) => l.code === "L5").id;
}
app.get("/api/line5/stops", (req, res, next) => l5Id().then((id) => res.redirect(307, `/api/lines/${encodeURIComponent(id)}/stops`)).catch(next));
app.get("/api/line5/vehicles", (req, res, next) => l5Id().then((id) => res.redirect(307, `/api/lines/${encodeURIComponent(id)}/vehicles`)).catch(next));
app.get("/api/line5/all-schedules", (req, res, next) => l5Id().then((id) => res.redirect(307, `/api/lines/${encodeURIComponent(id)}/all-schedules`)).catch(next));
app.get("/api/line5/schedules/:stopId", (req, res, next) => l5Id().then((id) => res.redirect(307, `/api/lines/${encodeURIComponent(id)}/schedules/${encodeURIComponent(req.params.stopId)}`)).catch(next));

app.get("/api/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => console.log(`LineRelay → http://localhost:${PORT}`));
