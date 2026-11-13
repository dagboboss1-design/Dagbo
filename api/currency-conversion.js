const CONVERSIONS = {
  JPY: { symbol: "USD/JPY", invert: true },
  GBP: { symbol: "GBP/USD", invert: false },
  EUR: { symbol: "EUR/USD", invert: false },
  CHF: { symbol: "USD/CHF", invert: true },
  CAD: { symbol: "USD/CAD", invert: true },
  AUD: { symbol: "AUD/USD", invert: false },
  NZD: { symbol: "NZD/USD", invert: false }
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=60");
  if (req.method !== "GET") return res.status(405).json({ error: "GET required" });

  const currency = String(req.query && req.query.currency || "").toUpperCase();
  if (currency === "USD") return res.status(200).json({ currency, usdPerUnit: 1 });
  const conversion = CONVERSIONS[currency];
  if (!conversion) return res.status(400).json({ error: "Unsupported quote currency" });

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "TWELVE_DATA_API_KEY is not configured" });

  try {
    const url = "https://api.twelvedata.com/price?symbol=" +
      encodeURIComponent(conversion.symbol) + "&apikey=" + encodeURIComponent(apiKey);
    const response = await fetch(url);
    const data = await response.json();
    const marketPrice = Number(data && data.price);
    if (!response.ok || data.status === "error" || !Number.isFinite(marketPrice) || marketPrice <= 0) {
      throw new Error(data && data.message ? data.message : "No valid conversion rate returned");
    }
    const usdPerUnit = conversion.invert ? 1 / marketPrice : marketPrice;
    return res.status(200).json({ currency, usdPerUnit, marketPrice, symbol: conversion.symbol });
  } catch (error) {
    console.error("DAGBO quote-currency conversion failed:", error.message);
    return res.status(502).json({ error: "Quote-currency conversion is temporarily unavailable" });
  }
};
