// Floating reference panel for the official JPD stop-list signboards
// (docs/<year>/images/stops/, served via /data/stop-image/...). It lets you keep
// the official signboard on screen while you create a route, draw its line and
// place stops on the map. Draggable by its header, resizable from the corner,
// and zoomable. The "+ Route" button hands off to EditorManager.createNew().
window.APP = window.APP || {};

APP.StopImageManager = class {
  /** @param {APP.EditorManager} editorManager */
  constructor(editorManager) {
    this.editorManager = editorManager;
    this.zoom = 1;
    this.loaded = false;
  }

  init() {
    this.panel = document.getElementById("stopImagePanel");
    this.img = document.getElementById("stopImageImg");
    this.empty = document.getElementById("stopImageEmpty");
    this.select = $("#stopImageSelect");
    this.notes = document.getElementById("stopImageNotesText");
    this.notesRoute = document.getElementById("stopImageNotesRoute");
    this.notesStatus = document.getElementById("stopImageNotesStatus");
    this.current = null; // { year, route }
    this._saveTimer = null;
    this._bind();
  }

  // --- Data --------------------------------------------------------------

  _load() {
    if (this.loaded) return Promise.resolve();
    return fetch("/data/stop-images")
      .then((r) => r.json())
      .then((d) => {
        this.select.empty();
        (d.years || []).forEach((y) => {
          const group = $("<optgroup>").attr("label", `${y} signboards`);
          (d.images[y] || []).forEach((im) => {
            $("<option>")
              .val(im.file)
              .attr("data-year", y)
              .text(im.route)
              .appendTo(group);
          });
          this.select.append(group);
        });
        this.loaded = true;
      })
      .catch((err) => {
        if (APP.MapUtils) APP.MapUtils.handleError(err, "Loading stop images");
        console.error("stop-images load failed", err);
      });
  }

  // --- Show / hide -------------------------------------------------------

  toggle() {
    if (this.panel.style.display === "none" || !this.panel.style.display) {
      this.show();
    } else {
      this.hide();
    }
  }

  /** @param {string} [routeHint] route number to preselect (e.g. "20"). */
  show(routeHint) {
    this._load().then(() => {
      this.panel.style.display = "flex";
      if (routeHint) this.selectByRoute(routeHint);
      if (!this.select.val() && this.select.find("option").length) {
        this.select.prop("selectedIndex", 0);
      }
      this._showSelected();
    });
  }

  hide() {
    // Persist any unsaved note before closing.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveNote();
    }
    this.panel.style.display = "none";
  }

  /** Preselect the first signboard whose route label matches (newest year wins,
   * since years are listed newest-first). */
  selectByRoute(route) {
    const opt = this.select
      .find("option")
      .filter((_, o) => o.text === route)
      .first();
    if (opt.length) this.select.val(opt.val());
  }

  _showSelected() {
    const opt = this.select.find("option:selected");
    const year = opt.attr("data-year");
    const file = opt.val();
    const route = opt.text();
    if (!year || !file) {
      this.img.style.display = "none";
      this.empty.style.display = "";
      this.empty.textContent = "No signboard selected.";
      this._loadNote(null);
      return;
    }
    this.empty.style.display = "none";
    this.img.style.display = "";
    this.img.src =
      "/data/stop-image/" +
      encodeURIComponent(year) +
      "/" +
      encodeURIComponent(file);
    this._setZoom(1); // fit to width on each new image
    this._loadNote({ year, route });
  }

  // --- Per-route notes ---------------------------------------------------

  _loadNote(ctx) {
    // Flush any pending save for the route we're leaving before switching.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveNote();
    }
    this.current = ctx;
    if (!ctx) {
      this.notes.value = "";
      this.notes.disabled = true;
      this.notesRoute.textContent = "—";
      this.notesStatus.textContent = "";
      return;
    }
    this.notesRoute.textContent = `${ctx.route} (${ctx.year})`;
    this.notes.disabled = true;
    this.notesStatus.textContent = "Loading…";
    const q = `?year=${encodeURIComponent(ctx.year)}&route=${encodeURIComponent(ctx.route)}`;
    fetch(`/data/route-note${q}`)
      .then((r) => r.json())
      .then((d) => {
        // Ignore a stale response if the selection changed meanwhile.
        if (!this.current || this.current.route !== ctx.route || this.current.year !== ctx.year) {
          return;
        }
        this.notes.value = d.note || "";
        this.notes.disabled = false;
        this.notesStatus.textContent = "";
      })
      .catch((err) => {
        this.notesStatus.textContent = "Load failed";
        console.error("route-note load failed", err);
      });
  }

  _queueSave() {
    if (!this.current) return;
    this.notesStatus.textContent = "Saving…";
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNote();
    }, 600);
  }

  _saveNote() {
    if (!this.current) return;
    const ctx = this.current;
    fetch("/data/route-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: ctx.year, route: ctx.route, note: this.notes.value }),
    })
      .then((r) => r.json())
      .then(() => {
        if (this.current && this.current.route === ctx.route) {
          this.notesStatus.textContent = "Saved ✓";
        }
      })
      .catch((err) => {
        this.notesStatus.textContent = "Save failed";
        console.error("route-note save failed", err);
      });
  }

  // --- Zoom --------------------------------------------------------------

  _setZoom(z) {
    this.zoom = Math.min(6, Math.max(0.3, z));
    this.img.style.width = this.zoom * 100 + "%";
  }

  // --- Create route handoff ---------------------------------------------

  _createRoute() {
    if (!this.editorManager) return;
    const route = this.select.find("option:selected").text();
    // Keep the panel open so the signboard stays visible while drawing.
    this.editorManager.createNew(route || "");
  }

  // --- Events ------------------------------------------------------------

  _bind() {
    $("#stopImageToggle").on("click", () => this.toggle());
    $("#sipClose").on("click", () => this.hide());
    this.select.on("change", () => this._showSelected());
    $("#sipZoomIn").on("click", () => this._setZoom(this.zoom * 1.25));
    $("#sipZoomOut").on("click", () => this._setZoom(this.zoom / 1.25));
    $("#sipFit").on("click", () => this._setZoom(1));
    $("#sipCreate").on("click", () => this._createRoute());
    $(this.notes).on("input", () => this._queueSave());
    APP.MapUtils.makeFloatingPanel(
      this.panel,
      document.getElementById("stopImageHeader"),
      document.getElementById("stopImageResize")
    );
  }
};
