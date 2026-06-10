// Floating GTFS editor panel. Per route: schedule (headway / service window /
// operating days), short & long name, color — saved to /data/gtfs-meta and
// merged into the /data/gtfs.zip export. Feed-wide: agency details and flat
// fare via /data/gtfs-config. The official JPD timing signboard for the route
// (docs/<year>/images/timings/) is shown alongside so real times can be
// transcribed. Drag/resize/autosave follow the StopImageManager patterns.
window.APP = window.APP || {};

APP.GtfsEditorManager = class {
  constructor() {
    this.zoom = 1;
    this.loaded = false;
    this.current = null; // { year, file } of the route being edited
    this._saveTimer = null;
    this._feedTimer = null;
    this._populating = false; // suppress autosave while filling the form
  }

  init() {
    this.panel = document.getElementById("gtfsPanel");
    this.routeSelect = $("#gtfsRouteSelect");
    this.timingSelect = $("#gtfsTimingSelect");
    this.timingImg = document.getElementById("gtfsTimingImg");
    this.timingEmpty = document.getElementById("gtfsTimingEmpty");
    this.routeLabel = document.getElementById("gepRouteLabel");
    this.status = document.getElementById("gepStatus");
    this.feedStatus = document.getElementById("gepFeedStatus");
    this._bind();
  }

  // --- Data ----------------------------------------------------------------

  _load() {
    if (this.loaded) return Promise.resolve();
    const routes = fetch("/data/catalog")
      .then((r) => r.json())
      .then((d) => {
        this.routeSelect.empty();
        (d.years || []).forEach((y) => {
          // Only KML routes carry stops, so only they appear in the feed.
          const files = ((d[y] && d[y].routes) || []).filter(
            (f) => !/^points\s*-/i.test(f)
          );
          if (!files.length) return;
          const names = (d[y] && d[y].names) || {};
          const group = $("<optgroup>").attr("label", `${y} routes`);
          files.forEach((f) => {
            const stem = f.replace(/\.[^.]+$/, "");
            $("<option>")
              .val(f)
              .attr("data-year", y)
              .text(names[f] || stem)
              .appendTo(group);
          });
          this.routeSelect.append(group);
        });
      });
    const timings = fetch("/data/timing-images")
      .then((r) => r.json())
      .then((d) => {
        this.timingSelect.empty();
        this.timingSelect.append($("<option>").val("").text("— signboard —"));
        (d.years || []).forEach((y) => {
          const group = $("<optgroup>").attr("label", `${y} timings`);
          (d.images[y] || []).forEach((im) => {
            $("<option>")
              .val(im.file)
              .attr("data-year", y)
              .attr("data-route", im.route)
              .text(im.route + " — " + im.file.replace(/\.[^.]+$/, ""))
              .appendTo(group);
          });
          this.timingSelect.append(group);
        });
      });
    const config = this._loadFeedConfig();
    return Promise.all([routes, timings, config])
      .then(() => {
        this.loaded = true;
      })
      .catch((err) => {
        if (APP.MapUtils) APP.MapUtils.handleError(err, "Loading GTFS editor");
        console.error("gtfs editor load failed", err);
      });
  }

  // --- Show / hide -----------------------------------------------------------

  toggle() {
    if (this.panel.style.display === "none" || !this.panel.style.display) {
      this.show();
    } else {
      this.hide();
    }
  }

  show() {
    this._load().then(() => {
      this.panel.style.display = "flex";
      if (!this.routeSelect.val() && this.routeSelect.find("option").length) {
        this.routeSelect.prop("selectedIndex", 0);
      }
      this._showSelected();
    });
  }

  hide() {
    this._flushSaves();
    this.panel.style.display = "none";
  }

  _flushSaves() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveMeta();
    }
    if (this._feedTimer) {
      clearTimeout(this._feedTimer);
      this._feedTimer = null;
      this._saveFeedConfig();
    }
  }

  // --- Route selection -------------------------------------------------------

  _showSelected() {
    const opt = this.routeSelect.find("option:selected");
    const year = opt.attr("data-year");
    const file = opt.val();
    if (!year || !file) {
      this.current = null;
      this.routeLabel.textContent = "—";
      return;
    }
    // Flush a pending save for the route we're leaving.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveMeta();
    }
    this.current = { year, file };
    this.routeLabel.textContent = `${opt.text()} (${year})`;
    this.status.textContent = "Loading…";
    const q = `?year=${encodeURIComponent(year)}&route=${encodeURIComponent(file)}`;
    fetch(`/data/gtfs-meta${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (!this.current || this.current.file !== file || this.current.year !== year) {
          return; // stale response, selection moved on
        }
        this._fillForm(d.meta || {});
        this.status.textContent = "";
        this._matchTimingImage();
      })
      .catch((err) => {
        this.status.textContent = "Load failed";
        console.error("gtfs-meta load failed", err);
      });
  }

  _fillForm(meta) {
    this._populating = true;
    const sched = meta.schedule || {};
    $("#gepHeadway").val(sched.headway_secs ? Math.round(sched.headway_secs / 60) : "");
    $("#gepStart").val((sched.start_time || "").slice(0, 5));
    $("#gepEnd").val((sched.end_time || "").slice(0, 5));
    const days = sched.days || [1, 1, 1, 1, 1, 1, 1];
    $(".gep-day").each((i, el) => {
      el.checked = !!days[i];
    });
    $("#gepShort").val(meta.short_name || "");
    $("#gepLong").val(meta.long_name || "");
    $("#gepColor").val(meta.color ? "#" + meta.color : "");
    this._populating = false;
  }

  _readForm() {
    const meta = {};
    const sched = {};
    const headway = parseInt($("#gepHeadway").val(), 10);
    if (headway > 0) sched.headway_secs = headway * 60;
    if ($("#gepStart").val()) sched.start_time = $("#gepStart").val();
    if ($("#gepEnd").val()) sched.end_time = $("#gepEnd").val();
    const days = $(".gep-day").map((_, el) => (el.checked ? 1 : 0)).get();
    if (days.some((d) => !d)) sched.days = days; // only save non-default patterns
    if (Object.keys(sched).length) meta.schedule = sched;
    if ($("#gepShort").val().trim()) meta.short_name = $("#gepShort").val().trim();
    if ($("#gepLong").val().trim()) meta.long_name = $("#gepLong").val().trim();
    const color = $("#gepColor").val().trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(color)) meta.color = color.replace("#", "");
    return meta;
  }

  _queueSave() {
    if (!this.current || this._populating) return;
    this.status.textContent = "Saving…";
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveMeta();
    }, 600);
  }

  _saveMeta() {
    if (!this.current) return;
    const ctx = this.current;
    fetch("/data/gtfs-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: ctx.year, route: ctx.file, meta: this._readForm() }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (this.current && this.current.file === ctx.file) {
          this.status.textContent = ok ? "Saved ✓" : d.error || "Save failed";
        }
      })
      .catch((err) => {
        this.status.textContent = "Save failed";
        console.error("gtfs-meta save failed", err);
      });
  }

  // --- Feed-level settings (agency + fare) ------------------------------------

  _loadFeedConfig() {
    return fetch("/data/gtfs-config")
      .then((r) => r.json())
      .then((d) => {
        const c = d.config || {};
        const def = d.defaults || {};
        const agency = c.agency || {};
        const defAgency = def.agency || {};
        this._populating = true;
        $("#gepAgencyName").val(agency.name || "").attr("placeholder", defAgency.name || "");
        $("#gepAgencyUrl").val(agency.url || "").attr("placeholder", defAgency.url || "");
        $("#gepAgencyPhone").val(agency.phone || "").attr("placeholder", defAgency.phone || "");
        $("#gepAgencyEmail").val(agency.email || "");
        const fare = c.fare || {};
        $("#gepFarePrice").val(fare.price != null ? fare.price : "");
        $("#gepFareCurrency").val(fare.currency || "");
        if (def.headway_secs) {
          $("#gepHeadway").attr("placeholder", Math.round(def.headway_secs / 60));
        }
        this._populating = false;
      });
  }

  _queueFeedSave() {
    if (this._populating) return;
    this.feedStatus.textContent = "Saving…";
    if (this._feedTimer) clearTimeout(this._feedTimer);
    this._feedTimer = setTimeout(() => {
      this._feedTimer = null;
      this._saveFeedConfig();
    }, 600);
  }

  _saveFeedConfig() {
    const config = {};
    const agency = {};
    if ($("#gepAgencyName").val().trim()) agency.name = $("#gepAgencyName").val().trim();
    if ($("#gepAgencyUrl").val().trim()) agency.url = $("#gepAgencyUrl").val().trim();
    if ($("#gepAgencyPhone").val().trim()) agency.phone = $("#gepAgencyPhone").val().trim();
    if ($("#gepAgencyEmail").val().trim()) agency.email = $("#gepAgencyEmail").val().trim();
    if (Object.keys(agency).length) config.agency = agency;
    const fare = {};
    if ($("#gepFarePrice").val() !== "") fare.price = parseFloat($("#gepFarePrice").val());
    if ($("#gepFareCurrency").val().trim()) fare.currency = $("#gepFareCurrency").val().trim();
    if (Object.keys(fare).length) config.fare = fare;
    // The feed config applies to the export year — use the selected route's
    // year (the default year when nothing is selected).
    const year = this.current ? this.current.year : undefined;
    fetch("/data/gtfs-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year, config }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        this.feedStatus.textContent = ok ? "Saved ✓" : d.error || "Save failed";
      })
      .catch((err) => {
        this.feedStatus.textContent = "Save failed";
        console.error("gtfs-config save failed", err);
      });
  }

  // --- Timing signboard --------------------------------------------------------

  /** Auto-select the signboard whose route code matches the edited route
   * (saved short_name first, else trailing code in the filename stem). */
  _matchTimingImage() {
    if (!this.current) return;
    const stem = this.current.file.replace(/\.[^.]+$/, "");
    const m = stem.match(/(\d+[A-Za-z]?)\s*$/);
    const codes = [$("#gepShort").val().trim(), m ? m[1] : ""].filter(Boolean);
    let found = null;
    for (const code of codes) {
      const opt = this.timingSelect
        .find("option")
        .filter((_, o) => $(o).attr("data-route") === code)
        .first();
      if (opt.length) {
        found = opt;
        break;
      }
    }
    this.timingSelect.val(found ? found.val() : "");
    this._showTiming();
  }

  _showTiming() {
    const opt = this.timingSelect.find("option:selected");
    const year = opt.attr("data-year");
    const file = opt.val();
    if (!year || !file) {
      this.timingImg.style.display = "none";
      this.timingEmpty.style.display = "";
      return;
    }
    this.timingEmpty.style.display = "none";
    this.timingImg.style.display = "";
    this.timingImg.src =
      "/data/timing-image/" +
      encodeURIComponent(year) +
      "/" +
      encodeURIComponent(file);
    this._setZoom(1);
  }

  _setZoom(z) {
    this.zoom = Math.min(6, Math.max(0.3, z));
    this.timingImg.style.width = this.zoom * 100 + "%";
  }

  // --- Download -----------------------------------------------------------------

  _download() {
    this._flushSaves();
    const year = this.current ? this.current.year : "";
    window.open(`/data/gtfs.zip${year ? "?year=" + encodeURIComponent(year) : ""}`);
  }

  // --- Events --------------------------------------------------------------------

  _bind() {
    $("#gtfsEditorToggle").on("click", () => this.toggle());
    $("#gepClose").on("click", () => this.hide());
    $("#gepDownload").on("click", () => this._download());
    this.routeSelect.on("change", () => this._showSelected());
    this.timingSelect.on("change", () => this._showTiming());
    $("#gepZoomIn").on("click", () => this._setZoom(this.zoom * 1.25));
    $("#gepZoomOut").on("click", () => this._setZoom(this.zoom / 1.25));
    $("#gepFit").on("click", () => this._setZoom(1));
    $("#gepHeadway, #gepStart, #gepEnd, #gepShort, #gepLong, #gepColor").on(
      "input change",
      () => this._queueSave()
    );
    $(".gep-day").on("change", () => this._queueSave());
    $(
      "#gepAgencyName, #gepAgencyUrl, #gepAgencyPhone, #gepAgencyEmail, " +
        "#gepFarePrice, #gepFareCurrency"
    ).on("input change", () => this._queueFeedSave());
    this._enableDrag();
    this._enableResize();
  }

  _enableDrag() {
    const header = document.getElementById("gtfsHeader");
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
      if (e.target.closest("button, select, input")) return;
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
    const handle = document.getElementById("gtfsResize");
    let sx, sy, sw, sh, resizing = false;
    const onMove = (e) => {
      if (!resizing) return;
      this.panel.style.width = Math.max(280, sw + (e.clientX - sx)) + "px";
      this.panel.style.height = Math.max(260, sh + (e.clientY - sy)) + "px";
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
