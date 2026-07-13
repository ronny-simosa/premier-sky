// ===========================================================================
// Lógica de la página por estado: mapa Leaflet con puntos calientes de
// tormentas (alertas NWS + outlook SPC), búsqueda por zip, geocodificación
// inversa (dirección + zip al hacer clic) y proyección a 7 días (Open-Meteo).
// ===========================================================================
(function () {
  const params = new URLSearchParams(location.search);
  const code = (params.get("state") || "IL").toUpperCase();
  const ST = window.STATES[code];

  function tr(key, vars) {
    return window.I18n ? window.I18n.t(key, vars) : key;
  }
  function loc() {
    return (window.I18n && window.I18n.lang) || "en";
  }

  if (!ST) {
    (async () => {
      if (window.I18n) {
        await window.I18n.init();
        window.I18n.apply(document);
      }
      document.getElementById("stateTitle").textContent = tr("state.notFound");
    })();
    return;
  }

  const API = window.WeatherAPI;

  // --- Cabecera + navegación -----------------------------------------------
  document.getElementById("stateTitle").textContent = `${ST.name} (${ST.code})`;
  document.title = `Premier Sky · ${ST.name}`;
  const nav = document.getElementById("nav");
  const navApp = document.getElementById("navApp") || nav;

  (async () => {
    if (window.I18n) {
      await window.I18n.init();
      // Globals (right): Home → Flag → session (below)
      nav.prepend(window.I18n.createHomeButton());
      window.I18n.mountLangSwitch(nav);
      window.I18n.apply(document);
      try { renderLegend(); } catch (e) { /* defined later; event also refreshes */ }
    }
  })();

  API.getAuthMe().then((auth) => {
    if (!auth.authenticated) {
      API.redirectToLogin(auth.sessionExpired);
      return;
    }
    if (!nav || nav.querySelector(".user-bar")) return;
    const bar = document.createElement("div");
    bar.className = "user-bar";
    bar.innerHTML = `<span class="user-email" title="${auth.email}">${auth.email}</span>` +
      `<button type="button" class="btn secondary btn-logout" id="btnLogout" data-i18n="nav.logout">${tr("nav.logout")}</button>`;
    nav.appendChild(bar);
    if (window.I18n) window.I18n.apply(bar);
    document.getElementById("btnLogout")?.addEventListener("click", () => API.logoutAuth());
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    API.getAuthMe().then((auth) => {
      if (!auth.authenticated) API.redirectToLogin(auth.sessionExpired);
    });
  });
  Object.values(window.STATES).forEach((s) => {
    const a = document.createElement("a");
    a.href = `state.html?state=${s.code}`;
    a.textContent = s.code;
    if (s.code === code) a.className = "active";
    navApp.appendChild(a);
  });

  // --- Mapa ----------------------------------------------------------------
  const MAP_BASES = {
    city: {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      opts: { attribution: "© OpenStreetMap © CARTO", maxZoom: 20, subdomains: "abcd" }
    },
    streets: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      opts: { attribution: "© OpenStreetMap", maxZoom: 19 }
    },
    satellite: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      opts: { attribution: "© Esri", maxZoom: 19 }
    }
  };

  function createBaseLayer(styleKey) {
    const cfg = MAP_BASES[styleKey] || MAP_BASES.city;
    return L.tileLayer(cfg.url, cfg.opts);
  }

  let mapStyleKey = "city";
  try {
    const saved = localStorage.getItem("premierMapStyle");
    if (saved && MAP_BASES[saved]) mapStyleKey = saved;
  } catch { /* ignore */ }

  const MAP_STYLE_BTNS = [
    { key: "city", titleKey: "state.map.city", glyph: "🏙" },
    { key: "streets", titleKey: "state.map.streets", glyph: "🗺" },
    { key: "satellite", titleKey: "state.map.satellite", glyph: "🛰" }
  ];

  function syncMapStyleButtons() {
    document.querySelectorAll(".map-style-control a").forEach((a) => {
      a.classList.toggle("active", a.dataset.style === mapStyleKey);
      a.setAttribute("aria-pressed", a.dataset.style === mapStyleKey ? "true" : "false");
      const title = tr(a.dataset.titleKey || "state.map.city");
      a.title = title;
      a.setAttribute("aria-label", title);
    });
  }

  function addMapStyleControl(targetMap) {
    const ctrl = L.control({ position: "topleft" });
    ctrl.onAdd = function () {
      const box = L.DomUtil.create("div", "leaflet-bar map-style-control");
      MAP_STYLE_BTNS.forEach((s) => {
        const a = L.DomUtil.create("a", "", box);
        a.href = "#";
        const title = tr(s.titleKey);
        a.title = title;
        a.dataset.style = s.key;
        a.dataset.titleKey = s.titleKey;
        a.setAttribute("aria-label", title);
        a.innerHTML = s.glyph;
        L.DomEvent.disableClickPropagation(a);
        L.DomEvent.on(a, "click", L.DomEvent.stop);
        L.DomEvent.on(a, "click", (e) => {
          L.DomEvent.preventDefault(e);
          setMapStyle(s.key);
        });
      });
      L.DomEvent.disableClickPropagation(box);
      return box;
    };
    ctrl.addTo(targetMap);
    return ctrl;
  }

  function setMapStyle(key) {
    if (!MAP_BASES[key]) return;
    mapStyleKey = key;
    map.removeLayer(baseLayer);
    baseLayer = createBaseLayer(key).addTo(map);
    syncMapStyleButtons();
    try { localStorage.setItem("premierMapStyle", key); } catch { /* ignore */ }
    jnReflowMap();
  }

  const map = L.map("map", { zoomControl: true }).setView(ST.center, ST.zoom);
  map.createPane("radarPane");
  map.getPane("radarPane").style.zIndex = 350;
  let baseLayer = createBaseLayer(mapStyleKey).addTo(map);
  addMapStyleControl(map);
  syncMapStyleButtons();

  function jnReflowMap() {
    requestAnimationFrame(() => map.invalidateSize({ animate: false }));
  }

  const mapWrapEl = document.querySelector(".map-wrap-clean");
  if (mapWrapEl && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(mapWrapEl);
  }

  const alertsLayer = L.geoJSON(null, { style: alertStyle, onEachFeature: onAlertFeature }).addTo(map);
  const spcLayer = L.geoJSON(null, { style: spcStyle, onEachFeature: onSPCFeature }).addTo(map);
  // Capas de granizo (no se muestran hasta activar su toggle):
  const hailReportsLayer = L.layerGroup(); // puntos de granizo YA reportado (hoy)
  const hailHistoryLayer = L.layerGroup(); // histórico de granizo (rango de fechas)
  const hailOutlookLayer = L.geoJSON(null, { style: hailStyle, onEachFeature: onHailFeature }); // % pronosticado
  const officeLayer = L.layerGroup().addTo(map); // oficinas de Premier + radio 40 mi
  const jobsLayer = L.layerGroup().addTo(map); // jobs JobNimbus por zona
  const scoreLayer = L.layerGroup().addTo(map); // puntuación de tormentas
  let stormScoreData = [];
  let jnJobsData = []; // cache local de jobs cargados
  let jnMarkers = new Map(); // jnid -> marker
  let clickMarker = null;
  let circleLayer = null;
  let selected = null; // {lat, lon} del último punto elegido

  function alertStyle(f) {
    const sev = f.properties.severity || "Unknown";
    const c = window.SEVERITY_COLORS[sev] || window.SEVERITY_COLORS.Unknown;
    return { color: c, weight: 2, fillColor: c, fillOpacity: 0.35 };
  }
  function spcStyle(f) {
    const label = (f.properties.LABEL || f.properties.DN || "").toString().toUpperCase();
    const c = window.SPC_COLORS[label] || "#888";
    return { color: c, weight: 1, fillColor: c, fillOpacity: 0.25, dashArray: "4 3" };
  }
  // Estilo de las zonas de granizo PRONOSTICADO (% de probabilidad).
  function hailStyle(f) {
    const p = f.properties || {};
    const label = (p.LABEL || p.DN || "").toString();
    const c = p.fill || window.HAIL_PROB_COLORS[label] || "#888";
    const sig = label === "SIGN";
    return {
      color: p.stroke || c, weight: sig ? 2 : 1,
      fillColor: c, fillOpacity: sig ? 0.08 : 0.3, dashArray: sig ? "3 4" : null
    };
  }
  function onHailFeature(f, layer) {
    const p = f.properties || {};
    const label = (p.LABEL || "").toString();
    let txt = p.LABEL2 || tr("state.hail.zoneDefault");
    if (label === "SIGN") txt = tr("state.hail.significant");
    layer.bindTooltip(`🔮 ${txt}`, { sticky: true });
    layer.on("click", (e) => { L.DomEvent.stop(e); selectPoint(e.latlng.lat, e.latlng.lng); });
  }
  // Color y tamaño de un reporte de granizo según su diámetro en pulgadas.
  function hailColor(inch) {
    if (inch >= 2.5) return "#e63900";
    if (inch >= 1.75) return "#ff9100";
    if (inch >= 1.0) return "#ffd000";
    return "#3aa0ff";
  }
  function hailRadius(inch) {
    return Math.max(5, Math.min(16, 5 + inch * 3.5));
  }

  // Cualquier clic (sobre polígono de riesgo o sobre el mapa) abre la misma
  // etiqueta de notas, que detecta el riesgo del punto y lista sus zips.
  function onAlertFeature(f, layer) {
    layer.on("click", (e) => { L.DomEvent.stop(e); selectPoint(e.latlng.lat, e.latlng.lng); });
  }
  function onSPCFeature(f, layer) {
    layer.on("click", (e) => { L.DomEvent.stop(e); selectPoint(e.latlng.lat, e.latlng.lng); });
  }

  // --- Detección de riesgo en un punto (point-in-polygon, ray casting) -----
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const hit = ((yi > lat) !== (yj > lat)) &&
        (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }
  function pointInPolygon(lng, lat, rings) {
    if (!rings.length || !pointInRing(lng, lat, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (pointInRing(lng, lat, rings[k])) return false; // dentro de un hueco
    }
    return true;
  }
  function pointInGeometry(lng, lat, geom) {
    if (!geom) return false;
    if (geom.type === "Polygon") return pointInPolygon(lng, lat, geom.coordinates);
    if (geom.type === "MultiPolygon")
      return geom.coordinates.some((poly) => pointInPolygon(lng, lat, poly));
    return false;
  }
  function alertsAtPoint(lat, lng) {
    const found = new Map();
    alertsLayer.eachLayer((l) => {
      const f = l.feature;
      if (f && f.geometry && pointInGeometry(lng, lat, f.geometry)) {
        found.set(f.properties.id, f.properties);
      }
    });
    return [...found.values()];
  }
  function spcRiskAtPoint(lat, lng) {
    let label = null;
    spcLayer.eachLayer((l) => {
      const f = l.feature;
      if (f && f.geometry && pointInGeometry(lng, lat, f.geometry)) {
        label = f.properties.LABEL2 || f.properties.LABEL || f.properties.DN || label;
      }
    });
    return label;
  }

  // --- Dataset de ZIP codes (centroides) para listado exhaustivo -----------
  let ZIPDB = [];
  let zipDbError = null;
  let zipDbPromise = null;
  let zipRadiusCacheKey = "";
  let zipRadiusCache = null;
  let radiusRenderTimer = null;
  const ZIP_CHIP_LIMIT = 48;

  function zipGlobalKey() {
    return `ZIPDB_${ST.code}`;
  }

  function ensureZipDB() {
    const gk = zipGlobalKey();
    if (Array.isArray(window[gk]) && window[gk].length) {
      ZIPDB = window[gk];
      zipDbError = null;
    }
    return ZIPDB.length > 0;
  }

  async function loadZipDB() {
    if (ensureZipDB()) return ZIPDB;
    const globalKey = zipGlobalKey();

    const existing = document.querySelector(`script[src*="zips_${ST.code}.js"]`);
    if (existing && !zipDbPromise) {
      zipDbPromise = new Promise((resolve) => {
        const finish = () => {
          ensureZipDB();
          if (!ZIPDB.length && !zipDbError) {
            zipDbError = tr("state.zip.errRead");
          }
          zipDbPromise = null;
          resolve(ZIPDB);
        };
        if (ensureZipDB()) { finish(); return; }
        existing.addEventListener("load", finish, { once: true });
        existing.addEventListener("error", () => {
          zipDbError = tr("state.zip.errLoad");
          finish();
        }, { once: true });
        setTimeout(finish, 6000);
      });
      return zipDbPromise;
    }

    if (zipDbPromise) return zipDbPromise;
    zipDbPromise = new Promise((resolve) => {
      const url = `assets/data/zips_${ST.code}.js?v=11`;
      const s = document.createElement("script");
      const t = setTimeout(() => {
        zipDbError = tr("state.zip.errTimeout");
        console.warn(zipDbError, "->", url);
        zipDbPromise = null;
        resolve(ZIPDB);
      }, 8000);
      s.onload = () => {
        clearTimeout(t);
        ensureZipDB();
        if (!ZIPDB.length) zipDbError = tr("state.zip.errFormat");
        zipDbPromise = null;
        resolve(ZIPDB);
      };
      s.onerror = () => {
        clearTimeout(t);
        zipDbError = tr("state.zip.errLoad");
        console.warn(zipDbError, "->", url);
        zipDbPromise = null;
        resolve(ZIPDB);
      };
      s.src = url;
      document.head.appendChild(s);
    });
    return zipDbPromise;
  }
  // Distancia en millas entre dos coordenadas (Haversine).
  function haversineMi(lat1, lon1, lat2, lon2) {
    const R = 3958.7613; // radio terrestre en millas
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ZIPs cuyo centroide está dentro de un radio (millas) del punto, por cercanía.
  function zipsWithinRadius(lat, lon, miles) {
    const key = `${ST.code}|${lat.toFixed(4)}|${lon.toFixed(4)}|${miles}|${ZIPDB.length}`;
    if (key === zipRadiusCacheKey && zipRadiusCache) return zipRadiusCache;
    const out = [];
    for (const z of ZIPDB) {
      const d = haversineMi(lat, lon, z[1], z[2]);
      if (d <= miles) out.push([z[0], z[1], z[2], z[3], z[4], d]);
    }
    out.sort((a, b) => a[5] - b[5]);
    zipRadiusCacheKey = key;
    zipRadiusCache = out;
    return out;
  }

  function renderRadiusContext() {
    if (!selected) return;
    renderRadiusZips();
    renderRadiusJobs();
  }

  function scheduleRadiusContext() {
    clearTimeout(radiusRenderTimer);
    radiusRenderTimer = setTimeout(() => renderRadiusContext(), 80);
  }

  function forEachRadiusPanel(fn, retries = 0) {
    const info = document.getElementById("locInfo");
    if (info) fn(info);
    const popEl = clickMarker?.getPopup()?.getElement?.();
    if (popEl) fn(popEl);
    else if (retries < 15) {
      setTimeout(() => forEachRadiusPanel(fn, retries + 1), 40);
    }
  }

  function zipChipsHtml(list) {
    const show = list.slice(0, ZIP_CHIP_LIMIT);
    let html = show.map((z) =>
      `<span class="badge zip-chip" data-zip="${z[0]}" title="${z[3]}, ${z[4]} · ${z[5].toFixed(1)} mi">` +
      `${z[0]}</span>`
    ).join("");
    if (list.length > ZIP_CHIP_LIMIT) {
      html += `<span class="zips-more">${tr("state.zip.moreInRadius", { n: list.length - ZIP_CHIP_LIMIT })}</span>`;
    }
    return html;
  }

  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".zip-chip");
    if (!chip?.dataset.zip) return;
    document.getElementById("zipInput").value = chip.dataset.zip;
    API.geocodeZip(chip.dataset.zip).then((r) => {
      map.setView([r.lat, r.lon], 11);
      selectPoint(r.lat, r.lon, r.name);
    }).catch(() => {});
  });

  ensureZipDB();

  function radiusMiles() {
    return parseInt(document.getElementById("radiusInput").value, 10) || 5;
  }

  function jnJobsWithinRadius(lat, lon, miles) {
    const zipRows = ZIPDB.length ? zipsWithinRadius(lat, lon, miles) : [];
    const zipSet = new Set(zipRows.map((z) => z[0]));
    const seen = new Set();
    const out = [];

    for (const job of jnJobsData.filter(jnJobMatchesFilter)) {
      let dist = null;
      if (job.lat != null && job.lon != null) {
        dist = haversineMi(lat, lon, job.lat, job.lon);
        if (dist <= miles) {
          if (!seen.has(job.jnid)) { seen.add(job.jnid); out.push({ job, dist }); }
          continue;
        }
      }
      const z = String(job.zip || "").replace(/\D/g, "").slice(0, 5);
      if (z && zipSet.has(z)) {
        const zipRow = zipRows.find((r) => r[0] === z);
        const zipDist = zipRow ? zipRow[5] : miles;
        if (!seen.has(job.jnid)) {
          seen.add(job.jnid);
          out.push({
            job,
            dist: job.lat != null && job.lon != null
              ? haversineMi(lat, lon, job.lat, job.lon)
              : zipDist
          });
        }
      }
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  function jnRadiusJobsHtml(list, miles) {
    const esc = (window.JNPhases && window.JNPhases.escapeHtml) || ((s) => String(s ?? ""));
    if (!jnJobsData.length) {
      return `<div class="jn-radius-empty">${tr("state.jn.radiusLoading")}</div>`;
    }
    if (!list.length) {
      return `<div class="jn-radius-empty">${tr("state.jn.radiusEmpty", { miles })}</div>`;
    }
    return list.map(({ job, dist }) => {
      const addr = [job.address, job.city, job.state, job.zip].filter(Boolean).join(", ");
      return `<button type="button" class="jn-radius-job" data-jnid="${job.jnid}">
        <div class="jn-radius-job-top">
          <span class="jn-radius-phase" style="background:${job.phaseColor}">${esc(job.phaseLabel)}</span>
          <span class="jn-radius-dist">${dist.toFixed(1)} mi</span>
        </div>
        <div class="jn-radius-name">${esc(job.name)}</div>
        <div class="jn-radius-status">${esc(job.status)}</div>
        <div class="jn-radius-addr">${esc(addr || tr("state.jn.noAddress"))}</div>
      </button>`;
    }).join("");
  }

  function renderRadiusJobs() {
    if (!selected) return;
    const miles = radiusMiles();
    const list = jnJobsWithinRadius(selected.lat, selected.lon, miles);
    const html = jnRadiusJobsHtml(list, miles);
    const title = tr("state.jn.radiusTitle", { miles, n: list.length });

    const apply = (root) => {
      const t = root.querySelector(".jnRadiusTitle");
      const listEl = root.querySelector(".jnRadiusList");
      if (t) t.textContent = title;
      if (!listEl) return;
      listEl.innerHTML = html;
      listEl.querySelectorAll(".jn-radius-job").forEach((el) => {
        el.addEventListener("click", () => {
          const job = jnJobsData.find((j) => j.jnid === el.dataset.jnid);
          if (job) focusJnJob(job);
        });
      });
    };

    forEachRadiusPanel(apply);
  }

  // Raíces donde se muestran los zips: panel lateral y popup (si está abierto).
  function panelRoots() {
    const roots = [document.getElementById("locInfo")];
    const pop = clickMarker && clickMarker.getPopup && clickMarker.getPopup();
    const popEl = pop && pop.getElement();
    if (popEl) roots.push(popEl);
    return roots.filter(Boolean);
  }

  function makeZipChip(zip, title) {
    const chip = document.createElement("span");
    chip.className = "badge";
    chip.style.cssText =
      "background:var(--panel-2);color:var(--text);border:1px solid var(--accent);cursor:pointer;padding:4px 9px";
    chip.title = title ? tr("state.zip.goToNamed", { place: title }) : tr("state.zip.goTo");
    chip.textContent = zip;
    chip.addEventListener("click", () => {
      document.getElementById("zipInput").value = zip;
      API.geocodeZip(zip).then((r) => {
        map.setView([r.lat, r.lon], 11);
        selectPoint(r.lat, r.lon, r.name);
      }).catch(() => {});
    });
    return chip;
  }

  // Dibuja el círculo de radio y rellena la lista de zips en popup y panel.
  function renderRadiusZips() {
    if (!selected) return;
    const miles = radiusMiles();
    const hasZipDb = ensureZipDB();

    if (circleLayer) map.removeLayer(circleLayer);
    circleLayer = L.circle([selected.lat, selected.lon], {
      radius: miles * 1609.344,
      color: "#3aa0ff", weight: 1.5, fillColor: "#3aa0ff", fillOpacity: 0.08
    }).addTo(map);

    let statusTxt;
    let list = [];
    if (zipDbError) {
      statusTxt = `⚠ ${zipDbError}`;
    } else if (!hasZipDb) {
      statusTxt = tr("state.zip.loading");
      loadZipDB().then(() => renderRadiusContext());
    } else {
      list = zipsWithinRadius(selected.lat, selected.lon, miles);
      statusTxt = list.length
        ? tr("state.zip.count", { n: list.length })
        : tr("state.zip.none");
    }

    const chipsHtml = list.length ? zipChipsHtml(list) : "";

    forEachRadiusPanel((root) => {
      const title = root.querySelector(".zipTitle");
      const status = root.querySelector(".zipsStatus");
      const chips = root.querySelector(".zipChips");
      if (title) title.textContent = tr("state.zip.title", { miles });
      if (status) status.textContent = statusTxt;
      if (chips) chips.innerHTML = chipsHtml;
    });
  }

  // --- Leyenda -------------------------------------------------------------
  function sevLabel(sev) {
    const key = `state.sev.${sev}`;
    const v = tr(key);
    return v === key ? sev : v;
  }

  function renderLegend() {
    const el = document.getElementById("legend");
    if (!el) return;
    const sevRows = Object.entries(window.SEVERITY_COLORS)
      .map(([k, v]) => `<div class="row"><span class="sw" style="background:${v}"></span>${sevLabel(k)}</div>`)
      .join("");
    const office = (window.PREMIER_OFFICES || {})[ST.code];
    const officeRow = office
      ? `<h4>🏠 Premier</h4><div class="row"><span>🏠</span> ${tr("state.office.coverage", { n: window.PREMIER_RADIUS_MI || 40 })}</div>`
      : "";
    el.innerHTML = `
      ${officeRow}
      <h4${office ? ' style="margin-top:8px"' : ""}>${tr("state.legend.nws")}</h4>${sevRows}
      <h4 style="margin-top:8px">${tr("state.legend.spc")}</h4>
      <div class="row"><span class="sw" style="background:#ffe066"></span>${tr("state.spc.slight")}</div>
      <div class="row"><span class="sw" style="background:#ffa366"></span>${tr("state.spc.enhanced")}</div>
      <div class="row"><span class="sw" style="background:#ff6666"></span>${tr("state.spc.moderate")}</div>
      <div class="row"><span class="sw" style="background:#ff66ff"></span>${tr("state.spc.high")}</div>
      <h4 style="margin-top:8px">🧊 ${tr("state.legend.hailRep")}</h4>
      <div class="row"><span class="sw" style="background:#3aa0ff"></span>&lt; 1"</div>
      <div class="row"><span class="sw" style="background:#ffd000"></span>1" – 1.74"</div>
      <div class="row"><span class="sw" style="background:#ff9100"></span>1.75" – 2.49"</div>
      <div class="row"><span class="sw" style="background:#e63900"></span>≥ 2.5"</div>
      <h4 style="margin-top:8px">🔮 ${tr("state.legend.hailFc")}</h4>
      <div class="row"><span class="sw" style="background:#8b4726"></span>5%</div>
      <div class="row"><span class="sw" style="background:#ffc800"></span>15%</div>
      <div class="row"><span class="sw" style="background:#ff0000"></span>30%</div>
      <div class="row"><span class="sw" style="background:#ff00ff"></span>45%</div>
      <div class="row"><span class="sw" style="background:#912cee"></span>60%</div>
      <h4 style="margin-top:8px">📊 ${tr("state.legend.score")}</h4>
      <div class="row"><span class="sw" style="background:#c1121f"></span>${tr("state.legend.scoreHigh")}</div>
      <div class="row"><span class="sw" style="background:#e85d04"></span>${tr("state.legend.scoreReview")}</div>
      <div class="row"><span class="sw" style="background:#ffd000"></span>${tr("state.legend.scoreInfo")}</div>`;
  }
  renderLegend();

  // --- Toggles de capas ----------------------------------------------------
  document.getElementById("tglOffice").addEventListener("change", (e) => {
    if (e.target.checked) map.addLayer(officeLayer); else map.removeLayer(officeLayer);
  });
  document.getElementById("tglAlerts").addEventListener("change", (e) => {
    if (e.target.checked) map.addLayer(alertsLayer); else map.removeLayer(alertsLayer);
  });
  document.getElementById("tglSPC").addEventListener("change", (e) => {
    if (e.target.checked) map.addLayer(spcLayer); else map.removeLayer(spcLayer);
  });
  document.getElementById("tglHailRep").addEventListener("change", async (e) => {
    if (e.target.checked) { await loadHailReports(); map.addLayer(hailReportsLayer); }
    else map.removeLayer(hailReportsLayer);
  });
  document.getElementById("tglHailFc").addEventListener("change", async (e) => {
    if (e.target.checked) {
      if (!hailOutlookLoaded) { hailOutlookLoaded = true; await loadHailOutlook(); }
      map.addLayer(hailOutlookLayer);
    } else map.removeLayer(hailOutlookLayer);
  });
  document.getElementById("tglJobs").addEventListener("change", (e) => {
    if (e.target.checked) map.addLayer(jobsLayer);
    else map.removeLayer(jobsLayer);
  });
  document.getElementById("tglScore").addEventListener("change", async (e) => {
    if (e.target.checked) {
      await loadStormScores();
      map.addLayer(scoreLayer);
    } else {
      map.removeLayer(scoreLayer);
    }
  });

  function scoreTierColor(tier) {
    if (tier === "campaign") return "#c1121f";
    if (tier === "review") return "#e85d04";
    return "#ffd000";
  }

  function scoreAtPoint(lat, lon, maxMi = 30) {
    let best = null;
    for (const h of stormScoreData) {
      const d = haversineMi(lat, lon, h.lat, h.lon);
      if (d > maxMi) continue;
      if (!best || h.score.total > best.score.total) best = h;
    }
    return best;
  }

  async function loadStormScores() {
    try {
      const data = await API.getStormScores(ST.code);
      stormScoreData = data.hotspots || [];
      scoreLayer.clearLayers();
      for (const h of stormScoreData) {
        const s = h.score;
        const col = scoreTierColor(s.tier);
        const m = L.circleMarker([h.lat, h.lon], {
          radius: Math.min(18, 8 + Math.floor(s.total / 12)),
          color: "#111",
          weight: 1,
          fillColor: col,
          fillOpacity: 0.88
        });
        const rows = s.breakdown.map((b) => `<li>${b.variable}: +${b.points}</li>`).join("");
        m.bindPopup(
          `<div style="min-width:220px"><b>Score ${s.total}</b> · ${h.label || "—"}` +
          `<div style="font-size:12px;margin:4px 0">${s.tier === "campaign" ? tr("state.score.high") : s.tier === "review" ? tr("state.score.review") : tr("state.score.info")}</div>` +
          `<ul style="margin:0;padding-left:18px;font-size:12px">${rows}</ul></div>`
        );
        scoreLayer.addLayer(m);
      }
    } catch (e) {
      console.warn("Storm scores:", e.message);
    }
  }

  // --- JobNimbus: fases, fechas, sub-estados y skeleton --------------------
  const JNP = window.JNPhases;
  let jnByStatus = {};
  let jnActivePhases = new Set(JNP.PHASES.map((p) => p.id));
  let jnActiveStatuses = new Set();
  let jnExpandedPhases = new Set();
  let jnSearchQuery = "";
  let jnDateOpts = null;
  let jnListLimit = 80;
  let jnMapBatchToken = 0;

  function jnJobDisplayDate(job) {
    const useCreated = jnDateFieldValue() === "date_created";
    const ts = useCreated ? job.dateCreated : job.dateUpdated;
    if (!ts) return "";
    const lbl = useCreated ? tr("state.jn.created") : tr("state.jn.updated");
    const d = new Date(ts * 1000).toLocaleDateString(loc());
    return `<span class="jn-job-date" title="${lbl}">${lbl}: ${d}</span>`;
  }

  const jnDateMode = document.getElementById("jnDateMode");
  const jnDateCustom = document.getElementById("jnDateCustom");
  const jnDateFieldWrap = document.getElementById("jnDateFieldWrap");
  const jnDateFrom = document.getElementById("jnDateFrom");
  const jnDateTo = document.getElementById("jnDateTo");
  const jnDateField = document.getElementById("jnDateField");
  const jnDateHint = document.getElementById("jnDateHint");
  const jnDateHintPanel = document.getElementById("jnDateHintPanel");
  const jnTodayISO = new Date().toISOString().slice(0, 10);
  const jnMonthAgoISO = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  if (jnDateTo) { jnDateTo.value = jnTodayISO; jnDateTo.max = jnTodayISO; }
  if (jnDateFrom) { jnDateFrom.value = jnMonthAgoISO; jnDateFrom.max = jnTodayISO; }
  if (jnDateField) jnDateField.value = "date_updated";
  jnDateOpts = jnDateRangeForMode(jnDateMode?.value || "month");
  jnSyncDateUI();

  function jnISO(d) {
    return d.toISOString().slice(0, 10);
  }

  function jnDateFieldValue() {
    return jnDateField?.value || "date_updated";
  }

  function jnDateRangeForMode(mode) {
    const today = new Date();
    const to = jnISO(today);
    if (mode === "month") {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: jnISO(from), to, field: jnDateFieldValue() };
    }
    return null;
  }

  function jnSyncDateUI() {
    const mode = jnDateMode?.value || "month";
    const custom = mode === "custom";
    const hasFilter = mode !== "all";
    if (jnDateCustom) jnDateCustom.style.display = custom ? "" : "none";
    if (jnDateFieldWrap) jnDateFieldWrap.style.display = hasFilter ? "" : "none";
    jnReflowMap();
  }

  function jnClientFilterByDate(jobs, opts) {
    if (!opts?.from || !opts?.to) return jobs;
    const key = opts.field === "date_created" ? "dateCreated" : "dateUpdated";
    const gte = Math.floor(new Date(`${opts.from}T00:00:00`).getTime() / 1000);
    const lte = Math.floor(new Date(`${opts.to}T23:59:59`).getTime() / 1000);
    return jobs.filter((j) => {
      const ts = j[key];
      if (ts == null) return false;
      const n = typeof ts === "number" ? ts : parseInt(ts, 10);
      return isFinite(n) && n >= gte && n <= lte;
    });
  }

  function jnRebuildByStatus(jobs) {
    const byStatus = {};
    for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    return byStatus;
  }

  function jnSetDateHint(text) {
    if (jnDateHint) jnDateHint.textContent = text;
    if (jnDateHintPanel) jnDateHintPanel.textContent = text;
  }

  function jnApplyCustomDates() {
    const from = jnDateFrom?.value;
    const to = jnDateTo?.value;
    if (!from || !to) { jnSetDateHint(tr("state.jn.pickBothDates")); return false; }
    if (from > to) { jnSetDateHint(tr("state.jn.dateOrder")); return false; }
    jnDateOpts = { from, to, field: jnDateFieldValue() };
    loadJNJobs();
    return true;
  }
  function jnApplyDateMode() {
    jnSyncDateUI();
    const mode = jnDateMode?.value || "month";
    if (mode === "all") {
      jnDateOpts = null;
      loadJNJobs();
      return;
    }
    if (mode === "custom") {
      if (jnDateFrom?.value && jnDateTo?.value) jnApplyCustomDates();
      else jnSetDateHint(tr("state.jn.pickBothDates"));
      return;
    }
    jnDateOpts = jnDateRangeForMode(mode);
    loadJNJobs();
  }

  function jnSkeletonList(n = 6) {
    return `<div class="jn-skeleton-list">${Array.from({ length: n }, () => `
      <div class="jn-skeleton-card">
        <div class="skeleton skeleton-tag"></div>
        <div class="skeleton skeleton-line lg"></div>
        <div class="skeleton skeleton-line md"></div>
        <div class="skeleton skeleton-line sm"></div>
      </div>`).join("")}</div>`;
  }

  function jnSkeletonLegend(n = 5) {
    return Array.from({ length: n }, () => `<div class="skeleton skeleton-row"></div>`).join("");
  }

  function showJnSkeleton() {
    const box = document.getElementById("jnJobs");
    const panel = document.getElementById("jnPhaseLegend");
    const side = document.getElementById("jnSideLegend");
    const chips = document.getElementById("jnStatusSummary");
    const countEl = document.getElementById("jnJobCount");
    if (countEl) countEl.textContent = tr("state.jn.loadingCount");
    if (panel) panel.innerHTML = `<div class="skeleton skeleton-bar"></div><div class="skeleton skeleton-line md"></div>`;
    if (chips) chips.innerHTML = `<div class="skeleton skeleton-line sm" style="width:100%"></div>`;
    if (side) side.innerHTML = jnSkeletonLegend(6);
    if (box) { box.className = ""; box.innerHTML = jnSkeletonList(8); }
  }

  function jnGroupedFromJobs(jobs) {
    const byStatus = {};
    for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    return JNP.groupByPhase(byStatus);
  }

  function jnStatusesForPhase(phaseId) {
    const counts = {};
    for (const j of jnJobsData) {
      if (j.phaseId !== phaseId) continue;
      counts[j.status] = (counts[j.status] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }

  function jnJobMatchesFilter(job) {
    if (!jnActivePhases.has(job.phaseId)) return false;
    if (jnActiveStatuses.size > 0 && !jnActiveStatuses.has(job.status)) return false;
    const q = jnSearchQuery.trim().toLowerCase();
    if (!q) return true;
    const hay = [job.name, job.customer, job.status, job.address, job.city, job.zip, job.contactName]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }

  function jnEnrichJob(job) {
    const phase = JNP.localized(JNP.getPhase(job.status));
    return { ...job, phaseId: phase.id, phaseLabel: phase.label, phaseColor: phase.color };
  }

  function jnResetFilters() {
    jnActivePhases = new Set(JNP.PHASES.map((p) => p.id));
    jnActiveStatuses = new Set();
    jnExpandedPhases = new Set();
  }

  /** Clic en fase: alterna en el mapa (varias a la vez). Desde "todas", el 1er clic deja solo esa. */
  function jnTogglePhase(phaseId) {
    jnActiveStatuses = new Set();
    const allIds = JNP.PHASES.map((p) => p.id);
    const allActive = allIds.length > 0 && allIds.every((id) => jnActivePhases.has(id));

    if (allActive) {
      jnActivePhases = new Set([phaseId]);
      return;
    }
    if (jnActivePhases.has(phaseId)) {
      jnActivePhases.delete(phaseId);
      if (!jnActivePhases.size) jnResetFilters();
    } else {
      jnActivePhases.add(phaseId);
    }
  }

  /** Clic en fase: 1ª vez aísla; siguientes clics suman/quitan (multi-selección). */
  function jnTogglePhase(id) {
    jnActiveStatuses = new Set();
    const allIds = JNP.PHASES.map((p) => p.id);
    const allActive = allIds.length === jnActivePhases.size
      && allIds.every((pid) => jnActivePhases.has(pid));

    if (allActive) {
      jnActivePhases = new Set([id]);
      return;
    }
    if (jnActivePhases.has(id)) {
      jnActivePhases.delete(id);
      if (!jnActivePhases.size) jnResetFilters();
    } else {
      jnActivePhases.add(id);
      if (jnActivePhases.size === allIds.length) jnResetFilters();
    }
  }

  function jnSyncLegendExpand(block) {
    if (!block) return;
    const id = block.dataset.phase;
    const open = jnExpandedPhases.has(id);
    const body = block.querySelector(".jn-legend-body");
    const toggle = block.querySelector(".jn-legend-toggle");
    if (body) body.hidden = !open;
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
    block.classList.toggle("open", open);
    jnReflowMap();
  }

  function jnJobMarker(job) {
    const color = job.phaseColor;
    const icon = L.divIcon({
      className: "job-pin",
      html: `<div class="job-pin-dot" style="background:${color};box-shadow:0 0 0 2px #fff,0 0 0 4px ${color}55"></div>`,
      iconSize: [16, 16], iconAnchor: [8, 8], popupAnchor: [0, -10]
    });
    const esc = JNP.escapeHtml;
    const popup = `
      <div class="jn-popup">
        <div class="jn-popup-name">${esc(job.name)}</div>
        ${job.customer ? `<div class="jn-popup-sub">${esc(job.customer)}</div>` : ""}
        <div class="jn-popup-badges">
          <span class="jn-popup-phase" style="background:${color}">${esc(job.phaseLabel)}</span>
          <span class="jn-popup-status">${esc(job.status)}</span>
        </div>
        <div class="jn-popup-addr">${esc([job.address, job.city, job.state, job.zip].filter(Boolean).join(", "))}</div>
        ${job.contactName ? `<div class="jn-popup-contact">👤 ${esc(job.contactName)}</div>` : ""}
        <a class="jn-popup-link" href="${esc(job.jnUrl)}" target="_blank" rel="noopener">${tr("state.jn.openIn")}</a>
      </div>`;
    const marker = L.marker([job.lat, job.lon], { icon, zIndexOffset: 500 })
      .bindPopup(popup).addTo(jobsLayer);
    marker._jnid = job.jnid;
    return marker;
  }

  function focusJnJob(job) {
    if (job.lat == null || job.lon == null) return;
    map.setView([job.lat, job.lon], Math.max(map.getZoom(), 11));
    selectPoint(job.lat, job.lon);
    setTimeout(() => jnMarkers.get(job.jnid)?.openPopup(), 200);
  }

  function syncJnMapMarkers() {
    jobsLayer.clearLayers();
    jnMarkers.clear();
    const toAdd = [];
    for (const job of jnJobsData) {
      if (job.lat == null || job.lon == null) continue;
      if (!jnJobMatchesFilter(job)) continue;
      toAdd.push(job);
    }
    const token = ++jnMapBatchToken;
    const BATCH = 200;
    let i = 0;
    function addBatch() {
      if (token !== jnMapBatchToken) return;
      const end = Math.min(i + BATCH, toAdd.length);
      for (; i < end; i++) {
        const job = toAdd[i];
        jnMarkers.set(job.jnid, jnJobMarker(job));
      }
      if (i < toAdd.length) requestAnimationFrame(addBatch);
    }
    if (toAdd.length) requestAnimationFrame(addBatch);
  }

  function jnRefreshUI() {
    const groupedAll = JNP.groupByPhase(jnByStatus);
    const filtered = jnJobsData.filter(jnJobMatchesFilter);
    const groupedFiltered = jnGroupedFromJobs(filtered);
    renderJnPhaseLegend(groupedAll, groupedFiltered);
    renderJnPhaseFilters(groupedAll);
    renderJnJobList(filtered);
    syncJnMapMarkers();
    if (selected) renderRadiusContext();
  }

  function bindJnLegendEvents(groupedAll) {
    const sideLeg = document.getElementById("jnSideLegend");
    if (!sideLeg) return;

    sideLeg.querySelectorAll(".jn-legend-toggle").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const block = btn.closest(".jn-legend-block");
        const id = block?.dataset.phase;
        if (!id) return;
        if (jnExpandedPhases.has(id)) jnExpandedPhases.delete(id);
        else jnExpandedPhases.add(id);
        jnSyncLegendExpand(block);
      });
    });

    sideLeg.querySelectorAll(".jn-legend-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        jnTogglePhase(btn.dataset.phase);
        jnRefreshUI();
      });
    });

    sideLeg.querySelectorAll(".jn-sub-chip").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const status = btn.dataset.status;
        const phaseId = btn.dataset.phase;
        if (jnActiveStatuses.has(status)) jnActiveStatuses.delete(status);
        else {
          jnActiveStatuses.add(status);
          jnActivePhases.add(phaseId);
        }
        jnRefreshUI();
      });
    });

    document.getElementById("jnShowAllPhases")?.addEventListener("click", () => {
      jnResetFilters();
      jnRefreshUI();
    });

    document.getElementById("jnClearStatuses")?.addEventListener("click", () => {
      jnActiveStatuses = new Set();
      jnRefreshUI();
    });
  }

  function renderJnPhaseLegend(groupedAll, groupedFiltered) {
    const panel = document.getElementById("jnPhaseLegend");
    const sideLeg = document.getElementById("jnSideLegend");
    const ordered = JNP.orderedPhases(groupedAll);
    const total = ordered.reduce((s, g) => s + g.count, 0);
    const filteredTotal = jnJobsData.filter(jnJobMatchesFilter).length;

    if (!total) {
      if (panel) panel.innerHTML = "";
      if (sideLeg) sideLeg.innerHTML = `<div class="empty" style="font-size:12px">${tr("state.jn.noneInPeriod")}</div>`;
      return;
    }

    const barSource = jnActiveStatuses.size || jnActivePhases.size < JNP.PHASES.length
      ? JNP.orderedPhases(groupedFiltered)
      : ordered;
    const barTotal = barSource.reduce((s, g) => s + g.count, 0) || 1;

    panel.innerHTML = `
      <div class="jn-phase-bar">${barSource.map((g) => {
        const pct = ((g.count / barTotal) * 100).toFixed(1);
        return `<div class="jn-phase-bar-seg" style="width:${pct}%;background:${g.phase.color}" title="${g.phase.label}: ${g.count}"></div>`;
      }).join("")}</div>
      <div class="jn-phase-bar-labels">${barSource.map((g) =>
        `<span><i style="background:${g.phase.color}"></i>${g.phase.short} ${g.count}</span>`
      ).join("")}</div>`;

    if (!sideLeg) return;

    const statusHint = jnActiveStatuses.size
      ? `<span class="jn-filter-active">${tr("state.jn.subsActive", { n: jnActiveStatuses.size })}</span>`
      : "";

    sideLeg.innerHTML = `
      <div class="jn-side-legend-head">
        ${statusHint}
        <div class="jn-side-legend-btns">
          ${jnActiveStatuses.size ? `<button type="button" class="jn-side-legend-all" id="jnClearStatuses">${tr("state.jn.clearSubs")}</button>` : ""}
          <button type="button" class="jn-side-legend-all" id="jnShowAllPhases">${tr("state.jn.showAll")}</button>
        </div>
      </div>
      <div class="jn-side-legend-rows">
        ${ordered.map((g) => {
          const phaseOn = jnActivePhases.has(g.phase.id);
          const subs = jnStatusesForPhase(g.phase.id);
          const subHtml = subs.map(([st, n]) => {
            const on = jnActiveStatuses.has(st);
            return `<button type="button" class="jn-sub-chip${on ? " on" : ""}" data-phase="${g.phase.id}" data-status="${JNP.escapeHtml(st)}" style="--ph-color:${g.phase.color}">
              <span>${JNP.escapeHtml(st)}</span><b>${n}</b>
            </button>`;
          }).join("");
          return `
            <div class="jn-legend-block${jnExpandedPhases.has(g.phase.id) ? " open" : ""}" data-phase="${g.phase.id}">
              <div class="jn-legend-header">
                <button type="button" class="jn-legend-toggle" aria-expanded="${jnExpandedPhases.has(g.phase.id) ? "true" : "false"}" aria-label="${tr("state.jn.expandPhase", { name: g.phase.label })}">
                  <span class="jn-chevron" aria-hidden="true"></span>
                </button>
                <button type="button" class="jn-legend-row${phaseOn ? " active" : " dim"}" data-phase="${g.phase.id}" style="--ph-color:${g.phase.color}">
                  <span class="jn-legend-swatch"></span>
                  <span class="jn-legend-label">${g.phase.label}</span>
                  <span class="jn-legend-count">${g.count}</span>
                </button>
              </div>
              <div class="jn-legend-body" ${jnExpandedPhases.has(g.phase.id) ? "" : "hidden"}>
                <div class="jn-sub-statuses">${subHtml || '<span class="empty">—</span>'}</div>
              </div>
            </div>`;
        }).join("")}
      </div>
      <div class="jn-side-foot">${tr("state.jn.visible", { filtered: filteredTotal, total })}</div>`;

    bindJnLegendEvents(groupedAll);
  }

  function renderJnPhaseFilters(groupedAll) {
    const chips = document.getElementById("jnStatusSummary");
    const ordered = JNP.orderedPhases(groupedAll);
    chips.innerHTML = ordered.map((g) => {
      const on = jnActivePhases.has(g.phase.id);
      return `<button type="button" class="jn-phase-chip${on ? " on" : ""}" data-phase="${g.phase.id}" style="--ph-color:${g.phase.color}">
        <span class="sw"></span>${g.phase.short} <b>${g.count}</b>
      </button>`;
    }).join("");

    chips.querySelectorAll(".jn-phase-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        jnTogglePhase(btn.dataset.phase);
        jnRefreshUI();
      });
    });
  }

  function renderJnJobList(filtered) {
    const box = document.getElementById("jnJobs");
    const countEl = document.getElementById("jnJobCount");
    const visibleMap = filtered.filter((j) => j.lat != null && j.lon != null).length;
    const noCoords = filtered.filter((j) => j.lat == null || j.lon == null).length;
    const show = filtered.slice(0, jnListLimit);
    const remaining = filtered.length - show.length;

    countEl.textContent = jnJobsData.length
      ? tr("state.jn.countOnMap", { filtered: filtered.length, total: jnJobsData.length, map: visibleMap })
      : "";

    if (!jnJobsData.length) {
      box.className = "empty";
      box.textContent = tr("state.jn.noneForPeriod");
      return;
    }

    if (!filtered.length) {
      box.className = "empty";
      box.textContent = tr("state.jn.visible", { filtered: 0, total: jnJobsData.length });
      return;
    }

    const esc = JNP.escapeHtml;
    box.className = "jn-job-list";
    box.innerHTML = show.map((j) => {
      const addr = [j.address, j.city, j.state, j.zip].filter(Boolean).join(", ");
      const mapHint = (j.lat != null && j.lon != null) ? "" : '<span class="jn-no-geo">' + tr("state.jn.noGeo") + '</span>';
      const dateLbl = jnJobDisplayDate(j);
      return `
        <div class="jn-job-item" data-jnid="${j.jnid}" style="--ph-color:${j.phaseColor}">
          <div class="jn-job-top">
            <span class="jn-job-phase">${esc(j.phaseLabel)}</span>
            ${mapHint}
            ${dateLbl || ""}
          </div>
          <div class="jn-name">${esc(j.name)}</div>
          ${j.customer ? `<div class="jn-meta">${esc(j.customer)}</div>` : ""}
          <div class="jn-status-line">${esc(j.status)}</div>
          <div class="jn-addr">${esc(addr || "—")}</div>
        </div>`;
    }).join("")
      + (remaining > 0
        ? `<button type="button" class="btn secondary jn-load-more" style="width:100%;margin-top:10px">${tr("state.jn.showMore", { n: Math.min(80, remaining), remaining })}</button>`
        : "")
      + (noCoords ? `<div class="jn-footnote">${tr("state.jn.noCoords", { n: noCoords })}</div>` : "");

    box.querySelectorAll(".jn-job-item").forEach((el) => {
      el.addEventListener("click", () => {
        const job = jnJobsData.find((j) => j.jnid === el.dataset.jnid);
        if (job) focusJnJob(job);
      });
    });
    box.querySelector(".jn-load-more")?.addEventListener("click", () => {
      jnListLimit += 80;
      jnRefreshUI();
    });
  }

  function jnUpdateDateHint(data) {
    const mode = jnDateMode?.value || "month";
    const filter = data?.dateFilter || (jnDateOpts?.from && jnDateOpts?.to
      ? { from: jnDateOpts.from, to: jnDateOpts.to, field: jnDateOpts.field || "date_updated" }
      : null);
    if (filter) {
      const fld = filter.field === "date_created" ? tr("state.jn.dateCreated") : tr("state.jn.dateUpdated");
      const preset = mode === "month" ? tr("state.jn.thisMonth")
        : mode === "custom" ? tr("state.jn.customRange")
        : filter.capped ? tr("state.hist.90").replace("90", String(filter.capped))
        : tr("state.jn.period");
      jnSetDateHint(`${preset} · ${fld}: ${filter.from} → ${filter.to}`);
    } else {
      jnSetDateHint("Mostrando todos los jobs de la zona");
    }
  }

  async function loadJNJobs() {
    showJnSkeleton();
    try {
      const status = await API.getJNStatus();
      if (!status.configured) {
        document.getElementById("jnJobs").className = "error";
        document.getElementById("jnJobs").innerHTML = tr("state.jn.apiMissing");
        return;
      }

      let data = await API.getJNJobs(ST.code, jnDateOpts || {});

      if (jnDateOpts?.from && jnDateOpts?.to) {
        const jobs = data.jobs || [];
        const filtered = jnClientFilterByDate(jobs, jnDateOpts);
        if (filtered.length !== jobs.length || !data.dateFilter) {
          let withCoords = 0;
          for (const j of filtered) if (j.lat != null && j.lon != null) withCoords++;
          data = {
            ...data,
            jobs: filtered,
            total: filtered.length,
            withCoords,
            withoutCoords: filtered.length - withCoords,
            byStatus: jnRebuildByStatus(filtered),
            dateFilter: {
              from: jnDateOpts.from,
              to: jnDateOpts.to,
              field: jnDateOpts.field || "date_updated"
            }
          };
        }
      }
      jnByStatus = data.byStatus || {};
      jnJobsData = (data.jobs || []).map(jnEnrichJob);
      jnListLimit = 80;
      jnResetFilters();
      jnUpdateDateHint(data);
      jnRefreshUI();
      updateStormExportButtons();
      console.info(`JobNimbus ${ST.code}: ${data.total} jobs, ${data.withCoords} en mapa`);
    } catch (e) {
      document.getElementById("jnJobs").className = "error";
      document.getElementById("jnJobs").textContent = tr("state.jn.error", { msg: e.message });
      console.warn("JobNimbus:", e.message);
    }
  }

  jnDateMode?.addEventListener("change", jnApplyDateMode);

  jnDateField?.addEventListener("change", () => {
    const mode = jnDateMode?.value || "month";
    if (mode === "all") return;
    if (mode === "custom") { jnApplyCustomDates(); return; }
    jnDateOpts = jnDateRangeForMode(mode);
    loadJNJobs();
  });

  document.getElementById("jnDateApply")?.addEventListener("click", jnApplyCustomDates);

  jnSyncDateUI();

  document.getElementById("jnJobSearch")?.addEventListener("input", (e) => {
    jnSearchQuery = e.target.value;
    jnRefreshUI();
  });

  // --- Histórico de granizo (selector de fechas) --------------------------
  const histRange = document.getElementById("histRange");
  const histCustom = document.getElementById("histCustom");
  const histStatus = document.getElementById("histStatus");
  const histFrom = document.getElementById("histFrom");
  const histTo = document.getElementById("histTo");
  // Valores por defecto del rango personalizado: últimos 30 días.
  const todayISO = new Date().toISOString().slice(0, 10);
  const monthAgoISO = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  histTo.value = todayISO; histTo.max = todayISO;
  histFrom.value = monthAgoISO; histFrom.max = todayISO;

  function clearHistory() {
    hailHistoryLayer.clearLayers();
    if (map.hasLayer(hailHistoryLayer)) map.removeLayer(hailHistoryLayer);
    histStatus.textContent = "";
  }
  histRange.addEventListener("change", () => {
    const v = histRange.value;
    histCustom.style.display = v === "custom" ? "" : "none";
    if (v === "custom") return;
    if (v === "0") { clearHistory(); return; }
    loadHailHistory({ days: parseInt(v, 10) }, histStatus);
  });
  document.getElementById("histApply").addEventListener("click", () => {
    const from = histFrom.value, to = histTo.value;
    if (!from || !to) { histStatus.textContent = tr("state.jn.pickBothDates"); return; }
    if (from > to) { histStatus.textContent = tr("state.jn.dateOrder"); return; }
    loadHailHistory({ from, to }, histStatus);
  });

  // --- Cargar alertas activas (puntos calientes) ---------------------------
  async function loadAlerts() {
    const box = document.getElementById("alerts");
    const countEl = document.getElementById("alertCount");
    try {
      const data = await API.getActiveAlerts(ST.code);
      const feats = data.features || [];
      countEl.textContent = `${feats.length}`;

      if (!feats.length) {
        box.innerHTML = `<div class="empty">✅ ${tr("state.alerts.none", { name: ST.name })}</div>`;
      }

      const listFrag = [];
      for (const f of feats) {
        const p = f.properties;
        const color = window.SEVERITY_COLORS[p.severity] || window.SEVERITY_COLORS.Unknown;
        const sevTxt = sevLabel(p.severity || "Unknown");
        listFrag.push(`
          <div class="alert-item" data-id="${p.id}" style="border-left-color:${color}">
            <div class="ev">${p.event}
              <span class="badge" style="background:${color}">${sevTxt}</span>
            </div>
            <div class="areas">${p.areaDesc || ""}</div>
            <div class="meta">${tr("state.alerts.expires", { when: p.expires ? new Date(p.expires).toLocaleString(loc()) : "—" })}</div>
          </div>`);

        // Dibuja la geometría de la alerta. Si no tiene polígono propio,
        // intenta recuperar la geometría de las zonas afectadas.
        if (f.geometry) {
          alertsLayer.addData(f);
        } else if (Array.isArray(p.affectedZones)) {
          for (const z of p.affectedZones.slice(0, 4)) {
            API.getZoneGeometry(z).then((geom) => {
              if (geom) alertsLayer.addData({ type: "Feature", properties: p, geometry: geom });
            });
          }
        }
      }
      if (feats.length) box.innerHTML = listFrag.join("");

      // Click en una alerta de la lista -> centra el mapa y abre la etiqueta
      box.querySelectorAll(".alert-item").forEach((item) => {
        item.addEventListener("click", () => {
          const id = item.getAttribute("data-id");
          alertsLayer.eachLayer((l) => {
            if (l.feature && l.feature.properties.id === id && l.getBounds) {
              map.fitBounds(l.getBounds(), { maxZoom: 9 });
              const c = l.getBounds().getCenter();
              selectPoint(c.lat, c.lng);
            }
          });
        });
      });
    } catch (e) {
      box.innerHTML = `<div class="error">${tr("state.alerts.loadErr", { msg: e.message })}</div>`;
    }
  }

  // --- Cargar outlook del SPC ----------------------------------------------
  async function loadSPC() {
    try {
      const data = await API.getSPCOutlook(1);
      if (!data || !data.features) return;
      // El outlook del SPC es nacional; Leaflet recorta a la vista del estado.
      data.features.forEach((f) => {
        if (f.geometry) spcLayer.addData(f);
      });
    } catch (e) {
      console.warn("SPC:", e.message);
    }
  }

  // --- Granizo PRONOSTICADO: zonas de % de probabilidad (SPC hail outlook) -
  let hailOutlookLoaded = false;
  async function loadHailOutlook() {
    try {
      const data = await API.getHailOutlook(1);
      if (!data || !data.features) return;
      data.features.forEach((f) => { if (f.geometry) hailOutlookLayer.addData(f); });
    } catch (e) {
      console.warn("Granizo pronosticado:", e.message);
    }
  }

  // Construye un marcador de reporte de granizo (usado por "hoy" e histórico).
  function hailMarker(r, showDate) {
    const col = hailColor(r.sizeIn);
    const m = L.circleMarker([r.lat, r.lon], {
      radius: hailRadius(r.sizeIn), color: "#111", weight: 1,
      fillColor: col, fillOpacity: 0.85
    });
    const sizeTxt = r.sizeIn.toFixed(2).replace(/0$/, "");
    const when = showDate
      ? (r.time ? new Date(r.time).toLocaleString(loc()) : "—")
      : tr("state.hail.reportedAt", { time: r.time });
    const place = [r.location, `${r.county} Co.`, r.state].filter(Boolean).join(", ");
    const note = r.comments || r.remark || "";
    m.bindPopup(
      `<div style="min-width:210px">
        <div style="font-weight:700;font-size:15px">🧊 ${tr("state.hail.sizeTitle", { size: sizeTxt })}</div>
        <div style="font-size:12px;color:#555">${place}</div>
        <div style="font-size:12px;color:#555">${showDate ? "📅 " : ""}${when}</div>
        ${note ? `<div style="font-size:12px;margin-top:4px">${note}</div>` : ""}
        <a href="#" onclick="__stSelectPoint(${r.lat},${r.lon});return false" style="display:inline-block;margin-top:6px;color:var(--accent)">📍 ${tr("state.hail.viewZips")}</a>
      </div>`
    );
    return m;
  }

  // --- Granizo YA REPORTADO HOY: puntos del SPC Storm Reports --------------
  let hailReportsLoaded = false;
  let hailReportsCache = [];
  async function loadHailReports() {
    if (hailReportsLoaded) return hailReportsCache;
    hailReportsLoaded = true;
    try {
      const reps = await API.getHailReports("today");
      const [w, s, e, n] = ST.bbox;
      hailReportsCache = [];
      for (const r of reps) {
        if (r.lon < w || r.lon > e || r.lat < s || r.lat > n) continue;
        hailReportsCache.push(r);
        hailReportsLayer.addLayer(hailMarker(r, false));
      }
      if (!hailReportsCache.length) console.info("Sin reportes de granizo hoy en", ST.code);
    } catch (e) {
      console.warn("Granizo reportado:", e.message);
      hailReportsLoaded = false;
    }
    return hailReportsCache;
  }

  // --- Histórico de granizo: rango de fechas (IEM Local Storm Reports) -----
  async function loadHailHistory(opts, statusEl) {
    hailHistoryLayer.clearLayers();
    statusEl.textContent = tr("common.loading");
    try {
      const reps = await API.getHailHistory(ST.code, opts);
      let count = 0;
      for (const r of reps) {
        if (r.state && r.state !== ST.code) continue; // solo el estado
        hailHistoryLayer.addLayer(hailMarker(r, true));
        count++;
        if (count >= 2500) break; // tope de seguridad
      }
      statusEl.textContent = count
        ? tr("state.hist.count", { n: count })
        : tr("state.hist.none");
      if (!map.hasLayer(hailHistoryLayer)) map.addLayer(hailHistoryLayer);
    } catch (e) {
      statusEl.textContent = tr("common.error");
      console.warn("Histórico granizo:", e.message);
    }
  }

  // --- Oficina de Premier: marcador (casita) + radio de cobertura 40 mi ---
  function loadOffice() {
    const off = (window.PREMIER_OFFICES || {})[ST.code];
    if (!off) return; // este estado no tiene oficina configurada
    const miles = window.PREMIER_RADIUS_MI || 40;

    // Círculo de cobertura (~40 millas).
    L.circle([off.lat, off.lon], {
      radius: miles * 1609.344,
      color: "#E2231A", weight: 2, fillColor: "#E2231A", fillOpacity: 0.06,
      dashArray: "6 4"
    }).addTo(officeLayer);

    // Marcador con ícono de casita (DivIcon).
    const icon = L.divIcon({
      className: "office-pin",
      html: '<div style="font-size:24px;line-height:24px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))">🏠</div>',
      iconSize: [24, 24], iconAnchor: [12, 22], popupAnchor: [0, -20]
    });
    L.marker([off.lat, off.lon], { icon, zIndexOffset: 1000 })
      .bindPopup(
        `<div style="min-width:200px">
          <div style="font-weight:700;font-size:15px;color:#E2231A">🏠 ${off.name}</div>
          <div style="font-size:12px;color:#555;margin-top:2px">${off.address}</div>
          <div style="font-size:12px;color:#555;margin-top:4px">${tr("state.office.radiusApprox", { miles })}</div>
          <a href="#" onclick="__stSelectPoint(${off.lat},${off.lon});return false" style="display:inline-block;margin-top:6px;color:var(--accent)">📍 ${tr("state.hail.viewZips")}</a>
        </div>`
      )
      .addTo(officeLayer);
  }

  // --- Clima actual + proyección 7 días (Open-Meteo) -----------------------
  async function loadForecast(lat, lon) {
    const fbox = document.getElementById("forecast");
    const cbox = document.getElementById("current");
    fbox.className = "loading"; fbox.textContent = tr("state.forecastLoading");
    cbox.className = "loading"; cbox.textContent = tr("state.currentLoading");

    // Open-Meteo como fuente principal; si falla, respaldo con NWS.
    let data;
    try {
      data = await API.getOpenMeteoForecast(lat, lon);
    } catch (e1) {
      try {
        data = await API.getNWSWeather(lat, lon);
      } catch (e2) {
        fbox.className = "error"; fbox.textContent = tr("state.fc.loadErr", { msg: e1.message });
        cbox.className = "error"; cbox.textContent = "—";
        document.querySelectorAll(".miniFc").forEach((el) => { el.textContent = tr("common.error"); });
        return;
      }
    }

    try {
      const fromNWS = data._source === "NWS";

      // Actual
      const cur = data.current;
      cbox.className = "current-now";
      cbox.innerHTML = `
        <div class="ico">${API.wmoEmoji(cur.weather_code)}</div>
        <div>
          <div class="big">${Math.round(cur.temperature_2m)}°F</div>
          <div class="desc">${API.wmoText(cur.weather_code)} · 💧 ${cur.relative_humidity_2m}% · 💨 ${Math.round(cur.wind_speed_10m)} mph</div>
        </div>`;

      // 7 días
      const d = data.daily;
      const cards = d.time.map((t, i) => {
        const date = new Date(t + "T00:00");
        const dow = date.toLocaleDateString(loc(), { weekday: "short" });
        const dd = date.toLocaleDateString(loc(), { day: "numeric", month: "short" });
        return `
          <div class="day-card">
            <div class="dow">${dow}<br/>${dd}</div>
            <div class="ico">${API.wmoEmoji(d.weather_code[i])}</div>
            <div class="tmax">${Math.round(d.temperature_2m_max[i])}°</div>
            <div class="tmin">${Math.round(d.temperature_2m_min[i])}°</div>
            <div class="rain">🌧️ ${d.precipitation_probability_max[i] ?? 0}%</div>
            ${fromNWS ? "" : `<div class="small">${(d.precipitation_sum[i] ?? 0).toFixed(2)}"</div>`}
            <div class="small">💨 ${Math.round(d.wind_gusts_10m_max[i])} mph</div>
          </div>`;
      }).join("");
      fbox.className = "forecast-grid";
      fbox.innerHTML = cards;
      if (fromNWS) {
        const note = document.createElement("div");
        note.style.cssText = "grid-column:1/-1;font-size:12px;color:var(--muted);margin-bottom:6px";
        note.textContent = tr("state.fc.nwsFallback");
        fbox.prepend(note);
      }

      // Proyección compacta para el popup del mapa y el panel "Punto seleccionado"
      const miniCards = d.time.slice(0, 7).map((t, i) => {
        const date = new Date(t + "T00:00");
        const dow = date.toLocaleDateString(loc(), { weekday: "short" });
        return `<div style="text-align:center;min-width:42px;flex:0 0 auto">
            <div style="font-size:10px;color:var(--muted);text-transform:capitalize">${dow}</div>
            <div style="font-size:18px;line-height:20px">${API.wmoEmoji(d.weather_code[i])}</div>
            <div style="font-size:11px"><b>${Math.round(d.temperature_2m_max[i])}°</b> <span style="color:var(--muted)">${Math.round(d.temperature_2m_min[i])}°</span></div>
            <div style="font-size:10px;color:#3aa0ff">💧${d.precipitation_probability_max[i] ?? 0}%</div>
          </div>`;
      }).join("");
      const miniHtml = `<div style="display:flex;gap:4px;overflow-x:auto;padding-bottom:2px">${miniCards}</div>`;
      document.querySelectorAll(".miniFc").forEach((el) => { el.innerHTML = miniHtml; });

      // Gráficas horarias (próximas 48 h)
      renderHourlyCharts(data.hourly);
    } catch (e) {
      fbox.className = "error"; fbox.textContent = tr("state.fc.loadErr", { msg: e.message });
      cbox.className = "error"; cbox.textContent = "—";
    }
  }

  // Token para descartar resultados de clics anteriores
  let zipSearchToken = 0;

  // --- Clic en el mapa: etiqueta de notas del área -------------------------
  function bindForecastLoad(root, lat, lon) {
    const btn = root.querySelector(".fcLoadBtn");
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = tr("state.fc.loading");
      try {
        await loadForecast(lat, lon);
        const fc = await API.getNWSForecast(lat, lon);
        const next = fc.periods.slice(0, 2).map((p) =>
          `<div style="margin-top:6px"><b>${p.name}:</b> ${p.temperature}°${p.temperatureUnit}, ${p.shortForecast}. ${tr("state.fc.windLine", { speed: p.windSpeed, dir: p.windDirection })}</div>`
        ).join("");
        root.querySelectorAll(".nwsBox").forEach((box) => {
          box.innerHTML =
            `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px"><b>${tr("state.fc.nwsTitle")}</b>${next}</div>`;
        });
        btn.style.display = "none";
      } catch {
        btn.disabled = false;
        btn.textContent = tr("state.fc.retry");
      }
    });
  }

  async function selectPoint(lat, lon, labelOverride) {
    const myToken = ++zipSearchToken;
    const info = document.getElementById("locInfo");

    if (clickMarker) map.removeLayer(clickMarker);
    clickMarker = L.marker([lat, lon]).addTo(map);

    // ¿El punto cae en una sección de riesgo? (solo informativo)
    const alerts = alertsAtPoint(lat, lon);
    const spc = spcRiskAtPoint(lat, lon);

    // Bloque de riesgo (tipo de fenómeno + severidad)
    let riskHtml = alerts.length
      ? alerts.map((p) => {
          const c = window.SEVERITY_COLORS[p.severity] || window.SEVERITY_COLORS.Unknown;
          const upd = p.updated || p.sent;
          const updTxt = upd ? new Date(upd).toLocaleString(loc()) : "—";
          return `<div style="margin:3px 0">⚠️ <b>${p.event}</b> ` +
            `<span class="badge" style="background:${c}">${sevLabel(p.severity || "Unknown")}</span>` +
            `<div style="font-size:11px;color:var(--muted)">${tr("state.point.updated", { when: updTxt })}</div></div>`;
        }).join("")
      : `<div style="color:#36d399">✅ ${tr("state.alerts.noneAtPoint")}</div>`;
    riskHtml += spc
      ? `<div style="margin-top:2px">🌩️ ${tr("state.point.spcRisk", { spc: `<b>${spc}</b>` })}</div>`
      : `<div style="color:var(--muted);font-size:12px">${tr("state.spc.none")}</div>`;

    const nearbyScore = scoreAtPoint(lat, lon);
    if (nearbyScore) {
      const s = nearbyScore.score;
      const col = scoreTierColor(s.tier);
      riskHtml += `<div style="margin-top:6px;padding:6px 8px;border-left:3px solid ${col};background:rgba(0,0,0,.04)">` +
        `<b>📊 Score ${s.total}</b> · ${nearbyScore.label || "—"}<br/>` +
        `<span style="font-size:11px;color:var(--muted)">${s.breakdown.map((b) => b.variable).slice(0, 3).join(" · ")}</span></div>`;
    }

    // Cuerpo común para la etiqueta de notas (popup) y el panel lateral
    const header = labelOverride ? `<div style="font-weight:700;margin-bottom:4px">${labelOverride}</div>` : "";
    const body = `
      ${header}
      <div>${riskHtml}</div>
      <div style="border-top:1px solid var(--border);padding-top:6px;margin-top:6px">
        <b class="jnRadiusTitle">${tr("state.jn.radiusTitle", { miles: radiusMiles(), n: "…" })}</b>
        <div class="jnRadiusList" style="margin-top:6px;max-height:200px;overflow:auto">
          <div class="jn-radius-empty">${tr("state.jn.searchingRadius")}</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:6px;margin-top:6px">
        <b class="zipTitle">${tr("state.zip.title", { miles: radiusMiles() })}</b>
        <span class="zipsStatus" style="font-size:11px;color:var(--muted)">${tr("state.zip.calculating")}</span>
        <div class="zipChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;max-height:160px;overflow:auto"></div>
      </div>
      <div class="fcBlock" style="border-top:1px solid var(--border);padding-top:6px;margin-top:6px">
        <b>📅 ${tr("state.point.projection7")}</b>
        <button type="button" class="btn secondary fcLoadBtn" style="margin-top:6px;font-size:12px;padding:4px 10px">${tr("state.fc.loadBtn")}</button>
        <div class="miniFc" style="font-size:12px;color:var(--muted);margin-top:4px"></div>
      </div>
      <div class="ptAddr" style="margin-top:6px;font-size:12px;color:var(--muted)">${tr("state.addr.loading")}</div>
      <div class="nwsBox"></div>`;

    clickMarker.bindPopup(`<div style="min-width:260px;max-width:340px">${body}</div>`, { maxWidth: 360 }).openPopup();
    info.className = "";
    info.innerHTML = body;
    bindForecastLoad(info, lat, lon);
    clickMarker.on("popupopen", () => {
      const popEl = clickMarker.getPopup()?.getElement();
      if (popEl) bindForecastLoad(popEl, lat, lon);
    });

    // Aplica una actualización al mismo selector en popup y panel lateral
    function setBoth(sel, fn) {
      const pop = clickMarker.getPopup();
      const popEl = pop && pop.getElement();
      [info.querySelector(sel), popEl ? popEl.querySelector(sel) : null]
        .forEach((el) => { if (el) fn(el); });
    }

    // Dirección + zip del punto exacto
    API.reverseGeocode(lat, lon).then((geo) => {
      if (myToken !== zipSearchToken) return;
      let txt;
      if (geo && geo.address) {
        const a = geo.address;
        const line = [a.house_number, a.road].filter(Boolean).join(" ");
        const city = a.city || a.town || a.village || a.county || "";
        txt = `📍 ${line || (geo.display_name || "").split(",")[0] || ""}` +
          `${city ? " · " + city : ""} · Zip <b style="color:var(--accent)">${a.postcode || "—"}</b>` +
          ` · ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
      } else {
        txt = `📍 ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
      }
      setBoth(".ptAddr", (el) => { el.innerHTML = txt; });
    });

    // ZIPs dentro del círculo de radio elegido (sustituye la lógica anterior).
    // Dibuja el círculo y pinta ya lo que haya (no espera al dataset).
    selected = { lat, lon };
    renderRadiusContext();
    [80, 200, 450].forEach((ms) => setTimeout(() => renderRadiusContext(), ms));
    loadZipDB().finally(() => {
      if (selected) renderRadiusContext();
    });
  }

  // Click en el mapa
  map.on("click", (e) => selectPoint(e.latlng.lat, e.latlng.lng));
  // Permite que los popups de reportes de granizo abran la etiqueta + zips.
  window.__stSelectPoint = (lat, lon) => selectPoint(lat, lon);

  // Slider de radio: actualiza la etiqueta y recalcula el círculo + zips en vivo
  document.getElementById("radiusInput").addEventListener("input", (e) => {
    document.getElementById("radiusVal").textContent = `${e.target.value} mi`;
    scheduleRadiusContext();
  });

  // Buscar por zip
  async function doZipSearch() {
    const zip = document.getElementById("zipInput").value.trim();
    if (!zip) return;
    try {
      const r = await API.geocodeZip(zip);
      map.setView([r.lat, r.lon], 11);
      selectPoint(r.lat, r.lon, r.name);
    } catch (e) {
      alert(tr("state.zip.notFound", { zip }));
    }
  }
  document.getElementById("zipBtn").addEventListener("click", doZipSearch);
  document.getElementById("zipInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doZipSearch();
  });

  // --- Gráficas horarias (Chart.js) ----------------------------------------
  let chartTemp = null, chartPrecip = null;
  function renderHourlyCharts(h) {
    if (!h || !window.Chart) return;
    const N = 48;
    const labels = h.time.slice(0, N).map((t) =>
      new Date(t).toLocaleString(loc(), { weekday: "short", hour: "2-digit" })
    );
    const grid = { color: "rgba(255,255,255,0.06)" };
    const tick = { color: "#93a3bd", maxTicksLimit: 8 };

    if (chartTemp) chartTemp.destroy();
    if (chartPrecip) chartPrecip.destroy();

    chartTemp = new Chart(document.getElementById("chartTemp"), {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: tr("state.chart.temp"),
          data: h.temperature_2m.slice(0, N),
          borderColor: "#ff6b3d",
          backgroundColor: "rgba(255,107,61,0.15)",
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2
        }, {
          label: tr("state.chart.wind"),
          data: h.wind_speed_10m.slice(0, N),
          borderColor: "#9aa7bd",
          fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1, borderDash: [4, 3]
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: "#e6edf7" } } },
        scales: { x: { grid, ticks: tick }, y: { grid, ticks: tick } }
      }
    });

    chartPrecip = new Chart(document.getElementById("chartPrecip"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: tr("state.chart.rainProb"),
          data: h.precipitation_probability.slice(0, N),
          backgroundColor: "rgba(58,160,255,0.55)", yAxisID: "y"
        }, {
          type: "line", label: tr("state.chart.precip"),
          data: h.precipitation.slice(0, N),
          borderColor: "#36d399", backgroundColor: "rgba(54,211,153,0.2)",
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, yAxisID: "y1"
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: "#e6edf7" } } },
        scales: {
          x: { grid, ticks: tick },
          y: { grid, ticks: tick, position: "left", min: 0, max: 100, title: { display: true, text: "%", color: "#93a3bd" } },
          y1: { grid: { drawOnChartArea: false }, ticks: tick, position: "right", min: 0 }
        }
      }
    });
  }

  // --- Radar de precipitación animado (RainViewer) -------------------------
  const RADAR = { frames: [], host: "", idx: 0, layer: null, timer: null, playing: false };
  const RADAR_STORAGE_KEY = "premierRadarOn";
  const tglRadar = document.getElementById("tglRadar");
  const radarPlayBtn = document.getElementById("radarPlay");
  const radarSlider = document.getElementById("radarSlider");
  const radarTimeEl = document.getElementById("radarTime");

  function readRadarPref() {
    try { return localStorage.getItem(RADAR_STORAGE_KEY) === "1"; } catch { return false; }
  }

  function saveRadarPref(on) {
    try { localStorage.setItem(RADAR_STORAGE_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  }

  async function initRadar() {
    const meta = await fetch("https://api.rainviewer.com/public/weather-maps.json").then((r) => r.json());
    RADAR.host = meta.host;
    const past = (meta.radar && meta.radar.past) || [];
    const nowcast = (meta.radar && meta.radar.nowcast) || [];
    RADAR.frames = past.concat(nowcast);
    RADAR.idx = past.length ? past.length - 1 : 0; // empezar en el frame más reciente real
    const slider = document.getElementById("radarSlider");
    slider.max = String(Math.max(0, RADAR.frames.length - 1));
    slider.value = String(RADAR.idx);
  }

  function radarTileUrl(frame) {
    return `${RADAR.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
  }

  function radarLayerOptions() {
    return {
      opacity: 0.78,
      maxNativeZoom: 7,
      maxZoom: 20,
      pane: "radarPane",
      updateWhenZooming: true,
      updateWhenIdle: true
    };
  }

  function showRadarFrame(i) {
    if (!RADAR.frames.length) return;
    RADAR.idx = (i + RADAR.frames.length) % RADAR.frames.length;
    const frame = RADAR.frames[RADAR.idx];
    const url = radarTileUrl(frame);
    if (!RADAR.layer) {
      RADAR.layer = L.tileLayer(url, radarLayerOptions()).addTo(map);
    } else {
      if (!map.hasLayer(RADAR.layer)) RADAR.layer.addTo(map);
      RADAR.layer.setUrl(url);
    }
    radarSlider.value = String(RADAR.idx);
    radarTimeEl.textContent =
      new Date(frame.time * 1000).toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" }) +
      tr("state.radar.active");
  }

  function radarPlay() {
    RADAR.playing = true;
    radarPlayBtn.textContent = "⏸";
    clearInterval(RADAR.timer);
    RADAR.timer = setInterval(() => showRadarFrame(RADAR.idx + 1), 700);
  }
  function radarPause() {
    RADAR.playing = false;
    radarPlayBtn.textContent = "▶";
    clearInterval(RADAR.timer);
  }

  async function setRadarEnabled(on, { persist = true } = {}) {
    if (persist) saveRadarPref(on);
    tglRadar.checked = on;
    if (on) {
      try {
        if (!RADAR.frames.length) await initRadar();
      } catch (err) {
        alert(tr("state.radar.unavailable"));
        tglRadar.checked = false;
        saveRadarPref(false);
        return;
      }
      radarPlayBtn.style.display = "";
      radarSlider.style.display = "";
      showRadarFrame(RADAR.idx);
      radarPlay();
    } else {
      radarPause();
      if (RADAR.layer) { map.removeLayer(RADAR.layer); RADAR.layer = null; }
      radarPlayBtn.style.display = "none";
      radarSlider.style.display = "none";
      radarTimeEl.textContent = "";
    }
  }

  tglRadar.addEventListener("change", (e) => {
    setRadarEnabled(e.target.checked);
  });
  radarPlayBtn.addEventListener("click", () => {
    RADAR.playing ? radarPause() : radarPlay();
  });
  radarSlider.addEventListener("input", (e) => {
    radarPause();
    showRadarFrame(parseInt(e.target.value, 10));
  });

  map.on("zoomend", () => {
    if (RADAR.layer && map.hasLayer(RADAR.layer)) RADAR.layer.redraw();
  });

  // Radar solo al activar el toggle (no carga tiles al abrir la página).

  // --- Exportación CSV por incidencia (servidor · requiere sesión) ----------
  function stormDateOptsForExport() {
    if (!jnDateOpts?.from || !jnDateOpts?.to) return {};
    return { from: jnDateOpts.from, to: jnDateOpts.to, field: jnDateOpts.field };
  }

  function setStormExportStatus(msg, kind) {
    const el = document.getElementById("stormExportStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "storm-export-status" + (kind ? ` ${kind}` : "");
  }

  function stormCsvFormat() {
    const sel = document.getElementById("stormCsvFormat");
    return sel?.value || localStorage.getItem("stormCsvFormat") || "excel";
  }

  (function initStormCsvFormat() {
    const sel = document.getElementById("stormCsvFormat");
    if (!sel) return;
    const saved = localStorage.getItem("stormCsvFormat");
    if (saved) sel.value = saved;
    sel.addEventListener("change", () => {
      localStorage.setItem("stormCsvFormat", sel.value);
      setStormExportStatus(
        sel.value === "google"
          ? tr("state.export.hintGoogle")
          : tr("state.export.hintExcel"),
        "ok"
      );
    });
  })();

  function updateStormExportButtons() {
    const hasJobs = jnJobsData.length > 0;
    document.querySelectorAll(".storm-export-btn").forEach((btn) => {
      btn.disabled = !hasJobs;
    });
    if (hasJobs) {
      const fmt = stormCsvFormat() === "google" ? "CSV Google" : "Excel .xlsx";
      setStormExportStatus(tr("state.export.ready", { fmt }));
    }
  }

  document.getElementById("stormExports")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".storm-export-btn");
    if (!btn || btn.disabled) return;
    const kind = btn.dataset.export;
    btn.classList.add("busy");
    setStormExportStatus(tr("state.export.generating"));
    try {
      const fmt = stormCsvFormat();
      const result = await API.exportStormList(kind, ST.code, stormDateOptsForExport(), fmt);
      const okMsg = fmt === "google"
        ? tr("state.export.doneGoogle")
        : tr("state.export.doneExcel");
      setStormExportStatus(result.ok ? okMsg : result.message, result.ok ? "ok" : "err");
    } catch (err) {
      setStormExportStatus(err.message || tr("state.export.fail"), "err");
    } finally {
      btn.classList.remove("busy");
    }
  });

  // --- Historial de tormentas + PDF -----------------------------------------
  function fmtHistoryDate(iso) {
    try {
      return new Date(iso).toLocaleString(loc() === "es" ? "es-US" : "en-US", { dateStyle: "short", timeStyle: "short" });
    } catch {
      return iso;
    }
  }

  function tierClass(tier) {
    if (tier === "campaign") return "storm-history-tier-campaign";
    if (tier === "review") return "storm-history-tier-review";
    return "";
  }

  async function loadStormHistory() {
    const list = document.getElementById("stormHistoryList");
    if (!list) return;
    try {
      const data = await API.getStormHistory(ST.code, 25);
      const hint = document.getElementById("stormHistoryHint");
      if (hint && data.policy) {
        const days = data.policy.retentionDays;
        const max = data.policy.maxEvents;
        hint.textContent = days
          ? tr("state.history.hintDays", { days, max })
          : tr("state.history.hintMax", { max });
      }
      if (!data.events?.length) {
        list.innerHTML = `<p class="storm-history-empty">${tr("state.history.empty")}</p>`;
        return;
      }
      list.innerHTML = data.events.map((ev) => {
        const tier = ev.tier === "campaign" ? tr("state.history.tierMeta") : ev.tier === "review" ? tr("state.history.tierReview") : "—";
        return `<div class="storm-history-item ${tierClass(ev.tier)}">
          <div class="storm-history-meta">
            <strong>Score ${ev.scoreTotal} · ${tier}</strong>
            <span>${fmtHistoryDate(ev.recordedAt)}<br/>${ev.label || ev.zone} · ${ev.leadCount} lead(s)</span>
          </div>
          <button type="button" class="storm-history-pdf" data-id="${ev.id}" title="${tr("state.history.pdfTitle")}">${tr("state.history.pdf")}</button>
        </div>`;
      }).join("");
    } catch (err) {
      list.innerHTML = `<p class="storm-history-empty">${err.message || tr("state.history.loadFail")}</p>`;
    }
  }

  document.getElementById("stormHistory")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".storm-history-pdf");
    if (!btn || btn.classList.contains("busy")) return;
    btn.classList.add("busy");
    btn.textContent = "…";
    try {
      await API.downloadStormHistoryPdf(btn.dataset.id);
    } catch (err) {
      alert(err.message || tr("state.history.pdfFail"));
    } finally {
      btn.classList.remove("busy");
      btn.textContent = tr("state.history.pdf");
    }
  });

  // --- Language change: refresh dynamic chrome -----------------------------
  window.addEventListener("premier:lang", (ev) => {
    if (window.I18n) window.I18n.apply(document);
    try { renderLegend(); } catch (e) {}
    syncMapStyleButtons();
    try { updateStormExportButtons(); } catch (e) {}
    // Re-localize phase badges baked into job cache + rebuild UI/markers.
    try {
      if (jnJobsData.length) jnJobsData = jnJobsData.map(jnEnrichJob);
      jnRefreshUI();
    } catch (e) {}
    try { loadStormHistory(); } catch (e) {}
    if (typeof selected !== "undefined" && selected) {
      try {
        selectPoint(selected.lat, selected.lon);
      } catch (e) {
        try { renderRadiusContext(); } catch (e2) {}
        try { renderRadiusJobs(); } catch (e2) {}
      }
    } else if (!ev.detail?.initial) {
      try { loadForecast(ST.center[0], ST.center[1]); } catch (e) {}
    }
    const logout = document.getElementById("btnLogout");
    if (logout) logout.textContent = tr("nav.logout");
  });

  // --- Init ----------------------------------------------------------------
  loadZipDB().then(() => {
    zipRadiusCacheKey = "";
    zipRadiusCache = null;
  });
  loadOffice();
  loadJNJobs();
  loadAlerts();
  loadSPC();
  loadStormScores();
  loadStormHistory();
  setInterval(() => {
    if (document.getElementById("tglScore")?.checked) loadStormScores();
  }, 10 * 60 * 1000);
  loadForecast(ST.center[0], ST.center[1]);
  setTimeout(() => map.invalidateSize(), 300);
})();
