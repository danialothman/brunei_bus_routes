// Bootstrap + orchestrator for the /gtfs workbench page. One selected route
// drives everything: the map display, the geometry editor target, and the GTFS
// pane. This class also acts as the EditorManager's routeManager adapter
// (hide/show/reload/rename/add/remove) over its single-route layer and list.
window.APP = window.APP || {};

APP.GtfsPage = class {
  constructor() {
    this.map = null;
    this.baseLayer = null;
    this.selected = null; // { id, year, file, kind, isUser }
    this.layer = null; // vector layer for the selected route
    this.names = {}; // id -> display name
    this.kinds = {}; // id -> "kml" | "geojson"
    this.userIds = new Set();
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

    this.infoManager = new APP.InfoManager(this.map);
    this.editorManager = new APP.EditorManager(this.map, this, this.infoManager);
    this.stopImageManager = new APP.StopImageManager(this.editorManager);
    this.gtfsEditor = new APP.GtfsEditorManager();
    this.gtfsEditor.page = this; // map focus, layer reloads, editor state
    this.infoManager.init();
    this.editorManager.init();
    this.stopImageManager.init();
    this.gtfsEditor.init();

    $("#gtfsEditBtn").on("click", () => this.editSelected());
    // Brand-new routes enter the editor without hideRouteForEdit firing
    // (no file yet) — engage the live stops list after the editor opens.
    // (EditorManager bound these first, so it runs before us.)
    $("#newRouteBtn, #sipCreate").on("click", () =>
      setTimeout(() => this.gtfsEditor.enterLive(), 0)
    );
    // The route list shares the sidebar with the GTFS pane — collapsible so
    // the pane can take the full height (forced shut while editing, via CSS).
    $("#gtfsRoutesHead").on("click", () =>
      $(".gtfs-routes-col").toggleClass("collapsed")
    );
    const list = $("#gtfsRouteList");
    list.on("click", ".gtfs-route-row", (e) => {
      if ($(e.target).closest(".gtfs-route-del").length) return;
      const el = $(e.currentTarget);
      this.select(el.attr("data-year"), el.attr("data-file"));
    });
    list.on("click", ".gtfs-route-del", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const row = $(e.currentTarget).closest(".gtfs-route-row");
      this.deleteUserRoute(row.attr("data-year"), row.attr("data-file"));
    });

    this.loadList();
  }

  _id(year, file) {
    return `${year}::${file}`;
  }

  // --- Route list ------------------------------------------------------------

  loadList() {
    fetch("/data/catalog")
      .then((r) => r.json())
      .then((cat) => {
        const out = $("#gtfsRouteList").empty();
        this.userIds.clear();
        this.names = {};
        this.kinds = {};
        const years = cat.years || [];
        let first = null;
        const head = (t) =>
          out.append($('<div class="gtfs-list-head"></div>').text(t));
        const add = (year, file, isUser, names, kind) => {
          const id = this._id(year, file);
          this.names[id] = names[file] || file.replace(/\.(kml|geojson)$/, "");
          this.kinds[id] = kind || "kml";
          if (isUser) this.userIds.add(id);
          out.append(this._row(id, year, file, this.names[id], isUser, kind));
          if (!first) first = { year, file };
        };
        // The user's own routes first, then shipped KML routes per year, then
        // the GeoJSON path tracings (line-only alternates — editable via copy,
        // which is also how they gain stops and join the feed). "Points - "
        // marker overlays aren't routes and stay on the main map page.
        years.forEach((y) => {
          const d = cat[y] || {};
          if (d.user && d.user.length) {
            head("My routes");
            d.user.forEach((f) => add(y, f, true, d.names || {}));
          }
        });
        years.forEach((y) => {
          const d = cat[y] || {};
          const shipped = (d.routes || []).filter((f) => !/^points\s*-/i.test(f));
          if (shipped.length) {
            head(`${y} routes`);
            shipped.forEach((f) => add(y, f, false, d.names || {}));
          }
          if (d.geojson && d.geojson.length) {
            head(`${y} paths`);
            d.geojson.forEach((f) => add(y, f, false, d.names || {}, "geojson"));
          }
        });
        $("#newRouteBtn").toggle(years.indexOf(APP.USER_ROUTE_YEAR) >= 0);
        this._loadStatuses(years);
        if (first) this.select(first.year, first.file);
      })
      .catch((e) => APP.MapUtils.handleError(e, "Loading catalog"));
  }

  /** Transcription-progress badges: 4 segments per route (schedule,
   * departures, operator, headsign). */
  _loadStatuses(years) {
    years.forEach((y) => {
      fetch(`/data/gtfs-meta-summary?year=${encodeURIComponent(y)}`)
        .then((r) => r.json())
        .then((d) => {
          Object.entries(d.routes || {}).forEach(([file, st]) =>
            this.setRouteStatus(y, file, st)
          );
        })
        .catch(() => {});
    });
  }

  setRouteStatus(year, file, st) {
    const row = this._rowFor(this._id(year, file));
    if (!row.length) return;
    let meter = row.find(".gtfs-route-meter");
    const flags = ["schedule", "departures", "operator", "headsign"];
    if (!meter.length) {
      meter = $('<span class="gtfs-route-meter"></span>');
      flags.forEach(() => meter.append("<i></i>"));
      row.find(".gtfs-route-label").after(meter);
    }
    meter.children().each((i, el) => {
      $(el).toggleClass("on", !!(st && st[flags[i]]));
    });
    meter.attr(
      "title",
      "transcribed: " +
        flags.map((f) => `${f} ${st && st[f] ? "✓" : "—"}`).join(" · ")
    );
  }

  _row(id, year, file, display, isUser, kind) {
    // Signage-style chip with the route code, where the name carries one.
    const code = (display.match(/(\d+[A-Za-z]?)\s*$/) || [])[1] || "•";
    const row = $('<div class="gtfs-route-row"></div>').attr({
      "data-id": id,
      "data-year": year,
      "data-file": file,
    });
    if (isUser) row.addClass("user");
    if (kind === "geojson") row.addClass("path");
    row.append($('<span class="gtfs-route-chip"></span>').text(code));
    row.append($('<span class="gtfs-route-label"></span>').text(display));
    if (isUser) {
      row.append($('<a class="gtfs-route-del" title="Delete route">✕</a>'));
    }
    return row;
  }

  _rowFor(id) {
    return $("#gtfsRouteList .gtfs-route-row").filter(
      (_, el) => $(el).attr("data-id") === id
    );
  }

  // --- Selection ---------------------------------------------------------------

  select(year, file) {
    if (this.editorManager.active) {
      if (
        !confirm("Exit the route editor? Unsaved in-session changes will be lost.")
      ) {
        return;
      }
      this.editorManager.exit();
    }
    this._setSelected(year, file);
  }

  /** Selection state + map + GTFS pane, without touching the editor. */
  _setSelected(year, file) {
    const id = this._id(year, file);
    const kind = this.kinds[id] || "kml";
    this.selected = { id, year, file, kind, isUser: this.userIds.has(id) };
    $("#gtfsRouteList .gtfs-route-row").removeClass("selected");
    const row = this._rowFor(id).addClass("selected");
    if (row.length) row[0].scrollIntoView({ block: "nearest" });
    // Collapsed-list header carries the selection.
    $("#gtfsRoutesCurrent").text(this.names[id] || "");
    this._loadLayer();
    this.gtfsEditor.setRoute(year, file, this.names[id], kind, this.userIds.has(id));
    $("#gtfsEditBtn").show();
  }

  /** Pan/zoom to a stop and flash a marker over it (from the stops list). */
  focusStop(lon, lat) {
    const center = APP.MapUtils.toOL([lon, lat]);
    const view = this.map.getView();
    view.animate({ center, zoom: Math.max(view.getZoom() || 0, 16), duration: 350 });
    const flash = new ol.layer.Vector({
      zIndex: 5000,
      source: new ol.source.Vector({
        features: [new ol.Feature(new ol.geom.Point(center))],
      }),
      style: new ol.style.Style({
        image: new ol.style.Circle({
          radius: 13,
          stroke: new ol.style.Stroke({ color: "#ff4136", width: 3 }),
        }),
      }),
    });
    this.map.addLayer(flash);
    setTimeout(() => this.map.removeLayer(flash), 1500);
  }

  _loadLayer() {
    if (this.layer) {
      this.map.removeLayer(this.layer);
      this.layer = null;
    }
    const { year, file, kind } = this.selected;
    const q = `?year=${encodeURIComponent(year)}`;
    const source =
      kind === "geojson"
        ? new ol.source.Vector({
            url: `/data/geojson/${encodeURIComponent(file)}${q}`,
            format: new ol.format.GeoJSON({
              dataProjection: "EPSG:4326",
              featureProjection: "EPSG:3857",
            }),
          })
        : new ol.source.Vector({
            url: `/data/kml/${encodeURIComponent(file)}${q}`,
            format: new ol.format.KML({
              extractStyles: false,
              dataProjection: "EPSG:4326",
              featureProjection: "EPSG:3857",
            }),
          });
    const layer = new ol.layer.Vector({
      source,
      style: (feat) => this._routeStyle(feat, kind),
    });
    source.on("change", () => {
      if (source.getState() === "ready" && source.getFeatures().length) {
        const ext = source.getExtent();
        if (ext && isFinite(ext[0])) {
          // Keep the fitted route clear of the timing panel docked on the
          // map's right edge.
          const timing = $("#timingPanel");
          const padRight =
            timing.is(":visible") ? timing.outerWidth() + 40 : 60;
          this.map.getView().fit(ext, {
            padding: [60, padRight, 60, 60],
            maxZoom: 16,
            duration: 400,
          });
        }
      }
    });
    this.layer = layer;
    this.map.addLayer(layer);
  }

  _routeStyle(feature, kind) {
    // Same language as the editor: blue line, yellow labelled stops.
    // GeoJSON path tracings draw dashed, like on the main map.
    if (feature.getGeometry() instanceof ol.geom.Point) {
      return new ol.style.Style({
        image: new ol.style.Circle({
          radius: 6,
          fill: new ol.style.Fill({ color: "#ffd166" }),
          stroke: new ol.style.Stroke({ color: "#7a5b00", width: 2 }),
        }),
        text: new ol.style.Text({
          text: feature.get("name") || "",
          offsetY: -14,
          font: "12px sans-serif",
          fill: new ol.style.Fill({ color: "#111" }),
          stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
        }),
      });
    }
    return new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: "#0074d9",
        width: 3,
        lineDash: kind === "geojson" ? [6, 6] : undefined,
      }),
    });
  }

  // --- Editing -------------------------------------------------------------------

  editSelected() {
    if (!this.selected || this.editorManager.active) return;
    const { id, year, file, kind, isUser } = this.selected;
    if (isUser) {
      this.editorManager.enter(file, "kml", year);
      return;
    }
    // Shipped routes are read-only — edit a copy, reusing an existing one.
    // Copies are always KML, so a copied GeoJSON path can gain stops.
    const copyName = `${this.names[id]} (copy)`;
    const existing = Array.from(this.userIds).find(
      (uid) => this.names[uid] === copyName
    );
    if (existing) {
      const sep = existing.indexOf("::");
      const yr = existing.slice(0, sep);
      const f = existing.slice(sep + 2);
      this._setSelected(yr, f);
      this.editorManager.enter(f, "kml", yr);
      return;
    }
    // Creates the copy, adds its row (via addUserRouteRow) and opens it.
    this.editorManager.copyToUserRoute(file, kind, year);
  }

  deleteUserRoute(year, file) {
    if (!confirm("Delete this route? This removes it and all its versions.")) {
      return;
    }
    fetch(`/data/edit/${encodeURIComponent(file)}?year=${encodeURIComponent(year)}`, {
      method: "DELETE",
    })
      .then((r) => r.json())
      .then(() => this.removeRouteRow(year, file))
      .catch((e) => APP.MapUtils.handleError(e, "Deleting route"));
  }

  // --- EditorManager adapter (the routeManager interface it relies on) ------------

  hideRouteForEdit(year, file) {
    if (this.selected && this.selected.id === this._id(year, file) && this.layer) {
      this.layer.setVisible(false);
    }
    // Editor is taking over: the stops list goes live against its session.
    // Deferred, because EditorManager.enter() calls this BEFORE it creates
    // its editing source — binding now would find nothing to mirror.
    setTimeout(() => {
      this.gtfsEditor.enterLive();
      // The route list collapses while editing (CSS) — bring the live stops
      // list into view, since it's the map editor's mirror.
      const stops = document.getElementById("gepStopsSection");
      if (stops) stops.scrollIntoView({ block: "start" });
    }, 0);
  }

  showRouteAfterEdit(year, file) {
    if (this.selected && this.selected.id === this._id(year, file) && this.layer) {
      this.layer.setVisible(true);
    }
    // Editor exited: back to the last saved geometry.
    this.gtfsEditor.exitLive();
  }

  reloadRoute(year, file) {
    if (this.selected && this.selected.id === this._id(year, file)) {
      this._loadLayer();
    }
  }

  setRouteDisplayName(year, file, name) {
    const id = this._id(year, file);
    this.names[id] = name || file.replace(/\.kml$/, "");
    this._rowFor(id).find(".gtfs-route-label").text(this.names[id]);
    if (this.selected && this.selected.id === id) {
      this.gtfsEditor.setLabel(this.names[id]);
      $("#gtfsRoutesCurrent").text(this.names[id]);
    }
  }

  addUserRouteRow(year, file, displayName) {
    const id = this._id(year, file);
    if (this.names[id] != null) {
      this.setRouteDisplayName(year, file, displayName);
      return;
    }
    this.names[id] = displayName || file.replace(/\.kml$/, "");
    this.kinds[id] = "kml"; // user routes (incl. copies of geojson paths)
    this.userIds.add(id);
    let head = $("#gtfsRouteList .gtfs-list-head").filter(
      (_, el) => $(el).text() === "My routes"
    );
    if (!head.length) {
      head = $('<div class="gtfs-list-head">My routes</div>');
      $("#gtfsRouteList").prepend(head);
    }
    head.after(this._row(id, year, file, this.names[id], true));
    // Saving a new/copied route makes it the working route — silently, so the
    // active editing session isn't disturbed.
    this._setSelected(year, file);
  }

  removeRouteRow(year, file) {
    const id = this._id(year, file);
    this._rowFor(id).remove();
    this.userIds.delete(id);
    delete this.names[id];
    delete this.kinds[id];
    if (this.selected && this.selected.id === id) {
      if (this.layer) {
        this.map.removeLayer(this.layer);
        this.layer = null;
      }
      this.selected = null;
      this.gtfsEditor.clearRoute();
      $("#gtfsEditBtn").hide();
    }
  }
};

$(document).ready(() => new APP.GtfsPage());
