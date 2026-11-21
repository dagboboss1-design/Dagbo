// Optional second-opinion reviewers for BOSS1. They never create or approve trade levels.
function isNewsQuestion(text) {
  return /\\b(news|geopolit|war|sanction|election|central bank|interest rate|inflation|cpi|nfp|payroll|fomc|fed|ecb|boe|boj|economic calendar)\\b/i.test(String(text || ""));
}
async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 3500);
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("provider_http_" + response.status);
    return data;
  } finally { clearTimeout(timer); }
}
async function reviewNews(question, context) {
  if (!isNewsQuestion(question)) return { reviewers: [], note: "" };
  const task = "Independently assess this user-provided news question/context for factual uncertainty, affected markets, possible transmission channels, and what must be verified from a dated primary source. Do not predict price direction, invent current events, or provide trade entries. If context is insufficient, say so.\nQUESTION: " + String(question).slice(0, 1600) + "\nCONTEXT: " + String(context || "No verified news feed supplied").slice(0, 1800);
  const jobs = [];
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL) {
    jobs.push(postJson("https://api.anthropic.com/v1/messages", {
      "content-type":"application/json", "x-api-key":process.env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01"
    }, { model:process.env.ANTHROPIC_MODEL, max_tokens:180, temperature:0, system:"You are DAGBO's independent news fact-check reviewer. You are not a trading signal generator.", messages:[{role:"user",content:task}] }, 3500)
      .then(d => ({ name:"Claude", text:(d.content||[]).filter(x=>x.type==="text").map(x=>x.text).join(" ").slice(0,900) })));
  }
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL) {
    const model=encodeURIComponent(process.env.GEMINI_MODEL);
    jobs.push(postJson("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+encodeURIComponent(process.env.GEMINI_API_KEY), {
      "content-type":"application/json"
    }, { contents:[{parts:[{text:task}]}], generationConfig:{temperature:0,maxOutputTokens:180} }, 3500)
      .then(d => ({ name:"Gemini", text:((d.candidates||[])[0]?.content?.parts||[]).map(x=>x.text||"").join(" ").slice(0,900) })));
  }
  const settled = await Promise.allSettled(jobs);
  const reviewers = settled.filter(x=>x.status==="fulfilled").map(x=>x.value);
  return { reviewers, note: reviewers.length ? reviewers.map(x=>x.name+": "+x.text).join("\\n") : "" };
}
module.exports = { reviewNews };
