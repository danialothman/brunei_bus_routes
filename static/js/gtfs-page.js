// Bootstrap + orchestrator for the /gtfs workbench page. One selected route
// drives everything: the map display, the geometry editor target, and the GTFS
// pane. This class also acts as the EditorManager's routeManager adapter
// (hide/show/reload/rename/add/remove) over its single-route layer and list.
window.APP = window.APP || {};

APP.GtfsPage = class {
  constructor() {
    this.map = null;
    this.baseLayer = null;
    this.selected = null; // { id, year, file, isUser }
    this.layer = null; // vector layer for the selected route
    this.names = {}; // id -> display name
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
    this.infoManager.init();
    this.editorManager.init();
    this.stopImageManager.init();
    this.gtfsEditor.init();

    $("#gtfsEditBtn").on("click", () => this.editSelected());
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
        const years = cat.years || [];
        let first = null;
        const head = (t) =>
          out.append($('<div class="gtfs-list-head"></div>').text(t));
        const add = (year, file, isUser, names) => {
          const id = this._id(year, file);
          this.names[id] = names[file] || file.replace(/\.kml$/, "");
          if (isUser) this.userIds.add(id);
          out.append(this._row(id, year, file, this.names[id], isUser));
          if (!first) first = { year, file };
        };
        // The user's own routes first, then shipped KML routes per year.
        // GeoJSON paths and "Points - " overlays carry no stops, so they're
        // not part of the GTFS picture and stay on the main map page.
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
        });
        $("#newRouteBtn").toggle(years.indexOf(APP.USER_ROUTE_YEAR) >= 0);
        if (first) this.select(first.year, first.file);
      })
      .catch((e) => APP.MapUtils.handleError(e, "Loading catalog"));
  }

  _row(id, year, file, display, isUser) {
    // Signage-style chip with the route code, where the name carries one.
    const code = (display.match(/(\d+[A-Za-z]?)\s*$/) || [])[1] || "•";
    const row = $('<div class="gtfs-route-row"></div>').attr({
      "data-id": id,
      "data-year": year,
      "data-file": file,
    });
    if (isUser) row.addClass("user");
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
    this.selected = { id, year, file, isUser: this.userIds.has(id) };
    $("#gtfsRouteList .gtfs-route-row").removeClass("selected");
    const row = this._rowFor(id).addClass("selected");
    if (row.length) row[0].scrollIntoView({ block: "nearest" });
    this._loadLayer();
    this.gtfsEditor.setRoute(year, file, this.names[id]);
    $("#gtfsEditBtn").show();
  }

  _loadLayer() {
    if (this.layer) {
      this.map.removeLayer(this.layer);
      this.layer = null;
    }
    const { year, file } = this.selected;
    const source = new ol.source.Vector({
      url: `/data/kml/${encodeURIComponent(file)}?year=${encodeURIComponent(year)}`,
      format: new ol.format.KML({
        extractStyles: false,
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });
    const layer = new ol.layer.Vector({
      source,
      style: (feat) => this._routeStyle(feat),
    });
    source.on("change", () => {
      if (source.getState() === "ready" && source.getFeatures().length) {
        const ext = source.getExtent();
        if (ext && isFinite(ext[0])) {
          this.map.getView().fit(ext, {
            padding: [60, 60, 60, 60],
            maxZoom: 16,
            duration: 400,
          });
        }
      }
    });
    this.layer = layer;
    this.map.addLayer(layer);
  }

  _routeStyle(feature) {
    // Same language as the editor: blue line, yellow labelled stops.
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
      stroke: new ol.style.Stroke({ color: "#0074d9", width: 3 }),
    });
  }

  // --- Editing -------------------------------------------------------------------

  editSelected() {
    if (!this.selected || this.editorManager.active) return;
    const { id, year, file, isUser } = this.selected;
    if (isUser) {
      this.editorManager.enter(file, "kml", year);
      return;
    }
    // Shipped routes are read-only — edit a copy, reusing an existing one.
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
    this.editorManager.copyToUserRoute(file, "kml", year);
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
  }

  showRouteAfterEdit(year, file) {
    if (this.selected && this.selected.id === this._id(year, file) && this.layer) {
      this.layer.setVisible(true);
    }
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
    }
  }

  addUserRouteRow(year, file, displayName) {
    const id = this._id(year, file);
    if (this.names[id] != null) {
      this.setRouteDisplayName(year, file, displayName);
      return;
    }
    this.names[id] = displayName || file.replace(/\.kml$/, "");
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
