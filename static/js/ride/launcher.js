// Launcher for the 3D ride-along modes. Populates the route chooser (numbered
// routes only for v1) and opens the selected route in either engine.
window.APP = window.APP || {};

$(document).ready(function () {
  const select = $("#rideRouteSelect");

  // The active dataset year comes from the shared #dataYear picker (populated by
  // RouteManager). Empty before it loads → server falls back to its default.
  const currentYear = () => $("#dataYear").val() || "";
  const yearQuery = () => (currentYear() ? `?year=${encodeURIComponent(currentYear())}` : "");

  // Point/reference layers have no single drive path to ride.
  const NON_ROUTE = /^(Points - |Landmarks\b|Road\b|intradistrict\b|ANNEX\b)/i;

  function loadRideRoutes() {
    const yq = yearQuery();
    Promise.all([
      fetch(`/data/routes.json${yq}`).then((r) => r.json()).catch(() => []),
      fetch(`/data/geojson-list${yq}`).then((r) => r.json()).catch(() => []),
    ])
      .then(([routes, geojson]) => {
        select.empty();
        const kml = (routes || []).filter((f) => !NON_ROUTE.test(f));
        if (kml.length) {
          const grp = $('<optgroup label="Routes (KML)"></optgroup>');
          kml.forEach((f) =>
            grp.append($("<option></option>").val(f).text(f.replace(".kml", "")))
          );
          select.append(grp);
        }
        if (geojson && geojson.length) {
          const grp = $('<optgroup label="GeoJSON paths"></optgroup>');
          geojson.forEach((f) =>
            grp.append(
              $("<option></option>").val(f).text(f.replace(".geojson", ""))
            )
          );
          select.append(grp);
        }
      })
      .catch((error) => APP.MapUtils.handleError(error, "Loading ride routes"));
  }

  loadRideRoutes();
  // Rebuild the chooser whenever the year changes.
  $("#dataYear").on("change", loadRideRoutes);

  function launch(engine) {
    const route = select.val();
    if (!route) return;
    const y = currentYear();
    const yq = y ? `&year=${encodeURIComponent(y)}` : "";
    // Navigate in the same tab; each ride page has an "✕ Exit" link back to "/".
    window.location.href =
      `/ride/${engine}?route=${encodeURIComponent(route)}${yq}`;
  }

  $("#rideThreeBtn").click(() => launch("three"));
  $("#rideMaplibreBtn").click(() => launch("maplibre"));
});
