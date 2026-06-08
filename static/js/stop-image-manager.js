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
    if (!year || !file) {
      this.img.style.display = "none";
      this.empty.style.display = "";
      this.empty.textContent = "No signboard selected.";
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
    this._enableDrag();
    this._enableResize();
  }

  _enableDrag() {
    const header = document.getElementById("stopImageHeader");
    let sx, sy, sl, st, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      this.panel.style.left = sl + (e.clientX - sx) + "px";
      this.panel.style.top = st + (e.clientY - sy) + "px";
      this.panel.style.right = "auto";
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    header.addEventListener("mousedown", (e) => {
      // Don't start a drag when interacting with the header controls.
      if (e.target.closest("button, select")) return;
      const r = this.panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      this.panel.style.left = r.left + "px";
      this.panel.style.top = r.top + "px";
      this.panel.style.right = "auto";
      dragging = true;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }

  _enableResize() {
    const handle = document.getElementById("stopImageResize");
    let sx, sy, sw, sh, resizing = false;
    const onMove = (e) => {
      if (!resizing) return;
      this.panel.style.width = Math.max(220, sw + (e.clientX - sx)) + "px";
      this.panel.style.height = Math.max(200, sh + (e.clientY - sy)) + "px";
    };
    const onUp = () => {
      resizing = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    handle.addEventListener("mousedown", (e) => {
      const r = this.panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
      resizing = true;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
      e.stopPropagation();
    });
  }
};
