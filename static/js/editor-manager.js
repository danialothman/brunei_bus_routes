// In-app route/stop editor. Edits a single route at a time over an editable
// OpenLayers vector layer (Modify/Draw/Select/Snap), with an in-session
// undo/redo snapshot stack. Saves go to the SQLite-backed /data/edit endpoints
// (full version history); originals on disk are never modified.
window.APP = window.APP || {};

APP.EditorManager = class {
  /**
   * @param {ol.Map} map
   * @param {APP.RouteManager} routeManager
   * @param {APP.InfoManager} infoManager
   */
  constructor(map, routeManager, infoManager) {
    this.map = map;
    this.routeManager = routeManager;
    this.infoManager = infoManager;

    this.active = false;
    this.file = null;
    this.kind = "kml"; // "kml" | "geojson"
    this.year = null;
    this.routeName = "";

    this.source = null;
    this.layer = null;
    this.modify = null;
    this.draw = null;
    this.drawLine = null;
    this.snap = null;
    this._onClick = null;
    this.tool = "move";
    this.creating = false;
    this.isUserRoute = false;

    this.undoStack = [];
    this.redoStack = [];
    this._suppressSnapshot = false;
  }

  init() {
    // Enter editing via the per-row pencil (delegated; don't toggle the checkbox).
    $("#routes").on("click", ".route-edit-btn", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = $(e.currentTarget);
      this.enter(
        el.attr("data-file"),
        el.attr("data-kind") || "kml",
        el.attr("data-year")
      );
    });

    // Copy a read-only shipped route into a new editable user route.
    $("#routes").on("click", ".route-copy-btn", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = $(e.currentTarget);
      this.copyToUserRoute(
        el.attr("data-file"),
        el.attr("data-kind") || "kml",
        el.attr("data-year")
      );
    });

    // Toolbar buttons.
    const t = (sel, fn) => $(sel).on("click", (e) => { e.preventDefault(); fn(); });
    t("#newRouteBtn", () => this.createNew());
    t("#edTool-drawline", () => this.setTool("drawline"));
    t("#edTool-move", () => this.setTool("move"));
    t("#edTool-addstop", () => this.setTool("addstop"));
    t("#edTool-delete", () => this.setTool("delete"));
    t("#edTool-rename", () => this.setTool("rename"));
    t("#edRenameRoute", () => this.renameRoute());
    t("#edReverse", () => this.reverse());
    t("#edUndo", () => this.undo());
    t("#edRedo", () => this.redo());
    t("#edSave", () => this.save());
    t("#edHistory", () => this.openHistory());
    t("#edRevert", () => this.revert());
    t("#edExit", () => this.exit());

  }

  // --- Enter / exit ----------------------------------------------------------

  enter(file, kind, year) {
    if (!file) return;
    if (this.active) {
      if (this.file === file && this.kind === kind) return;
      if (!confirm("Finish editing the current route first? Unsaved in-session changes will be lost.")) {
        return;
      }
      this.exit();
    }
    this.active = true;
    this.file = file;
    this.kind = kind || "kml";
    this.year = year;
    this.creating = false;
    this.isUserRoute = /^user-\d+\.kml$/.test(file);

    this.infoManager.setEnabled(false);
    this.routeManager.hideRouteForEdit(this.year, file, this.kind);

    this.source = new ol.source.Vector();
    this.layer = new ol.layer.Vector({
      source: this.source,
      zIndex: 9999,
      style: (feat) => this._styleFor(feat),
    });
    this.map.addLayer(this.layer);

    this._addInteractions();
    this._loadGeometry();
    this._showToolbar(true);
    this.setTool("move");
  }

  /** Start a brand-new (file-less) route — only for the 2026 dataset.
   * @param {string} [defaultName] pre-fills the name prompt (e.g. a route number
   *   when launched from the official-stops reference panel). */
  createNew(defaultName) {
    if (this.active) {
      if (!confirm("Finish the current edit first? Unsaved changes will be lost.")) {
        return;
      }
      this.exit();
    }
    const name = window.prompt("New route name:", defaultName || "");
    if (name == null) return;

    this.active = true;
    this.file = null;
    this.kind = "kml";
    // New routes are created only for the user-route year (enforced server-side).
    this.year = APP.USER_ROUTE_YEAR;
    this.creating = true;
    this.isUserRoute = true;
    this.routeName = name.trim() || "New route";

    this.infoManager.setEnabled(false);
    this.source = new ol.source.Vector();
    this.layer = new ol.layer.Vector({
      source: this.source,
      zIndex: 9999,
      style: (feat) => this._styleFor(feat),
    });
    this.map.addLayer(this.layer);
    this._addInteractions();
    this._showToolbar(true);
    $("#edRouteName").text(this.routeName);
    this.undoStack = [this._serialize()];
    this.redoStack = [];
    this._updateButtons();
    this.setTool("drawline");
    this._flash("Draw the route line, then Save");
  }

  /**
   * Duplicate a read-only shipped route into a new editable user route (in the
   * user-route year), then open the copy for editing. The geometry copied is
   * whatever is currently served for the route (any DB overlay, else on-disk).
   */
  copyToUserRoute(file, kind, year) {
    if (!file) return;
    if (this.active) {
      if (!confirm("Finish the current edit first? Unsaved changes will be lost.")) {
        return;
      }
      this.exit();
    }
    const q = `?year=${encodeURIComponent(year)}`;
    fetch(`/data/route-geometry/${encodeURIComponent(file)}${q}`)
      .then((r) => r.json())
      .then((geo) => {
        const segments = geo.segments || [];
        if (!segments.length) {
          alert("This layer has no route line to copy.");
          return;
        }
        const baseName = geo.name || file.replace(/\.(kml|geojson)$/, "");
        const body = { segments, stops: geo.stops || [], name: `${baseName} (copy)` };
        const yr = APP.USER_ROUTE_YEAR;
        return fetch(`/data/create?year=${encodeURIComponent(yr)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
          .then(({ ok, j }) => {
            if (!ok) throw new Error(j.error || "copy failed");
            this.routeManager.addUserRouteRow(yr, j.filename, body.name);
            this.routeManager.reloadRoute(yr, j.filename, "kml");
            // Open the editable copy straight away — that's the point of copying.
            this.enter(j.filename, "kml", yr);
            this._flash("Copied to your routes");
          });
      })
      .catch((err) => {
        APP.MapUtils.handleError(err, "Copying route");
        alert("Copy failed: " + err.message);
      });
  }

  exit() {
    if (!this.active) return;
    this._removeInteractions();
    if (this.layer) {
      this.map.removeLayer(this.layer);
    }
    this.routeManager.showRouteAfterEdit(this.year, this.file, this.kind);
    this.infoManager.setEnabled(true);
    this._showToolbar(false);
    this.active = false;
    this.file = null;
    this.source = null;
    this.layer = null;
    this.creating = false;
    this.isUserRoute = false;
    this.undoStack = [];
    this.redoStack = [];
  }

  // --- Geometry load / build / serialize ------------------------------------

  _loadGeometry(version) {
    const v = version != null ? `&version=${version}` : "";
    fetch(`/data/route-geometry/${encodeURIComponent(this.file)}${this._yq()}${v}`)
      .then((r) => r.json())
      .then((geo) => {
        this._buildFeatures({ segments: geo.segments || [], stops: geo.stops || [] });
        this.routeName = geo.name || this.file.replace(/\.(kml|geojson)$/, "");
        $("#edRouteName").text(this.routeName);
        this.routeManager.setRouteDisplayName(this.year, this.file, this.routeName, this.kind);
        const ext = this.source.getExtent();
        if (ext && isFinite(ext[0])) {
          // On /gtfs the timing panel may dock over the map's right edge.
          const timing = $("#timingPanel");
          const padRight = timing.is(":visible") ? timing.outerWidth() + 40 : 60;
          this.map.getView().fit(ext, { padding: [60, padRight, 60, 60], maxZoom: 17, duration: 400 });
        }
        this.undoStack = [this._serialize()];
        this.redoStack = [];
        this._updateButtons();
      })
      .catch((err) => APP.MapUtils.handleError(err, "Loading route for edit"));
  }

  _buildFeatures(geom) {
    this.source.clear();
    geom.segments.forEach((seg) => {
      const coords = seg.map((p) => APP.MapUtils.toOL(p));
      const f = new ol.Feature(new ol.geom.LineString(coords));
      f.set("kind", "line");
      this.source.addFeature(f);
    });
    if (this.kind !== "geojson") {
      geom.stops.forEach((s) => {
        const f = new ol.Feature(new ol.geom.Point(APP.MapUtils.toOL([s.lon, s.lat])));
        f.set("kind", "stop");
        f.set("name", s.name || "");
        f.set("code", s.code || ""); // public stop number (GTFS stop_code)
        this.source.addFeature(f);
      });
    }
  }

  _serialize() {
    const segments = [];
    const stops = [];
    this.source.forEachFeature((f) => {
      const geom = f.getGeometry();
      if (f.get("kind") === "line") {
        segments.push(
          geom.getCoordinates().map((c) => {
            const ll = APP.MapUtils.toNormal(c);
            return [round7(ll[0]), round7(ll[1])];
          })
        );
      } else if (f.get("kind") === "stop") {
        const ll = APP.MapUtils.toNormal(geom.getCoordinates());
        const stop = { name: f.get("name") || "", lon: round7(ll[0]), lat: round7(ll[1]) };
        if (f.get("code")) stop.code = f.get("code");
        stops.push(stop);
      }
    });
    return { segments, stops, name: this.routeName };
  }

  // --- Tools / interactions --------------------------------------------------

  _addInteractions() {
    // A stop snapped onto the line sits exactly on a vertex/segment, and one
    // Modify over the whole source would drag both together. Split: Translate
    // moves stops (whole points), Modify handles the line but stands down
    // whenever the pointer is over a stop.
    const stopAtPixel = (e) => {
      let hit = false;
      this.map.forEachFeatureAtPixel(
        e.pixel,
        (f) => {
          if (f.get("kind") === "stop") {
            hit = true;
            return true;
          }
        },
        { hitTolerance: 8, layerFilter: (l) => l === this.layer }
      );
      return hit;
    };
    this.modify = new ol.interaction.Modify({
      source: this.source,
      condition: (e) => !stopAtPixel(e),
    });
    this.modify.on("modifyend", () => this._snapshot());

    this.translate = new ol.interaction.Translate({
      layers: [this.layer],
      filter: (f) => f.get("kind") === "stop",
      hitTolerance: 8,
    });
    this.translate.on("translateend", () => this._snapshot());

    this.draw = new ol.interaction.Draw({ source: this.source, type: "Point" });
    this.draw.on("drawend", (e) => {
      const f = e.feature;
      f.set("kind", "stop");
      const name = window.prompt("Stop name:", "");
      f.set("name", name == null ? "" : name);
      // snapshot after the feature is committed to the source
      setTimeout(() => this._snapshot(), 0);
    });

    this.drawLine = new ol.interaction.Draw({ source: this.source, type: "LineString" });
    this.drawLine.on("drawend", (e) => {
      e.feature.set("kind", "line");
      setTimeout(() => this._snapshot(), 0);
    });

    this.snap = new ol.interaction.Snap({ source: this.source }); // add last
    // Translate after Modify: later interactions see events first, so a
    // grabbed stop never reaches the line editor.
    [this.modify, this.translate, this.draw, this.drawLine, this.snap].forEach(
      (i) => this.map.addInteraction(i)
    );

    // Rename/Delete act directly on the stop clicked — more reliable than a
    // Select interaction's select event, and a single click does the action.
    this._onClick = (e) => this._handleClick(e);
    this.map.on("singleclick", this._onClick);
  }

  _removeInteractions() {
    [this.modify, this.translate, this.draw, this.drawLine, this.snap].forEach(
      (i) => {
        if (i) this.map.removeInteraction(i);
      }
    );
    if (this._onClick) this.map.un("singleclick", this._onClick);
    this._onClick = null;
    this.modify = this.translate = this.draw = this.drawLine = this.snap = null;
  }

  setTool(tool) {
    // geojson routes are line-only
    if (this.kind === "geojson" && tool === "addstop") tool = "move";
    this.tool = tool;
    if (this.modify) this.modify.setActive(tool === "move");
    if (this.translate) this.translate.setActive(tool === "move");
    if (this.draw) this.draw.setActive(tool === "addstop");
    if (this.drawLine) this.drawLine.setActive(tool === "drawline");
    $(".ed-tool").removeClass("active");
    $(`#edTool-${tool}`).addClass("active");
  }

  /** In rename/delete tools, act on the stop under the click. */
  _handleClick(e) {
    if (!this.active) return;
    if (
      this.tool !== "rename" &&
      this.tool !== "delete" &&
      this.tool !== "move"
    ) {
      return; // drawline/addstop: a click means "draw here", not "inspect"
    }
    let stop = null;
    let line = null;
    this.map.forEachFeatureAtPixel(
      e.pixel,
      (f) => {
        const k = f.get("kind");
        if (k === "stop" && !stop) stop = f;
        else if (k === "line" && !line) line = f;
      },
      { hitTolerance: 6, layerFilter: (l) => l === this.layer }
    );
    // Surface the clicked stop in the workbench's stops list (no-op on the
    // main map page, whose route manager has no such hook). Not for delete —
    // the row is about to disappear.
    if (stop && this.tool !== "delete" && this.routeManager.highlightStop) {
      this.routeManager.highlightStop(stop);
    }
    if (this.tool === "move") return;
    if (this.tool === "rename") {
      if (!stop) return;
      const name = window.prompt("Rename stop:", stop.get("name") || "");
      if (name != null) {
        stop.set("name", name);
        this.layer.changed();
        this._snapshot();
      }
      return;
    }
    // Delete tool: remove the clicked stop, or the line if no stop is hit.
    const target = stop || line;
    if (!target) return;
    this.source.removeFeature(target);
    this._snapshot();
  }

  // --- Undo / redo (in-session snapshots) -----------------------------------

  _snapshot() {
    if (this._suppressSnapshot) return;
    this.undoStack.push(this._serialize());
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this._updateButtons();
  }

  _restore(geom) {
    this._suppressSnapshot = true;
    this._buildFeatures(geom);
    if (geom.name != null) {
      this.routeName = geom.name;
      $("#edRouteName").text(this.routeName ||
        (this.file ? this.file.replace(/\.(kml|geojson)$/, "") : "New route"));
    }
    this._suppressSnapshot = false;
    this._updateButtons();
  }

  /** Rename the whole route (a custom display name, persisted on Save). */
  renameRoute() {
    if (!this.active) return;
    const name = window.prompt("Route name:", this.routeName || "");
    if (name == null) return;
    this.routeName = name.trim();
    $("#edRouteName").text(this.routeName ||
        (this.file ? this.file.replace(/\.(kml|geojson)$/, "") : "New route"));
    this._snapshot();
  }

  undo() {
    if (this.undoStack.length < 2) return;
    this.redoStack.push(this.undoStack.pop());
    this._restore(this.undoStack[this.undoStack.length - 1]);
  }

  redo() {
    if (!this.redoStack.length) return;
    const geom = this.redoStack.pop();
    this.undoStack.push(geom);
    this._restore(geom);
  }

  // --- Save / history / restore / revert ------------------------------------

  /** Reverse travel direction: flip segment order + each segment's points. */
  reverse() {
    if (!this.active) return;
    const geom = this._serialize();
    if (!geom.segments.length) return;
    geom.segments = geom.segments.map((s) => s.slice().reverse()).reverse();
    geom.stops = geom.stops.slice().reverse();
    this._buildFeatures(geom);
    this._snapshot();
    this._flash("Direction reversed");
  }

  save() {
    const body = this._serialize();
    if (!body.segments.length) {
      alert("Cannot save a route with no line — use the Line tool to draw it.");
      return;
    }
    const creating = this.creating;
    const url = creating
      ? `/data/create${this._yq()}`
      : `/data/edit/${encodeURIComponent(this.file)}${this._yq()}`;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error || "save failed");
        if (creating) {
          this.file = j.filename;
          this.creating = false;
          this.isUserRoute = true;
          this.routeManager.addUserRouteRow(this.year, this.file, this.routeName);
        }
        this.routeManager.reloadRoute(this.year, this.file, this.kind);
        // Keep editing without the saved read-only layer duplicating the editable one.
        this.routeManager.hideRouteForEdit(this.year, this.file, this.kind);
        this.routeManager.setRouteDisplayName(this.year, this.file, this.routeName, this.kind);
        this._flash(`Saved v${j.version}`);
      })
      .catch((err) => {
        APP.MapUtils.handleError(err, "Saving edit");
        alert("Save failed: " + err.message);
      });
  }

  openHistory() {
    fetch(`/data/edit-history/${encodeURIComponent(this.file)}${this._yq()}`)
      .then((r) => r.json())
      .then((versions) => {
        const list = $("#editHistoryList").empty();
        $("#editHistoryFile").text(this.file);
        if (!versions.length) {
          list.append('<p class="text-muted">No saved versions yet.</p>');
        }
        versions.forEach((v) => {
          const row = $('<div class="ed-hist-row"></div>');
          row.append(
            $("<span></span>").text(
              `v${v.version} · ${v.created_at}` + (v.label ? ` · ${v.label}` : "")
            )
          );
          const btns = $('<span class="ed-hist-btns"></span>');
          btns.append(
            $('<a class="btn btn-default btn-xs">Preview</a>').on("click", () => {
              this._loadGeometry(v.version);
              $("#editHistoryModal").modal("hide");
            })
          );
          btns.append(
            $('<a class="btn btn-primary btn-xs">Restore</a>').on("click", () =>
              this._restoreVersion(v.version)
            )
          );
          row.append(btns);
          list.append(row);
        });
        $("#editHistoryModal").modal("show");
      })
      .catch((err) => APP.MapUtils.handleError(err, "Loading history"));
  }

  _restoreVersion(version) {
    fetch(
      `/data/edit/${encodeURIComponent(this.file)}/restore${this._yq()}&version=${version}`,
      { method: "POST" }
    )
      .then((r) => r.json())
      .then((j) => {
        $("#editHistoryModal").modal("hide");
        this._loadGeometry(); // load new latest
        this.routeManager.reloadRoute(this.year, this.file, this.kind);
        this._flash(`Restored as v${j.version}`);
      })
      .catch((err) => APP.MapUtils.handleError(err, "Restoring version"));
  }

  revert() {
    // A new route that was never saved: just discard it.
    if (this.creating && !this.file) {
      if (confirm("Discard this new route?")) this.exit();
      return;
    }
    const wasUser = this.isUserRoute;
    const msg = wasUser
      ? "Delete this route? This removes it and all its versions."
      : "Revert to the original route? This deletes all saved edits for it.";
    if (!confirm(msg)) return;
    const file = this.file;
    const kind = this.kind;
    const year = this.year;
    fetch(`/data/edit/${encodeURIComponent(file)}${this._yq()}`, { method: "DELETE" })
      .then((r) => r.json())
      .then(() => {
        this.exit();
        if (wasUser) {
          this.routeManager.removeRouteRow(year, file, kind); // route is gone entirely
        } else {
          this.routeManager.reloadRoute(year, file, kind);
          this.routeManager.setRouteDisplayName(year, file, null, kind); // back to filename
        }
      })
      .catch((err) => APP.MapUtils.handleError(err, "Reverting"));
  }

  // --- UI helpers ------------------------------------------------------------

  _showToolbar(show) {
    const bar = $("#editorToolbar");
    $("body").toggleClass("editing", show);
    if (show) {
      // A new route has no file yet — show its name instead.
      const display = this.file
        ? this.file.replace(/\.(kml|geojson)$/, "")
        : this.routeName || "New route";
      $("#edRouteName").text(display);
      // Stops don't exist on geojson routes; keep Delete (it removes lines too).
      $("#edTool-addstop, #edTool-rename").toggle(this.kind !== "geojson");
      bar.show();
    } else {
      bar.hide();
    }
  }

  _updateButtons() {
    $("#edUndo").prop("disabled", this.undoStack.length < 2);
    $("#edRedo").prop("disabled", this.redoStack.length === 0);
  }

  _flash(msg) {
    $("#edStatus").text(msg);
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => $("#edStatus").text(""), 2500);
  }

  _yq() {
    return this.year ? `?year=${encodeURIComponent(this.year)}` : "";
  }

  _styleFor(feature, selected) {
    const kind = feature.get("kind");
    if (kind === "stop") {
      return new ol.style.Style({
        image: new ol.style.Circle({
          radius: selected ? 8 : 6,
          fill: new ol.style.Fill({ color: selected ? "#ff4136" : "#ffd166" }),
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
        color: selected ? "#ff4136" : "#0074d9",
        width: selected ? 5 : 3,
      }),
    });
  }
};

function round7(n) {
  return Math.round(n * 1e7) / 1e7;
}
