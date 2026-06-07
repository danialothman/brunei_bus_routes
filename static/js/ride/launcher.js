// Launcher for the 3D ride-along modes. Populates the route chooser from the
// full catalog (all years, grouped) and opens the selected route in the chosen
// engine, passing along that route's year.
window.APP = window.APP || {};

$(document).ready(function () {
  const select = $("#rideRouteSelect");

  // Point/reference layers have no single drive path to ride.
  const NON_ROUTE = /^(Points - |Landmarks\b|Road\b|intradistrict\b|ANNEX\b)/i;

  function opt(file, ext, year, names) {
    return $("<option></option>")
      .val(file)
      .attr("data-year", year)
      .text(names[file] || file.replace(ext, ""));
  }

  function loadRideRoutes() {
    fetch("/data/catalog")
      .then((r) => r.json())
      .then((cat) => {
        select.empty();
        (cat.years || []).forEach((year) => {
          const d = cat[year] || {};
          const names = d.names || {};
          const add = (label, files, ext) => {
            if (!files || !files.length) return;
            const grp = $(`<optgroup label="${year} · ${label}"></optgroup>`);
            files.forEach((f) => grp.append(opt(f, ext, year, names)));
            select.append(grp);
          };
          add("Routes", (d.routes || []).filter((f) => !NON_ROUTE.test(f)), ".kml");
          add("My routes", d.user || [], ".kml");
          add("GeoJSON paths", d.geojson || [], ".geojson");
        });
      })
      .catch((error) => APP.MapUtils.handleError(error, "Loading ride routes"));
  }

  loadRideRoutes();

  // Per-row 🚌 button: ride that route directly (Three.js), without the modal.
  $("#routes").on("click", ".route-ride-btn", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = $(e.currentTarget);
    const file = el.attr("data-file");
    const year = el.attr("data-year");
    const yq = year ? `&year=${encodeURIComponent(year)}` : "";
    window.location.href = `/ride/three?route=${encodeURIComponent(file)}${yq}`;
  });

  function launch(engine) {
    const sel = select.find("option:selected");
    const route = sel.val();
    if (!route) return;
    const year = sel.attr("data-year");
    const yq = year ? `&year=${encodeURIComponent(year)}` : "";
    // Navigate in the same tab; each ride page has an "✕ Exit" link back to "/".
    window.location.href =
      `/ride/${engine}?route=${encodeURIComponent(route)}${yq}`;
  }

  $("#rideThreeBtn").click(() => launch("three"));
  $("#rideMaplibreBtn").click(() => launch("maplibre"));
});
