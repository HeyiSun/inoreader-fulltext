import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { renderRss } from "./rss.mjs";
import { KONG_CATEGORIES, isKongTechnicalArticle } from "./kong-categories.mjs";

export function mergeKongEntries(existing, incoming) {
  const entries = new Map();
  for (const entry of [...existing, ...incoming]) {
    if (!isKongTechnicalArticle(entry.url)) continue;
    const url = entry.url.replace(/\/$/, "");
    const id = createHash("sha256").update(url).digest("hex").slice(0, 24);
    entries.set(id, { ...entry, id, url });
  }
  return [...entries.values()].sort((a, b) => b.published - a.published);
}

export function readKongFeed(xml) {
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
  if (!parsed.rss?.channel) throw new Error("Kong feed is not valid RSS");
  const items = parsed.rss.channel.item || [];
  return (Array.isArray(items) ? items : [items]).map(item => ({
    url: item.link,
    title: item.title,
    published: Math.floor(Date.parse(item.pubDate) / 1000),
    html: item["content:encoded"] || item.description,
    cover: item["media:thumbnail"]?.["@_url"] || "",
    tags: Array.isArray(item.category) ? item.category : item.category ? [item.category] : []
  }));
}

export function renderKongFeed(entries, workerUrl) {
  const datedEntries = entries.map(entry => {
    if (entry.html.startsWith("<p>原始发布日期 ")) return entry;
    const date = new Date(entry.published * 1000).toISOString().slice(0, 10);
    const category = KONG_CATEGORIES[new URL(entry.url).pathname.split("/")[2]];
    return { ...entry, html: `<p>原始发布日期 ${date} · ${category}</p>${entry.html}` };
  });
  return renderRss(datedEntries, {
    source: "kong",
    title: "Kong Blog 全文",
    websiteUrl: "https://konghq.com/blog",
    feedUrl: `${workerUrl}/rss/kong-blog.xml`,
    description: "Engineering、Educational、Learning Center 的历史与最新全文"
  });
}

export async function publishKongFeed(entries, workerUrl, publishSecret) {
  const compressed = gzipSync(renderKongFeed(entries, workerUrl), { level: 9 });
  const response = await fetch(`${workerUrl}/api/archives/kong`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${publishSecret}`,
      "Content-Type": "application/gzip",
      "X-Article-Count": String(entries.length)
    },
    body: compressed,
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Kong feed publishing failed: HTTP ${response.status}`);
  return response.json();
}
