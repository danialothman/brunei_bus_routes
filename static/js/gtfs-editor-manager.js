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
    this._timingDismissed = false; // user closed the timing panel this session
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

  // --- Live mode: mirror the map editor's working stops ---------------------------
  // While the editor is open, the list reflects its in-session features as they
  // are dragged/placed/renamed, and list edits write back into those features.
  // Nothing touches the server until the toolbar Save — exiting without saving
  // discards both map and list changes together.

  enterLive() {
    const em = this.page && this.page.editorManager;
    if (!em || !em.active || !em.source) {
      this._renderStops();
      return;
    }
    if (this._liveSource === em.source) {
      this._renderStops(); // re-entered after an editor Save — just refresh
      return;
    }
    this._flushStopsSave(); // pending non-live autosave from before
    this._liveSource = em.source;
    this._squelch = false;
    this._onLiveCoord = (e) => this._updateLiveRow(e.feature);
    this._onLiveStruct = () => {
      if (this._squelch) return;
      // Coalesce bursts (loads, undo/redo rebuilds); never steal typing focus.
      clearTimeout(this._liveRenderTimer);
      this._liveRenderTimer = setTimeout(() => {
        if (!$("#gepStopsList").find(":focus").length) this._renderStops();
      }, 200);
    };
    this._liveSource.on("changefeature", this._onLiveCoord);
    this._liveSource.on("addfeature", this._onLiveStruct);
    this._liveSource.on("removefeature", this._onLiveStruct);
    this._liveSource.on("clear", this._onLiveStruct);
    this._renderStops();
  }

  exitLive() {
    if (this._liveSource) {
      this._liveSource.un("changefeature", this._onLiveCoord);
      this._liveSource.un("addfeature", this._onLiveStruct);
      this._liveSource.un("removefeature", this._onLiveStruct);
      this._liveSource.un("clear", this._onLiveStruct);
      this._liveSource = null;
      clearTimeout(this._liveRenderTimer);
    }
    this.refreshStops(); // back to the last saved version
  }

  _liveStopFeatures() {
    if (!this._liveSource) return [];
    return this._liveSource.getFeatures().filter((f) => f.get("kind") === "stop");
  }

  /** Update one row's inputs in place during a drag (no re-render, no focus loss). */
  _updateLiveRow(feature) {
    if (feature.get("kind") !== "stop") return;
    const i = this._liveStopFeatures().indexOf(feature);
    if (i < 0) return;
    const row = $("#gepStopsList .gep-stop-row").eq(i);
    if (!row.length) return;
    const ll = APP.MapUtils.toNormal(feature.getGeometry().getCoordinates());
    const set = (sel, val) => {
      const el = row.find(sel)[0];
      if (el && document.activeElement !== el) el.value = val;
    };
    set(".gep-stop-lat", ll[1].toFixed(6));
    set(".gep-stop-lon", ll[0].toFixed(6));
    set(".gep-stop-name", feature.get("name") || "");
    set(".gep-stop-code", feature.get("code") || "");
  }

  /** Map → list: flash and scroll to the row of a stop clicked in the editor
   * (the counterpart of the row's ① chip, which pans the map to the stop). */
  highlightStopFeature(feature) {
    const i = this._liveStopFeatures().indexOf(feature);
    if (i < 0) return;
    const rows = $("#gepStopsList .gep-stop-row");
    rows.removeClass("flash");
    const row = rows.eq(i);
    if (!row.length) return;
    row[0].scrollIntoView({ block: "nearest" });
    // Force a reflow so re-clicking the same stop restarts the fade.
    void row[0].offsetWidth;
    row.addClass("flash");
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => row.removeClass("flash"), 1600);
  }

  /** Stops as plain data, from the live editor session or saved geometry. */
  _stopsData() {
    if (this._liveSource) {
      return this._liveStopFeatures().map((f) => {
        const ll = APP.MapUtils.toNormal(f.getGeometry().getCoordinates());
        return {
          name: f.get("name") || "",
          code: f.get("code") || "",
          lon: ll[0],
          lat: ll[1],
        };
      });
    }
    return (this.geom && this.geom.stops) || [];
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

  /** Outside live mode, list edits save as a new geometry version, which only
   * user routes accept. In live mode the editor session is always editable. */
  _stopsEditable() {
    if (this._liveSource) return true;
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
    const live = !!this._liveSource;
    const stops = this._stopsData();
    count.text(stops.length ? `· ${stops.length}` : "");
    if (!live && !this.geom) {
      hint.hide();
      return;
    }
    if (!stops.length) {
      hint
        .text(
          live
            ? "No stops yet — use + Stop on the map; they appear here live."
            : this.current && this.current.isUser
              ? "No stops yet — ✎ Edit the route and use + Stop to place them."
              : "No stops on this route."
        )
        .show();
      return;
    }
    let note = "";
    if (live) {
      note = "● live with the map editor — Save in the toolbar to keep changes";
    } else if (this.page && this.page.editorManager.active) {
      note = "Map editor open on another route.";
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
        $('<input type="text" class="gep-stop-code" placeholder="code" title="Public stop number (GTFS stop_code)" />')
          .val(s.code || "")
          .prop("disabled", !editable)
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
    const n = this._liveSource
      ? this._liveStopFeatures().length
      : ((this.geom && this.geom.stops) || []).length;
    return i >= 0 && i < n ? i : null;
  }

  /** Reorder the editor session's stop features (order = stop_sequence). */
  _liveReorder(i, j) {
    const src = this._liveSource;
    const feats = this._liveStopFeatures();
    if (j < 0 || j >= feats.length) return;
    [feats[i], feats[j]] = [feats[j], feats[i]];
    this._squelch = true; // one render at the end, not one per remove/add
    feats.forEach((f) => src.removeFeature(f));
    feats.forEach((f) => src.addFeature(f));
    this._squelch = false;
    this.page.editorManager._snapshot();
    this._renderStops();
  }

  _queueStopsSave() {
    if (this._liveSource) return; // live edits persist via the editor's Save
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
      "#gepSchedList input, #gepSchedList textarea, #gepSchedAdd, " +
        "#gepShort, #gepLong, #gepColor, #gepOperator, #gepDirection, " +
        "#gepHeadsign, #gepReturnHeadsign, #gepDesc, #gepHail"
    );
  }

  _setFormEnabled(on) {
    this._formInputs().prop("disabled", !on);
  }

  // --- Form <-> meta -------------------------------------------------------------

  /** One day-type schedule block's form (weekday/weekend…). */
  _schedBlockEl(sched) {
    const block = $('<div class="gep-sched-block"></div>');
    const head = $('<div class="gep-sched-head"></div>');
    head.append($('<span class="gep-sched-title"></span>'));
    head.append($('<a class="gep-sched-del" title="Remove this schedule block">✕</a>'));
    block.append(head);
    const days = sched.days || [1, 1, 1, 1, 1, 1, 1];
    const daysRow = $('<div class="gep-row gep-days"></div>');
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach((d, i) => {
      const label = $("<label></label>").text(d);
      label.prepend(
        $('<input type="checkbox" class="gep-day" />').prop("checked", !!days[i])
      );
      daysRow.append(label);
    });
    block.append(daysRow);
    // Time-of-day frequency bands (peak/off-peak); legacy single-headway
    // schedules render as one band.
    const bandList = $('<div class="gep-band-list"></div>');
    const bands = sched.bands || [{
      headway_secs: sched.headway_secs,
      start_time: sched.start_time,
      end_time: sched.end_time,
    }];
    bands.forEach((b) => bandList.append(this._bandRow(b)));
    block.append(bandList);
    const foot = $('<div class="gep-row"></div>');
    foot.append(
      $('<a class="gep-band-add" title="Add a peak/off-peak headway window">+ time band</a>')
    );
    foot.append(
      $("<label>run </label>").append(
        $('<input type="number" class="gep-run" min="1" max="360" placeholder="auto" />')
          .val(sched.run_secs ? Math.round(sched.run_secs / 60) : "")
      ).append(" min")
    );
    block.append(foot);
    const depRow = $('<div class="gep-row"></div>');
    depRow.append(
      $('<label class="gep-block">Exact departures — when filled, real trips are exported instead of the headway estimate.</label>').append(
        $('<textarea class="gep-departures" rows="2" spellcheck="false" placeholder="06:30, 07:00, 07:45, …"></textarea>')
          .val((sched.departures || []).map((t) => t.slice(0, 5)).join(", "))
      )
    );
    block.append(depRow);
    // Return-direction departures: only meaningful for out & back routes
    // (visibility synced to the Type selector).
    const retRow = $('<div class="gep-row gep-return-deps" style="display:none"></div>');
    retRow.append(
      $('<label class="gep-block">Return departures — optional; derived from outbound + run time when empty.</label>').append(
        $('<textarea class="gep-ret-departures" rows="2" spellcheck="false" placeholder="07:30, 08:00, …"></textarea>')
          .val((sched.return_departures || []).map((t) => t.slice(0, 5)).join(", "))
      )
    );
    block.append(retRow);
    return block;
  }

  /** Show return-direction fields only for out & back routes. */
  _syncReturnUI() {
    const outback = $("#gepDirection").val() === "outback";
    $("#gepReturnWrap").toggle(outback);
    $("#gepSchedList .gep-return-deps").toggle(outback);
  }

  /** One time-of-day frequency window: "every N min, HH:MM–HH:MM". */
  _bandRow(band) {
    const row = $('<div class="gep-row gep-band"></div>');
    row.append(
      $("<label>Every </label>").append(
        $('<input type="number" class="gep-headway" min="1" max="1440" />')
          .attr("placeholder", this._defHeadwayMin || 30)
          .val(band.headway_secs ? Math.round(band.headway_secs / 60) : "")
      ).append(" min,")
    );
    row.append(
      $("<label>from </label>").append(
        $('<input type="time" class="gep-start" />').val((band.start_time || "").slice(0, 5))
      )
    );
    row.append(
      $("<label>to </label>").append(
        $('<input type="time" class="gep-end" />').val((band.end_time || "").slice(0, 5))
      )
    );
    row.append($('<a class="gep-band-del" title="Remove this time band">✕</a>'));
    return row;
  }

  _renderSched(blocks) {
    const list = $("#gepSchedList").empty();
    (blocks.length ? blocks : [{}]).forEach((b) => list.append(this._schedBlockEl(b)));
    this._renumberSched();
  }

  /** Title each block and only offer ✕ when there is more than one. */
  _renumberSched() {
    const rows = $("#gepSchedList .gep-sched-block");
    rows.each((i, el) => {
      $(el).find(".gep-sched-title").text(`Schedule ${i + 1}`);
    });
    $("#gepSchedList .gep-sched-head").toggle(rows.length > 1);
  }

  _fillForm(meta) {
    this._populating = true;
    this._renderSched(meta.schedules || (meta.schedule ? [meta.schedule] : []));
    $("#gepShort").val(meta.short_name || "");
    $("#gepLong").val(meta.long_name || "");
    $("#gepColor").val(meta.color ? "#" + meta.color : "");
    $("#gepDirection").val(meta.direction || "");
    $("#gepHeadsign").val(meta.headsign || "");
    $("#gepReturnHeadsign").val(meta.return_headsign || "");
    $("#gepDesc").val(meta.desc || "");
    $("#gepHail").prop("checked", !!meta.hail);
    this._syncReturnUI();
    // Remember the assignment so the dropdown survives option rebuilds
    // (operators may still be loading, or get edited in the modal).
    this._currentOperator = meta.agency_id || "";
    const op = $("#gepOperator");
    op.val(this._currentOperator);
    if (op.val() == null) op.val("");
    this._populating = false;
  }

  _readForm() {
    const meta = {};
    const blocks = [];
    $("#gepSchedList .gep-sched-block").each((_, el) => {
      const b = $(el);
      const sched = {};
      const bands = [];
      b.find(".gep-band").each((_, bel) => {
        const bb = $(bel);
        const band = {};
        const headway = parseInt(bb.find(".gep-headway").val(), 10);
        if (headway > 0) band.headway_secs = headway * 60;
        if (bb.find(".gep-start").val()) band.start_time = bb.find(".gep-start").val();
        if (bb.find(".gep-end").val()) band.end_time = bb.find(".gep-end").val();
        if (Object.keys(band).length) bands.push(band);
      });
      if (bands.length) sched.bands = bands;
      const run = parseInt(b.find(".gep-run").val(), 10);
      if (run > 0) sched.run_secs = run * 60;
      const deps = b.find(".gep-departures").val().split(/[\s,;]+/).filter(Boolean);
      if (deps.length) sched.departures = deps;
      const rdeps = b.find(".gep-ret-departures").val().split(/[\s,;]+/).filter(Boolean);
      if (rdeps.length && $("#gepDirection").val() === "outback") {
        sched.return_departures = rdeps;
      }
      const days = b.find(".gep-day").map((_, d) => (d.checked ? 1 : 0)).get();
      if (days.some((d) => !d)) sched.days = days; // only save non-default patterns
      if (Object.keys(sched).length) blocks.push(sched); // all-default blocks drop out
    });
    if (blocks.length) meta.schedules = blocks;
    if ($("#gepShort").val().trim()) meta.short_name = $("#gepShort").val().trim();
    if ($("#gepLong").val().trim()) meta.long_name = $("#gepLong").val().trim();
    const color = $("#gepColor").val().trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(color)) meta.color = color.replace("#", "");
    const operator = $("#gepOperator").val();
    if (operator) meta.agency_id = operator;
    this._currentOperator = operator || "";
    if ($("#gepDirection").val() === "outback") meta.direction = "outback";
    if ($("#gepHeadsign").val().trim()) meta.headsign = $("#gepHeadsign").val().trim();
    if ($("#gepReturnHeadsign").val().trim()) {
      meta.return_headsign = $("#gepReturnHeadsign").val().trim();
    }
    if ($("#gepDesc").val().trim()) meta.desc = $("#gepDesc").val().trim();
    if ($("#gepHail").prop("checked")) meta.hail = true;
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
    const meta = this._readForm();
    fetch("/data/gtfs-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: ctx.year, route: ctx.file, meta }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (this.current && this.current.file === ctx.file) {
          this.status.textContent = ok ? "Saved ✓" : d.error || "Save failed";
        }
        if (ok && this.page) {
          const blocks = meta.schedules || [];
          this.page.setRouteStatus(ctx.year, ctx.file, {
            schedule: blocks.length > 0,
            departures: blocks.some(
              (b) => (b.departures || []).length || (b.return_departures || []).length
            ),
            operator: !!meta.agency_id,
            headsign: !!meta.headsign,
          });
        }
      })
      .catch((err) => {
        this.status.textContent = "Save failed";
        console.error("gtfs-meta save failed", err);
      });
  }

  // --- Feed-level settings (operators + fare modal) ---------------------------------

  _loadFeedConfig() {
    return fetch("/data/gtfs-config")
      .then((r) => r.json())
      .then((d) => {
        const c = d.config || {};
        const def = d.defaults || {};
        this._populating = true;
        // Resolved operators = what the export will actually use (saved list,
        // or the built-in default). Keep the first as the deletion fallback.
        const agencies = d.agencies || [];
        this._defaultAgency = agencies[0] || { id: "ADBS", name: (def.agency || {}).name || "Default" };
        this._renderAgencyRows(agencies);
        this._updateOperatorOptions();
        const list = $("#gepHolidayList").empty();
        (c.holidays || []).forEach((h) => list.append(this._holidayRow(h)));
        const fare = c.fare || {};
        $("#gepFarePrice").val(fare.price != null ? fare.price : "");
        $("#gepFareCurrency").val(fare.currency || "");
        if (def.headway_secs) {
          this._defHeadwayMin = Math.round(def.headway_secs / 60);
          $("#gepSchedList .gep-headway").attr("placeholder", this._defHeadwayMin);
        }
        this._populating = false;
      });
  }

  _renderAgencyRows(agencies) {
    const list = $("#gepAgencyList").empty();
    agencies.forEach((a) => list.append(this._agencyRow(a)));
    if (!agencies.length) list.append(this._agencyRow({}));
  }

  _agencyRow(a) {
    const row = $('<div class="gep-agency-row"></div>').attr("data-id", a.id || "");
    row.append($('<input type="text" class="gep-agency-name" placeholder="Operator name" />').val(a.name || ""));
    row.append($('<input type="text" class="gep-agency-url" placeholder="https://…" />').val(a.url || ""));
    row.append($('<input type="text" class="gep-agency-phone" placeholder="+673 …" />').val(a.phone || ""));
    row.append($('<a class="gep-agency-del" title="Remove operator">✕</a>'));
    return row;
  }

  _holidayRow(h) {
    const row = $('<div class="gep-holiday-row"></div>');
    const v = h.date
      ? `${h.date.slice(0, 4)}-${h.date.slice(4, 6)}-${h.date.slice(6, 8)}`
      : "";
    row.append($('<input type="date" class="gep-holiday-date" />').val(v));
    row.append(
      $(
        '<select class="gep-holiday-mode">' +
          '<option value="none">no service</option>' +
          '<option value="sunday">Sunday timetable</option></select>'
      ).val(h.mode || "none")
    );
    row.append(
      $('<input type="text" class="gep-holiday-name" placeholder="name (optional)" />')
        .val(h.name || "")
    );
    row.append($('<a class="gep-holiday-del" title="Remove holiday">✕</a>'));
    return row;
  }

  _holidayData() {
    const out = [];
    $("#gepHolidayList .gep-holiday-row").each((_, el) => {
      const row = $(el);
      const date = (row.find(".gep-holiday-date").val() || "").replace(/-/g, "");
      if (!/^\d{8}$/.test(date)) return; // dateless rows are drafts
      const entry = { date, mode: row.find(".gep-holiday-mode").val() || "none" };
      const name = row.find(".gep-holiday-name").val().trim();
      if (name) entry.name = name;
      out.push(entry);
    });
    return out;
  }

  /** Operators as data, from the modal rows. Rows without an id get one
   * derived from the name (same slug rule as the server). With `pin` the id
   * is written onto the row, freezing it so route assignments stay stable
   * across later renames — pin only once typing has settled (save time),
   * never per keystroke. */
  _agencyData(pin) {
    const out = [];
    const seen = new Set();
    $("#gepAgencyList .gep-agency-row").each((_, el) => {
      const row = $(el);
      const name = row.find(".gep-agency-name").val().trim();
      if (!name) return;
      let id = row.attr("data-id");
      if (!id) {
        id = name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toUpperCase().slice(0, 30) || "OP";
        let unique = id;
        let n = 2;
        while (seen.has(unique)) unique = `${id}-${n++}`;
        id = unique;
        if (pin) row.attr("data-id", id);
      }
      if (seen.has(id)) return;
      seen.add(id);
      const entry = { id, name };
      const url = row.find(".gep-agency-url").val().trim();
      const phone = row.find(".gep-agency-phone").val().trim();
      if (url) entry.url = url;
      if (phone) entry.phone = phone;
      out.push(entry);
    });
    return out;
  }

  /** Rebuild the route pane's Operator dropdown from the modal rows,
   * preserving the selected route's assignment. */
  _updateOperatorOptions() {
    const select = $("#gepOperator");
    const agencies = this._agencyData();
    const first = agencies[0] || this._defaultAgency || { id: "", name: "default" };
    select.empty();
    select.append($("<option>").val("").text(`(default — ${first.name})`));
    agencies.forEach((a) => select.append($("<option>").val(a.id).text(a.name)));
    select.val(this._currentOperator || "");
    if (select.val() == null) select.val(""); // assignment to a removed operator
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
    const agencies = this._agencyData(true); // pin ids now that typing settled
    if (agencies.length) config.agencies = agencies;
    const holidays = this._holidayData();
    if (holidays.length) config.holidays = holidays;
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
        if (ok) this._updateOperatorOptions();
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
      // No signboard — an empty floating window is just clutter.
      this._setTimingPanelVisible(false);
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
    if (!this._timingDismissed) this._setTimingPanelVisible(true);
  }

  /** The timing panel floats over the map (see gtfs.html). Auto-shown when a
   * route has a signboard, auto-hidden when not; ✕ dismisses for the session
   * and the navbar 🕐 toggle brings it back. */
  _setTimingPanelVisible(show) {
    const panel = document.getElementById("timingPanel");
    if (!panel) return;
    // Phones: the panel would overlay everything — only the toggle opens it.
    if (show && window.matchMedia("(max-width: 820px)").matches) return;
    panel.style.display = show ? "flex" : "none";
  }

  _toggleTimingPanel() {
    const panel = document.getElementById("timingPanel");
    if (!panel) return;
    if (panel.style.display === "flex") {
      this._timingDismissed = true;
      panel.style.display = "none";
    } else {
      this._timingDismissed = false;
      panel.style.display = "flex"; // explicit open bypasses the phone guard
    }
  }

  _setZoom(z) {
    this.zoom = Math.min(6, Math.max(0.3, z));
    this.timingImg.style.width = this.zoom * 100 + "%";
  }

  // --- Download ------------------------------------------------------------------------

  /** Push any debounced route/feed saves now, so feed builds (download,
   * validate, preview) reflect what's on screen. */
  _flushPending() {
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
  }

  _download() {
    this._flushPending();
    const year = this.year || (this.current ? this.current.year : "");
    window.open(`/data/gtfs.zip${year ? "?year=" + encodeURIComponent(year) : ""}`);
  }

  // --- Validation ----------------------------------------------------------------------

  _validate() {
    this._flushPending();
    const year = this.year || "";
    $("#validateYear").text(year || "default");
    $("#validateSummary").attr("class", "gep-validate-summary").text("Validating…");
    $("#validateList").empty();
    $("#validateModal").modal("show");
    fetch(`/data/gtfs-validate${year ? "?year=" + encodeURIComponent(year) : ""}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          $("#validateSummary").addClass("err").text(d.error);
          return;
        }
        const s = d.stats || {};
        const summary = $("#validateSummary");
        summary
          .addClass(d.errors ? "err" : d.warnings ? "warn" : "ok")
          .text(
            `${d.errors} error${d.errors === 1 ? "" : "s"}, ` +
              `${d.warnings} warning${d.warnings === 1 ? "" : "s"} — ` +
              `${s.routes} routes, ${s.trips} trips, ${s.stops} stops, ` +
              `${Math.round(d.size / 1024)} KB` +
              (d.errors ? "" : " · feed is structurally sound")
          );
        const list = $("#validateList");
        (d.findings || []).forEach((f) => {
          const row = $('<div class="gep-validate-row"></div>');
          row.append(
            $('<span class="gep-validate-badge"></span>')
              .addClass(f.severity)
              .text(f.severity === "error" ? "ERROR" : "WARN")
          );
          const body = $('<span class="gep-validate-msg"></span>').text(
            `${f.message} (×${f.count})`
          );
          if (f.examples && f.examples.length) {
            body.append(
              $('<span class="gep-validate-ex"></span>').text(
                " — " + f.examples.join(", ") + (f.count > f.examples.length ? ", …" : "")
              )
            );
          }
          row.append(body);
          list.append(row);
        });
        if (!(d.findings || []).length) {
          list.append('<div class="gep-empty">No findings — all checks passed.</div>');
        }
      })
      .catch((err) => {
        $("#validateSummary").addClass("err").text("Validation request failed");
        console.error("gtfs-validate failed", err);
      });
  }

  // --- Feed preview --------------------------------------------------------------------
  // The actual files the export emits, rebuilt on demand so the transcriber can
  // watch routes.txt / stop_times.txt / … take shape as they fill in the forms.

  /** Where each GTFS file is shaped in-app. kind: "edit" = fully driven by a
   * form/map control, "partial" = some columns computed, "auto" = derived,
   * nothing to edit. Shown as a banner on the file's preview tab. */
  static FILE_SOURCES = {
    "agency.txt": { kind: "edit", where: "⚙ Feed settings → Operators" },
    "routes.txt": {
      kind: "edit",
      where: "Route pane — No., Name, Color, Description, Operator",
    },
    "stops.txt": {
      kind: "edit",
      where:
        "Map editor (✎ Edit route — add / move / rename stops) + stop codes in the Stops list",
    },
    "shapes.txt": {
      kind: "edit",
      where: "Map editor — the drawn route line is the shape",
    },
    "trips.txt": {
      kind: "edit",
      where: "Route pane — Headsign, Type (out & back), day-type schedule blocks",
    },
    "stop_times.txt": {
      kind: "partial",
      where:
        "Departure times & timepoint flags in schedule blocks; in-between stop times are computed by projecting stops along the route geometry",
    },
    "frequencies.txt": {
      kind: "edit",
      where: "Time-of-day frequency bands in the route's schedule blocks",
    },
    "calendar.txt": {
      kind: "edit",
      where: "Day-type schedule blocks (weekday / weekend / …)",
    },
    "calendar_dates.txt": { kind: "edit", where: "⚙ Feed settings → Holidays" },
    "fare_attributes.txt": { kind: "edit", where: "⚙ Feed settings → Fare" },
    "transfers.txt": {
      kind: "auto",
      where: "Auto-generated from stop proximity (walking-distance pairs)",
    },
    "feed_info.txt": {
      kind: "auto",
      where: "Auto-generated — version is stamped with the export date",
    },
  };

  _preview() {
    this._flushPending();
    const year = this.year || "";
    $("#previewYear").text(year || "default");
    $("#previewSummary").text("Building feed…");
    $("#previewModal").modal("show");
    fetch(`/data/gtfs-preview${year ? "?year=" + encodeURIComponent(year) : ""}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          $("#previewSummary").text(d.error);
          $("#previewTabs").empty();
          $("#previewMeta").empty();
          $("#previewTableWrap").empty();
          this._previewFiles = null;
          return;
        }
        this._previewFiles = d.files || [];
        const s = d.stats || {};
        $("#previewSummary").text(
          `${this._previewFiles.length} files · ${s.routes} routes, ` +
            `${s.trips} trips, ${s.stops} stops · ${Math.round(d.size / 1024)} KB`
        );
        const tabs = $("#previewTabs").empty();
        this._previewFiles.forEach((f) => {
          tabs.append(
            $('<button type="button" class="gep-preview-tab"></button>')
              .attr("data-file", f.name)
              .append($("<span></span>").text(f.name))
              .append(
                $('<span class="gep-preview-tab-count"></span>').text(f.total_rows)
              )
          );
        });
        // Keep the tab the user was on across refreshes, else start at the top.
        const current =
          this._previewFiles.find((f) => f.name === this._previewTab) ||
          this._previewFiles[0];
        this._showPreviewFile(current ? current.name : null);
      })
      .catch((err) => {
        $("#previewSummary").text("Preview request failed");
        console.error("gtfs-preview failed", err);
      });
  }

  _showPreviewFile(name) {
    this._previewTab = name;
    $("#previewTabs .gep-preview-tab").each((_, el) => {
      $(el).toggleClass("active", $(el).attr("data-file") === name);
    });
    this._renderPreviewTable();
  }

  _renderPreviewTable() {
    const f = (this._previewFiles || []).find((x) => x.name === this._previewTab);
    const wrap = $("#previewTableWrap").empty();
    const meta = $("#previewMeta").empty();
    const src = $("#previewSource").empty().attr("class", "gep-preview-source");
    if (!f) return;
    const info = APP.GtfsEditorManager.FILE_SOURCES[f.name];
    if (info) {
      const badge = { edit: "✎ editable", partial: "◐ partly editable", auto: "🔒 derived" };
      src
        .addClass(info.kind)
        .append($('<span class="gep-preview-source-badge"></span>').text(badge[info.kind]))
        .append($("<span></span>").text(info.where));
    }
    const q = ($("#previewFilter").val() || "").trim().toLowerCase();
    const rows = q
      ? f.rows.filter((r) => r.some((c) => c.toLowerCase().indexOf(q) >= 0))
      : f.rows;
    const bits = [`${f.total_rows} row${f.total_rows === 1 ? "" : "s"}`];
    if (f.truncated) bits.push(`showing first ${f.rows.length}`);
    if (q) bits.push(`${rows.length} match${rows.length === 1 ? "" : "es"}`);
    bits.push(`${(f.size / 1024).toFixed(1)} KB`);
    meta.text(`${f.name} — ${bits.join(" · ")}`);
    if (!rows.length) {
      wrap.append(
        $('<div class="gep-empty"></div>').text(
          q ? "No rows match the filter." : "No data rows."
        )
      );
      return;
    }
    const table = $('<table class="gep-preview-table"></table>');
    const thead = $("<thead></thead>").appendTo(table);
    const hr = $("<tr></tr>").appendTo(thead);
    f.header.forEach((h) => hr.append($("<th></th>").text(h)));
    const tbody = $("<tbody></tbody>").appendTo(table);
    rows.forEach((r) => {
      const tr = $("<tr></tr>");
      r.forEach((c) => tr.append($("<td></td>").text(c)));
      tbody.append(tr);
    });
    wrap.append(table);
  }

  // --- Events --------------------------------------------------------------------------

  _bind() {
    $("#gepDownload").on("click", () => this._download());
    $("#gepValidate").on("click", () => this._validate());
    $("#gepPreview").on("click", () => this._preview());
    $("#timingToggle").on("click", () => this._toggleTimingPanel());
    $("#timingClose").on("click", () => {
      this._timingDismissed = true;
      this._setTimingPanelVisible(false);
    });
    const timingPanel = document.getElementById("timingPanel");
    if (timingPanel) {
      APP.MapUtils.makeFloatingPanel(
        timingPanel,
        document.getElementById("timingPanelHeader"),
        document.getElementById("timingResize")
      );
    }
    $("#previewRefresh").on("click", () => this._preview());
    $("#previewTabs").on("click", ".gep-preview-tab", (e) => {
      this._showPreviewFile($(e.currentTarget).attr("data-file"));
    });
    $("#previewFilter").on("input", () => this._renderPreviewTable());
    this.timingSelect.on("change", () => this._showTiming());
    $("#gepZoomIn").on("click", () => this._setZoom(this.zoom * 1.25));
    $("#gepZoomOut").on("click", () => this._setZoom(this.zoom / 1.25));
    $("#gepFit").on("click", () => this._setZoom(1));
    $(
      "#gepShort, #gepLong, #gepColor, #gepOperator, #gepDirection, " +
        "#gepHeadsign, #gepReturnHeadsign, #gepDesc, #gepHail"
    ).on("input change", () => this._queueSave());
    $("#gepDirection").on("change", () => this._syncReturnUI());
    // Schedule blocks are rebuilt per route — delegate.
    $("#gepSchedList").on("input change", "input, textarea", () => this._queueSave());
    $("#gepSchedList").on("click", ".gep-sched-del", (e) => {
      const block = $(e.currentTarget).closest(".gep-sched-block");
      if (block.find("input").prop("disabled")) return;
      block.remove();
      this._renumberSched();
      this._queueSave();
    });
    $("#gepSchedAdd").on("click", () => {
      if (!this.current) return;
      $("#gepSchedList").append(this._schedBlockEl({}));
      this._renumberSched();
      this._syncReturnUI();
    });
    $("#gepSchedList").on("click", ".gep-band-add", (e) => {
      const block = $(e.currentTarget).closest(".gep-sched-block");
      if (block.find("input").prop("disabled")) return;
      block.find(".gep-band-list").append(this._bandRow({}));
    });
    $("#gepSchedList").on("click", ".gep-band-del", (e) => {
      const band = $(e.currentTarget).closest(".gep-band");
      if (band.find("input").prop("disabled")) return;
      band.remove();
      this._queueSave();
    });
    $("#gepFarePrice, #gepFareCurrency").on("input change", () => this._queueFeedSave());
    // Operator rows are dynamic — delegate, and refresh the route pane's
    // dropdown as names change.
    $("#gepAgencyList").on("input", "input", () => {
      this._updateOperatorOptions();
      this._queueFeedSave();
    });
    $("#gepAgencyList").on("click", ".gep-agency-del", (e) => {
      $(e.currentTarget).closest(".gep-agency-row").remove();
      this._updateOperatorOptions();
      this._queueFeedSave();
    });
    $("#gepAgencyAdd").on("click", () => {
      $("#gepAgencyList").append(this._agencyRow({}));
    });
    $("#gepHolidayList").on("input change", "input, select", () =>
      this._queueFeedSave()
    );
    $("#gepHolidayList").on("click", ".gep-holiday-del", (e) => {
      $(e.currentTarget).closest(".gep-holiday-row").remove();
      this._queueFeedSave();
    });
    $("#gepHolidayAdd").on("click", () => {
      $("#gepHolidayList").append(this._holidayRow({}));
    });

    // Stops list (rows are rebuilt per route, so delegate). Every edit
    // branches: live mode writes into the editor's features (persisted only
    // by the toolbar Save); otherwise it autosaves a new geometry version.
    const stopsList = $("#gepStopsList");
    stopsList.on("click", ".gep-stop-seq", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null || !this.page) return;
      const s = this._stopsData()[i];
      if (s) this.page.focusStop(s.lon, s.lat);
    });
    stopsList.on("input", ".gep-stop-name", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      if (this._liveSource) {
        const f = this._liveStopFeatures()[i];
        if (f) f.set("name", e.currentTarget.value);
        return;
      }
      this.geom.stops[i].name = e.currentTarget.value;
      this._queueStopsSave();
    });
    stopsList.on("input", ".gep-stop-code", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      if (this._liveSource) {
        const f = this._liveStopFeatures()[i];
        if (f) f.set("code", e.currentTarget.value.trim());
        return;
      }
      this.geom.stops[i].code = e.currentTarget.value.trim();
      this._queueStopsSave();
    });
    // In live mode a rename/recode becomes one undo step when the field is left.
    stopsList.on("change", ".gep-stop-name, .gep-stop-code", () => {
      if (this._liveSource) this.page.editorManager._snapshot();
    });
    stopsList.on("change", ".gep-stop-coord", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      const v = parseFloat(e.currentTarget.value);
      const isLat = $(e.currentTarget).hasClass("gep-stop-lat");
      const ok = isFinite(v) && (isLat ? Math.abs(v) <= 90 : Math.abs(v) <= 180);
      const s = this._stopsData()[i];
      if (!ok) {
        e.currentTarget.value = (isLat ? s.lat : s.lon).toFixed(6); // revert
        return;
      }
      if (this._liveSource) {
        const f = this._liveStopFeatures()[i];
        if (!f) return;
        const lon = isLat ? s.lon : v;
        const lat = isLat ? v : s.lat;
        f.setGeometry(new ol.geom.Point(APP.MapUtils.toOL([lon, lat])));
        this.page.editorManager._snapshot();
        return;
      }
      if (isLat) this.geom.stops[i].lat = v;
      else this.geom.stops[i].lon = v;
      this._queueStopsSave();
    });
    stopsList.on("click", ".gep-stop-up, .gep-stop-down", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      const j = $(e.currentTarget).hasClass("gep-stop-up") ? i - 1 : i + 1;
      if (this._liveSource) {
        this._liveReorder(i, j);
        return;
      }
      const stops = this.geom.stops;
      if (j < 0 || j >= stops.length) return;
      [stops[i], stops[j]] = [stops[j], stops[i]];
      this._renderStops();
      this._queueStopsSave();
    });
    stopsList.on("click", ".gep-stop-del", (e) => {
      const i = this._stopAt(e.currentTarget);
      if (i == null) return;
      if (this._liveSource) {
        const f = this._liveStopFeatures()[i];
        if (f) {
          this._liveSource.removeFeature(f);
          this.page.editorManager._snapshot();
        }
        return;
      }
      this.geom.stops.splice(i, 1);
      this._renderStops();
      this._queueStopsSave();
    });
  }
};
