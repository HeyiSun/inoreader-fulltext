import sanitizeHtml from "sanitize-html";

export function extractArticleHtml({ selector, snapshots = [], articleUrl, document: suppliedDocument }) {
  const document = suppliedDocument || globalThis.document;
  const root = document.querySelector(selector).cloneNode(true);
  if (selector === "main .toc-body") {
    for (const element of root.querySelectorAll(".agent")) element.remove();
  }
  const figures = Array.from(root.querySelectorAll("figure"));
  for (const snapshot of snapshots) {
    const target = figures[snapshot.index];
    if (!target || !root.contains(target)) continue;
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
  for (const element of root.querySelectorAll("nav,script,style,button,form,select,input,iframe,footer,[aria-hidden=true],pre .linenumber,pre .react-syntax-highlighter-line-number")) element.remove();
  for (const heading of root.querySelectorAll("h1,h2,h3")) {
    if (heading.textContent.trim() === "Keep reading") {
      let section = heading;
      while (section.parentElement && section.parentElement !== root && section.parentElement.children.length < 5) section = section.parentElement;
      section.remove();
    }
  }
  for (const image of root.querySelectorAll("img")) {
    const src = image.getAttribute("src") || image.getAttribute("data-src");
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
    try {
      link.setAttribute("href", new URL(link.getAttribute("href"), articleUrl).href);
    } catch {
      link.removeAttribute("href");
    }
  }
  for (const math of root.querySelectorAll(".katex")) {
    const text = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (text) math.replaceWith(document.createTextNode(text));
  }
  for (const pre of root.querySelectorAll("pre")) {
    const code = document.createElement("code");
    code.textContent = pre.textContent;
    pre.replaceChildren(code);
  }
  return root.innerHTML;
}

export function sanitizeArticleHtml(html) {
  return sanitizeHtml(html, {
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
}
