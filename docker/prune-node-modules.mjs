#!/usr/bin/env node
/**
 * prune-node-modules.mjs — retire de node_modules ce qui n'est pas atteignable
 * à l'exécution, puis supprime les liens de .bin devenus orphelins.
 *
 * Pourquoi : `gtfs-realtime-bindings` déclare `protobufjs-cli` en dépendance
 * normale (et non de développement). Cet outil tire `jsdoc` et toute sa chaîne
 * (@babel, lodash, underscore, markdown-it, …) alors que LineRelay n'utilise
 * que le décodeur `protobufjs`. Soit une vingtaine de Mo d'outillage de
 * génération de code et de documentation, inutiles dans l'image.
 *
 * Fonctionnement : on part des dépendances de production de package.json, on
 * parcourt leurs dépendances de proche en proche, et on supprime tout paquet
 * de premier niveau qui n'est pas dans cette fermeture. Les paquets listés
 * dans DROP sont écartés du parcours : ni eux ni leurs dépendances exclusives
 * ne sont conservés.
 *
 * Le calcul est refait à chaque build : il reste juste après une mise à jour
 * de dépendances, là où une liste figée se périmerait en silence.
 *
 * Usage : node docker/prune-node-modules.mjs [racine_du_projet]
 *         DRY_RUN=1 pour afficher sans rien supprimer.
 */
import { readFileSync, readdirSync, rmSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.argv[2] || ".");
const NM = join(ROOT, "node_modules");
const DRY_RUN = process.env.DRY_RUN === "1";

// Outillage de build/doc dont l'exécution n'a jamais besoin.
const DROP = new Set(["protobufjs-cli"]);

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function listPackages() {
  const names = [];
  for (const entry of readdirSync(NM)) {
    if (entry === ".bin" || entry === ".package-lock.json") continue;
    if (entry.startsWith("@")) {
      for (const sub of readdirSync(join(NM, entry))) names.push(`${entry}/${sub}`);
    } else {
      names.push(entry);
    }
  }
  return names;
}

const rootPkg = readJson(join(ROOT, "package.json"));
if (!rootPkg) {
  console.error(`[prune] package.json introuvable dans ${ROOT}`);
  process.exit(1);
}

// Fermeture transitive des dépendances de production.
const keep = new Set();
const queue = Object.keys(rootPkg.dependencies || {}).filter((n) => !DROP.has(n));

while (queue.length) {
  const name = queue.pop();
  if (keep.has(name) || DROP.has(name)) continue;
  const manifest = readJson(join(NM, name, "package.json"));
  if (!manifest) continue; // absent : rien à garder sous ce nom
  keep.add(name);
  // Les dépendances facultatives peuvent être réellement chargées ; les
  // peerDependencies non installées, elles, ne nous concernent pas.
  for (const dep of [
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ]) {
    if (!keep.has(dep) && !DROP.has(dep)) queue.push(dep);
  }
}

// Suppression de tout ce qui n'est pas dans la fermeture.
let removed = 0;
for (const name of listPackages()) {
  if (keep.has(name)) continue;
  const target = join(NM, name);
  console.log(`[prune] ${DRY_RUN ? "à supprimer" : "supprimé"} : ${name}`);
  if (!DRY_RUN) rmSync(target, { recursive: true, force: true });
  removed++;
}

// Liens de .bin pointant vers un paquet disparu.
const bin = join(NM, ".bin");
if (existsSync(bin)) {
  for (const entry of readdirSync(bin)) {
    const link = join(bin, entry);
    let dangling = false;
    try {
      realpathSync(link);
    } catch {
      dangling = lstatSync(link, { throwIfNoEntry: false }) !== undefined;
    }
    if (dangling) {
      console.log(`[prune] ${DRY_RUN ? "lien mort" : "lien supprimé"} : .bin/${entry}`);
      if (!DRY_RUN) rmSync(link, { force: true });
    }
  }
}

console.log(
  `[prune] ${keep.size} paquets conservés, ${removed} supprimés${DRY_RUN ? " (simulation)" : ""}`
);
