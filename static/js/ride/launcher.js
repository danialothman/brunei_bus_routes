// Launcher for the 3D ride-along modes. Populates the route chooser (numbered
// routes only for v1) and opens the selected route in either engine.
window.APP = window.APP || {};

$(document).ready(function () {
  const select = $("#rideRouteSelect");

  // The active dataset year comes from the shared #dataYear picker (populated by
  // RouteManager). Empty before it loads → server falls back to its default.
  const currentYear = () => $("#dataYear").val() || "";
  const yearQuery = () => (currentYear() ? `?year=${encodeURIComponent(currentYear())}` : "");

  function loadRideRoutes() {
    fetch(`/data/routes.json${yearQuery()}`)
      .then((r) => r.json())
      .then((routes) => {
        select.empty();
        routes
          .filter((f) => /^\d/.test(f)) // numbered routes have clean single paths
          .forEach((f) => {
            select.append(
              $("<option></option>").val(f).text(f.replace(".kml", ""))
            );
          });
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
