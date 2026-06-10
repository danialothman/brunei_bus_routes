// The GTFS pane on the /gtfs page. Edits one route at a time — whichever the
// page has selected (GtfsPage.setRoute drives it). Per route: schedule
// (headway / window / days), exact departures transcribed from the JPD timing
// signboard shown alongside, run time, names, color — saved to /data/gtfs-meta
// and merged into the /data/gtfs.zip export. Feed-wide agency + flat fare live
// in the Feed settings modal (/data/gtfs-config); ⬇ Download grabs the zip.
window.APP = window.APP || {};

APP.GtfsEditorManager = class {
  constructor() {
    this.zoom = 1;
    this.current = null; // { year, file, label, isUser }
    this.page = null; // GtfsPage backref (map focus, layer reload, editor state)
    this.geom = null; // { segments, stops, name } of the selected route
    this._saveTimer = null;
    this._feedTimer = null;
    this._stopsTimer = null;
    this._populating = false; // suppress autosave while filling the form
  }

  init() {
    this.timingSelect = $("#gtfsTimingSelect");
    this.timingImg = document.getElementById("gtfsTimingImg");
    this.timingEmpty = document.getElementById("gtfsTimingEmpty");
    this.routeLabel = document.getElementById("gepRouteLabel");
    this.status = document.getElementById("gepStatus");
    this.feedStatus = document.getElementById("gepFeedStatus");
    this.stopsStatus = document.getElementById("gepStopsStatus");
    this._bind();
    this._setFormEnabled(false);
    this._loadTimings();
    this._loadFeedConfig();
  }

  // --- Selected route ----------------------------------------------------------

  /** Load a route into the pane (called by GtfsPage on selection). */
  setRoute(year, file, label, kind, isUser) {
    // Flush pending saves for the route we're leaving.
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this._saveMeta();
    }
    this._flushStopsSave();
    this.year = year; // for downloads, even when no schedulable route is current
    if (kind === "geojson") {
      // Path tracings have no stops, so they can't be scheduled or exported
      // directly. Editing copies them to a KML route where stops can be added.
      this.current = null;
      this.geom = null;
      this.routeLabel.textContent = label || file.replace(/\.geojson$/, "");
      this.status.classList.add("hint");
      this.status.textContent = "path only — ✎ Edit copies it, then add stops";
      this._fillForm({});
      this._setFormEnabled(false);
      this.timingSelect.val("");
      this._showTiming();
      this._renderStops();
      return;
    }
    this.current = {
      year,
      file,
      label: label || file.replace(/\.kml$/, ""),
      isUser: !!isUser,
    };
    this.routeLabel.textContent = this.current.label;
    this.status.classList.remove("hint");
    this.status.textContent = "Loading…";
    this._setFormEnabled(false);
    const q = `?year=${encodeURIComponent(year)}&route=${encodeURIComponent(file)}`;
    fetch(`/data/gtfs-meta${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (!this.current || this.current.file !== file || this.current.year !== year) {
          return; // stale response, selection moved on
        }
        this._fillForm(d.meta || {});
        this._setFormEnabled(true);
        this.status.textContent = "";
        this._matchTimingImage();
      })
      .catch((err) => {
        this.status.textContent = "Load failed";
        console.error("gtfs-meta load failed", err);
      });
    this._loadStops();
  }

  /** Re-fetch the stops after the map editor saved or exited (geometry may
   * have changed under us). */
  refreshStops() {
    if (this.current) this._loadStops();
  }

  /** Update the displayed name (e.g. after a rename in the editor). */
  setLabel(label) {
    if (!this.current) return;
    this.current.label = label;
    this.routeLabel.textContent = label;
  }

  clearRoute() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._stopsTimer) {
      clearTimeout(this._stopsTimer);
      this._stopsTimer = null;
    }
    this.current = null;
    this.geom = null;
    this.routeLabel.textContent = "—";
    this.status.textContent = "";
    this._fillForm({});
    this._setFormEnabled(false);
    this.timingSelect.val("");
    this._showTiming();
    this._renderStops();
  }

  // --- Stops list ----------------------------------------------------------------

  _loadStops() {
    const ctx = this.current;
    if (!ctx) return;
    this.geom = null;
    this._renderStops();
    this.stopsStatus.textContent = "Loading…";
    const q = `?year=${encodeURIComponent(ctx.year)}`;
    fetch(`/data/route-geometry/${encodeURIComponent(ctx.file)}${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (!this.current || this.current.file !== ctx.file || this.current.year !== ctx.year) {
          return; // stale
        }
        this.geom = {
          segments: d.segments || [],
          stops: d.stops || [],
          name: d.name || ctx.label,
        };
        this.stopsStatus.textContent = "";
        this._renderStops();
      })
      .catch((err) => {
        this.stopsStatus.textContent = "Load failed";
        console.error("route-geometry load failed", err);
      });
  }

  /** Stops are saved as a new geometry version, which only user routes
   * accept; the map editor being active also pauses list editing. */
  _stopsEditable() {
    return !!(
      this.current &&
      this.current.isUser &&
      this.geom &&
      !(this.page && this.page.editorManager.active)
    );
  }

  _renderStops() {
    const list = $("#gepStopsList").empty();
    const hint = $("#gepStopsHint");
    const count = $("#gepStopCount");
    const stops = (this.geom && this.geom.stops) || [];
    count.text(stops.length ? `· ${stops.length}` : "");
    if (!this.geom) {
      hint.hide();
      return;
    }
    if (!stops.length) {
      hint
        .text(
          this.current && this.current.isUser
            ? "No stops yet — ✎ Edit the route and use + Stop to place them."
            : "No stops on this route."
        )
        .show();
      return;
    }
    let note = "";
    if (this.page && this.page.editorManager.active) {
      note = "Map editor open — stop edits happen there until you exit.";
    } else if (this.current && !this.current.isUser) {
      note = "Official route — ✎ Edit copies it to make stops editable.";
    }
    hint.text(note).toggle(!!note);
    const editable = this._stopsEditable();
    stops.forEach((s, i) => {
      const row = $('<div class="gep-stop-row"></div>').attr("data-i", i);
      row.append(
        $('<button type="button" class="gep-stop-seq" title="Show on map"></button>').text(i + 1)
      );
      row.append(
        $('<input type="text" class="gep-stop-name" placeholder="(unnamed)" />')
          .val(s.name || "")
          .prop("disabled", !editable)
      );
      row.append(
        $('<input type="text" class="gep-stop-coord gep-stop-lat" title="Latitude" />')
          .val(s.lat.toFixed(6))
          .prop("disabled", !editable)
      );
      row.append(
        $('<input type="text" class="gep-stop-coord gep-stop-lon" title="Longitude" />')
          .val(s.lon.toFixed(6))
          .prop("disabled", !editable)
      );
      if (editable) {
        const tools = $('<span class="gep-stop-tools"></span>');
        tools.append($('<a class="gep-stop-up" title="Move earlier">↑</a>'));
        tools.append($('<a class="gep-stop-down" title="Move later">↓</a>'));
        tools.append($('<a class="gep-stop-del" title="Remove stop">✕</a>'));
        row.append(tools);
      }
      list.append(row);
    });
  }

  _stopAt(el) {
    const i = parseInt($(el).closest(".gep-stop-row").attr("data-i"), 10);
    const stops = (this.geom && this.geom.stops) || [];
    return i >= 0 && i < stops.length ? i : null;
  }

  _queueStopsSave() {
    if (!this._stopsEditable()) return;
    this.stopsStatus.textContent = "Saving…";
    if (this._stopsTimer) clearTimeout(this._stopsTimer);
    this._stopsTimer = setTimeout(() => {
      this._stopsTimer = null;
      this._saveStops();
    }, 800);
  }

  _flushStopsSave() {
    if (this._stopsTimer) {
      clearTimeout(this._stopsTimer);
      this._stopsTimer = null;
      this._saveStops();
    }
  }

  _saveStops() {
    if (!this.current || !this.geom) return;
    const ctx = this.current;
    fetch(`/data/edit/${encodeURIComponent(ctx.file)}?year=${encodeURIComponent(ctx.year)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segments: this.geom.segments,
        stops: this.geom.stops,
        name: this.geom.name,
        label: "Stop edits (GTFS pane)",
      }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!this.current || this.current.file !== ctx.file) return;
        this.stopsStatus.textContent = ok ? `Saved v${d.version} ✓` : d.error || "Save failed";
        if (ok && this.page) this.page.reloadRoute(ctx.year, ctx.file);
      })
      .catch((err) => {
        this.stopsStatus.textContent = "Save failed";
        console.error("stops save failed", err);
      });
  }

  _formInputs() {
    return $(
      "#gepHeadway, #gepStart, #gepEnd, #gepRun, #gepDepartures, " +
        "#gepShort, #gepLong, #gepColor, .gep-day"
    );
  }

  _setFormEnabled(on) {
    this._formInputs().prop("disabled", !on);
  }

  // --- Form <-> meta -------------------------------------------------------------

  _fillForm(meta) {
    this._populating = true;
    const sched = meta.schedule || {};
    $("#gepHeadway").val(sched.headway_secs ? Math.round(sched.headway_secs / 60) : "");
    $("#gepStart").val((sched.start_time || "").slice(0, 5));
    $("#gepEnd").val((sched.end_time || "").slice(0, 5));
    $("#gepRun").val(sched.run_secs ? Math.round(sched.run_secs / 60) : "");
    $("#gepDepartures").val(
      (sched.departures || []).map((t) => t.slice(0, 5)).join(", ")
    );
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
    const run = parseInt($("#gepRun").val(), 10);
    if (run > 0) sched.run_secs = run * 60;
    const deps = $("#gepDepartures")
      .val()
      .split(/[\s,;]+/)
      .filter(Boolean);
    if (deps.length) sched.departures = deps;
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

  // --- Feed-level settings (agency + fare modal) -----------------------------------

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

  // --- Timing signboard --------------------------------------------------------------

  _loadTimings() {
    return fetch("/data/timing-images")
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
      })
      .catch((err) => console.error("timing-images load failed", err));
  }

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

  // --- Download ------------------------------------------------------------------------

  _download() {
    this._flushStopsSave();
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
    const year = this.year || (this.current ? this.current.year : "");
    window.open(`/data/gtfs.zip${year ? "?year=" + encodeURIComponent(year) : ""}`);
  }

  // --- Events --------------------------------------------------------------------------

  _bind() {
    $("#gepDownload").on("click", () => this._download());
    this.timingSelect.on("change", () => this._showTiming());
    $("#gepZoomIn").on("click", () => this._setZoom(this.zoom * 1.25));
    $("#gepZoomOut").on("click", () => this._setZoom(this.zoom / 1.25));
    $("#gepFit").on("click", () => this._setZoom(1));
    $(
      "#gepHeadway, #gepStart, #gepEnd, #gepRun, #gepDepartures, " +
        "#gepShort, #gepLong, #gepColor"
    ).on("input change", () => this._queueSave());
    $(".gep-day").on("change", () => this._queueSave());
    $(
      "#gepAgencyName, #gepAgencyUrl, #gepAgencyPhone, #gepAgencyEmail, " +
        "#gepFarePrice, #gepFareCurrency"
    ).on("input change", () => this._queueFeedSave());

    // Stops list (rows are rebuilt per route, so delegate).
    const stopsList = $("#gepStopsList");
    stopsList.on("click", ".gep-stop-seq", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i != null && this.page) {
        const s = this.geom.stops[i];
        this.page.focusStop(s.lon, s.lat);
      }
    });
    stopsList.on("input", ".gep-stop-name", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      this.geom.stops[i].name = e.currentTarget.value;
      this._queueStopsSave();
    });
    stopsList.on("change", ".gep-stop-coord", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      const v = parseFloat(e.currentTarget.value);
      const isLat = $(e.currentTarget).hasClass("gep-stop-lat");
      const ok = isFinite(v) && (isLat ? Math.abs(v) <= 90 : Math.abs(v) <= 180);
      const s = this.geom.stops[i];
      if (!ok) {
        e.currentTarget.value = (isLat ? s.lat : s.lon).toFixed(6); // revert
        return;
      }
      if (isLat) s.lat = v;
      else s.lon = v;
      this._queueStopsSave();
    });
    stopsList.on("click", ".gep-stop-up, .gep-stop-down", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      const j = $(e.currentTarget).hasClass("gep-stop-up") ? i - 1 : i + 1;
      const stops = this.geom.stops;
      if (j < 0 || j >= stops.length) return;
      [stops[i], stops[j]] = [stops[j], stops[i]];
      this._renderStops();
      this._queueStopsSave();
    });
    stopsList.on("click", ".gep-stop-del", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      this.geom.stops.splice(i, 1);
      this._renderStops();
      this._queueStopsSave();
    });
  }
};
