(function () {
  "use strict";

  window.isTeacherEventVisible = function (event, options = {}) {
    const status = String(event?.status || "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    return ["approved", "published", "rescheduled"].includes(status) ||
      Boolean(options.includeCancelled && ["cancelled", "canceled"].includes(status));
  };
})();
