import { renderRss } from "../lib/rss.mjs";
import { isKongTechnicalArticle } from "../lib/kong-categories.mjs";
export { escapeXml } from "../lib/rss.mjs";

const SOURCES = {
  "openai-engineering": "OpenAI Engineering 全文",
  "openai-research": "OpenAI Research 全文",
  "openai-developer": "OpenAI Developer Blog 全文",
  "kong": "Kong Blog 全文"
};

const ALLOWED_HOSTS = new Set(["openai.com", "www.openai.com", "developers.openai.com", "konghq.com", "www.konghq.com"]);
const KONG_ARCHIVE_PATH = "/rss/kong-blog.xml";
const KONG_ARCHIVE_KEY = "archive:kong";


export function normalizeItems(payload) {
  if (!Array.isArray(payload.items) || payload.items.length > 20) {
    throw new Error("Expected 1–20 Inoreader items");
  }
  return payload.items.map(item => {
    const url = new URL(item.canonical?.[0]?.href || item.alternate?.[0]?.href || item.url);
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error("This website is not enabled");
    }
    url.hash = "";
    const origin = item.origin?.streamId || "";
    let source = "openai-research";
    if (url.hostname === "developers.openai.com") source = "openai-developer";
    if (origin.includes("engineering")) source = "openai-engineering";
    if (url.hostname === "konghq.com" || url.hostname === "www.konghq.com") source = "kong";
    if (item.source && SOURCES[item.source]) source = item.source;
    return {
      url: url.href,
      source,
      title: String(item.title || "").slice(0, 500),
      published: Number(item.published) || Math.floor(Date.now() / 1000),
      originalId: String(item.id || "").slice(0, 200)
    };
  });
}

async function articleKey(url) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.replace(/\/$/, "")));
  return Array.from(new Uint8Array(bytes)).map(x => x.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function feedPath(source) {
  return `/rss/${source === "kong" ? "kong-blog" : source}.xml`;
}

async function renderFeed(request, env, source) {
  const base = new URL(request.url).origin;
  const feedUrl = base + feedPath(source);
  const websiteUrl = source === "kong" ? "https://konghq.com/blog" : "https://openai.com/news/";
  if (source === "kong") {
    const archive = await env.CONTENT.getWithMetadata(KONG_ARCHIVE_KEY, "arrayBuffer");
    if (archive.value) return new Response(archive.value, { encodeBody: "manual", headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Content-Encoding": "gzip",
      "Cache-Control": "public, max-age=30",
      "Access-Control-Allow-Origin": "*"
    } });
  }
  const listed = await env.CONTENT.list({ prefix: `article:${source}:`, limit: 1000 });
  const newest = listed.keys.sort((a, b) => (b.metadata?.published || 0) - (a.metadata?.published || 0)).slice(0, 20);
  const entries = (await Promise.all(newest.map(key => env.CONTENT.get(key.name, "json"))))
    .filter(entry => entry && (source !== "kong" || isKongTechnicalArticle(entry.url)));
  const xml = renderRss(entries, {
    source,
    title: SOURCES[source],
    websiteUrl,
    feedUrl,
    description: "保留配图和静态图表的全文阅读源"
  });
  return new Response(xml, { headers: {
    "Content-Type": "application/rss+xml; charset=utf-8",
    "Cache-Control": "public, max-age=30",
    "Access-Control-Allow-Origin": "*"
  } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({ service: "inoreader-fulltext", feeds: Object.keys(SOURCES).map(feedPath) });
      }
      if (request.method === "GET" && url.pathname === "/rss/kong-technical-history.xml") {
        return Response.redirect(url.origin + KONG_ARCHIVE_PATH, 301);
      }
      const feedSlug = parts[1]?.replace(/\.xml$/, "");
      const feedSource = feedSlug === "kong-blog" ? "kong" : feedSlug;
      if (request.method === "GET" && ["rss", "feeds"].includes(parts[0]) && SOURCES[feedSource]) {
        return renderFeed(request, env, feedSource);
      }
      if (request.method === "GET" && parts[0] === "images") {
        const image = await env.CONTENT.getWithMetadata(`image:${parts.slice(1).join("/")}`, "arrayBuffer");
        if (!image.value) return new Response("Image not found", { status: 404 });
        return new Response(image.value, { headers: {
          "Content-Type": image.metadata?.contentType || "image/png",
          "Cache-Control": "public, max-age=31536000, immutable",
          "Access-Control-Allow-Origin": "*"
        } });
      }
      if (request.method === "POST" && parts[0] === "hooks" && parts[1] === env.HOOK_SECRET) {
        const payload = await request.json();
        const items = normalizeItems(payload).filter(item => item.source !== "kong" || isKongTechnicalArticle(item.url));
        if (!items.length) return json({ accepted: 0 });
        const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "inoreader-fulltext",
            "X-GitHub-Api-Version": "2022-11-28"
          },
          body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { articles: JSON.stringify(items) } })
        });
        if (!response.ok) return json({ error: "GitHub did not accept the job", status: response.status }, 502);
        return json({ accepted: items.length }, 202);
      }
      if (!env.PUBLISH_SECRET || request.headers.get("Authorization") !== `Bearer ${env.PUBLISH_SECRET}`) {
        return json({ error: "Unauthorized" }, 401);
      }
      if (request.method === "PUT" && url.pathname === "/api/archives/kong") {
        const count = Number(request.headers.get("X-Article-Count"));
        if (!Number.isInteger(count) || count < 1 || count > 5000) return json({ error: "Invalid article count" }, 400);
        const body = await request.arrayBuffer();
        const bytes = new Uint8Array(body);
        if (bytes.length > 25 * 1024 * 1024 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
          return json({ error: "Expected a gzip archive within the KV size limit" }, 400);
        }
        await env.CONTENT.put(KONG_ARCHIVE_KEY, body, { metadata: { count, publishedAt: Date.now() } });
        return json({ count, bytes: body.byteLength, feed: url.origin + KONG_ARCHIVE_PATH }, 201);
      }
      if (request.method === "PUT" && parts[0] === "api" && parts[1] === "images") {
        const key = parts.slice(2).join("/");
        if (!/^[a-z0-9/_-]+\.(png|jpg|webp)$/.test(key)) return json({ error: "Invalid image key" }, 400);
        const contentType = request.headers.get("Content-Type");
        if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) return json({ error: "Invalid image type" }, 400);
        await env.CONTENT.put(`image:${key}`, await request.arrayBuffer(), { metadata: { contentType } });
        return json({ url: `${url.origin}/images/${key}` }, 201);
      }
      if (parts[0] === "api" && parts[1] === "articles" && SOURCES[parts[2]]) {
        const source = parts[2];
        const id = await articleKey(url.searchParams.get("url") || "");
        const key = `article:${source}:${id}`;
        if (request.method === "GET") {
          const article = await env.CONTENT.get(key, "json");
          return article ? json(article) : json({ error: "Not found" }, 404);
        }
        if (request.method === "PUT") {
          const article = await request.json();
          const normalized = normalizeItems({ items: [{ ...article, source }] })[0];
          if (source === "kong" && !isKongTechnicalArticle(normalized.url)) return json({ error: "Kong category is not selected" }, 400);
          if (await articleKey(normalized.url) !== id) return json({ error: "URL mismatch" }, 400);
          if (typeof article.html !== "string" || article.html.length > 1500000) return json({ error: "Invalid article HTML" }, 400);
          const entry = { ...normalized, id, html: article.html, cover: article.cover || "", tags: article.tags || [], capturedAt: Date.now() };
          await env.CONTENT.put(key, JSON.stringify(entry), { metadata: { published: entry.published } });
          return json({ id, feed: url.origin + feedPath(source) }, 201);
        }
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  }
};
