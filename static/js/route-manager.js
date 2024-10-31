window.APP = window.APP || {};

APP.RouteManager = class {
  /**
   * @param {ol.Map} map - OpenLayers map instance
   */
  constructor(map) {
    this.map = map;
    this.layers = new Map();
    this.loading = new Map();
    this.layersEnabled = new Map();
  }

  /**
   * Initialize route management
   */
  init() {
    this.setupRouteControls();
    this.loadRouteList();
  }

  /**
   * Create vector source for KML file
   * @param {string} kmlFile - KML file name
   * @returns {ol.source.Vector} Vector source
   */
  createVectorSource(kmlFile) {
    return new ol.source.Vector({
      url: `/data/kml/${kmlFile}`,
      format: new ol.format.KML({
        extractStyles: false,
        dataProjection: "EPSG:4326",
        featureProjection: "EPSG:3857",
      }),
    });
  }

  /**
   * Create vector layer with styling
   * @param {ol.source.Vector} source - Vector source
   * @returns {ol.layer.Vector} Vector layer
   */
  createVectorLayer(source) {
    const { stroke, point } = APP.MAP_CONFIG.ROUTE_STYLE;
    return new ol.layer.Vector({
      source: source,
      style: new ol.style.Style({
        stroke: new ol.style.Stroke(stroke),
        image: new ol.style.Circle({
          radius: point.radius,
          fill: new ol.style.Fill({ color: point.fill }),
          stroke: new ol.style.Stroke(point.stroke),
        }),
      }),
    });
  }

  /**
   * Show loading indicator for layer
   * @param {string} layer - Layer identifier
   */
  showLoading(layer) {
    if (!this.loading.has(layer) || this.loading.get(layer) !== 1) {
      this.loading.set(layer, -1);
      $("#loading").show();
    }
  }

  /**
   * Hide loading indicator for layer
   * @param {string} layer - Layer identifier
   * @param {boolean} forced - Force hide loading
   */
  hideLoading(layer, forced = false) {
    if (this.loading.has(layer) && this.loading.get(layer) !== 1) {
      this.loading.set(layer, 0);
    }
    const stillLoading = Array.from(this.loading.values()).some(
      (val) => val === -1
    );
    if (!stillLoading || forced) {
      $("#loading").hide();
    }
  }

  /**
   * Zoom to layer extent
   * @param {ol.layer.Vector} layer - Vector layer
   */
  zoomToLayerExtent(layer) {
    const extent = layer.getSource().getExtent();
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
    console.log("Creating new layer for:", kmlFile);
    const source = this.createVectorSource(kmlFile);
    const layer = this.createVectorLayer(source);

    source.on("error", (error) => {
      APP.MapUtils.handleError(error, `Loading KML: ${kmlFile}`);
      this.hideLoading(kmlFile);
    });

    source.on("change", () => {
      if (source.getState() === "ready") {
        const features = source.getFeatures();
        console.log(`Loaded ${features.length} features for ${kmlFile}`);
        if (features.length > 0) {
          this.zoomToLayerExtent(layer);
        }
        this.loading.set(kmlFile, 1);
        this.hideLoading(kmlFile);
      }
    });

    return layer;
  }

  /**
   * Setup route controls and event handlers
   */
  setupRouteControls() {
    const output = $("#routes");
    output.on("click", "input", (e) => {
      try {
        const kmlFile = e.target.value;
        console.log("Toggling route:", kmlFile);

        if (this.layersEnabled.get(kmlFile)) {
          console.log("Removing layer:", kmlFile);
          this.hideLoading(kmlFile);
          this.map.removeLayer(this.layers.get(kmlFile));
          this.layers.delete(kmlFile);
        } else {
          console.log("Adding layer:", kmlFile);
          this.showLoading(kmlFile);
          const layer = this.createRouteLayer(kmlFile);
          this.layers.set(kmlFile, layer);
          this.map.addLayer(layer);
        }
        this.layersEnabled.set(kmlFile, !this.layersEnabled.get(kmlFile));
      } catch (error) {
        APP.MapUtils.handleError(error, "Route toggle");
        this.hideLoading(null, true);
      }
    });
  }

  /**
   * Load route list from JSON
   */
  loadRouteList() {
    fetch("/data/routes.json")
      .then((response) => response.json())
      .then((routes) => {
        const output = $("#routes");
        routes.forEach((kmlFile) => {
          const label = $("<label></label>")
            .addClass("list-group-item")
            .text(kmlFile.replace(".kml", ""));
          const input = $('<input type="checkbox">').val(kmlFile);
          label.prepend(input);
          output.append(label);
        });
      })
      .catch((error) => APP.MapUtils.handleError(error, "Loading routes"));
  }
};
