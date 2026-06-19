window.APP = window.APP || {};

APP.InfoManager = class {
  /**
   * @param {ol.Map} map - OpenLayers map instance
   */
  constructor(map) {
    this.map = map;
    this.select = new ol.interaction.Select();
    this.map.addInteraction(this.select);
  }

  /**
   * Initialize info management
   */
  init() {
    this.setupEventHandlers();
  }

  /**
   * Show information for selected feature
   * @param {ol.Feature} feature - Selected feature
   */
  showInfo(feature) {
    if (!feature) {
      $("#info").hide();
      document.body.classList.remove("stop-selected");
      return;
    }
    // Lets the CSS shorten the routes sidebar so it doesn't cover the banner.
    document.body.classList.add("stop-selected");

    const name = feature.get("name");
    $("#info .name").text(name);

    const coord = APP.MapUtils.toNormal(feature.getGeometry().getCoordinates());
    if (isNaN(coord[0])) {
      $("#info .location").hide();
    } else {
      $("#info .location")
        .text(`${coord[0].toFixed(7)}, ${coord[1].toFixed(7)}`)
        .show();
    }

    this.showStopPhotos(feature, coord);
    $("#info").show();
  }

  /**
   * Show field photos for a clicked stop, if any exist. Only point features
   * tagged with a route (year + file) can be matched; the stop is keyed by its
   * rounded coordinates, the same key the workbench uploads under.
   * @param {ol.Feature} feature
   * @param {number[]} coord - [lon, lat] of the feature
   */
  showStopPhotos(feature, coord) {
    const wrap = $("#info .info-photos").empty().hide();
    const geom = feature.getGeometry();
    const year = feature.get("routeYear");
    const file = feature.get("routeFile");
    if (!geom || geom.getType() !== "Point" || !year || !file || isNaN(coord[0])) {
      return; // not a locatable stop on a known route
    }
    const stopKey = `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
    const token = (this._photoToken = (this._photoToken || 0) + 1);
    const q = `?year=${encodeURIComponent(year)}&route=${encodeURIComponent(file)}`
      + `&stop=${encodeURIComponent(stopKey)}`;
    fetch(`/data/stop-photos${q}`)
      .then((r) => (r.ok ? r.json() : { photos: [] }))
      .then((d) => {
        if (token !== this._photoToken) return; // a newer stop was clicked
        const photos = d.photos || [];
        if (!photos.length) return;
        const srcs = photos.map((p) => `/data/stop-photo/${p.id}`);
        photos.forEach((p, i) => {
          wrap.append(
            $('<img alt="stop photo" title="Click to enlarge" />')
              .attr("src", srcs[i])
              .on("click", () => APP.lightbox(srcs, i))
          );
        });
        wrap.show();
      })
      .catch(() => {});
  }

  /**
   * Hide information panel
   */
  hideInfo() {
    this.select.getFeatures().clear();
    $("#info").hide();
    document.body.classList.remove("stop-selected");
  }

  /**
   * Enable/disable click-to-inspect (so the editor's interactions don't fight
   * this Select for pointer events). Disabling also clears any open info panel.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.select.setActive(enabled);
    if (!enabled) {
      this.hideInfo();
    }
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.select.on("select", (e) => {
      const features = e.target.getFeatures().getArray();
      this.showInfo(features[0]);
    });

    $("#info .dismiss").click(() => this.hideInfo());
  }
};
