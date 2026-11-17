import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import sanitizeHtml from "sanitize-html";
import sharp from "sharp";
import { XMLParser } from "fast-xml-parser";

const outputDirectory = "artifacts";
const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
const publishSecret = process.env.PUBLISH_SECRET;
const allowedHosts = new Set(["openai.com", "www.openai.com", "developers.openai.com"]);
const articles = JSON.parse(process.env.ARTICLE_INPUT || "[]");
const feedCache = new Map();

if (!Array.isArray(articles) || !articles.length || articles.length > 20) {
  throw new Error("ARTICLE_INPUT must contain 1–20 articles");
}
for (const article of articles) {
  const url = new URL(article.url);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
    throw new Error("Article domain is not enabled");
  }
  if (!["openai-engineering", "openai-research", "openai-developer"].includes(article.source)) {
    throw new Error("Unknown feed");
  }
}
await mkdir(outputDirectory, { recursive: true });

async function api(path, options = {}) {
  const response = await fetch(workerUrl + path, {
    ...options,
    headers: { Authorization: `Bearer ${publishSecret}`, ...options.headers },
    signal: AbortSignal.timeout(30000)
  });
  return response;
}

async function publishImage(buffer, articleId, index) {
  const name = `${articleId}/${index}.png`;
  const png = await sharp(buffer).resize({ width: 1800, withoutEnlargement: true }).png().toBuffer();
  await writeFile(`${outputDirectory}/${articleId}-${index}.png`, png);
  if (!workerUrl || !publishSecret) return `${articleId}-${index}.png`;
  const response = await api(`/api/images/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: png
  });
  if (!response.ok) throw new Error(`Image publishing failed (${response.status})`);
  return (await response.json()).url;
}

async function loadArticle(page, url) {
  const selector = new URL(url).hostname === "developers.openai.com" ? "main" : "#main article";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(selector).waitFor({ state: "visible", timeout: 10000 });
  await page.evaluate(async selector => {
    const article = document.querySelector(selector);
    for (const figure of article.querySelectorAll("figure")) {
      figure.scrollIntoView({ block: "center" });
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    for (const image of article.querySelectorAll("img")) image.loading = "eager";
    await Promise.race([
      Promise.all(Array.from(article.querySelectorAll("img")).map(image => image.decode().catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 8000))
    ]);
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]);
  }, selector);
  return selector;
}

async function loadFromFulltextFeed(page, article) {
  const routes = article.source === "openai-research"
    ? ["https://rsshub.rss3.workers.dev/openai/research?limit=40", "https://rsshub.rssforever.com/openai/news?limit=100"]
    : ["https://rsshub.rssforever.com/openai/news?limit=100", "https://rsshub.rssforever.com/openai/news?limit=50"];
  const normalizedUrl = article.url.replace(/\/$/, "");
  for (const feedUrl of routes) {
    try {
      if (!feedCache.has(feedUrl)) {
        const response = await fetch(feedUrl, { signal: AbortSignal.timeout(55000) });
        if (!response.ok) throw new Error(`RSS returned ${response.status}`);
        const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
        const parsed = parser.parse(await response.text());
        const entries = parsed.rss?.channel?.item;
        feedCache.set(feedUrl, Array.isArray(entries) ? entries : entries ? [entries] : []);
      }
      const match = feedCache.get(feedUrl).find(item => String(item.link).replace(/\/$/, "") === normalizedUrl);
      const body = match?.["content:encoded"] || match?.description;
      if (typeof body !== "string" || body.length < 1000) continue;
      const safe = sanitizeHtml(body, {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
          "img", "figure", "figcaption", "svg", "g", "path", "rect", "circle", "line", "polyline", "polygon", "text", "tspan", "defs", "clipPath", "marker"
        ]),
        allowedAttributes: { "*": ["*"] },
        parser: { lowerCaseAttributeNames: false, lowerCaseTags: false },
        allowedSchemes: ["http", "https", "data"],
        allowVulnerableTags: false
      });
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><base href="${article.url}">
      <style>
        :root{--color-text:#202020;--color-border:#ccc;--color-background:#fff;--color-primary:#202020;--color-brand:#9b76de;--color-token-text-primary:#202020;--color-token-border-light:#ddd;--color-token-bg-primary:#fff}
        *{box-sizing:border-box}body{font:18px/1.65 Arial,sans-serif;color:#202020;background:#fff;margin:0;padding:36px}
        main{max-width:1100px;margin:auto}h1,h2,h3,h4{line-height:1.3}p{margin:1em 0}figure{margin:32px 0;padding:20px;border:1px solid #eee;background:#fff}
        img,svg{max-width:100%;height:auto}img{display:block;margin:16px auto}figcaption{font-size:15px;color:#555}button,input,select,nav{display:none}
        svg{color:#222;--line:#666;--ink:#222;--muted:#777;--accent:#9b76de;--bg:#fff}
      </style></head><body><main><h1>${sanitizeHtml(match.title || article.title, {allowedTags:[]})}</h1>${safe}</main></body></html>`, {waitUntil:"domcontentloaded"});
      await page.evaluate(async () => {
        await Promise.race([
          Promise.all(Array.from(document.querySelectorAll("img")).map(image => image.decode().catch(() => {}))),
          new Promise(resolve => setTimeout(resolve, 8000))
        ]);
      });
      return { selector: "main", feedUrl };
    } catch (error) {
      console.log(`Full-text source unavailable: ${new URL(feedUrl).hostname} (${error.message})`);
    }
  }
  throw new Error("Original page and full-text sources are unavailable");
}

async function capture(article, browser) {
  const id = createHash("sha256").update(article.url.replace(/\/$/, "")).digest("hex").slice(0, 24);
  const itemPath = `/api/articles/${article.source}?url=${encodeURIComponent(article.url)}`;
  if (workerUrl && publishSecret && !article.force) {
    const existing = await api(itemPath);
    if (existing.ok) return { id, url: article.url, source: article.source, cached: true };
    if (existing.status !== 404) throw new Error(`Cannot check existing article (${existing.status})`);
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1.5,
    colorScheme: "light"
  });
  const page = await context.newPage();
  try {
    let selector;
    let fallbackSource;
    try {
      selector = await loadArticle(page, article.url);
    } catch {
      const fallback = await loadFromFulltextFeed(page, article);
      selector = fallback.selector;
      fallbackSource = fallback.feedUrl;
    }
    const title = await page.locator("h1").first().innerText();
    const cover = await page.locator('meta[property="og:image"]').getAttribute("content").catch(() => null);
    const figures = page.locator(`${selector} figure`);
    const count = await figures.count();
    const snapshots = [];
    for (let i = 0; i < count; i++) {
      const figure = figures.nth(i);
      const nested = await figure.evaluate(el => Boolean(el.parentElement.closest("figure")));
      if (nested) continue;
      const drawable = await figure.evaluate(el => Boolean(el.querySelector("svg,canvas")));
      if (!drawable) continue;
      await figure.scrollIntoViewIfNeeded();
      const buffer = await figure.screenshot({ animations: "disabled", timeout: 15000 });
      const url = await publishImage(buffer, id, snapshots.length);
      const label = await figure.evaluate(el => el.querySelector("h1,h2,h3,h4")?.textContent || el.getAttribute("aria-label") || "Article figure");
      snapshots.push({ index: i, url, label });
    }

    const html = await page.evaluate(({ selector, snapshots, articleUrl }) => {
      const root = document.querySelector(selector).cloneNode(true);
      const figures = Array.from(root.querySelectorAll("figure"));
      for (const snapshot of snapshots) {
        const target = figures[snapshot.index];
        if (!target || !target.isConnected && !root.contains(target)) continue;
        const replacement = document.createElement("figure");
        const image = document.createElement("img");
        image.src = snapshot.url;
        image.alt = snapshot.label;
        replacement.append(image);
        const caption = target.querySelector(":scope > figcaption");
        if (caption) replacement.append(caption.cloneNode(true));
        const note = document.createElement("figcaption");
        const link = document.createElement("a");
        link.href = articleUrl;
        link.textContent = "图表静态快照 · 原文可操作交互图表";
        note.append(link);
        replacement.append(note);
        target.replaceWith(replacement);
      }

      for (const figure of root.querySelectorAll("figure")) {
        if (!figure.querySelector("img,svg,canvas") && !figure.textContent.trim()) {
          const link = document.createElement("a");
          link.href = articleUrl;
          link.textContent = "此处为原网页动态图表，点击查看";
          figure.replaceWith(link);
        }
      }
      for (const element of root.querySelectorAll("nav,script,style,button,form,select,input,iframe,footer,[aria-hidden=true]")) element.remove();
      for (const heading of root.querySelectorAll("h1,h2,h3")) {
        if (heading.textContent.trim() === "Keep reading") {
          let section = heading;
          while (section.parentElement && section.parentElement !== root && section.parentElement.children.length < 5) section = section.parentElement;
          section.remove();
        }
      }
      for (const image of root.querySelectorAll("img")) {
        let src = image.getAttribute("src") || image.getAttribute("data-src");
        if (!src) { image.remove(); continue; }
        const url = new URL(src, articleUrl);
        if (url.hostname === "images.ctfassets.net" && url.pathname.toLowerCase().endsWith(".svg")) {
          url.search = "";
          url.searchParams.set("fm", "png");
          url.searchParams.set("w", "1600");
        }
        image.setAttribute("src", url.href);
        image.removeAttribute("srcset");
        image.removeAttribute("sizes");
      }
      for (const link of root.querySelectorAll("a[href]")) {
        link.setAttribute("href", new URL(link.getAttribute("href"), articleUrl).href);
      }
      for (const math of root.querySelectorAll(".katex")) {
        const text = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
        if (text) math.replaceWith(document.createTextNode(text));
      }
      return root.innerHTML;
    }, { selector, snapshots, articleUrl: article.url });

    const cleaned = sanitizeHtml(html, {
      allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6"],
      allowedAttributes: {
        a: ["href", "title"],
        img: ["src", "alt", "width", "height"],
        td: ["colspan", "rowspan"],
        th: ["colspan", "rowspan"]
      },
      allowedSchemes: ["http", "https"],
      transformTags: { div: "div" }
    });
    const imageCount = (cleaned.match(/<img\b/g) || []).length;
    const textLength = sanitizeHtml(cleaned, { allowedTags: [], allowedAttributes: {} }).trim().length;
    if (textLength < 500) throw new Error("Extracted content is unexpectedly short");
    await writeFile(`${outputDirectory}/${id}.html`, cleaned);

    const entry = {
      ...article,
      title: title || article.title,
      html: `<p><a href="${article.url}">原文</a></p>${cleaned}`,
      cover: snapshots[0]?.url || cover || "",
      published: article.published || Math.floor(Date.now() / 1000)
    };
    if (workerUrl && publishSecret) {
      const response = await api(itemPath, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry)
      });
      if (!response.ok) throw new Error(`Article publishing failed (${response.status})`);
    }
    return { id, title: entry.title, url: article.url, source: article.source, imageCount, textLength, staticSnapshots: snapshots.length, fallbackSource };
  } catch (error) {
    await page.screenshot({ path: `${outputDirectory}/${id}-error.png`, fullPage: false }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const report = [];
try {
  for (const article of articles) {
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await capture(article, browser);
        break;
      } catch (error) {
        console.error(`Attempt ${attempt} failed for ${article.url}: ${error.message}`);
        if (attempt === 3) result = { url: article.url, source: article.source, error: error.message };
      }
    }
    report.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  await browser.close();
}

await writeFile(`${outputDirectory}/report.json`, JSON.stringify(report, null, 2));
if (workerUrl && publishSecret) {
  for (const source of new Set(report.filter(item => !item.error && !item.cached).map(item => item.source))) {
    const feedUrl = `${workerUrl}/feeds/${source}.xml`;
    const hubResponse = await fetch("https://pubsubhubbub.appspot.com/", {
      method: "POST",
      body: new URLSearchParams({ "hub.mode": "publish", "hub.url": feedUrl }),
      signal: AbortSignal.timeout(20000)
    });
    console.log(`Feed updated: ${feedUrl}; hub response ${hubResponse.status}`);
  }
}
if (report.some(item => item.error)) process.exitCode = 1;
