// Minimal shared image lightbox with prev/next. Call APP.lightbox(srcs, index)
// with an array of image URLs (or a single URL) to open a full-size view; click
// the backdrop / ✕ or press Esc to close, ‹ › or arrow keys to navigate.
// Vanilla JS, no dependency — the overlay is created lazily on first use.
window.APP = window.APP || {};

APP.lightbox = (function () {
  let overlay = null;
  let imgEl = null;
  let prevBtn = null;
  let nextBtn = null;
  let counter = null;
  let items = [];
  let idx = 0;

  function render() {
    imgEl.src = items[idx] || "";
    const multi = items.length > 1;
    prevBtn.style.display = multi ? "" : "none";
    nextBtn.style.display = multi ? "" : "none";
    counter.style.display = multi ? "" : "none";
    counter.textContent = multi ? `${idx + 1} / ${items.length}` : "";
  }

  function step(delta) {
    if (items.length < 2) return;
    idx = (idx + delta + items.length) % items.length;
    render();
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("is-open");
    imgEl.src = "";
    items = [];
  }

  function ensure() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML =
      '<button type="button" class="lightbox-close" aria-label="Close">&times;</button>'
      + '<button type="button" class="lightbox-nav lightbox-prev" aria-label="Previous">&#8249;</button>'
      + '<img class="lightbox-img" alt="" />'
      + '<button type="button" class="lightbox-nav lightbox-next" aria-label="Next">&#8250;</button>'
      + '<div class="lightbox-counter"></div>';
    imgEl = overlay.querySelector(".lightbox-img");
    prevBtn = overlay.querySelector(".lightbox-prev");
    nextBtn = overlay.querySelector(".lightbox-next");
    counter = overlay.querySelector(".lightbox-counter");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.classList.contains("lightbox-close")) {
        close();
      }
    });
    prevBtn.addEventListener("click", (e) => { e.stopPropagation(); step(-1); });
    nextBtn.addEventListener("click", (e) => { e.stopPropagation(); step(1); });
    document.addEventListener("keydown", (e) => {
      if (!overlay.classList.contains("is-open")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    });
    document.body.appendChild(overlay);
  }

  function open(srcs, index) {
    const list = Array.isArray(srcs) ? srcs.slice() : [srcs];
    if (!list.length || !list[0]) return;
    ensure();
    // Drop any text/image selection so the enlarged image isn't shown
    // highlighted (a stray range from rapid thumbnail clicks).
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
    items = list;
    idx = Math.min(Math.max(index || 0, 0), items.length - 1);
    render();
    overlay.classList.add("is-open");
  }

  open.close = close;
  return open;
})();
