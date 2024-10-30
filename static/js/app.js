const MAP_STYLES = {
  osm: {
    create: () =>
      new ol.layer.Tile({
        source: new ol.source.OSM(),
      }),
  },
  satellite: {
    create: () =>
      new ol.layer.Tile({
        source: new ol.source.XYZ({
          attributions: [
            "Powered by Esri",
            "Source: Esri, DigitalGlobe, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community",
          ],
          url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          maxZoom: 23,
        }),
      }),
  },
  terrain: {
    create: () =>
      new ol.layer.Tile({
        source: new ol.source.XYZ({
          url: "https://tile.opentopomap.org/{z}/{x}/{y}.png",
          attributions:
            'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
          maxZoom: 17,
        }),
      }),
  },
  dark: {
    create: () =>
      new ol.layer.Tile({
        source: new ol.source.XYZ({
          url: "https://cartodb-basemaps-{a-d}.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png",
          attributions:
            '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="http://cartodb.com/attributions">CartoDB</a>',
        }),
      }),
  },
};

class BusMap {
  constructor() {
    this.map = null;
    this.layers = {};
    this.loading = {};
    this.layersEnabled = {};
    this.baseLayer = null;
    this.select = new ol.interaction.Select();
    this.locationLayer = null;
    this.locationFeature = null;

    this.init();
  }

  toOL(coordinate) {
    return ol.proj.transform(coordinate, "EPSG:4326", "EPSG:3857");
  }

  toNormal(coordinate) {
    return ol.proj.transform(coordinate, "EPSG:3857", "EPSG:4326");
  }

  showInfo(feature) {
    if (!feature) {
      $("#info").hide();
      return;
    }
    const name = feature.get("name");
    $("#info .name").text(name);

    const coord = this.toNormal(feature.getGeometry().getCoordinates());
    if (isNaN(coord[0])) {
      $("#info .location").hide();
    } else {
      $("#info .location")
        .text(`${coord[0].toFixed(7)}, ${coord[1].toFixed(7)}`)
        .show();
    }

    $("#info").show();
  }

  hideInfo() {
    this.select.getFeatures().clear();
    $("#info").hide();
  }

  showLoading(layer) {
    if (
      typeof this.loading[layer] === "undefined" ||
      this.loading[layer] !== 1
    ) {
      this.loading[layer] = -1;
      $("#loading").show();
    }
  }

  hideLoading(layer, forced) {
    if (
      typeof this.loading[layer] !== "undefined" &&
      this.loading[layer] != 1
    ) {
      this.loading[layer] = 0;
    }
    const stillLoading = Object.values(this.loading).some((val) => val === -1);
    if (!stillLoading || forced) {
      $("#loading").hide();
    }
  }

  changeMapStyle(style) {
    if (this.baseLayer) {
      this.map.removeLayer(this.baseLayer);
    }
    this.baseLayer = MAP_STYLES[style].create();
    this.map.getLayers().insertAt(0, this.baseLayer);
  }

  setupLocationTracking() {
    if (!navigator.geolocation) {
      console.log("Geolocation is not supported by your browser");
      return;
    }

    // Create location feature and layer
    this.locationFeature = new ol.Feature();
    const locationStyle = new ol.style.Style({
      image: new ol.style.Circle({
        radius: 8,
        fill: new ol.style.Fill({
          color: "#3399CC",
        }),
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

    // Watch position
    navigator.geolocation.watchPosition(
      (position) => {
        const coords = [position.coords.longitude, position.coords.latitude];
        const olCoords = this.toOL(coords);
        this.locationFeature.setGeometry(new ol.geom.Point(olCoords));

        // Center map on first position
        if (!this.locationFeature.getGeometry()) {
          this.map.getView().animate({
            center: olCoords,
            zoom: 15,
          });
        }
      },
      (error) => {
        console.error("Error getting location:", error.message);
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0,
      }
    );
  }

  setupRoutes() {
    const output = $("#routes");
    output.on("click", "input", (e) => {
      const file = e.target.value;
      const layer = this.layers[file];

      if (this.layersEnabled[file]) {
        this.hideLoading(file);
        this.map.removeLayer(layer);
      } else {
        this.showLoading(file);
        this.map.addLayer(layer);
      }
      this.layersEnabled[file] = !this.layersEnabled[file];
    });

    fetch("/data/routes.json") // Updated path
      .then((response) => response.json())
      .then((routes) => {
        routes.forEach((file) => {
          const prefix = "/data/kml/"; // Updated path
          const vectorSource = new ol.source.Vector({
            url: prefix + file,
            format: new ol.format.KML({
              scale: 0.5,
              defaultStyle: [
                new ol.style.Style({
                  image: new ol.style.Icon({
                    scale: 0.5,
                    anchor: [0.5, 0.5],
                    anchorXUnits: "fraction",
                    anchorYUnits: "fraction",
                  }),
                }),
              ],
            }),
          });

          const route = new ol.layer.Vector({
            source: vectorSource,
            style: (feature) => {
              const kmlStyle = feature.getStyleFunction()(feature);
              if (kmlStyle[0].getImage()) {
                kmlStyle[0].getImage().setScale(0.5);
              }
              return kmlStyle;
            },
          });

          vectorSource.on("change", (e) => {
            const source = e.target;
            if (source.getState() == "ready") {
              const file = source.getUrl().substring(prefix.length);
              this.loading[file] = 1;
              this.hideLoading(file);
            }
          });

          this.layers[file] = route;
          const label = $("<label></label>")
            .addClass("list-group-item")
            .text(file.replace(".kml", ""));
          const input = $('<input type="checkbox">').val(file);
          label.prepend(input);
          output.append(label);
        });
      });
  }

  init() {
    $("#loading").click((e) => {
      e.preventDefault();
      this.hideLoading(null, true);
    });

    // Convert Brunei's bounding box coordinates to OpenLayers projection with minimal padding
    const extent = this.toOL([114.4, 4.4]).concat(this.toOL([115.2, 4.8]));

    const view = new ol.View({
      // Center coordinates for Brunei (approximately centered on BSB)
      center: this.toOL([114.7277, 4.5353]),

      // Initial zoom level when the map loads
      zoom: 1,

      // Minimum zoom level - set to 9.5 to maintain context while preventing too much zoom out
      minZoom: 9.5,

      // Maximum zoom level - set to 18 for detailed street-level view
      maxZoom: 18,

      // Geographical extent that limits the viewable area to Brunei's main bus route areas
      extent: extent,

      // When false, constrains both center and extent of the view to stay within bounds
      // When true, only the center is constrained (allows edge panning)
      constrainOnlyCenter: false,
    });

    this.baseLayer = MAP_STYLES.osm.create();
    this.map = new ol.Map({
      target: "map",
      layers: [this.baseLayer],
      view: view,
    });

    $("#mapStyle").change((e) => {
      this.changeMapStyle(e.target.value);
    });

    $("#info .dismiss").click(() => {
      this.hideInfo();
    });

    this.map.addInteraction(this.select);
    this.select.on("select", (e) => {
      const features = e.target.getFeatures().getArray();
      this.showInfo(features[0]);
    });

    this.setupRoutes();
    this.setupLocationTracking();
  }
}

$(document).ready(() => new BusMap());
