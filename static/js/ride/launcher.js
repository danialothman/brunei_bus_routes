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
      fetch(`/data/user-routes${yq}`).then((r) => r.json()).catch(() => []),
      fetch(`/data/edit-names${yq}`).then((r) => r.json()).catch(() => ({})),
    ])
      .then(([routes, geojson, userRoutes, names]) => {
        select.empty();
        const opt = (f, ext) =>
          $("<option></option>").val(f).text(names[f] || f.replace(ext, ""));
        const addGroup = (label, files, ext) => {
          if (!files || !files.length) return;
          const grp = $(`<optgroup label="${label}"></optgroup>`);
          files.forEach((f) => grp.append(opt(f, ext)));
          select.append(grp);
        };
        addGroup("Routes (KML)", (routes || []).filter((f) => !NON_ROUTE.test(f)), ".kml");
        addGroup("My routes", userRoutes, ".kml");
        addGroup("GeoJSON paths", geojson, ".geojson");
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
