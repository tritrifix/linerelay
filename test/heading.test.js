/**
 * Tests du cap des véhicules — `npm test` (node:test, aucune dépendance).
 *
 * Aucun appel réseau : le flux GTFS-RT est un objet construit à la main, ou un
 * message encodé localement et servi par une doublure de `fetch`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.VELODI_FEED_URL = "http://source.invalid/velos";
process.env.RATE_LIMIT_MAX = "1000";

const divia = require("divia-api");
const GtfsRT = require("gtfs-realtime-bindings");
const srv = require("../server.js");

// Place Darcy, Dijon. À cette latitude, 0,001° vaut environ 111 m vers le
// nord et 75 m vers l'est.
const DARCY = { lat: 47.3235, lon: 5.0345 };
const north = (p, deg) => ({ lat: p.lat + deg, lon: p.lon });
const east = (p, deg) => ({ lat: p.lat, lon: p.lon + deg });

/* ------------------------------------------------------------------ */
/*  Fonctions pures                                                    */
/* ------------------------------------------------------------------ */
test("normalizeBearing ramène le cap dans [0, 360) et rejette les valeurs absentes", () => {
  assert.equal(srv.normalizeBearing(0), 0, "plein nord est un cap valide");
  assert.equal(srv.normalizeBearing(360), 0);
  assert.equal(srv.normalizeBearing(725), 5);
  assert.equal(srv.normalizeBearing(-90), 270);
  assert.equal(srv.normalizeBearing(359.96), 0, "l'arrondi ne doit pas produire 360");
  assert.equal(srv.normalizeBearing("181"), 181);
  for (const absent of [null, undefined, "", NaN, Infinity, "nord", true]) {
    assert.equal(srv.normalizeBearing(absent), null);
  }
});

test("distanceMeters : ordre de grandeur correct, nul sur place", () => {
  assert.equal(srv.distanceMeters(DARCY, DARCY), 0);
  const d = srv.distanceMeters(DARCY, north(DARCY, 0.001));
  assert.ok(d > 110 && d < 112, `111 m attendus, obtenu ${d}`);
});

test("bearingBetween : les quatre points cardinaux", () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.5, `${expected}° attendus, obtenu ${actual}`);
  near(srv.bearingBetween(DARCY, north(DARCY, 0.001)), 0);
  near(srv.bearingBetween(DARCY, east(DARCY, 0.001)), 90);
  near(srv.bearingBetween(DARCY, north(DARCY, -0.001)), 180);
  near(srv.bearingBetween(DARCY, east(DARCY, -0.001)), 270);
});

test("bearingBetween : de part et d'autre du nord, le résultat reste dans [0, 360)", () => {
  const nne = srv.bearingBetween(DARCY, { lat: DARCY.lat + 0.001, lon: DARCY.lon + 0.00002 });
  const nnw = srv.bearingBetween(DARCY, { lat: DARCY.lat + 0.001, lon: DARCY.lon - 0.00002 });
  assert.ok(nne > 0 && nne < 2, `≈ 1° attendu, obtenu ${nne}`);
  assert.ok(nnw > 358 && nnw < 360, `≈ 359° attendu (et non -1°), obtenu ${nnw}`);
});

test("computeHeading : le bearing du flux est prioritaire, y compris à 0° (nord)", () => {
  assert.deepEqual(srv.computeHeading({ bearing: 251 }), { heading: 251, source: "bearing" });
  assert.deepEqual(srv.computeHeading({ bearing: 0 }), { heading: 0, source: "bearing" });
  // Le bearing l'emporte sur une estimation qui diffère sans le contredire
  // (virage : 90° d'écart).
  assert.deepEqual(
    srv.computeHeading({ bearing: 90, prev: DARCY, cur: north(DARCY, 0.001) }),
    { heading: 90, source: "bearing" }
  );
});

test("computeHeading : un bearing démenti par un déplacement net cède au cap estimé", () => {
  // Le flux annonce l'ouest (251°), le véhicule a parcouru 150 m vers l'est.
  assert.deepEqual(
    srv.computeHeading({ bearing: 251, prev: DARCY, cur: east(DARCY, 0.002) }),
    { heading: 90, source: "estimé" }
  );
  // Même contradiction de part et d'autre du nord : 350° annoncé, 170° constaté.
  assert.equal(srv.computeHeading({ bearing: 350, prev: DARCY, cur: { lat: DARCY.lat - 0.001, lon: DARCY.lon + 0.00026 } }).source, "estimé");
  // 2° d'écart réel entre 359° et 1° : aucune contradiction.
  assert.deepEqual(
    srv.computeHeading({ bearing: 359, prev: DARCY, cur: { lat: DARCY.lat + 0.001, lon: DARCY.lon + 0.00002 } }),
    { heading: 359, source: "bearing" }
  );
  // Déplacement trop court (22 m) pour démentir le flux.
  assert.deepEqual(
    srv.computeHeading({ bearing: 180, prev: DARCY, cur: north(DARCY, 0.0002) }),
    { heading: 180, source: "bearing" }
  );
});

test("computeHeading : bearing absent, cap estimé à partir de deux positions", () => {
  assert.deepEqual(srv.computeHeading({ prev: DARCY, cur: north(DARCY, 0.001) }), { heading: 0, source: "estimé" });
  assert.deepEqual(srv.computeHeading({ bearing: null, prev: DARCY, cur: east(DARCY, 0.001) }), { heading: 90, source: "estimé" });
});

test("computeHeading : passage par le nord, 359° puis 1°", () => {
  const a = srv.computeHeading({ prev: DARCY, cur: { lat: DARCY.lat + 0.001, lon: DARCY.lon - 0.00002 } });
  const b = srv.computeHeading({ prev: DARCY, cur: { lat: DARCY.lat + 0.001, lon: DARCY.lon + 0.00002 } });
  assert.deepEqual([a, b], [{ heading: 359, source: "estimé" }, { heading: 1, source: "estimé" }]);
  // Un cap estimé qui s'arrondit à 360 doit valoir 0.
  const c = srv.computeHeading({ prev: DARCY, cur: { lat: DARCY.lat + 0.001, lon: DARCY.lon - 0.000001 } });
  assert.deepEqual(c, { heading: 0, source: "estimé" });
});

test("computeHeading : distance trop faible ou information insuffisante, cap inconnu", () => {
  const unknown = { heading: null, source: "inconnu" };
  assert.deepEqual(srv.computeHeading({ prev: DARCY, cur: north(DARCY, 0.00005) }), unknown, "≈ 5,5 m : bruit GPS");
  assert.deepEqual(srv.computeHeading({ prev: DARCY, cur: DARCY }), unknown);
  assert.deepEqual(srv.computeHeading({ cur: DARCY }), unknown, "pas de position précédente");
  assert.deepEqual(srv.computeHeading({ prev: DARCY }), unknown);
  assert.deepEqual(srv.computeHeading({ prev: { lat: NaN, lon: 5 }, cur: DARCY }), unknown);
  assert.deepEqual(srv.computeHeading({ bearing: NaN }), unknown);
  assert.deepEqual(srv.computeHeading(), unknown);
  // Le seuil est réglable : les mêmes 5,5 m suffisent si on l'abaisse.
  assert.equal(srv.computeHeading({ prev: DARCY, cur: north(DARCY, 0.00005), minDistanceM: 5 }).source, "estimé");
});

test("terminusByDirection : arrêt le plus proche de la fin de chaque sens", () => {
  const stops = [
    { name: "Gare", lat: 47.32, lon: 5.02 },
    { name: "Milieu", lat: 47.32, lon: 5.05 },
    { name: "Campus", lat: 47.32, lon: 5.08 },
  ];
  const polylines = [
    { direction: "0", points: [[47.32, 5.02], [47.32, 5.05], [47.32, 5.0801]] },
    { direction: "0", points: [[47.32, 5.02], [47.32, 5.05]] }, // variante courte, ignorée
    { direction: "1", points: [[47.32, 5.08], [47.32, 5.0201]] },
    { direction: "2", points: [[47.32, 5.08], [47.5, 5.5]] }, // aucun arrêt à proximité
  ];
  assert.deepEqual(srv.terminusByDirection(polylines, stops), { 0: "Campus", 1: "Gare" });
  assert.deepEqual(srv.terminusByDirection(undefined, stops), {});
  assert.deepEqual(srv.terminusByDirection(polylines, []), {});
});

/* ------------------------------------------------------------------ */
/*  Index des véhicules                                                */
/* ------------------------------------------------------------------ */
const entity = (id, position, trip = {}) => ({
  id: "e" + id,
  vehicle: { vehicle: { id: String(id), label: String(id) }, trip: { routeId: "4-T9", tripId: "trip-" + id, ...trip }, position },
});
const at = (p, extra = {}) => ({ latitude: p.lat, longitude: p.lon, ...extra });

test("buildVehicleIndex : champs historiques conservés, champs de cap ajoutés", () => {
  const { byRoute, stats } = srv.buildVehicleIndex({
    entity: [
      entity(1, at(DARCY, { bearing: 251, speed: 33 }), { directionId: 1 }),
      entity(2, at(DARCY, { bearing: 0, speed: 12 }), { directionId: 0 }),
      entity(3, at(DARCY)),
      { id: "sans-position", vehicle: { trip: { routeId: "4-T9" } } },
      { id: "sans-ligne", vehicle: { position: at(DARCY) } },
      { tripUpdate: {} },
    ],
  });
  const [a, b, c] = byRoute["4-T9"];
  assert.equal(byRoute["4-T9"].length, 3);
  assert.deepEqual(a, {
    id: "1", lat: DARCY.lat, lon: DARCY.lon, bearing: 251, speed: 33, tripId: "trip-1",
    heading: 251, headingSource: "bearing", stopped: false, speedReliable: true, directionId: 1,
  });
  // Plein nord : l'ancien champ reste à null (contrat inchangé), le nouveau vaut 0.
  assert.deepEqual([b.bearing, b.heading, b.headingSource, b.directionId], [null, 0, "bearing", 0]);
  // Ni bearing ni position précédente : cap inconnu, jamais 0 par défaut.
  assert.deepEqual([c.bearing, c.speed, c.heading, c.headingSource, c.speedReliable, c.directionId],
    [null, null, null, "inconnu", null, null]);
  assert.deepEqual(stats, { total: 3, bearing: 2, estimated: 0, unknown: 1, stopped: 0, unreliableSpeed: 0 });
});

test("buildVehicleIndex : sans bearing, le cap est estimé entre deux relevés", () => {
  const memory = new Map();
  const feed = (p) => ({ entity: [entity(7, at(p, { speed: 20 }))] });
  const first = srv.buildVehicleIndex(feed(DARCY), memory, 0).byRoute["4-T9"][0];
  assert.deepEqual([first.heading, first.headingSource], [null, "inconnu"]);
  // 5,5 m plus loin : trop peu pour conclure, et la référence ne bouge pas.
  const second = srv.buildVehicleIndex(feed(north(DARCY, 0.00005)), memory, 10000).byRoute["4-T9"][0];
  assert.deepEqual([second.heading, second.headingSource], [null, "inconnu"]);
  // La progression lente s'accumule depuis la référence : 22 m au total, vers le nord.
  const third = srv.buildVehicleIndex(feed(north(DARCY, 0.0002)), memory, 20000);
  assert.deepEqual([third.byRoute["4-T9"][0].heading, third.byRoute["4-T9"][0].headingSource], [0, "estimé"]);
  assert.equal(third.stats.estimated, 1);
  // Puis vers l'est.
  const fourth = srv.buildVehicleIndex(feed(east(north(DARCY, 0.0002), 0.001)), memory, 30000).byRoute["4-T9"][0];
  assert.deepEqual([fourth.heading, fourth.headingSource], [90, "estimé"]);
});

test("buildVehicleIndex : une position de référence trop ancienne est oubliée", () => {
  const memory = new Map();
  srv.buildVehicleIndex({ entity: [entity(8, at(DARCY))] }, memory, 0);
  const late = srv.buildVehicleIndex({ entity: [entity(8, at(north(DARCY, 0.01)))] }, memory, 6 * 60 * 1000).byRoute["4-T9"][0];
  assert.equal(late.headingSource, "inconnu", "un saut après six minutes de silence n'est pas un cap");
  // Un véhicule disparu du flux ne reste pas en mémoire indéfiniment.
  srv.buildVehicleIndex({ entity: [] }, memory, 20 * 60 * 1000);
  assert.equal(memory.size, 0);
});

test("buildVehicleIndex : à l'arrêt = vitesse nulle et aucun déplacement constaté", () => {
  const memory = new Map();
  const feed = (p, speed) => ({ entity: [entity(9, at(p, { bearing: 80, speed }))] });
  const stopped = (r) => r.byRoute["4-T9"][0].stopped;
  assert.equal(stopped(srv.buildVehicleIndex(feed(DARCY, 0), memory, 0)), true, "0 km/h, premier relevé");
  assert.equal(stopped(srv.buildVehicleIndex(feed(DARCY, 0), memory, 10000)), true, "0 km/h, immobile");
  // Le flux annonce 0 km/h alors que le véhicule a avancé de 111 m : il roule.
  assert.equal(stopped(srv.buildVehicleIndex(feed(north(DARCY, 0.001), 0), memory, 20000)), false);
  assert.equal(stopped(srv.buildVehicleIndex(feed(north(DARCY, 0.001), 0), memory, 30000)), true);
  assert.equal(stopped(srv.buildVehicleIndex(feed(north(DARCY, 0.001), 14), memory, 40000)), false, "vitesse non nulle");
});

test("buildVehicleIndex : une vitesse aberrante est signalée, pas modifiée", () => {
  const { byRoute, stats } = srv.buildVehicleIndex({
    entity: [entity(1, at(DARCY, { speed: 137 })), entity(2, at(DARCY, { speed: 100 })), entity(3, at(DARCY, { speed: -4 }))],
  });
  assert.deepEqual(byRoute["4-T9"].map((v) => [v.speed, v.speedReliable]), [[137, false], [100, true], [-4, false]]);
  assert.equal(stats.unreliableSpeed, 2);
});

/* ------------------------------------------------------------------ */
/*  HTTP : flux GTFS-RT encodé localement                              */
/* ------------------------------------------------------------------ */
test("GET /vehicles : ancienne structure intacte, cap et source ajoutés", async (t) => {
  const real = { listLines: divia.listLines, listStops: divia.listStops, fetch: global.fetch };
  divia.listLines = async (mode) => (mode === "tramway" ? [{ id: "line:TEST:T9", code: "T9", name: "Gare <> Campus" }] : []);
  divia.listStops = async () => [{ id: "stop_area:TEST:SA:4-29", name: "Génois", coord: { lat: 47.33, lon: 5.03 } }];
  const FeedMessage = GtfsRT.transit_realtime.FeedMessage;
  const bytes = FeedMessage.encode(
    FeedMessage.create({
      header: { gtfsRealtimeVersion: "2.0", timestamp: 1 },
      entity: [
        entity(1001, at(DARCY, { bearing: 251, speed: 33 }), { directionId: 1 }),
        entity(1002, at(DARCY, { speed: 140 })),
      ],
    })
  ).finish();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  srv.store.delete("veh-index");
  srv.failures.delete("veh-index");

  const server = srv.app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.close();
    Object.assign(divia, { listLines: real.listLines, listStops: real.listStops });
    global.fetch = real.fetch;
  });

  const body = await new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: server.address().port, path: `/api/lines/${encodeURIComponent("line:TEST:T9")}/vehicles` }, (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
      })
      .on("error", reject);
  });

  assert.equal(body.status, 200);
  assert.deepEqual(Object.keys(body.json), ["vehicles", "cachedAt", "stale", "updatedAt"]);
  const [a, b] = body.json.vehicles;
  // Les six champs d'origine, dans le même ordre et avec les mêmes valeurs.
  assert.deepEqual(Object.keys(a).slice(0, 6), ["id", "lat", "lon", "bearing", "speed", "tripId"]);
  assert.deepEqual([a.id, a.bearing, a.speed, a.tripId], ["1001", 251, 33, "trip-1001"]);
  assert.ok(Math.abs(a.lat - DARCY.lat) < 1e-4 && Math.abs(a.lon - DARCY.lon) < 1e-4);
  // Champs ajoutés.
  assert.deepEqual([a.heading, a.headingSource, a.stopped, a.speedReliable, a.directionId], [251, "bearing", false, true, 1]);
  assert.equal(a.destination, null, "pas de tracé dans les tests : destination absente, sans erreur");
  // Bearing absent du message protobuf : inconnu, et non « nord ».
  assert.deepEqual([b.bearing, b.heading, b.headingSource, b.speedReliable, b.destination], [null, null, "inconnu", false, null]);
});
