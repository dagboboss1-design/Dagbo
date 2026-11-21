// Backward-compatible endpoint for older schedulers.
// Use the live calendar, Redis deduplication and guarded news monitor;
// never generate guessed CPI/NFP/FOMC dates.
module.exports = require("./news-monitor");
