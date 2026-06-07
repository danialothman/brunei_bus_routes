window.APP = window.APP || {};

APP.RouteManager = class {
  /**
   * @param {ol.Map} map - OpenLayers map instance
   */
  constructor(map) {
    this.map = map;
    this.layers = new Map(); // kmlFile -> ol.layer.Vector (cached, may be hidden)
    this.colors = new Map(); // kmlFile -> assigned color
    this.loadingFiles = new Set(); // kmlFiles with a fetch in flight
    this.year = null; // selected dataset year (set from /data/years)
    this.geojsonLayers = new Map(); // geojsonFile -> ol.layer.Vector
    this.geojsonColors = new Map(); // geojsonFile -> assigned color
  }

  /**
   * Initialize route management
   */
  init() {
    this.setupRouteControls();
    this.setupYearControl(); // populates the picker, then loads the route list
  }

  /**
   * Query-string suffix for the active dataset year (empty if none selected).
   * @returns {string}
   */
  yearQuery() {
    return this.year ? `?year=${encodeURIComponent(this.year)}` : "";
  }

  /**
   * Create vector source for KML file
   * @param {string} kmlFile - KML file name
   * @returns {ol.source.Vector} Vector source
   */
  createVectorSource(kmlFile) {
    return new ol.source.Vector({
      url: `/data/kml/${kmlFile}${this.yearQuery()}`,
      format: new ol.format.KML({
        extractStyles: false,
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });
  }

  /**
   * Create vector layer with per-route color styling
   * @param {ol.source.Vector} source - Vector source
   * @param {string} color - Route color
   * @returns {ol.layer.Vector} Vector layer
   */
  createVectorLayer(source, color) {
    const { stroke, point } = APP.MAP_CONFIG.ROUTE_STYLE;
    return new ol.layer.Vector({
      source: source,
      style: new ol.style.Style({
        stroke: new ol.style.Stroke({ color: color, width: stroke.width }),
        image: new ol.style.Circle({
          radius: point.radius,
          fill: new ol.style.Fill({ color: color }),
          stroke: new ol.style.Stroke(point.stroke),
        }),
      }),
    });
  }

  /**
   * Mark a route as loading and reflect it in the spinner
   * @param {string} kmlFile - Layer identifier
   */
  showLoading(kmlFile) {
    this.loadingFiles.add(kmlFile);
    this.updateSpinner();
  }

  /**
   * Clear a route's loading state (or all of them) and update the spinner
   * @param {string} kmlFile - Layer identifier (ignored when forced)
   * @param {boolean} forced - Force-clear all loading state
   */
  hideLoading(kmlFile, forced = false) {
    if (forced) {
      this.loadingFiles.clear();
    } else {
      this.loadingFiles.delete(kmlFile);
    }
    this.updateSpinner();
  }

  /**
   * Show the loading banner only while something is actually loading
   */
  updateSpinner() {
    if (this.loadingFiles.size > 0) {
      $("#loading").show();
    } else {
      $("#loading").hide();
    }
  }

  /**
   * Whether a route's layer is currently on the map and visible
   * @param {string} kmlFile - KML file name
   * @returns {boolean}
   */
  isVisible(kmlFile) {
    const layer = this.layers.get(kmlFile);
    return !!layer && layer.getVisible();
  }

  /**
   * Zoom to a layer's extent only when it is the sole visible route, so
   * adding a route to an existing selection doesn't yank the camera away.
   * @param {ol.layer.Vector} layer - Vector layer just made visible
   */
  maybeZoomTo(layer) {
    const otherVisible = Array.from(this.layers.values()).some(
      (l) => l !== layer && l.getVisible()
    );
    if (otherVisible) {
      return;
    }
    const extent = layer.getSource().getExtent();
    if (!extent || !isFinite(extent[0])) {
      return;
    }
    this.map.getView().fit(extent, {
      padding: [50, 50, 50, 50],
      maxZoom: 16,
      duration: 1000,
    });
  }

  /**
   * Create and setup route layer
   * @param {string} kmlFile - KML file name
   * @returns {ol.layer.Vector} Vector layer
   */
  createRouteLayer(kmlFile) {
    const color = this.colors.get(kmlFile) || APP.MAP_CONFIG.ROUTE_STYLE.stroke.color;
    const source = this.createVectorSource(kmlFile);
    const layer = this.createVectorLayer(source, color);

    source.on("error", (error) => {
      APP.MapUtils.handleError(error, `Loading KML: ${kmlFile}`);
      this.hideLoading(kmlFile);
    });

    source.on("change", () => {
      if (source.getState() === "ready") {
        const features = source.getFeatures();
        if (features.length > 0 && layer.getVisible()) {
          this.maybeZoomTo(layer);
        }
        this.hideLoading(kmlFile);
      }
    });

    return layer;
  }

  /**
   * Show a route — reusing its cached layer if it was loaded before, so
   * re-enabling never re-fetches the KML over the network.
   * @param {string} kmlFile - KML file name
   */
  enableRoute(kmlFile) {
    let layer = this.layers.get(kmlFile);
    if (layer) {
      layer.setVisible(true);
      this.maybeZoomTo(layer);
      return;
    }
    this.showLoading(kmlFile);
    layer = this.createRouteLayer(kmlFile);
    this.layers.set(kmlFile, layer);
    this.map.addLayer(layer);
  }

  /**
   * Hide a route without destroying its layer (cached for instant re-show)
   * @param {string} kmlFile - KML file name
   */
  disableRoute(kmlFile) {
    const layer = this.layers.get(kmlFile);
    if (layer) {
      layer.setVisible(false);
    }
    this.hideLoading(kmlFile);
  }

  /**
   * Toggle a single route on/off
   * @param {string} kmlFile - KML file name
   */
  toggleRoute(kmlFile) {
    if (this.isVisible(kmlFile)) {
      this.disableRoute(kmlFile);
    } else {
      this.enableRoute(kmlFile);
    }
  }

  /**
   * Show every route in the list
   */
  showAll() {
    $("#routes input").each((_, el) => {
      if (!el.checked) {
        el.checked = true;
        this.enableRoute(el.value);
      }
    });
  }

  /**
   * Hide every route
   */
  clearAll() {
    $("#routes input, #geojsonRoutes input").each((_, el) => {
      el.checked = false;
    });
    this.layers.forEach((layer) => layer.setVisible(false));
    this.geojsonLayers.forEach((layer) => layer.setVisible(false));
    this.hideLoading(null, true);
  }

  /**
   * Setup route controls and event handlers
   */
  setupRouteControls() {
    $("#routes").on("click", "input", (e) => {
      try {
        this.toggleRoute(e.target.value);
      } catch (error) {
        APP.MapUtils.handleError(error, "Route toggle");
        this.hideLoading(null, true);
      }
    });

    $("#geojsonRoutes").on("click", "input", (e) => {
      try {
        this.toggleGeojson(e.target.value);
      } catch (error) {
        APP.MapUtils.handleError(error, "GeoJSON toggle");
        this.hideLoading(null, true);
      }
    });

    $("#showAll").on("click", () => this.showAll());
    $("#clearAll").on("click", () => this.clearAll());
  }

  /**
   * Populate the year picker from /data/years, then load the default year's
   * routes. Falls back to the server default if the list can't be fetched.
   */
  setupYearControl() {
    const sel = $("#dataYear");
    sel.on("change", (e) => this.setYear(e.target.value));
    fetch("/data/years")
      .then((r) => r.json())
      .then(({ years, default: def }) => {
        sel.empty();
        years.forEach((y) =>
          sel.append($("<option></option>").val(y).text(y))
        );
        this.year = def || (years && years[0]) || null;
        sel.val(this.year);
        this.loadRouteList();
        this.loadGeojsonList();
      })
      .catch(() => {
        // No picker data — just load whatever the server defaults to.
        this.loadRouteList();
        this.loadGeojsonList();
      });
  }

  /**
   * Switch the active dataset year: drop all cached layers and rebuild the list.
   * @param {string} year
   */
  setYear(year) {
    if (year === this.year) {
      return;
    }
    this.year = year;
    // Layers/colors are year-specific — remove and clear so nothing leaks across.
    this.layers.forEach((layer) => this.map.removeLayer(layer));
    this.layers.clear();
    this.colors.clear();
    this.geojsonLayers.forEach((layer) => this.map.removeLayer(layer));
    this.geojsonLayers.clear();
    this.geojsonColors.clear();
    this.hideLoading(null, true);
    $("#routes").empty();
    $("#geojsonRoutes").empty();
    this.loadRouteList();
    this.loadGeojsonList();
  }

  /**
   * Load route list from JSON and build the colored legend/toggles
   */
  loadRouteList() {
    fetch(`/data/routes.json${this.yearQuery()}`)
      .then((response) => response.json())
      .then((routes) => {
        const output = $("#routes");
        routes.forEach((kmlFile, index) => {
          const color = APP.ROUTE_COLORS[index % APP.ROUTE_COLORS.length];
          this.colors.set(kmlFile, color);

          const label = $("<label></label>").addClass("list-group-item route-item");
          const input = $('<input type="checkbox">').val(kmlFile);
          const swatch = $('<span class="route-swatch"></span>').css(
            "background-color",
            color
          );
          const name = $('<span class="route-name"></span>').text(
            kmlFile.replace(".kml", "")
          );
          label.append(input).append(swatch).append(name);
          output.append(label);
        });
      })
      .catch((error) => APP.MapUtils.handleError(error, "Loading routes"));
  }

  /**
   * Load the GeoJSON path overlay list for the active year (hidden if none).
   */
  loadGeojsonList() {
    const section = $("#geojsonSection");
    fetch(`/data/geojson-list${this.yearQuery()}`)
      .then((response) => response.json())
      .then((files) => {
        const output = $("#geojsonRoutes").empty();
        if (!files || !files.length) {
          section.hide();
          return;
        }
        files.forEach((file, index) => {
          const color = APP.ROUTE_COLORS[index % APP.ROUTE_COLORS.length];
          this.geojsonColors.set(file, color);

          const label = $("<label></label>").addClass("list-group-item route-item");
          const input = $('<input type="checkbox">').val(file);
          const swatch = $('<span class="route-swatch"></span>').css(
            "background-color",
            color
          );
          const name = $('<span class="route-name"></span>').text(
            file.replace(".geojson", "")
          );
          label.append(input).append(swatch).append(name);
          output.append(label);
        });
        section.show();
      })
      .catch(() => section.hide());
  }

  /**
   * Build a dashed GeoJSON path layer (distinct from the solid KML routes).
   * @param {string} file - GeoJSON file name
   * @returns {ol.layer.Vector}
   */
  createGeojsonLayer(file) {
    const color = this.geojsonColors.get(file) || "#111";
    const source = new ol.source.Vector({
      url: `/data/geojson/${file}${this.yearQuery()}`,
      format: new ol.format.GeoJSON({
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });
    const layer = new ol.layer.Vector({
      source: source,
      style: new ol.style.Style({
        stroke: new ol.style.Stroke({ color: color, width: 3, lineDash: [6, 6] }),
      }),
    });
    source.on("error", (error) => {
      APP.MapUtils.handleError(error, `Loading GeoJSON: ${file}`);
      this.hideLoading(file);
    });
    source.on("change", () => {
      if (source.getState() === "ready") {
        if (source.getFeatures().length > 0 && layer.getVisible()) {
          this.maybeZoomTo(layer);
        }
        this.hideLoading(file);
      }
    });
    return layer;
  }

  /**
   * Toggle a GeoJSON path overlay on/off (caches the layer for instant re-show).
   * @param {string} file - GeoJSON file name
   */
  toggleGeojson(file) {
    let layer = this.geojsonLayers.get(file);
    if (layer) {
      const visible = !layer.getVisible();
      layer.setVisible(visible);
      if (visible) {
        this.maybeZoomTo(layer);
      } else {
        this.hideLoading(file);
      }
      return;
    }
    this.showLoading(file);
    layer = this.createGeojsonLayer(file);
    this.geojsonLayers.set(file, layer);
    this.map.addLayer(layer);
  }
};
