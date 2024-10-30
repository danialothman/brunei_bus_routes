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

    fetch("../data/routes.json")
      .then((response) => response.json())
      .then((routes) => {
        routes.forEach((file) => {
          const prefix = "../data/kml/";
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

    const view = new ol.View({
      center: this.toOL([114.7277, 4.5353]),
      zoom: 9,
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
  }
}

$(document).ready(() => new BusMap());
