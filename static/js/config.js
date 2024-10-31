// Map style configurations
window.APP = window.APP || {};

APP.MAP_STYLES = {
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

// Map configuration constants
APP.MAP_CONFIG = {
  INITIAL_CENTER: [114.7277, 4.5353],
  INITIAL_ZOOM: 11,
  MIN_ZOOM: 9.5,
  MAX_ZOOM: 18,
  BOUNDS: {
    MIN: [114.0, 4.2],
    MAX: [115.4, 5.0],
  },
  ROUTE_STYLE: {
    stroke: {
      color: "#FF4136",
      width: 3,
    },
    point: {
      radius: 5,
      fill: "#FF4136",
      stroke: {
        color: "#FFF",
        width: 2,
      },
    },
  },
};
