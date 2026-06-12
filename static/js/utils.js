window.APP = window.APP || {};

APP.MapUtils = {
  /**
   * Convert coordinates from [longitude, latitude] to OpenLayers projection
   * @param {[number, number]} coordinate - [longitude, latitude] coordinates
   * @returns {[number, number]} OpenLayers projected coordinates
   */
  toOL: function (coordinate) {
    return ol.proj.fromLonLat(coordinate);
  },

  /**
   * Convert coordinates from OpenLayers projection to [longitude, latitude]
   * @param {[number, number]} coordinate - OpenLayers projected coordinates
   * @returns {[number, number]} [longitude, latitude] coordinates
   */
  toNormal: function (coordinate) {
    return ol.proj.toLonLat(coordinate);
  },

  /**
   * Handle errors with consistent logging and user feedback
   * @param {Error} error - The error object
   * @param {string} context - Context where the error occurred
   */
  handleError: function (error, context) {
    console.error(`Error in ${context}:`, error);
  },

  /**
   * Make a panel float: draggable by its header, resizable from a corner
   * handle. Shared by the Official-stops and Timing signboard panels.
   * @param {HTMLElement} panel
   * @param {HTMLElement} header drag handle (clicks on button/select ignored)
   * @param {HTMLElement} [resizeHandle] corner resize grip
   */
  makeFloatingPanel: function (panel, header, resizeHandle) {
    let sx, sy, sl, st, dragging = false;
    const onDragMove = (e) => {
      if (!dragging) return;
      panel.style.left = sl + (e.clientX - sx) + "px";
      panel.style.top = st + (e.clientY - sy) + "px";
      panel.style.right = "auto";
    };
    const onDragUp = () => {
      dragging = false;
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragUp);
    };
    header.addEventListener("mousedown", (e) => {
      // Don't start a drag when interacting with the header controls.
      if (e.target.closest("button, select")) return;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      panel.style.right = "auto";
      dragging = true;
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragUp);
      e.preventDefault();
    });
    if (!resizeHandle) return;
    let rx, ry, rw, rh, resizing = false;
    const onResizeMove = (e) => {
      if (!resizing) return;
      panel.style.width = Math.max(220, rw + (e.clientX - rx)) + "px";
      panel.style.height = Math.max(200, rh + (e.clientY - ry)) + "px";
    };
    const onResizeUp = () => {
      resizing = false;
      document.removeEventListener("mousemove", onResizeMove);
      document.removeEventListener("mouseup", onResizeUp);
    };
    resizeHandle.addEventListener("mousedown", (e) => {
      const r = panel.getBoundingClientRect();
      rx = e.clientX; ry = e.clientY; rw = r.width; rh = r.height;
      resizing = true;
      document.addEventListener("mousemove", onResizeMove);
      document.addEventListener("mouseup", onResizeUp);
      e.preventDefault();
      e.stopPropagation();
    });
  },
};
