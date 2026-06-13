// Trip planner page (/planner): pick a data source (2016 official or the
// user's own routes), set A/B by clicking the map or naming a stop, and plan
// point-to-point journeys via the RAPTOR endpoint (/data/plan). Selected
// journeys draw on the map: solid colored ride legs, dashed walk legs.
window.APP = window.APP || {};

// Pedestrian routing for walk legs (the OSRM instance behind osm.org's foot
// directions): turns straight A→B hops into road-following paths. Purely a
// display upgrade — journey times still come from the planner.
const FOOT_ROUTER = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";

APP.PlannerPage = class {
  constructor() {
    this.map = null;
    this.baseLayer = null;
    this.year = "2016"; // selected data source year
    this.from = null; // {lon, lat, label}
    this.to = null;
    this.pick = null; // "from" | "to" | null — armed map-pick target
    this.stops = []; // searchable stops of the current source
    this.journeys = [];
    this._planSeq = 0; // invalidates in-flight walk routing on replan
    this._walkCache = new Map(); // "lon,lat,lon,lat" -> Promise<route|null>
    this.init();
  }

  init() {
    const view = new ol.View({
      center: APP.MapUtils.toOL(APP.MAP_CONFIG.INITIAL_CENTER),
      zoom: APP.MAP_CONFIG.INITIAL_ZOOM,
      minZoom: APP.MAP_CONFIG.MIN_ZOOM,
      maxZoom: APP.MAP_CONFIG.MAX_ZOOM,
    });
    this.baseLayer = APP.MAP_STYLES.osm.create();
    this.map = new ol.Map({ target: "map", layers: [this.baseLayer], view });
    $("#mapStyle").on("change", (e) => {
      this.map.removeLayer(this.baseLayer);
      this.baseLayer = APP.MAP_STYLES[e.target.value].create();
      this.map.getLayers().insertAt(0, this.baseLayer);
    });

    this.markerSource = new ol.source.Vector();
    this.journeySource = new ol.source.Vector();
    this.map.addLayer(
      new ol.layer.Vector({ source: this.journeySource, zIndex: 100 })
    );
    this.map.addLayer(
      new ol.layer.Vector({ source: this.markerSource, zIndex: 200 })
    );

    this.map.on("click", (e) => this.onMapClick(e));

    // Data source toggle: the shipped 2016 set, or the user's own routes.
    $("#tpSourceMine").attr("data-year", APP.USER_ROUTE_YEAR);
    $(".tp-source .btn").on("click", (e) => {
      const btn = $(e.currentTarget);
      if (btn.hasClass("active")) return;
      $(".tp-source .btn").removeClass("active");
      btn.addClass("active");
      this.year = btn.attr("data-year");
      this.loadStops();
      this.clearResults("Source changed — plan again.");
    });

    $("#tpPickFrom").on("click", () => this.armPick("from"));
    $("#tpPickTo").on("click", () => this.armPick("to"));
    $("#tpUseLocation").on("click", () => this.useMyLocation());
    if (!navigator.geolocation) $("#tpUseLocation").hide(); // unsupported browser
    $("#tpSwap").on("click", () => this.swap());
    $("#tpPlan").on("click", () => this.plan());
    $("#tpClearPlan").on("click", () => this.clearPlan());

    // Recent trips: click to make a saved search the active one; ✕ removes it.
    $("#tpTripsClear").on("click", () => {
      this._saveTrips([]);
      this.renderTrips();
    });
    $("#tpTrips").on("click", ".tp-trip", (e) => {
      if ($(e.target).closest(".tp-trip-del").length) return;
      this.loadTrip($(e.currentTarget).index());
    });
    $("#tpTrips").on("click", ".tp-trip-del", (e) => {
      e.stopPropagation();
      const trips = this._loadTrips();
      trips.splice($(e.currentTarget).closest(".tp-trip").index(), 1);
      this._saveTrips(trips);
      this.renderTrips();
    });
    $("#tpFrom").on("change", () => this.stopTyped("from"));
    $("#tpTo").on("change", () => this.stopTyped("to"));
    $("#tpResults").on("click", ".tp-journey", (e) => {
      this.selectJourney($(e.currentTarget).index());
    });
    // 3D ride-along preview of a planned journey (engine picked in a modal).
    this.pendingRide = null;
    $("#tpResults").on("click", ".tp-ride-btn", (e) => {
      e.stopPropagation();
      const i = $(e.currentTarget).closest(".tp-journey").index();
      this.selectJourney(i);
      this.pendingRide = this.journeys[i];
      $("#engineModal").modal("show");
    });
    $("#engineThree").on("click", () => this.rideJourney("three"));
    $("#engineMaplibre").on("click", () => this.rideJourney("maplibre"));

    // Time and day default to "any" (blank time, "Any day" option) — the planner
    // searches typical service unless the user filters to a specific time/day.

    // Coming back (e.g. from a 3D trip preview): restore the previous
    // search and re-plan it, so A/B and the results survive the round trip.
    const restored = this.restoreState();
    this.loadStops();
    this.renderTrips();
    if (restored) this.plan();
  }

  // --- Recent trips (persist across sessions in localStorage) -----------------

  _loadTrips() {
    try {
      const a = JSON.parse(localStorage.getItem("tp-trips"));
      return Array.isArray(a) ? a : [];
    } catch (e) {
      return [];
    }
  }

  _saveTrips(trips) {
    try {
      localStorage.setItem("tp-trips", JSON.stringify(trips));
    } catch (e) {
      /* storage full/disabled — trips just won't persist */
    }
  }

  _tripKey(t) {
    return [t.year, t.from.lon, t.from.lat, t.to.lon, t.to.lat, t.time, t.day]
      .join("|");
  }

  /** Put the current search at the top of the recent list (deduped, capped). */
  addTrip() {
    if (!this.from || !this.to) return;
    const t = {
      year: this.year,
      from: this.from,
      to: this.to,
      time: $("#tpTime").val(),
      day: $("#tpDay").val(),
    };
    const trips = this._loadTrips().filter(
      (x) => this._tripKey(x) !== this._tripKey(t)
    );
    trips.unshift(t);
    this._saveTrips(trips.slice(0, 8));
    this.renderTrips();
  }

  renderTrips() {
    const trips = this._loadTrips();
    $("#tpTripsSection").toggle(trips.length > 0);
    const out = $("#tpTrips").empty();
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    trips.forEach((t) => {
      out.append(
        $('<div class="tp-trip" title="Load this trip"></div>').append(
          $('<span class="tp-trip-route"></span>').text(
            `${t.from.label || "A"} → ${t.to.label || "B"}`
          ),
          $('<span class="tp-trip-meta"></span>').text(
            `${t.time} ${days[+t.day] || ""} · ` +
              (t.year === APP.USER_ROUTE_YEAR ? "my routes" : t.year)
          ),
          $('<a class="tp-trip-del" title="Remove this trip">✕</a>')
        )
      );
    });
  }

  /** Make a saved trip the active one: restore its form and re-plan. */
  loadTrip(i) {
    const t = this._loadTrips()[i];
    if (!t) return;
    const year = t.year === APP.USER_ROUTE_YEAR ? t.year : "2016";
    if (year !== this.year) {
      this.year = year;
      $(".tp-source .btn")
        .removeClass("active")
        .filter((_, el) => $(el).attr("data-year") === year)
        .addClass("active");
      this.loadStops();
    }
    this.from = t.from;
    this.to = t.to;
    $("#tpFrom").val(t.from.label || "");
    $("#tpTo").val(t.to.label || "");
    if (t.time) $("#tpTime").val(t.time);
    if (t.day != null) $("#tpDay").val(t.day);
    this.drawMarkers();
    this.plan();
  }

  /** Reset the current plan: points, results, drawn journey, session state.
   * The recent-trips list is untouched (it has its own remove controls). */
  clearPlan() {
    this._planSeq++;
    this.from = null;
    this.to = null;
    $("#tpFrom").val("");
    $("#tpTo").val("");
    this.drawMarkers();
    this.clearResults("");
    try {
      sessionStorage.removeItem("tp-state");
    } catch (e) {
      /* nothing to clear */
    }
  }

  // --- Session state (survives navigating to the 3D preview and back) ---------

  saveState(selected) {
    if (!this.from || !this.to) return;
    try {
      sessionStorage.setItem(
        "tp-state",
        JSON.stringify({
          year: this.year,
          from: this.from,
          to: this.to,
          time: $("#tpTime").val(),
          day: $("#tpDay").val(),
          selected:
            selected != null
              ? selected
              : Math.max(0, $("#tpResults .tp-journey.selected").index()),
        })
      );
    } catch (e) {
      /* storage full/disabled — state just won't survive navigation */
    }
  }

  restoreState() {
    let s = null;
    try {
      s = JSON.parse(sessionStorage.getItem("tp-state"));
    } catch (e) {
      return false;
    }
    if (!s || !s.from || !s.to) return false;
    this.year = s.year === APP.USER_ROUTE_YEAR ? s.year : "2016";
    $(".tp-source .btn")
      .removeClass("active")
      .filter((_, el) => $(el).attr("data-year") === this.year)
      .addClass("active");
    this.from = s.from;
    this.to = s.to;
    $("#tpFrom").val(s.from.label || "");
    $("#tpTo").val(s.to.label || "");
    if (s.time) $("#tpTime").val(s.time);
    if (s.day != null) $("#tpDay").val(s.day);
    this.drawMarkers();
    this._restoreSelected = s.selected;
    return true;
  }

  // --- Points ----------------------------------------------------------------

  armPick(which) {
    this.pick = which;
    $("#tpMapHint")
      .text(which === "from" ? "Click the map to set the start (A)" : "Click the map to set the destination (B)")
      .show();
  }

  onMapClick(e) {
    const [lon, lat] = APP.MapUtils.toNormal(e.coordinate);
    // Explicitly armed pick wins; otherwise fill A first, then B.
    const which = this.pick || (!this.from ? "from" : "to");
    this.pick = null;
    $("#tpMapHint").hide();
    this.setPoint(which, lon, lat, `${lat.toFixed(5)}, ${lon.toFixed(5)}`);
  }

  setPoint(which, lon, lat, label) {
    this[which === "from" ? "from" : "to"] = { lon, lat, label };
    $(which === "from" ? "#tpFrom" : "#tpTo").val(label);
    this.drawMarkers();
  }

  /** Use the browser's geolocation as the start (A) — only if the user grants it.
   * Sets A to the reported coordinate (the planner snaps to the nearest stop, as
   * with a map-click) and centres the map there so it can be checked/adjusted. */
  useMyLocation() {
    if (!navigator.geolocation) {
      this._geoHint("Location isn't available in this browser.");
      return;
    }
    const btn = $("#tpUseLocation").prop("disabled", true);
    this._geoHint("Locating you…", false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.prop("disabled", false);
        $("#tpMapHint").hide();
        const lon = pos.coords.longitude;
        const lat = pos.coords.latitude;
        this.setPoint("from", lon, lat, "My location");
        const view = this.map.getView();
        view.animate({
          center: APP.MapUtils.toOL([lon, lat]),
          zoom: Math.max(view.getZoom() || 0, 15),
          duration: 400,
        });
      },
      (err) => {
        btn.prop("disabled", false);
        this._geoHint(
          err && err.code === err.PERMISSION_DENIED
            ? "Location permission denied — pick the start on the map instead."
            : "Couldn't get your location — pick the start on the map instead."
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  /** Transient message in the map-hint overlay (auto-hides unless told not to). */
  _geoHint(msg, autoHide = true) {
    $("#tpMapHint").text(msg).show();
    clearTimeout(this._geoHintTimer);
    if (autoHide) {
      this._geoHintTimer = setTimeout(() => $("#tpMapHint").hide(), 4000);
    }
  }

  stopTyped(which) {
    // A point can be set by typing a stop name (via the datalist) or a raw
    // "lat, lon" coordinate. Stop-name match wins; then coordinates.
    const text = $(which === "from" ? "#tpFrom" : "#tpTo").val().trim();
    if (!text) {
      this[which] = null;
      this.drawMarkers();
      return;
    }
    const stop = this.stops.find(
      (s) => this.stopLabel(s).toLowerCase() === text.toLowerCase()
    ) || this.stops.find((s) => s.name.toLowerCase() === text.toLowerCase());
    if (stop) {
      this.setPoint(which, stop.lon, stop.lat, this.stopLabel(stop));
      return;
    }
    const c = this._parseLatLon(text);
    if (c) {
      this.setPoint(which, c.lon, c.lat, `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`);
    }
  }

  /** Parse "lat, lon" (latitude first, the order shown for map-picked points).
   * Returns {lat, lon} within valid ranges, or null. */
  _parseLatLon(text) {
    const m = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  swap() {
    [this.from, this.to] = [this.to, this.from];
    $("#tpFrom").val(this.from ? this.from.label : "");
    $("#tpTo").val(this.to ? this.to.label : "");
    this.drawMarkers();
  }

  stopLabel(s) {
    return s.code ? `${s.name} (${s.code})` : s.name;
  }

  loadStops() {
    this.stops = [];
    fetch(`/data/planner-stops?year=${encodeURIComponent(this.year)}`)
      .then((r) => r.json())
      .then((d) => {
        this.stops = d.stops || [];
        const dl = $("#tpStopOptions").empty();
        const seen = new Set();
        this.stops.forEach((s) => {
          const label = this.stopLabel(s);
          if (seen.has(label)) return;
          seen.add(label);
          dl.append($("<option></option>").attr("value", label));
        });
        if (!this.stops.length) {
          this.setStatus(
            this.year === APP.USER_ROUTE_YEAR
              ? "No plannable routes yet — draw routes with at least 2 stops in the GTFS workbench."
              : "This source has no stops to plan over.",
            "warn"
          );
        } else {
          this.setStatus(`${this.stops.length} stops available.`);
        }
      })
      .catch((e) => APP.MapUtils.handleError(e, "Loading planner stops"));
  }

  // --- Planning ----------------------------------------------------------------

  setStatus(text, kind) {
    $("#tpStatus")
      .text(text || "")
      .toggleClass("warn", kind === "warn");
  }

  clearResults(statusText) {
    this.journeys = [];
    $("#tpResults").empty();
    this.journeySource.clear();
    if (statusText !== undefined) this.setStatus(statusText);
  }

  plan() {
    if (!this.from || !this.to) {
      this.setStatus("Set both A and B first — click the map or type a stop.", "warn");
      return;
    }
    const time = $("#tpTime").val(); // blank = any time (backend uses a default)
    const day = $("#tpDay").val();   // "any" or 0..6
    const q = new URLSearchParams({
      year: this.year,
      from: `${this.from.lon},${this.from.lat}`,
      to: `${this.to.lon},${this.to.lat}`,
      time,
      day,
    });
    this.clearResults();
    this.setStatus("Planning…");
    fetch(`/data/plan?${q}`)
      .then((r) =>
        r.json().then((d) => {
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          return d;
        })
      )
      .then((d) => {
        this.journeys = d.journeys || [];
        const notes = (d.notes || []).join("; ");
        if (!this.journeys.length) {
          this.setStatus(notes || "No journey found — try another time or day.", "warn");
          return;
        }
        this.setStatus(notes);
        this.renderResults();
        // Restoring a previous session re-selects the journey it had open.
        const sel =
          this._restoreSelected != null
            ? Math.min(this._restoreSelected, this.journeys.length - 1)
            : 0;
        this._restoreSelected = null;
        this.selectJourney(sel);
        this.saveState(sel);
        this.addTrip();
        this.routeWalkLegs(this._planSeq);
      })
      .catch((e) => this.setStatus(e.message, "warn"));
  }

  // --- Walk legs along real roads ---------------------------------------------

  /** Upgrade every walk leg of the current journeys to a road-following path,
   * then redraw. Straight lines remain wherever routing fails. */
  routeWalkLegs(seq) {
    const legs = [];
    this.journeys.forEach((j) =>
      j.legs.forEach((l) => l.type === "walk" && legs.push(l))
    );
    Promise.allSettled(legs.map((l) => this.routeWalkLeg(l))).then(() => {
      if (seq !== this._planSeq) return; // results were replaced meanwhile
      const sel = $("#tpResults .tp-journey.selected").index();
      this.renderResults();
      this.selectJourney(sel >= 0 ? sel : 0);
    });
  }

  routeWalkLeg(leg) {
    const key = [leg.from.lon, leg.from.lat, leg.to.lon, leg.to.lat]
      .map((v) => v.toFixed(5))
      .join(",");
    if (!this._walkCache.has(key)) {
      const url =
        `${FOOT_ROUTER}/${leg.from.lon},${leg.from.lat};` +
        `${leg.to.lon},${leg.to.lat}?overview=full&geometries=geojson`;
      this._walkCache.set(
        key,
        fetch(url, { signal: AbortSignal.timeout(8000) })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            const rt = d && d.routes && d.routes[0];
            return rt && rt.geometry && rt.geometry.coordinates.length >= 2
              ? {
                  coords: rt.geometry.coordinates,
                  dist: Math.round(rt.distance),
                }
              : null;
          })
          .catch(() => null)
      );
    }
    return this._walkCache.get(key).then((r) => {
      if (r) {
        leg.geometry = r.coords;
        leg.road_dist_m = r.dist;
      }
    });
  }

  // --- Results list ---------------------------------------------------------------

  fmt(secs) {
    const h = Math.floor(secs / 3600) % 24;
    const m = Math.floor((secs % 3600) / 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  fmtDur(secs) {
    const m = Math.round(secs / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }

  rideColor(leg, i) {
    return leg.color
      ? `#${leg.color}`
      : APP.ROUTE_COLORS[i % APP.ROUTE_COLORS.length];
  }

  /** Remove short out-and-back spurs from a [lon,lat] polyline (turns
   * sharper than ~120° with a side under 300 m) — junction artifacts where
   * stop pins and road-snapped endpoints don't quite meet. */
  despike(pts) {
    if (pts.length < 3) return pts;
    const M_PER_DEG = 111320;
    const kx = Math.cos((pts[0][1] * Math.PI) / 180);
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      out.push(p);
      while (out.length >= 3) {
        const a = out[out.length - 3];
        const b = out[out.length - 2];
        const c = out[out.length - 1];
        const v1 = [(b[0] - a[0]) * kx, b[1] - a[1]];
        const v2 = [(c[0] - b[0]) * kx, c[1] - b[1]];
        const l1 = Math.hypot(v1[0], v1[1]);
        const l2 = Math.hypot(v2[0], v2[1]);
        if (!l1 || !l2) break;
        const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
        if (cos < -0.5 && Math.min(l1, l2) * M_PER_DEG < 300) {
          out.splice(out.length - 2, 1);
        } else {
          break;
        }
      }
    }
    return out;
  }

  renderResults() {
    const out = $("#tpResults").empty();
    this.journeys.forEach((j, ji) => {
      const card = $('<div class="tp-journey"></div>');
      const head = $('<div class="tp-journey-head"></div>');
      head.append(
        $('<span class="tp-journey-times"></span>').text(
          `${this.fmt(j.departure)} → ${this.fmt(j.arrival)}`
        )
      );
      const what = j.walk_only
        ? "walk only"
        : `${j.transfers} transfer${j.transfers === 1 ? "" : "s"}`;
      head.append(
        $('<span class="tp-journey-meta"></span>').text(
          `${this.fmtDur(j.duration)} · ${what}`
        )
      );
      card.append(head);

      const esc = (s) => $("<i>").text(s == null ? "" : s).html();
      const legs = $('<div class="tp-legs"></div>');
      let rideIdx = 0;
      j.legs.forEach((leg) => {
        const row = $('<div class="tp-leg"></div>');
        const body = $('<div class="tp-leg-body"></div>');
        if (leg.type === "walk") {
          const dest = leg.to.name || "destination";
          const dist = leg.road_dist_m || leg.dist_m;
          body.append(
            $('<div class="tp-leg-main"></div>').text(
              `${this.fmtDur(leg.arrive - leg.depart)} walk to ${dest}`
            )
          );
          if (dist) body.append($('<div class="tp-leg-sub"></div>').text(`${dist} m`));
          row.addClass("tp-leg-walk").append(
            $('<span class="tp-leg-node tp-leg-icon">🚶</span>'),
            body
          );
        } else {
          const color = this.rideColor(leg, rideIdx++);
          const name = leg.short_name || leg.long_name || leg.route_id;
          body.css("border-left-color", color).append(
            $('<div class="tp-leg-main"></div>').html(
              `<b>${esc(leg.board.name)}</b> <time>${this.fmt(leg.depart)}</time>` +
                ` <span class="tp-leg-arrow">→</span> ` +
                `<b>${esc(leg.alight.name)}</b> <time>${this.fmt(leg.arrive)}</time>`
            ),
            $('<div class="tp-leg-sub"></div>').html(
              `${leg.stops.length - 1} stops` +
                (leg.headsign
                  ? ` · <span class="tp-headsign">${esc(leg.headsign)}</span>`
                  : "")
            )
          );
          const chip = $('<span class="tp-leg-node tp-leg-chip"></span>')
            .css("background", color)
            .append(
              $('<span class="tp-chip-text"></span>').append(
                $('<span class="tp-chip-run"></span>').text(name)
              )
            );
          row.addClass("tp-leg-ride").append(chip, body);
        }
        legs.append(row);
      });
      card.append(legs);
      card.append(
        $('<div class="tp-journey-ride"></div>').append(
          $(
            '<button type="button" class="btn btn-default btn-xs tp-ride-btn" ' +
              'title="Ride this journey end-to-end in 3D">🚌 3D preview</button>'
          )
        )
      );
      out.append(card);
    });
    this._applyChipTickers(out);
  }

  /** Route chips are compact timeline nodes, so a long route name (e.g. "BSB
   * Circular (C)") would be clipped. Where the name overflows its chip, scroll
   * it as a seamless ticker: duplicate the run so a -50% slide loops without a
   * seam, paused on hover so it can be read. Chips that fit are left static. */
  _applyChipTickers(scope) {
    scope.find(".tp-leg-chip").each((_, el) => {
      const _cs = getComputedStyle(el);
      const _avail =
        el.clientWidth - parseFloat(_cs.paddingLeft) - parseFloat(_cs.paddingRight);
      const _run = el.querySelector(".tp-chip-run");
      if (!_run || _run.getBoundingClientRect().width <= _avail + 1) return; // fits — no ticker
      const run = _run;
      const text = el.querySelector(".tp-chip-text");
      if (!text) return;
      run.textContent += "  "; // trailing gap baked into each copy
      text.appendChild(run.cloneNode(true)); // 2 copies → -50% loops seamlessly
      const runW = run.getBoundingClientRect().width;
      el.style.setProperty("--tp-ticker-dur", Math.max(4, runW / 22).toFixed(1) + "s");
      el.classList.add("tp-chip-ticker");
    });
  }

  // --- 3D ride preview --------------------------------------------------------

  /** A planned journey reshaped into ride geometry ({segments, stops, bounds,
   * phases, name}): all legs concatenated into one continuous drive path —
   * walks along their routed road path when available — with the ride legs'
   * stops as the stop markers. `phases` marks which stretches of the path are
   * walked vs ridden, as fractions of total length, so the 3D engines can
   * swap the bus for a pedestrian.
   *
   * Leg junctions don't meet exactly (ride lines pin to the stop, routed
   * walks end at the nearest road point), which would leave short
   * out-and-back spurs that flip the 3D heading — so tight reversals are
   * dropped as the path is assembled. */
  ridePayload(j) {
    const M_PER_DEG = 111320;
    const kx = Math.cos((j.legs[0].from.lat * Math.PI) / 180);
    const dist = (a, b) =>
      Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]) * M_PER_DEG;

    const path = [];
    const legOf = []; // owning leg index per path point (for phase spans)
    const add = (c, li) => {
      const p = [c[0], c[1]];
      const last = path[path.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) return;
      path.push(p);
      legOf.push(li);
      // De-spike: while the last three points double back within a short
      // hop (turn sharper than ~120° with a side under 300 m), drop the
      // middle one — these are junction artifacts, not the route.
      while (path.length >= 3) {
        const a = path[path.length - 3];
        const b = path[path.length - 2];
        const c2 = path[path.length - 1];
        const v1 = [(b[0] - a[0]) * kx, b[1] - a[1]];
        const v2 = [(c2[0] - b[0]) * kx, c2[1] - b[1]];
        const l1 = Math.hypot(v1[0], v1[1]);
        const l2 = Math.hypot(v2[0], v2[1]);
        if (!l1 || !l2) break;
        const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
        if (cos < -0.5 && Math.min(l1, l2) * M_PER_DEG < 300) {
          path.splice(path.length - 2, 1);
          legOf.splice(legOf.length - 2, 1);
        } else {
          break;
        }
      }
    };

    const stops = [];
    j.legs.forEach((leg, li) => {
      if (leg.type === "walk") {
        // True endpoints around the routed road path, so walks connect to
        // the A/B markers and the stops they serve.
        add([leg.from.lon, leg.from.lat], li);
        (leg.geometry || []).forEach((c) => add(c, li));
        add([leg.to.lon, leg.to.lat], li);
      } else {
        leg.geometry.forEach((c) => add(c, li));
        leg.stops.forEach((s) =>
          stops.push({ name: s.name, lon: s.lon, lat: s.lat })
        );
      }
    });

    // Surviving per-leg spans -> fractions of total path length.
    const cum = [0];
    for (let i = 1; i < path.length; i++) {
      cum.push(cum[i - 1] + dist(path[i - 1], path[i]));
    }
    const total = cum[cum.length - 1] || 1;
    const first = {};
    const last = {};
    legOf.forEach((li, i) => {
      if (first[li] == null) first[li] = i;
      last[li] = i;
    });
    // phases drive the walk/ride marker swap; legs carry display info so the 3D
    // ride can show the journey breakdown and highlight the leg being travelled.
    const WALK_COLOR = "#9aa0a6"; // muted grey marks walked stretches
    const phases = [];
    const legs = [];
    const legColor = {}; // leg index -> colour, for the per-point path colouring
    let rideIdx = 0;
    j.legs.forEach((leg, li) => {
      if (first[li] == null || last[li] <= first[li]) return; // leg despiked away
      const t0 = cum[first[li]] / total;
      const t1 = cum[last[li]] / total;
      if (leg.type === "walk") {
        legColor[li] = WALK_COLOR;
        phases.push({ mode: "walk", t0, t1 });
        legs.push({
          mode: "walk",
          t0,
          t1,
          color: WALK_COLOR,
          to: (leg.to && leg.to.name) || "destination",
        });
      } else {
        const c = this.rideColor(leg, rideIdx++);
        legColor[li] = c;
        phases.push({ mode: "ride", t0, t1 });
        legs.push({
          mode: "ride",
          t0,
          t1,
          name: leg.short_name || leg.long_name || leg.route_id,
          color: c,
          board: leg.board.name,
          alight: leg.alight.name,
          headsign: leg.headsign || "",
        });
      }
    });
    // Colour per path point (parallel to segments[0]) so the 3D centerline can
    // be drawn in each leg's colour — rides in their route colour, walks grey.
    const pathColors = legOf.map((li) => legColor[li] || WALK_COLOR);

    const lons = path.map((p) => p[0]);
    const lats = path.map((p) => p[1]);
    return {
      segments: [path],
      stops,
      bounds: {
        minLon: Math.min(...lons),
        minLat: Math.min(...lats),
        maxLon: Math.max(...lons),
        maxLat: Math.max(...lats),
      },
      phases,
      legs,
      pathColors,
      name: `Planned trip ${this.fmt(j.departure)} → ${this.fmt(j.arrival)}`,
    };
  }

  rideJourney(engine) {
    if (!this.pendingRide) return;
    sessionStorage.setItem(
      "trip-preview",
      JSON.stringify(this.ridePayload(this.pendingRide))
    );
    window.location.href = `/ride/${engine}?route=trip-preview`;
  }

  // --- Map drawing ----------------------------------------------------------------

  drawMarkers() {
    this.markerSource.clear();
    const add = (pt, label, color) => {
      if (!pt) return;
      const f = new ol.Feature(
        new ol.geom.Point(APP.MapUtils.toOL([pt.lon, pt.lat]))
      );
      f.setStyle(
        new ol.style.Style({
          image: new ol.style.Circle({
            radius: 11,
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke({ color: "#fff", width: 2.5 }),
          }),
          text: new ol.style.Text({
            text: label,
            font: "bold 12px sans-serif",
            fill: new ol.style.Fill({ color: "#fff" }),
          }),
        })
      );
      this.markerSource.addFeature(f);
    };
    add(this.from, "A", "#2e7d32");
    add(this.to, "B", "#c0392b");
  }

  selectJourney(i) {
    const j = this.journeys[i];
    if (!j) return;
    $("#tpResults .tp-journey").removeClass("selected").eq(i).addClass("selected");
    this.saveState(i);
    this.journeySource.clear();

    let rideIdx = 0;
    j.legs.forEach((leg) => {
      if (leg.type === "walk") {
        // Road-following path when the foot router supplied one, tied to the
        // leg's true endpoints (the router snaps to the nearest road).
        const pts = this.despike([
          [leg.from.lon, leg.from.lat],
          ...(leg.geometry || []),
          [leg.to.lon, leg.to.lat],
        ]);
        const line = new ol.Feature(
          new ol.geom.LineString(pts.map((c) => APP.MapUtils.toOL(c)))
        );
        line.setStyle(
          new ol.style.Style({
            stroke: new ol.style.Stroke({
              color: "#5a6770",
              width: 3,
              lineDash: [2, 8],
              lineCap: "round",
            }),
          })
        );
        this.journeySource.addFeature(line);
        return;
      }
      const color = this.rideColor(leg, rideIdx++);
      const coords = this.despike(leg.geometry).map((c) => APP.MapUtils.toOL(c));
      const line = new ol.Feature(new ol.geom.LineString(coords));
      line.setStyle([
        new ol.style.Style({
          stroke: new ol.style.Stroke({ color: "#fff", width: 7 }),
        }),
        new ol.style.Style({
          stroke: new ol.style.Stroke({ color, width: 4 }),
        }),
      ]);
      this.journeySource.addFeature(line);
      [leg.board, leg.alight].forEach((s) => {
        const f = new ol.Feature(
          new ol.geom.Point(APP.MapUtils.toOL([s.lon, s.lat]))
        );
        f.setStyle(
          new ol.style.Style({
            image: new ol.style.Circle({
              radius: 6,
              fill: new ol.style.Fill({ color: "#fff" }),
              stroke: new ol.style.Stroke({ color, width: 3 }),
            }),
            text: new ol.style.Text({
              text: s.name,
              offsetY: -14,
              font: "12px sans-serif",
              fill: new ol.style.Fill({ color: "#111" }),
              stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
            }),
          })
        );
        this.journeySource.addFeature(f);
      });
    });

    // Fit A, B and the whole journey.
    const ext = ol.extent.createEmpty();
    this.journeySource.forEachFeature((f) =>
      ol.extent.extend(ext, f.getGeometry().getExtent())
    );
    this.markerSource.forEachFeature((f) =>
      ol.extent.extend(ext, f.getGeometry().getExtent())
    );
    if (!ol.extent.isEmpty(ext)) {
      this.map.getView().fit(ext, { padding: [60, 60, 60, 60], maxZoom: 16, duration: 400 });
    }
  }
};

$(document).ready(() => (APP.plannerPage = new APP.PlannerPage()));
