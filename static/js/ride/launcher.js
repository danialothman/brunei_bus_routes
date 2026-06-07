// 3D ride launcher. Each route row has a 🚌 button that opens a small modal to
// pick the engine (Three.js / MapLibre), then rides that route for its year.
window.APP = window.APP || {};

$(document).ready(function () {
  let pendingRide = null;

  $("#routes").on("click", ".route-ride-btn", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = $(e.currentTarget);
    pendingRide = { file: el.attr("data-file"), year: el.attr("data-year") };
    $("#engineRouteName").text(el.closest("label").find(".route-name").text());
    $("#engineModal").modal("show");
  });

  const rideEngine = (engine) => {
    if (!pendingRide) return;
    const yq = pendingRide.year
      ? `&year=${encodeURIComponent(pendingRide.year)}`
      : "";
    window.location.href =
      `/ride/${engine}?route=${encodeURIComponent(pendingRide.file)}${yq}`;
  };

  $("#engineThree").on("click", () => rideEngine("three"));
  $("#engineMaplibre").on("click", () => rideEngine("maplibre"));
});
