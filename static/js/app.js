window.APP = window.APP || {};

APP.BusMap = class {
  constructor() {
    this.map = null;
    this.baseLayer = null;
    this.locationTracker = null;
    this.routeManager = null;
    this.infoManager = null;

    this.init();
  }

  /**
   * Initialize the map and its components
   */
  init() {
    this.setupMap();
    this.setupMapStyleControls();
    this.setupLoadingControls();

    // Initialize components
    this.locationTracker = new APP.LocationTracker(this.map);
    this.routeManager = new APP.RouteManager(this.map);
    this.infoManager = new APP.InfoManager(this.map);

    this.locationTracker.init();
    this.routeManager.init();
    this.infoManager.init();
  }

  /**
   * Set up the OpenLayers map
   */
  setupMap() {
    const extent = APP.MapUtils.toOL(APP.MAP_CONFIG.BOUNDS.MIN).concat(
      APP.MapUtils.toOL(APP.MAP_CONFIG.BOUNDS.MAX)
    );

    const view = new ol.View({
      center: APP.MapUtils.toOL(APP.MAP_CONFIG.INITIAL_CENTER),
      zoom: APP.MAP_CONFIG.INITIAL_ZOOM,
      minZoom: APP.MAP_CONFIG.MIN_ZOOM,
      maxZoom: APP.MAP_CONFIG.MAX_ZOOM,
      extent: extent,
      constrainOnlyCenter: true,
    });

    this.baseLayer = APP.MAP_STYLES.osm.create();
    this.map = new ol.Map({
      target: "map",
      layers: [this.baseLayer],
      view: view,
    });
  }

  /**
   * Set up map style controls
   */
  setupMapStyleControls() {
    $("#mapStyle").change((e) => this.changeMapStyle(e.target.value));
  }

  /**
   * Change the map base layer style
   * @param {string} style - Map style identifier
   */
  changeMapStyle(style) {
    if (this.baseLayer) {
      this.map.removeLayer(this.baseLayer);
    }
    this.baseLayer = APP.MAP_STYLES[style].create();
    this.map.getLayers().insertAt(0, this.baseLayer);
  }

  /**
   * Set up loading controls
   */
  setupLoadingControls() {
    $("#loading").click((e) => {
      e.preventDefault();
      this.routeManager.hideLoading(null, true);
    });
  }
};

// Initialize the application when the document is ready
$(document).ready(() => new APP.BusMap());
