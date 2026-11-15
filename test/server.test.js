/**
 * Tests de LineRelay — `npm test` (node:test, aucune dépendance).
 *
 * Aucun appel réseau : les sources externes (Navitia via divia-api, flux
 * GTFS-RT, vélos) sont remplacées par des doublures. Les tests HTTP démarrent
 * l'application sur un port libre et l'interrogent avec node:http, pour que
 * `fetch` (utilisé par le serveur vers les sources) puisse être remplacé sans
 * gêner le client de test.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.VELODI_FEED_URL = "http://source.invalid/velos";
process.env.RATE_LIMIT_MAX = "1000";

const divia = require("divia-api");
const srv = require("../server.js");

/* ------------------------------------------------------------------ */
/*  Fonctions pures                                                    */
/* ------------------------------------------------------------------ */
test("parseLimit borne la valeur entre 1 et 10 et retombe sur 3", () => {
  assert.equal(srv.parseLimit("2"), 2);
  assert.equal(srv.parseLimit("10"), 10);
  assert.equal(srv.parseLimit("999"), 10);
  assert.equal(srv.parseLimit(undefined), 3);
  assert.equal(srv.parseLimit("abc"), 3);
  assert.equal(srv.parseLimit("0"), 3);
  assert.equal(srv.parseLimit("-5"), 3, "une valeur négative ne doit pas contourner le plafond");
});

test("fmtServiceTime lit l'heure locale de la date fournie par divia-api", () => {
  assert.equal(srv.fmtServiceTime(new Date(2026, 10, 15, 4, 49, 44)), "04:49");
  assert.equal(srv.fmtServiceTime(new Date(2026, 6, 1, 0, 5, 0)), "00:05");
  assert.equal(srv.fmtServiceTime(null), null);
  assert.equal(srv.fmtServiceTime("pas une date"), null);
});

test("resolveGtfsRouteId retire le préfixe alphabétique des lignes numérotées", () => {
  // Sans traces.json (cas des tests), la fonction construit l'identifiant.
  assert.equal(srv.resolveGtfsRouteId("B10"), "4-10");
  assert.equal(srv.resolveGtfsRouteId("BC61"), "4-61");
  assert.equal(srv.resolveGtfsRouteId("46"), "4-46");
  // Tramways et lianes gardent leur code : sans cela, aucun véhicule ne
  // correspondait à T1 ou L5 dans une image construite sans tracés.
  assert.equal(srv.resolveGtfsRouteId("T1"), "4-T1");
  assert.equal(srv.resolveGtfsRouteId("L5"), "4-L5");
  assert.equal(srv.resolveGtfsRouteId("CITY"), "4-CITY");
});

test("gtfsStopCode extrait le code GTFS de l'identifiant ou des codes", () => {
  assert.equal(srv.gtfsStopCode({ id: "stop_area:CGD:SA:4-1530" }), "1530");
  assert.equal(srv.gtfsStopCode({ id: "x", codes: [{ value: "a" }, { value: "4-29" }] }), "29");
  assert.equal(srv.gtfsStopCode({ id: "x", codes: [] }), null);
});

test("transformSchedules écarte les passages passés, trie et marque le temps réel", () => {
  const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
  const out = srv.transformSchedules([
    {
      display_informations: { direction: "Université" },
      date_times: [
        { date_time: inMin(20), data_freshness: "base_schedule" },
        { date_time: inMin(-10), data_freshness: "realtime" },
        { date_time: "invalide" },
      ],
    },
    { date_times: [{ date_time: inMin(5), data_freshness: "realtime" }] },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.minutes), [5, 20]);
  assert.deepEqual(out.map((p) => p.realtime), [true, false]);
  assert.deepEqual(out.map((p) => p.direction), ["—", "Université"]);
  assert.deepEqual(srv.transformSchedules(undefined), []);
});

test("buildDelayIndex sépare les retards par ligne et garde le pire par arrêt", () => {
  const feed = {
    entity: [
      { tripUpdate: { trip: { routeId: "4-L5" }, stopTimeUpdate: [
        { stopId: "4-29", arrival: { delay: 120 } },
        { stopId: "4-29", departure: { delay: 300 } },
        { stopId: "4-30", scheduleRelationship: 1 },
        { stopId: "sans-code", arrival: { delay: 999 } },
      ] } },
      { tripUpdate: { trip: { routeId: "4-T1" }, stopTimeUpdate: [{ stopId: "4-29", arrival: { delay: 600 } }] } },
      { vehicle: {} },
    ],
  };
  const { all, byRoute } = srv.buildDelayIndex(feed);
  assert.deepEqual(byRoute["4-L5"]["29"], { delay: 5, skipped: false });
  assert.deepEqual(byRoute["4-L5"]["30"], { delay: null, skipped: true });
  assert.deepEqual(byRoute["4-T1"]["29"], { delay: 10, skipped: false });
  assert.deepEqual(all["29"], { delay: 10, skipped: false }, "l'index global garde le pire retard, toutes lignes");
  assert.equal(Object.keys(all).length, 2);
  assert.deepEqual(srv.buildDelayIndex({ entity: [] }), { all: {}, byRoute: {} });
});

/* ------------------------------------------------------------------ */
/*  Repli horaires                                                     */
/* ------------------------------------------------------------------ */
test("schedulesWithFallback : source principale utilisée quand elle répond", async () => {
  let fallbackCalls = 0;
  const r = await srv.schedulesWithFallback(async () => [{ minutes: 1 }], async () => { fallbackCalls++; return [{ minutes: 9 }]; });
  assert.equal(r.source, "divia-api");
  assert.equal(fallbackCalls, 0);
});

test("schedulesWithFallback : repli quand la source principale est vide", async () => {
  const r = await srv.schedulesWithFallback(async () => [], async () => [{ minutes: 9 }]);
  assert.deepEqual(r, { passages: [{ minutes: 9 }], source: "gtfs-rt-fallback" });
});

test("schedulesWithFallback : repli quand la source principale est en erreur", async () => {
  const r = await srv.schedulesWithFallback(async () => { throw new Error("Navitia HS"); }, async () => [{ minutes: 9 }]);
  assert.equal(r.source, "gtfs-rt-fallback");
});

test("schedulesWithFallback : l'erreur d'origine remonte si le repli ne donne rien", async () => {
  await assert.rejects(srv.schedulesWithFallback(async () => { throw new Error("Navitia HS"); }, async () => null), /Navitia HS/);
  const r = await srv.schedulesWithFallback(async () => [], async () => []);
  assert.deepEqual(r, { passages: [], source: "divia-api" });
});

/* ------------------------------------------------------------------ */
/*  Cache                                                              */
/* ------------------------------------------------------------------ */
test("cached : sert la valeur fraîche sans rappeler le producteur", async () => {
  let calls = 0;
  const producer = async () => ++calls;
  assert.equal((await srv.cached("t:frais", 60000, producer)).value, 1);
  const again = await srv.cached("t:frais", 60000, producer);
  assert.deepEqual([again.value, again.stale, calls], [1, false, 1]);
});

test("cached : repli sur la valeur périmée quand le producteur échoue", async () => {
  await srv.cached("t:perime", 0, async () => "ancienne");
  const r = await srv.cached("t:perime", 0, async () => { throw new Error("source HS"); });
  assert.deepEqual([r.value, r.stale, r.error], ["ancienne", true, "source HS"]);
});

test("cached : mutualise les appels simultanés", async () => {
  let calls = 0;
  const producer = () => new Promise((resolve) => setTimeout(() => resolve(++calls), 20));
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => srv.cached("t:simultane", 60000, producer)));
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.value), [1, 1, 1, 1, 1]);
});

test("cached : un échec sans valeur de repli remonte et n'est pas retenté aussitôt", async () => {
  let calls = 0;
  const producer = async () => { calls++; throw new Error("source HS"); };
  await assert.rejects(srv.cached("t:echec", 60000, producer), /source HS/);
  await assert.rejects(srv.cached("t:echec", 60000, producer), /source HS/);
  assert.equal(calls, 1, "le second appel réutilise l'échec mémorisé");
  srv.failures.delete("t:echec");
});

test("storeSet évince les entrées les plus anciennes au-delà de la borne", () => {
  const before = srv.store.size;
  for (let i = 0; i < 5; i++) srv.storeSet(`t:borne:${i}`, { value: i, ts: 0 }, before + 3);
  assert.equal(srv.store.size, before + 3);
  assert.equal(srv.store.has("t:borne:4"), true);
  for (let i = 0; i < 5; i++) srv.store.delete(`t:borne:${i}`);
});

test("createRateLimiter : refuse au-delà du plafond puis rouvre la fenêtre", () => {
  let now = 0;
  const limiter = srv.createRateLimiter({ max: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("a").allowed, true);
  assert.deepEqual([limiter.check("a").allowed, limiter.check("b").allowed], [false, true]);
  now = 1000;
  assert.equal(limiter.check("a").allowed, true);
  now = 2500;
  limiter.sweep();
  assert.equal(limiter.size(), 0);
});

/* ------------------------------------------------------------------ */
/*  HTTP, sources remplacées par des doublures                         */
/* ------------------------------------------------------------------ */
test("API HTTP", async (t) => {
  const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
  const real = { listLines: divia.listLines, listStops: divia.listStops, getSchedules: divia.getSchedules, fetch: global.fetch };
  divia.listLines = async (mode) =>
    mode === "tramway"
      ? [{ id: "line:TEST:T9", code: "T9", name: "Gare <> Campus", color: "AB0672", text_color: "FFFFFF",
           opening_time: new Date(2026, 10, 15, 5, 5), closing_time: new Date(2026, 10, 15, 0, 41) }]
      : [];
  divia.listStops = async () => [
    { id: "stop_area:TEST:SA:4-29", name: "Génois", coord: { lat: 47.33, lon: 5.03 } },
    { id: "stop_area:TEST:SA:4-30", name: "Sans coordonnées" },
  ];
  divia.getSchedules = async () => [
    { display_informations: { direction: "Campus" },
      date_times: Array.from({ length: 15 }, (_, i) => ({ date_time: inMin(3 + i * 7), data_freshness: "realtime" })) },
  ];
  global.fetch = async () => { throw new Error("fetch failed"); }; // flux GTFS-RT et vélos injoignables

  const server = srv.app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  t.after(() => {
    server.close();
    Object.assign(divia, { listLines: real.listLines, listStops: real.listStops, getSchedules: real.getSchedules });
    global.fetch = real.fetch;
  });

  const get = (path, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* corps non JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      });
      req.on("error", reject);
      req.end();
    });
  const LINE = encodeURIComponent("line:TEST:T9");
  const STOP = encodeURIComponent("stop_area:TEST:SA:4-29");

  await t.test("sonde de santé et en-têtes de sécurité", async () => {
    const r = await get("/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.headers["x-powered-by"], undefined);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(r.headers["content-security-policy"], /default-src 'self'/);
  });

  await t.test("catalogue et métadonnées", async () => {
    const r = await get("/api/lines");
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 1);
    assert.deepEqual(
      { ...r.json.lines[0] },
      { id: "line:TEST:T9", code: "T9", name: "Gare <> Campus", color: "#AB0672", textColor: "#FFFFFF",
        openingTime: "05:05", closingTime: "00:41", mode: "tram", gtfsRouteId: "4-T9", hasTrace: false }
    );
    const meta = await get("/api/lines/meta");
    assert.deepEqual(meta.json.lines[0], { id: "line:TEST:T9", code: "T9", color: "#AB0672", text_color: "#FFFFFF",
      opening_time: "05:05", closing_time: "00:41" });
  });

  await t.test("arrêts : seuls ceux qui ont des coordonnées", async () => {
    const r = await get(`/api/lines/${LINE}/stops`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.stops, [{ id: "stop_area:TEST:SA:4-29", name: "Génois", lat: 47.33, lon: 5.03, gtfsCode: "29" }]);
  });

  await t.test("tracé absent : polylignes vides", async () => {
    const r = await get(`/api/lines/${LINE}/route`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.polylines, []);
  });

  await t.test("horaires : limit borné, y compris négatif", async () => {
    assert.equal((await get(`/api/lines/${LINE}/schedules/${STOP}`)).json.passages.length, 3);
    assert.equal((await get(`/api/lines/${LINE}/schedules/${STOP}?limit=999`)).json.passages.length, 10);
    const neg = await get(`/api/lines/${LINE}/schedules/${STOP}?limit=-5`);
    assert.equal(neg.json.passages.length, 3);
    assert.equal(neg.json.source, "divia-api");
  });

  await t.test("ligne ou arrêt inconnus : 404 en JSON", async () => {
    for (const path of [
      `/api/lines/${encodeURIComponent("line:TEST:INCONNUE")}/stops`,
      `/api/lines/${encodeURIComponent("line:TEST:INCONNUE")}/vehicles`,
      `/api/lines/${encodeURIComponent("line:TEST:INCONNUE")}/delays`,
      `/api/lines/${LINE}/schedules/${encodeURIComponent("bidon:4-29")}`,
      `/api/lines/${LINE}/schedules/${"A".repeat(3000)}`,
    ]) {
      const r = await get(path);
      assert.equal(r.status, 404, path.slice(0, 60));
      assert.equal(r.json.error, "Ressource inconnue");
    }
  });

  await t.test("route inconnue, méthode non prévue et URL mal encodée : JSON sans pile d'appels", async () => {
    const nope = await get("/api/nope");
    assert.deepEqual([nope.status, nope.json.error], [404, "Ressource inconnue"]);
    assert.equal((await get("/api/lines", "POST")).status, 404);
    const bad = await get("/api/lines/%E0%A4%A/stops");
    assert.deepEqual([bad.status, bad.json.error], [400, "Requête invalide"]);
    assert.doesNotMatch(bad.body, /at .*\.js/);
  });

  await t.test("sources temps réel injoignables : dégradation prévue", async () => {
    const vehicles = await get(`/api/lines/${LINE}/vehicles`);
    assert.deepEqual([vehicles.status, vehicles.json.detail], [502, "fetch failed"]);
    const delays = await get(`/api/lines/${LINE}/delays`);
    assert.deepEqual([delays.status, delays.json.stops, delays.json.error], [200, {}, "fetch failed"]);
    assert.equal((await get("/api/lines/delays")).status, 200);
    assert.equal((await get("/api/velodi/stations")).status, 502);
  });

  await t.test("fichiers statiques servis, sources du serveur non exposées", async () => {
    assert.equal((await get("/")).status, 200);
    assert.equal((await get("/server.js")).status, 404);
    assert.equal((await get("/..%2fserver.js")).status, 404);
  });
});
