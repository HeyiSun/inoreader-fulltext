export function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, char => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"
  })[char]);
}

export function renderRss(entries, { source, title, websiteUrl, feedUrl, description }) {
  const items = entries.map(entry => `
    <item>
      <title>${escapeXml(entry.title)}</title>
      <link>${escapeXml(entry.url)}</link>
      <guid isPermaLink="false">fulltext:${source}:${entry.id}</guid>
      <pubDate>${new Date(entry.published * 1000).toUTCString()}</pubDate>
      <description>${escapeXml(entry.html)}</description>
      <content:encoded>${escapeXml(entry.html)}</content:encoded>
      ${entry.cover ? `<media:thumbnail url="${escapeXml(entry.cover)}"/>` : ""}
      ${(entry.tags || []).map(tag => `<category>${escapeXml(tag)}</category>`).join("")}
    </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(websiteUrl)}</link>
    <description>${escapeXml(description)}</description>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <atom:link href="https://pubsubhubbub.appspot.com/" rel="hub"/>
    ${items}
  </channel>
</rss>`;
}
