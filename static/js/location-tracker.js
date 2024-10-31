window.APP = window.APP || {};

APP.LocationTracker = class {
  /**
   * @param {ol.Map} map - OpenLayers map instance
   */
  constructor(map) {
    this.map = map;
    this.locationFeature = null;
    this.locationLayer = null;
  }

  /**
   * Initialize location tracking
   */
  init() {
    if (!navigator.geolocation) {
      console.log("Geolocation is not supported by your browser");
      return;
    }

    this.setupLocationFeature();
    this.watchPosition();
  }

  /**
   * Set up location feature and layer
   */
  setupLocationFeature() {
    this.locationFeature = new ol.Feature();
    const locationStyle = new ol.style.Style({
      image: new ol.style.Circle({
        radius: 8,
        fill: new ol.style.Fill({ color: "#3399CC" }),
        stroke: new ol.style.Stroke({
          color: "#fff",
          width: 2,
        }),
      }),
    });
    this.locationFeature.setStyle(locationStyle);

    this.locationLayer = new ol.layer.Vector({
      source: new ol.source.Vector({
        features: [this.locationFeature],
      }),
    });
    this.map.addLayer(this.locationLayer);
  }

  /**
   * Watch user position
   */
  watchPosition() {
    navigator.geolocation.watchPosition(
      (position) => this.handlePositionUpdate(position),
      (error) => APP.MapUtils.handleError(error, "Location tracking"),
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0,
      }
    );
  }

  /**
   * Handle position updates
   * @param {GeolocationPosition} position
   */
  handlePositionUpdate(position) {
    const coords = [position.coords.longitude, position.coords.latitude];
    const olCoords = APP.MapUtils.toOL(coords);
    this.locationFeature.setGeometry(new ol.geom.Point(olCoords));

    // Center map on first position
    if (!this.locationFeature.getGeometry()) {
      this.map.getView().animate({
        center: olCoords,
        zoom: 15,
      });
    }
  }
};
