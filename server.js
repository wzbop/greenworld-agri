require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const SERP_API_KEY = process.env.SERP_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const delay = ms => new Promise(res => setTimeout(res, ms));

// ── FILTER DIRECTORY/SOCIAL SITES ──
function isValidBusinessSite(url) {
  const blocked = [
    "facebook.com","instagram.com","twitter.com","x.com","linkedin.com",
    "google.com","yelp.com","angi.com","houzz.com","yellowpages.com",
    "bbb.org","thumbtack.com","homeadvisor.com","tripadvisor.com",
    "mapquest.com","angieslist.com","nextdoor.com","reddit.com",
    "wikipedia.org","wikihow.com","amazon.com","bing.com","yahoo.com"
  ];
  return url.startsWith("http") && !blocked.some(b => url.includes(b));
}

// ── CHECK IF SITE IS ALIVE ──
async function isSiteAlive(url) {
  try {
    const res = await axios.get(url, {
      timeout: 6000,
      maxRedirects: 3,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      validateStatus: s => s < 500
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

// ── SEARCH: SERPAPI ──
async function searchCompanies(query) {
  if (SERP_API_KEY) {
    try {
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=20&api_key=${SERP_API_KEY}`;
      const res = await axios.get(url, { timeout: 10000 });
      const links = res.data.organic_results?.map(r => r.link).filter(Boolean) || [];
      if (links.length) { console.log("✅ SerpAPI:", links.length, "results"); return links; }
    } catch (err) { console.log("⚠️ SerpAPI failed:", err.message); }
  }

  // Fallback: DuckDuckGo
  try {
    const ddg = await searchDuckDuckGo(query);
    if (ddg.length) { console.log("✅ DuckDuckGo:", ddg.length, "results"); return ddg; }
  } catch (err) { console.log("⚠️ DDG failed:", err.message); }

  // Last resort: Google scrape
  console.log("⚠️ Falling back to Google scrape...");
  return await scrapeGoogleDirectly(query);
}

// ── SEARCH: DUCKDUCKGO (FREE) ──
async function searchDuckDuckGo(query) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" });
  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeout: 15000 });
    await page.waitForTimeout(1500);
    const links = await page.$$eval("a.result__a", els =>
      els.map(a => {
        try {
          const u = new URL(a.href);
          const uddg = u.searchParams.get("uddg");
          return uddg ? decodeURIComponent(uddg) : a.href;
        } catch { return a.href; }
      }).filter(h => h.startsWith("http"))
    );
    return [...new Set(links)].slice(0, 25);
  } catch(e) { return []; }
  finally { await browser.close(); }
}

// ── SEARCH: GOOGLE SCRAPE ──
async function scrapeGoogleDirectly(query) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" });
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=20`, { timeout: 15000 });
    const links = await page.$$eval("a[href]", anchors =>
      anchors.map(a => a.href).filter(h => h.startsWith("http") && !h.includes("google.com"))
    );
    return [...new Set(links)].slice(0, 25);
  } catch(e) { return []; }
  finally { await browser.close(); }
}

// ── EMAIL EXTRACTION ──
function extractEmails(text) {
  const standard = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
  const mailto = [...text.matchAll(/mailto:([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/gi)].map(m => m[1]);
  const obfuscated = [...text.matchAll(/([A-Za-z0-9._%+\-]+)\s*[\[\(]?\s*at\s*[\]\)]?\s*([A-Za-z0-9.\-]+)\s*[\[\(]?\s*dot\s*[\]\)]?\s*([A-Za-z]{2,})/gi)]
    .map(m => `${m[1]}@${m[2]}.${m[3]}`);
  return [...new Set([...standard, ...mailto, ...obfuscated])]
    .map(e => e.toLowerCase().trim())
    .filter(e =>
      !e.match(/\.(png|jpg|jpeg|svg|webp|gif|css|js)$/i) &&
      !e.includes("sentry") && !e.includes("example") &&
      !e.includes("wixpress") && !e.includes("schema") &&
      e.length < 80
    );
}

// ── PHONE EXTRACTION ──
function extractPhones(text) {
  const patterns = [
    /(?:\+1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g,
    /\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{2,4}[\s\-.]?\d{2,4}[\s\-.]?\d{2,4}/g,
  ];
  const found = new Set();
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    matches.forEach(m => {
      const digits = m.replace(/\D/g, "");
      if (digits.length >= 10 && digits.length <= 15) found.add(m.trim());
    });
  }
  return [...found].slice(0, 5);
}

// ── SCRAPE SITE ──
async function scrapeSite(page, url) {
  const paths = ["", "/contact", "/contact-us", "/about", "/about-us"];
  const allEmails = new Set();
  const allPhones = new Set();
  let hasWhatsApp = false;
  let combinedText = "";

  for (const p of paths) {
    try {
      const fullUrl = p ? new URL(p, url).href : url;
      await page.goto(fullUrl, { timeout: 15000, waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      const text = await page.evaluate(() => document.body?.innerText || "");
      const html = await page.content();

      // Grab all href attributes — catches tel: and mailto:
      const hrefs = await page.$$eval("a[href]", links =>
        links.map(a => a.getAttribute("href") || "").filter(Boolean)
      );

      // tel: links — most reliable source of phone numbers
      hrefs.filter(h => h.startsWith("tel:")).forEach(h => {
        const num = h.replace("tel:", "").trim();
        const digits = num.replace(/\D/g, "");
        if (digits.length >= 10 && digits.length <= 15) allPhones.add(num);
      });

      // mailto: links — most reliable source of emails
      hrefs.filter(h => h.startsWith("mailto:")).forEach(h => {
        const email = h.replace("mailto:", "").split("?")[0].trim().toLowerCase();
        if (email.includes("@") && email.length < 80) allEmails.add(email);
      });

      combinedText += text + " ";
      extractEmails(text).forEach(e => allEmails.add(e));
      extractEmails(html).forEach(e => allEmails.add(e));
      extractPhones(text).forEach(ph => allPhones.add(ph));
      if (/wa\.me|whatsapp/i.test(html)) hasWhatsApp = true;

    } catch (_) {}
  }

  return { content: combinedText, emails: [...allEmails], phones: [...allPhones], hasWhatsApp };
}

// ── AI ANALYSIS ──
async function analyzeBusiness(content, emails) {
  if (!OPENAI_API_KEY) return null;
  const cleanText = content.replace(/\s+/g, " ").substring(0, 1500);
  const prompt = `Analyze this business for digital marketing opportunities.
Content: ${cleanText}
Emails: ${emails.join(", ")}
Return ONLY valid JSON, no markdown:
{"score":<1-100>,"intent_level":"<low|medium|high>","problems":["..."],"opportunities":["..."],"summary":"<2 sentences>"}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Return only raw JSON. No markdown. No backticks." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 500
        },
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 20000 }
      );
      const raw = res.data.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
      return JSON.parse(raw);
    } catch (err) {
      if (err.response?.status === 429) {
        const wait = 10000 * (attempt + 1);
        console.log(`Rate limit → waiting ${wait / 1000}s...`);
        await delay(wait);
      } else {
        console.log("AI error:", err.message);
        return null;
      }
    }
  }
  return null;
}

// ── MAIN SEARCH ENDPOINT ──
app.get("/api/search", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "No query" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    send("status", { message: `Searching: "${query}"...` });
    let links = await searchCompanies(query);
    links = links.filter(isValidBusinessSite);

    if (!links.length) {
      send("error", { message: "No valid business sites found." });
      return res.end();
    }

    // ── CHECK WHICH SITES ARE ALIVE ──
    send("status", { message: `Checking ${links.length} sites for availability...` });
    const aliveChecks = await Promise.all(links.map(l => isSiteAlive(l)));
    const activeLinks = links.filter((_, i) => aliveChecks[i]).slice(0, 20);

    send("status", { message: `${activeLinks.length} active sites found — starting deep scan...` });
    send("count", { total: activeLinks.length });

    if (!activeLinks.length) {
      send("error", { message: "No active sites found." });
      return res.end();
    }

    const browser = await chromium.launch({ headless: true });

    for (let i = 0; i < activeLinks.length; i++) {
      const link = activeLinks[i];
      let hostname = link;
      try { hostname = new URL(link).hostname; } catch(_) {}
      send("status", { message: `Scanning (${i + 1}/${activeLinks.length}): ${hostname}` });

      try {
        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" });
        const { content, emails, phones, hasWhatsApp } = await scrapeSite(page, link);
        await page.close();

        let analysis = null;
        if (emails.length > 0 && content.length > 300) {
          send("status", { message: `AI analysis: ${hostname}...` });
          analysis = await analyzeBusiness(content, emails);
        }

        send("result", {
          website: link, emails, phones,
          whatsapp: hasWhatsApp,
          score: analysis?.score ?? null,
          intent: analysis?.intent_level ?? null,
          summary: analysis?.summary ?? null,
          problems: analysis?.problems ?? [],
          opportunities: analysis?.opportunities ?? []
        });

      } catch (siteErr) {
        send("result", {
          website: link, emails: [], phones: [], whatsapp: false,
          score: null, intent: null, summary: "Could not fully load this site.",
          problems: [], opportunities: []
        });
      }

      if (i < activeLinks.length - 1) await delay(1500);
    }

    await browser.close();
    send("done", { message: "Scan complete." });

  } catch (err) {
    console.error(err);
    send("error", { message: "Server error: " + err.message });
  }

  res.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🌊 WZBOP → http://localhost:${PORT}\n`));