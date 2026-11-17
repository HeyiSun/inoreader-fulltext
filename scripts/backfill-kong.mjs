import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { XMLParser } from "fast-xml-parser";
import { extractArticleHtml, sanitizeArticleHtml } from "./article-content.mjs";
import { escapeXml, renderRss } from "../lib/rss.mjs";

const categories = new Set(["engineering", "educational", "learning-center"]);
const outputDirectory = "artifacts/kong-history-entries";
const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
const publishSecret = process.env.PUBLISH_SECRET;
const limit = Number(process.env.BACKFILL_LIMIT || 0);
const categoryNames = { engineering: "Engineering", educational: "Educational", "learning-center": "Learning Center" };

function articleId(url) {
  return createHash("sha256").update(url.replace(/\/$/, "")).digest("hex").slice(0, 24);
}

async function fetchText(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { html: await response.text(), url: response.url };
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
}

async function readArticle(inputUrl) {
  const path = `${outputDirectory}/${articleId(inputUrl)}.json`;
  const cached = await readFile(path, "utf8").then(JSON.parse).catch(() => null);
  if (cached?.inputUrl === inputUrl && cached.html && cached.published) return cached;

  const response = await fetchText(inputUrl);
  const { document } = parseHTML(response.html);
  const pageData = document.querySelector('script[id="__NEXT_DATA__"]')?.textContent;
  const page = pageData ? JSON.parse(pageData).props?.pageProps?.page : null;
  if (!page?.title || !page.publishedAt) throw new Error("Article metadata is missing");
  const published = Math.floor(Date.parse(page.publishedAt) / 1000);
  if (!Number.isFinite(published)) throw new Error("Publication date is invalid");
  const category = page.categories?.slug;
  if (!categories.has(category)) throw new Error(`Unexpected category: ${category}`);

  const root = document.querySelector("main .toc-body");
  if (!root) throw new Error("Article body is missing");
  const url = new URL(document.querySelector('link[rel="canonical"]')?.getAttribute("href") || response.url, response.url);
  if (!["konghq.com", "www.konghq.com"].includes(url.hostname) || !url.pathname.startsWith("/blog/")) {
    throw new Error("Article redirected outside the Kong blog");
  }
  url.hash = "";

  for (const frame of root.querySelectorAll("iframe[src]")) {
    const link = document.createElement("a");
    link.href = new URL(frame.getAttribute("src"), url).href;
    link.textContent = "查看原文嵌入内容";
    frame.replaceWith(link);
  }

  const html = sanitizeArticleHtml(extractArticleHtml({
    selector: "main .toc-body", articleUrl: url.href, document
  }));
  const plain = root.textContent.trim();
  if (plain.length < 50) throw new Error("Article body is unexpectedly short");
  const entry = {
    inputUrl,
    id: articleId(url.href),
    url: url.href,
    title: page.title,
    published,
    category,
    tags: [categoryNames[category], ...(page.tags || []).map(tag => tag.title)],
    cover: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
    html: `<p><a href="${escapeXml(url.href)}">原文</a></p>${html}`,
    images: (html.match(/<img\b/g) || []).length,
    codeBlocks: (html.match(/<pre\b/g) || []).length,
    inlineDiagrams: root.querySelectorAll("svg,canvas").length
  };
  await writeFile(path + ".tmp", JSON.stringify(entry));
  await rename(path + ".tmp", path);
  return entry;
}

await mkdir(outputDirectory, { recursive: true });
const sitemap = new XMLParser().parse((await fetchText("https://konghq.com/sitemaps/blogs.xml")).html);
const allUrls = [...new Set(sitemap.urlset.url.map(item => item.loc).filter(url => {
  const path = new URL(url).pathname.split("/").filter(Boolean);
  return path.length === 3 && path[0] === "blog" && categories.has(path[1]);
}))];
const urls = limit > 0 ? allUrls.slice(0, limit) : allUrls;
const entries = [];
const failures = [];
let next = 0;
let completed = 0;

async function worker() {
  while (next < urls.length) {
    const url = urls[next++];
    try {
      entries.push(await readArticle(url));
    } catch (error) {
      failures.push({ url, error: error.message });
    }
    completed++;
    if (completed % 50 === 0 || completed === urls.length) {
      console.log(JSON.stringify({ completed, total: urls.length, failures: failures.length }));
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

await Promise.all(Array.from({ length: 4 }, worker));
const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()].sort((a, b) => b.published - a.published);
const base = workerUrl || "https://inoreader-fulltext.inoreader-fulltext.workers.dev";
const feedUrl = `${base}/rss/kong-technical-history.xml`;
const xml = renderRss(unique, {
  source: "kong",
  title: "Kong 技术历史全文",
  websiteUrl: "https://konghq.com/blog",
  feedUrl,
  description: "Engineering、Educational、Learning Center 历史全文"
});
const compressed = gzipSync(xml, { level: 9 });
await writeFile("artifacts/kong-technical-history.xml.gz", compressed);
const report = {
  discovered: allUrls.length,
  processed: urls.length,
  captured: entries.length,
  uniqueArticles: unique.length,
  failures,
  categories: Object.fromEntries([...categories].map(category => [category, unique.filter(entry => entry.category === category).length])),
  oldest: unique.at(-1)?.published,
  newest: unique[0]?.published,
  images: unique.reduce((sum, entry) => sum + entry.images, 0),
  codeBlocks: unique.reduce((sum, entry) => sum + entry.codeBlocks, 0),
  inlineDiagrams: unique.filter(entry => entry.inlineDiagrams).map(entry => ({ url: entry.url, count: entry.inlineDiagrams })),
  xmlBytes: Buffer.byteLength(xml),
  compressedBytes: compressed.length,
  feedUrl
};
await writeFile("artifacts/kong-backfill-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

if (failures.length) throw new Error(`${failures.length} articles need another attempt; completed articles are cached locally`);
if (workerUrl && publishSecret && !limit) {
  const response = await fetch(`${workerUrl}/api/archives/kong-technical-history`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${publishSecret}`, "Content-Type": "application/gzip", "X-Article-Count": String(unique.length) },
    body: compressed,
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Archive publishing failed: HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json()));
}
