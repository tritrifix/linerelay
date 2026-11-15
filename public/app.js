/* app.js — carte Leaflet de LineRelay : une ligne affichée à la fois,
   choisie via le menu déroulant. Limite les requêtes (seule la ligne
   sélectionnée est chargée + rafraîchie) et évite les superpositions. */
(() => {
  "use strict";

  const DIJON = [47.3215, 5.0415];
  const REFRESH_MS = 30000;
  const STORAGE_KEY = "linerelay.selectedLine"; // mémorise la ligne choisie (persistée au rechargement)
  const VELODI_VALUE = "velodi"; // valeur sentinelle du menu pour le mode stations vélo
  const VELODI_COLOR = "#127a3a"; // vert vélo, distinct des couleurs de lignes (contraste AA avec le blanc)

  // Préférences : lecture sous le nom actuel, puis sous l'ancien préfixe
  // « divia. » pour ne pas perdre le choix déjà mémorisé par un visiteur.
  const readPref = (key) => localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^linerelay\./, "divia."));

  // Les boutons de zoom vont en bas à droite : en haut à gauche, leur place
  // par défaut, ils étaient recouverts par la barre de sélection.
  const map = L.map("map", { zoomControl: false }).setView(DIJON, 13);
  L.control.zoom({ position: "bottomright", zoomInTitle: "Zoomer", zoomOutTitle: "Dézoomer" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">les contributeurs OpenStreetMap</a>',
  }).addTo(map);

  const routeLayer = L.layerGroup().addTo(map);
  const stopLayer = L.layerGroup().addTo(map);
  const busLayer = L.layerGroup().addTo(map);
  const velodiLayer = L.layerGroup().addTo(map);

  const stopMarkers = new Map(); // stopId -> { marker, name }
  const velodiMarkers = new Map(); // stationId -> { marker }
  const vehicleMarkers = new Map(); // id véhicule -> { marker, el, dirEl, sig }
  const lineMeta = new Map(); // lineId -> { color, text_color } (métadonnées officielles)
  let openStopId = null;
  let currentLineId = null;
  let velodiActive = false; // true quand la catégorie DiviaVélodi est sélectionnée
  let lineColor = "#888888";
  let refreshTimer = null;
  let selectSeq = 0; // numéro de la sélection en cours : écarte les réponses d'une ligne quittée

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Couleur de texte lisible sur un fond donné (#RRGGBB) : la plus contrastée
  // de l'encre foncée et du blanc, selon la luminance relative WCAG. Les
  // couleurs de ligne officielles sont souvent trop claires pour du blanc.
  function readableOn(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#fff";
    const lum = [0, 2, 4]
      .map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
      .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
    const onWhite = 1.05 / (lum + 0.05);
    const onInk = (lum + 0.05) / (0.0151 + 0.05); // 0,0151 = luminance de l'encre #1c2230
    return onWhite >= onInk ? "#fff" : "#1c2230";
  }

  function setStatus(state, label) {
    const el = $("status");
    el.classList.remove("ok", "stale", "error");
    el.classList.add(state);
    $("status-label").textContent = label;
    $("status-time").textContent =
      "MàJ " + new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // "Service : 05h05 – 00h41" depuis les métadonnées. Vide si les deux champs
  // sont absents (repli silencieux, le .service:empty le masque en CSS).
  function formatService(meta) {
    if (!meta || (!meta.opening_time && !meta.closing_time)) return "";
    const f = (t) => (t ? t.replace(":", "h") : "—");
    return "Service : " + f(meta.opening_time) + " – " + f(meta.closing_time);
  }

  function applyLineColor(color) {
    if (color) {
      lineColor = color;
      document.documentElement.style.setProperty("--line", color);
    }
  }

  async function api(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  const lineUrl = (suffix) => "api/lines/" + encodeURIComponent(currentLineId) + suffix;

  // Rendu des passages groupés par direction (terminus). Format :
  //   "→ TALANT La Forêt — dans 3 min, 11 min"
  // Repli silencieux : si la direction est absente ("—"), on affiche les
  // horaires seuls, sans la ligne de terminus.
  function renderPassages(passages) {
    const groups = new Map(); // direction -> [passages] (ordre d'apparition préservé)
    for (const p of passages || []) {
      const dir = p.direction && p.direction !== "—" ? p.direction : "";
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(p);
    }
    let html = "";
    for (const [dir, ps] of groups) {
      const parts = ps.map((p) => (p.minutes <= 0 ? "à quai" : p.minutes + " min"));
      const when = (parts[0] === "à quai" ? "" : "dans ") + parts.join(", ");
      const realtime = ps.some((p) => p.realtime);
      html +=
        '<div class="passage' + (realtime ? "" : " sched") + '">' +
        (dir ? '<span class="dir">→ ' + escapeHtml(dir) + "</span>" : "") +
        '<span class="when">' + when +
        '<span class="rt" title="' + (realtime ? "temps réel" : "horaire théorique") + '"></span></span>' +
        "</div>";
    }
    return html;
  }

  // Métadonnées officielles (couleurs) chargées une fois au démarrage.
  // Échec silencieux : on conserve alors les couleurs renvoyées par /stops.
  async function loadMeta() {
    try {
      const data = await api("api/lines/meta");
      for (const l of data.lines || [])
        lineMeta.set(l.id, { color: l.color, text_color: l.text_color, opening_time: l.opening_time, closing_time: l.closing_time });
    } catch (e) {
      console.warn("loadMeta", e.message);
    }
  }

  /* ----------------------- retards (GTFS-RT) --------------------------- */
  let delaysByCode = {}; // codeGTFS -> { delay: minutes|null, skipped: bool }
  const DELAYS_KEY = "linerelay.showDelays"; // mémorise l'affichage des retards
  let showDelays = readPref(DELAYS_KEY) === "1"; // OFF par défaut

  // Icône d'arrêt + éventuel badge de retard. info = entrée delaysByCode.
  function stopIcon(info) {
    let badge = "";
    if (info) {
      if (info.skipped) badge = '<span class="delay-badge skip">Supprimé</span>';
      else if (info.delay != null && info.delay > 2) badge = '<span class="delay-badge late">+' + info.delay + 'min</span>';
    }
    return L.divIcon({ className: "", html: '<div class="stop-marker"></div>' + badge, iconSize: [14, 14], iconAnchor: [7, 7] });
  }

  // Récupère les retards en cours (best-effort, échec silencieux).
  async function loadDelays() {
    try {
      const data = await api(lineUrl("/delays")); // retards de la ligne affichée uniquement
      delaysByCode = data.stops || {};
    } catch (e) {
      console.warn("loadDelays", e.message); // on conserve l'état précédent, aucun badge ajouté
    }
  }

  // Réapplique les badges sur les marqueurs d'arrêts affichés.
  // Si l'affichage des retards est désactivé, aucun badge (marqueur nu).
  function applyDelayBadges() {
    for (const entry of stopMarkers.values()) {
      const info = showDelays && entry.gtfsCode ? delaysByCode[entry.gtfsCode] : null;
      entry.marker.setIcon(stopIcon(info));
    }
  }

  // Met à jour l'apparence du bouton bascule selon l'état courant.
  function syncDelaysButton() {
    const btn = $("delays-toggle");
    if (!btn) return;
    btn.classList.toggle("active", showDelays);
    btn.setAttribute("aria-pressed", showDelays ? "true" : "false");
    btn.title = showDelays ? "Masquer les retards" : "Afficher les retards";
  }

  // Bascule l'affichage des retards (mémorisé). Ne charge le flux que si activé.
  async function toggleDelays() {
    showDelays = !showDelays;
    localStorage.setItem(DELAYS_KEY, showDelays ? "1" : "0");
    syncDelaysButton();
    if (showDelays && currentLineId) await loadDelays();
    applyDelayBadges();
  }

  /* ----------------------------- catalogue ----------------------------- */
  async function loadCatalog() {
    const data = await api("api/lines");
    const sel = $("line-select");
    sel.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— Sélectionnez une ligne —";
    sel.appendChild(placeholder);
    const groups = { tram: "Tramway", bus: "Bus" };
    for (const mode of ["tram", "bus"]) {
      const lines = data.lines.filter((l) => l.mode === mode);
      if (!lines.length) continue;
      const og = document.createElement("optgroup");
      og.label = groups[mode];
      for (const l of lines) {
        const opt = document.createElement("option");
        opt.value = l.id;
        opt.textContent = `${l.code} — ${l.name}`;
        opt.dataset.color = l.color;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    // Catégorie vélos en libre-service (données stations, pas une ligne).
    const velodiGroup = document.createElement("optgroup");
    velodiGroup.label = "Vélos en libre-service";
    const velodiOpt = document.createElement("option");
    velodiOpt.value = VELODI_VALUE;
    velodiOpt.textContent = "DiviaVélodi — stations";
    velodiGroup.appendChild(velodiOpt);
    sel.appendChild(velodiGroup);

    sel.addEventListener("change", () => selectLine(sel.value));
    // Restaure le dernier choix s'il existe toujours ; sinon, aucun.
    const saved = readPref(STORAGE_KEY);
    if (saved === VELODI_VALUE || (saved && data.lines.some((l) => l.id === saved))) {
      sel.value = saved;
      return saved;
    }
    sel.value = "";
    return null;
  }

  /* --------------------------- sélection ligne -------------------------- */
  async function selectLine(lineId) {
    const seq = ++selectSeq;
    openStopId = null;
    velodiActive = false;
    $("delays-toggle").hidden = lineId === VELODI_VALUE; // sans objet pour les stations vélo
    routeLayer.clearLayers();
    stopLayer.clearLayers();
    busLayer.clearLayers();
    velodiLayer.clearLayers();
    stopMarkers.clear();
    velodiMarkers.clear();
    vehicleMarkers.clear();

    // Catégorie DiviaVélodi : affichage des stations vélo, pas d'une ligne.
    if (lineId === VELODI_VALUE) {
      currentLineId = null;
      return selectVelodi();
    }

    currentLineId = lineId || null;

    // Aucune ligne sélectionnée (placeholder) : carte vide, état d'attente.
    if (!currentLineId) {
      localStorage.removeItem(STORAGE_KEY);
      $("line-badge").textContent = "—";
      $("line-badge").style.background = "";
      $("line-badge").style.color = "";
      $("line-service").textContent = "";
      $("line-select").value = "";
      map.setView(DIJON, 13);
      setStatus("stale", "Choisissez une ligne");
      return;
    }

    localStorage.setItem(STORAGE_KEY, currentLineId);
    $("line-select").value = currentLineId;
    setStatus("stale", "Chargement…");

    try {
      // Tracé + arrêts en parallèle (2 requêtes seulement)
      const [route, stopsData] = await Promise.all([api(lineUrl("/route")), api(lineUrl("/stops"))]);
      if (seq !== selectSeq) return; // une autre ligne a été choisie entre-temps

      const meta = lineMeta.get(currentLineId);
      applyLineColor((meta && meta.color) || (stopsData.line && stopsData.line.color) || route.color);
      if (stopsData.line) {
        $("line-badge").textContent = stopsData.line.code;
        $("line-badge").style.background = lineColor;
        $("line-badge").style.color = readableOn(lineColor);
      }
      $("line-service").textContent = formatService(meta);

      (route.polylines || []).forEach((pl) =>
        L.polyline(pl.points, { color: lineColor, weight: 5, opacity: 0.85, lineJoin: "round" }).addTo(routeLayer)
      );
      routeLayer.eachLayer((l) => l.bringToBack && l.bringToBack());

      const bounds = [];
      for (const s of stopsData.stops) {
        const marker = L.marker([s.lat, s.lon], { icon: stopIcon(null), title: s.name });
        marker.bindPopup('<div class="popup-title">' + escapeHtml(s.name) + "</div>…", { minWidth: 220 });
        // Chargement à l'ouverture de la popup, et non au clic : Leaflet ouvre
        // aussi la popup au clavier (Entrée), sans émettre de clic.
        marker.on("popupopen", () => {
          openStopId = s.id;
          refreshPopup(s.id, s.name);
        });
        marker.on("popupclose", () => {
          if (openStopId === s.id) openStopId = null;
        });
        marker.addTo(stopLayer);
        stopMarkers.set(s.id, { marker, name: s.name, gtfsCode: s.gtfsCode });
        bounds.push([s.lat, s.lon]);
      }
      if (bounds.length) map.fitBounds(bounds, { padding: [50, 50] });

      if (showDelays) await loadDelays();
      if (seq !== selectSeq) return;
      applyDelayBadges();
      await tick();
    } catch (e) {
      if (seq !== selectSeq) return;
      setStatus("error", "Ligne indisponible");
      console.warn("selectLine", e.message);
    }
  }

  async function refreshPopup(stopId, name) {
    const entry = stopMarkers.get(stopId);
    if (!entry) return;
    try {
      const data = await api(lineUrl("/schedules/" + encodeURIComponent(stopId) + "?limit=3"));
      const rows = renderPassages(data.passages);
      const foot = data.source === "gtfs-rt-fallback" ? "GTFS-RT (repli)" : "temps réel · Navitia";
      entry.marker.setPopupContent(
        '<div class="popup-title">' + escapeHtml(name) + "</div>" +
          (rows || '<div class="popup-empty">Aucun passage à venir.</div>') +
          '<div class="popup-foot">' + foot + (data.stale ? " · cache" : "") + "</div>"
      );
    } catch (e) {
      entry.marker.setPopupContent(
        '<div class="popup-title">' + escapeHtml(name) + '</div><div class="popup-empty">Horaires indisponibles.</div>'
      );
    }
  }

  /* --------------------------- DiviaVélodi ----------------------------- */
  // Icône de station : pastille verte portant le nombre de vélos disponibles
  // (grise si station vide ou hors service).
  function bikeIcon(st) {
    const cls = !st.online ? "off" : st.bikes === 0 ? "empty" : "";
    return L.divIcon({
      className: "",
      html: '<div class="velodi-marker ' + cls + '">' + st.bikes + "</div>",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }

  const plural = (n) => (n > 1 ? "s" : "");

  function velodiPopup(st) {
    const num = st.number ? ' <span class="velodi-num">n°' + escapeHtml(st.number) + "</span>" : "";
    const ebikes = st.ebikes
      ? '<div class="velodi-stat">⚡ ' + st.ebikes + " électrique" + plural(st.ebikes) + "</div>"
      : "";
    return (
      '<div class="popup-title">' + escapeHtml(st.name) + num + "</div>" +
      '<div class="velodi-stat"><b>' + st.bikes + "</b> vélo" + plural(st.bikes) + " disponible" + plural(st.bikes) + "</div>" +
      ebikes +
      '<div class="velodi-stat"><b>' + st.docks + "</b> place" + plural(st.docks) + " libre" + plural(st.docks) + "</div>" +
      '<div class="popup-foot">' + (st.online ? "en service" : "hors service") + " · DiviaVélodi</div>"
    );
  }

  async function selectVelodi() {
    velodiActive = true;
    localStorage.setItem(STORAGE_KEY, VELODI_VALUE);
    $("line-select").value = VELODI_VALUE;
    applyLineColor(VELODI_COLOR);
    $("line-badge").textContent = "Vélodi";
    $("line-badge").style.background = VELODI_COLOR;
    $("line-badge").style.color = readableOn(VELODI_COLOR);
    $("line-service").textContent = "";
    setStatus("stale", "Chargement…");
    await tickVelodi(true);
  }

  // Récupère la dispo des stations et met à jour les marqueurs (créés une fois,
  // puis simplement réactualisés). `fit` recadre la carte au premier chargement.
  async function tickVelodi(fit) {
    try {
      const data = await api("api/velodi/stations");
      const bounds = [];
      for (const st of data.stations || []) {
        const html = velodiPopup(st);
        const entry = velodiMarkers.get(st.id);
        if (entry) {
          entry.marker.setIcon(bikeIcon(st));
          entry.marker.setPopupContent(html);
        } else {
          const marker = L.marker([st.lat, st.lon], { icon: bikeIcon(st), title: st.name });
          marker.bindPopup(html, { minWidth: 200 });
          marker.addTo(velodiLayer);
          velodiMarkers.set(st.id, { marker });
        }
        bounds.push([st.lat, st.lon]);
      }
      if (fit && bounds.length) map.fitBounds(bounds, { padding: [50, 50] });
      const n = (data.stations || []).length;
      setStatus(data.stale ? "stale" : "ok", "À jour · " + n + " station" + plural(n) + (data.stale ? " · cache" : ""));
    } catch (e) {
      setStatus("error", "Stations indisponibles");
      console.warn("tickVelodi", e.message);
    }
  }

  /* ------------------------ véhicules : direction ----------------------- */
  // Flèche de sens de marche, dessinée pointe vers le haut (nord) autour du
  // marqueur, puis tournée du cap du véhicule. Pleine : cap donné par le flux ;
  // creuse et en pointillé : cap estimé d'après deux positions successives.
  const DIR_ARROW =
    '<svg viewBox="0 0 44 44" aria-hidden="true" focusable="false"><path d="M22 0.8 30.5 10.5 22 7.6 13.5 10.5Z"/></svg>';
  const CARDINALS = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
  const cardinal = (deg) => CARDINALS[Math.round(deg / 45) % 8];

  // Ce qu'il faut afficher pour un véhicule : flèche (ou non), texte de la
  // popup et intitulé accessible. La direction est toujours dite en toutes
  // lettres, la flèche n'étant qu'un rappel visuel.
  function vehicleView(v) {
    // Serveur antérieur (sans `headingSource`) : on se rabat sur `bearing`.
    const heading =
      typeof v.heading === "number" ? v.heading : v.headingSource === undefined && typeof v.bearing === "number" ? v.bearing : null;
    const estimated = v.headingSource === "estimé";
    const stopped = v.stopped === true;
    const arrow = heading != null && !stopped; // à l'arrêt ou cap inconnu : pas de flèche trompeuse
    const name = "Véhicule " + (v.id || "");
    const dest = v.destination ? "vers " + v.destination : "";

    let sense;
    if (stopped) sense = "À l'arrêt";
    else if (heading == null) sense = "Sens de marche inconnu";
    else sense = (estimated ? "Cap estimé : " : "Cap : ") + cardinal(heading) + " (" + Math.round(heading) + "°)";

    let speed = "";
    if (!stopped) {
      if (v.speedReliable === false) speed = "Vitesse indisponible";
      else if (v.speed != null) speed = Math.round(v.speed) + " km/h"; // le flux publie des km/h
      else speed = "En circulation";
    }

    const html =
      '<div class="popup-title">' + escapeHtml(name) + "</div>" +
      (dest ? '<div class="veh-dest">→ ' + escapeHtml(dest) + "</div>" : "") +
      '<div class="veh-info">' + sense + "</div>" +
      (estimated && arrow ? '<div class="veh-note">Estimation d\'après ses deux dernières positions.</div>' : "") +
      (speed ? '<div class="veh-info">' + speed + "</div>" : "");
    const label = [name, dest, arrow ? (estimated ? "cap estimé " : "cap ") + cardinal(heading) : stopped ? "à l'arrêt" : ""]
      .filter(Boolean)
      .join(", ");
    return { arrow, estimated, rotation: arrow ? Math.round(heading) : 0, html, label };
  }

  // Applique l'état d'un véhicule à son marqueur. Le DOM n'est touché que si
  // quelque chose a changé ; la rotation passe par le CSSOM (la politique de
  // contenu de la page interdit les attributs style).
  function applyVehicle(entry, v) {
    entry.marker.setLatLng([v.lat, v.lon]);
    const view = vehicleView(v);
    const sig = view.arrow + "|" + view.estimated + "|" + view.rotation + "|" + view.label + "|" + view.html;
    if (sig === entry.sig) return;
    entry.sig = sig;
    if (entry.dirEl) {
      entry.dirEl.hidden = !view.arrow;
      entry.dirEl.classList.toggle("est", view.estimated);
      entry.dirEl.style.transform = "rotate(" + view.rotation + "deg)";
    }
    if (entry.el) {
      entry.el.title = view.label;
      entry.el.setAttribute("aria-label", view.label);
    }
    entry.marker.setPopupContent(view.html);
  }

  function createVehicle() {
    const marker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "",
        html: '<div class="veh"><span class="veh-dir" hidden>' + DIR_ARROW + '</span><div class="bus-marker">🚌</div></div>',
        iconSize: [44, 44],
        iconAnchor: [22, 22],
        popupAnchor: [0, -10],
      }),
      zIndexOffset: 1000,
    });
    marker.bindPopup("", { minWidth: 180 });
    return { marker, el: null, dirEl: null, sig: null };
  }

  // Met à jour les marqueurs existants, ajoute les véhicules apparus et retire
  // ceux qui ont quitté la ligne : aucun marqueur n'est recréé à chaque
  // rafraîchissement, et une popup ouverte le reste.
  function renderVehicles(vehicles) {
    const seen = new Set();
    vehicles.forEach((v, i) => {
      let key = v.id != null && v.id !== "" ? String(v.id) : "";
      if (!key || seen.has(key)) key = "sans-id-" + i;
      seen.add(key);
      let entry = vehicleMarkers.get(key);
      if (!entry) {
        entry = createVehicle();
        entry.marker.setLatLng([v.lat, v.lon]).addTo(busLayer);
        entry.el = entry.marker.getElement() || null;
        entry.dirEl = entry.el ? entry.el.querySelector(".veh-dir") : null;
        vehicleMarkers.set(key, entry);
      }
      applyVehicle(entry, v);
    });
    for (const [key, entry] of vehicleMarkers) {
      if (seen.has(key)) continue;
      busLayer.removeLayer(entry.marker);
      vehicleMarkers.delete(key);
    }
  }

  /* --------------------------- véhicules (MàJ) -------------------------- */
  async function tick() {
    if (velodiActive) return tickVelodi(false);
    if (!currentLineId) return;
    const lineAtStart = currentLineId;
    try {
      const data = await api(lineUrl("/vehicles"));
      if (lineAtStart !== currentLineId) return; // la ligne a changé pendant l'appel
      renderVehicles(data.vehicles || []);
      if (openStopId) {
        const entry = stopMarkers.get(openStopId);
        if (entry) refreshPopup(openStopId, entry.name);
      }
      if (showDelays) await loadDelays(); // retards rafraîchis au même rythme (cache 30 s côté serveur)
      applyDelayBadges();
      const n = (data.vehicles || []).length;
      setStatus("ok", "À jour · " + n + (n > 1 ? " véhicules" : " véhicule"));
    } catch (e) {
      setStatus("error", "Erreur de mise à jour");
    }
  }

  /* --------------- rafraîchissement manuel (bouton ↻) ------------------- */
  // Actualise immédiatement les positions (et l'éventuelle popup ouverte),
  // puis réarme le minuteur de 30 s pour repartir d'un cycle complet.
  async function manualRefresh() {
    const btn = $("refresh-btn");
    if ((!currentLineId && !velodiActive) || btn.disabled) return;
    btn.disabled = true;
    btn.classList.remove("spin");
    void btn.offsetWidth; // relance l'animation
    btn.classList.add("spin");
    if (refreshTimer) clearInterval(refreshTimer);
    await tick();
    refreshTimer = setInterval(tick, REFRESH_MS);
    btn.disabled = false;
  }

  /* ------------------------------- démarrage ---------------------------- */
  async function init() {
    $("refresh-btn").addEventListener("click", manualRefresh);
    $("delays-toggle").addEventListener("click", toggleDelays);
    // Légende repliable (bouton visible seulement sur petits écrans, via CSS).
    $("legend-toggle").addEventListener("click", () => {
      const open = $("legend").classList.toggle("open");
      $("legend-toggle").setAttribute("aria-expanded", open ? "true" : "false");
    });
    syncDelaysButton();
    setStatus("stale", "Chargement…");
    let savedId;
    try {
      savedId = await loadCatalog();
    } catch (e) {
      setStatus("error", "Réseau indisponible");
      return;
    }
    await loadMeta(); // couleurs officielles (best-effort, ne bloque pas la carte)
    if (savedId) {
      await selectLine(savedId);
    } else {
      setStatus("stale", "Choisissez une ligne");
    }
    refreshTimer = setInterval(tick, REFRESH_MS);
  }

  init();
})();
