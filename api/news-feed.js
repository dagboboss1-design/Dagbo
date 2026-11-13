const FEED_URL = "https://www.fxstreet.com/rss/news";

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function readTag(block, name) {
  const match = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return match ? decodeXml(match[1]) : "";
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
  if (req.method !== "GET") return res.status(405).json({ status: "error", error: "GET required" });

  try {
    const response = await fetch(FEED_URL, {
      headers: { "User-Agent": "DAGBO-SIGNAL-News/1.0", "Accept": "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error("FXStreet RSS returned HTTP " + response.status);
    const xml = await response.text();
    const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
    const items = blocks.slice(0, 12).map(block => {
      const rawLink = readTag(block, "link");
      let link = "";
      try {
        const parsed = new URL(rawLink);
        if (parsed.protocol === "https:" && parsed.hostname === "www.fxstreet.com") link = parsed.href;
      } catch (_) {}
      const pubDate = readTag(block, "pubDate");
      return { title: readTag(block, "title").slice(0, 240), link, pubDate };
    }).filter(item => item.title && item.link);

    if (!items.length) throw new Error("FXStreet RSS did not contain usable headlines");
    return res.status(200).json({ status: "ok", source: "FXStreet", fetchedAt: new Date().toISOString(), items });
  } catch (error) {
    console.error("DAGBO news feed error:", error.message);
    return res.status(502).json({ status: "error", error: "Market news feed is temporarily unavailable" });
  }
};
