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

    this.source = null;
    this.layer = null;
    this.modify = null;
    this.draw = null;
    this.snap = null;
    this._onClick = null;
    this.tool = "move";

    this.undoStack = [];
    this.redoStack = [];
    this._suppressSnapshot = false;
  }

  init() {
    // Enter editing via the per-row pencil (delegated; don't toggle the checkbox).
    $("#routes, #geojsonRoutes").on("click", ".route-edit-btn", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = $(e.currentTarget);
      this.enter(el.attr("data-file"), el.attr("data-kind") || "kml");
    });

    // Toolbar buttons.
    const t = (sel, fn) => $(sel).on("click", (e) => { e.preventDefault(); fn(); });
    t("#edTool-move", () => this.setTool("move"));
    t("#edTool-addstop", () => this.setTool("addstop"));
    t("#edTool-delete", () => this.setTool("delete"));
    t("#edTool-rename", () => this.setTool("rename"));
    t("#edUndo", () => this.undo());
    t("#edRedo", () => this.redo());
    t("#edSave", () => this.save());
    t("#edHistory", () => this.openHistory());
    t("#edRevert", () => this.revert());
    t("#edExit", () => this.exit());

  }

  // --- Enter / exit ----------------------------------------------------------

  enter(file, kind) {
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
    this.year = this.routeManager.year;

    this.infoManager.setEnabled(false);
    this.routeManager.hideRouteForEdit(file, this.kind);

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

  exit() {
    if (!this.active) return;
    this._removeInteractions();
    if (this.layer) {
      this.map.removeLayer(this.layer);
    }
    this.routeManager.showRouteAfterEdit(this.file, this.kind);
    this.infoManager.setEnabled(true);
    this._showToolbar(false);
    this.active = false;
    this.file = null;
    this.source = null;
    this.layer = null;
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
        const ext = this.source.getExtent();
        if (ext && isFinite(ext[0])) {
          this.map.getView().fit(ext, { padding: [60, 60, 60, 60], maxZoom: 17, duration: 400 });
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
        stops.push({ name: f.get("name") || "", lon: round7(ll[0]), lat: round7(ll[1]) });
      }
    });
    return { segments, stops };
  }

  // --- Tools / interactions --------------------------------------------------

  _addInteractions() {
    this.modify = new ol.interaction.Modify({ source: this.source });
    this.modify.on("modifyend", () => this._snapshot());

    this.draw = new ol.interaction.Draw({ source: this.source, type: "Point" });
    this.draw.on("drawend", (e) => {
      const f = e.feature;
      f.set("kind", "stop");
      const name = window.prompt("Stop name:", "");
      f.set("name", name == null ? "" : name);
      // snapshot after the feature is committed to the source
      setTimeout(() => this._snapshot(), 0);
    });

    this.snap = new ol.interaction.Snap({ source: this.source }); // add last
    [this.modify, this.draw, this.snap].forEach((i) => this.map.addInteraction(i));

    // Rename/Delete act directly on the stop clicked — more reliable than a
    // Select interaction's select event, and a single click does the action.
    this._onClick = (e) => this._handleClick(e);
    this.map.on("singleclick", this._onClick);
  }

  _removeInteractions() {
    [this.modify, this.draw, this.snap].forEach((i) => {
      if (i) this.map.removeInteraction(i);
    });
    if (this._onClick) this.map.un("singleclick", this._onClick);
    this._onClick = null;
    this.modify = this.draw = this.snap = null;
  }

  setTool(tool) {
    // geojson routes are line-only
    if (this.kind === "geojson" && tool === "addstop") tool = "move";
    this.tool = tool;
    if (this.modify) this.modify.setActive(tool === "move");
    if (this.draw) this.draw.setActive(tool === "addstop");
    $(".ed-tool").removeClass("active");
    $(`#edTool-${tool}`).addClass("active");
  }

  /** In rename/delete tools, act on the stop under the click. */
  _handleClick(e) {
    if (!this.active) return;
    if (this.tool !== "rename" && this.tool !== "delete") return;
    let target = null;
    this.map.forEachFeatureAtPixel(
      e.pixel,
      (f) => {
        if (f.get("kind") === "stop") {
          target = f;
          return true; // stop at the first stop hit
        }
      },
      { hitTolerance: 6, layerFilter: (l) => l === this.layer }
    );
    if (!target) return;
    if (this.tool === "rename") {
      const name = window.prompt("Rename stop:", target.get("name") || "");
      if (name != null) {
        target.set("name", name);
        this.layer.changed();
        this._snapshot();
      }
    } else {
      this.source.removeFeature(target);
      this._snapshot();
    }
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
    this._suppressSnapshot = false;
    this._updateButtons();
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

  save() {
    const body = this._serialize();
    if (!body.segments.length) {
      alert("Cannot save an empty route (needs at least one line).");
      return;
    }
    fetch(`/data/edit/${encodeURIComponent(this.file)}${this._yq()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error || "save failed");
        this.routeManager.reloadRoute(this.file, this.kind);
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
        this.routeManager.reloadRoute(this.file, this.kind);
        this._flash(`Restored as v${j.version}`);
      })
      .catch((err) => APP.MapUtils.handleError(err, "Restoring version"));
  }

  revert() {
    if (!confirm("Revert to the original route? This deletes all saved edits for it.")) {
      return;
    }
    fetch(`/data/edit/${encodeURIComponent(this.file)}${this._yq()}`, { method: "DELETE" })
      .then((r) => r.json())
      .then(() => {
        const file = this.file;
        const kind = this.kind;
        this.exit();
        this.routeManager.reloadRoute(file, kind);
      })
      .catch((err) => APP.MapUtils.handleError(err, "Reverting"));
  }

  // --- UI helpers ------------------------------------------------------------

  _showToolbar(show) {
    const bar = $("#editorToolbar");
    if (show) {
      $("#edRouteName").text(this.file.replace(/\.(kml|geojson)$/, ""));
      // hide stop tools for geojson (line-only)
      $("#edTool-addstop, #edTool-delete, #edTool-rename").toggle(this.kind !== "geojson");
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
