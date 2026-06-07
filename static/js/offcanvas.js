// Toggle the floating routes sidebar via the navbar "Show Routes" button.
$(document).ready(function () {
  // Start collapsed on small screens so it doesn't cover the map.
  if (window.innerWidth < 768) {
    $("#sidebar").addClass("collapsed");
  }
  $('[data-toggle="offcanvas"]').click(function () {
    $("#sidebar").toggleClass("collapsed");
  });
});
