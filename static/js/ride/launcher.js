// Launcher for the 3D ride-along modes. Populates the route chooser (numbered
// routes only for v1) and opens the selected route in either engine.
window.APP = window.APP || {};

$(document).ready(function () {
  const select = $("#rideRouteSelect");

  fetch("/data/routes.json")
    .then((r) => r.json())
    .then((routes) => {
      routes
        .filter((f) => /^\d/.test(f)) // numbered routes have clean single paths
        .forEach((f) => {
          select.append(
            $("<option></option>").val(f).text(f.replace(".kml", ""))
          );
        });
    })
    .catch((error) => APP.MapUtils.handleError(error, "Loading ride routes"));

  function launch(engine) {
    const route = select.val();
    if (!route) return;
    // Navigate in the same tab; each ride page has an "✕ Exit" link back to "/".
    window.location.href = `/ride/${engine}?route=${encodeURIComponent(route)}`;
  }

  $("#rideThreeBtn").click(() => launch("three"));
  $("#rideMaplibreBtn").click(() => launch("maplibre"));
});
