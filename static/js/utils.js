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
};
