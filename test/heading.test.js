/**
 * Tests du cap des véhicules — `npm test` (node:test, aucune dépendance).
 *
 * Aucun appel réseau.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.VELODI_FEED_URL = "http://source.invalid/velos";
process.env.RATE_LIMIT_MAX = "1000";

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
