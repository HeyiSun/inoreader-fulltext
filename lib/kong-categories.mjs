export const KONG_CATEGORIES = {
  engineering: "Engineering",
  educational: "Educational",
  "learning-center": "Learning Center"
};

export function isKongTechnicalArticle(url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  return ["konghq.com", "www.konghq.com"].includes(parsed.hostname)
    && parts[0] === "blog" && Object.hasOwn(KONG_CATEGORIES, parts[1]);
}
