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
      return;
    }

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

    $("#info").show();
  }

  /**
   * Hide information panel
   */
  hideInfo() {
    this.select.getFeatures().clear();
    $("#info").hide();
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
