// Usage: node snapshot.mjs [--selector .site-body] [--out ./out] [--list urls.txt] [url ...]
import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args.splice(i, 2)[1];
};
const selector = opt("--selector", ".site-body");
const outDir = opt("--out", "./out");
const listFile = opt("--list");
const urls = [...args];
if (listFile) {
  urls.push(...(await readFile(listFile, "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
}
if (!urls.length) {
  console.error("No URLs. Usage: node snapshot.mjs [--selector .site-body] [--out ./out] [--list urls.txt] [url ...]");
  process.exit(1);
}

// Runs inside the page: returns { title, css, html, warnings }.
function extract(selector) {
  const warnings = [];
  const root = document.querySelector(selector);
  if (!root) throw new Error(`Selector "${selector}" not found`);

  const scope = [root, ...root.querySelectorAll("*")];
  for (let el = root.parentElement; el; el = el.parentElement) scope.push(el); // inherited font/color

  // Interaction-state and pseudo-element parts can't match a static DOM; drop them just for the test.
  const dynamicPseudo = /::?(hover|focus-within|focus-visible|focus|active|visited|link|target|before|after|placeholder|selection|first-line|first-letter|-webkit-[\w-]+|-moz-[\w-]+|-ms-[\w-]+)/g;
  const isUsed = (selectorText) => {
    const testable = selectorText.replace(dynamicPseudo, "").trim() || "*";
    try {
      return scope.some((el) => el.matches(testable));
    } catch {
      return true; // unparseable after stripping: keep rather than lose styling
    }
  };

  const absolutize = (cssText, base) =>
    cssText.replace(/url\((["']?)([^"')]+)\1\)/g, (m, q, u) =>
      /^(data:|https?:|#)/.test(u) ? m : `url("${new URL(u, base).href}")`);

  const deferred = []; // @font-face / @keyframes, kept only if referenced
  const walk = (rules, base) => {
    const out = [];
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        if (isUsed(rule.selectorText)) out.push(absolutize(rule.cssText, base));
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
        const inner = walk(rule.cssRules, base);
        if (inner.length) {
          const at = rule instanceof CSSMediaRule ? "@media" : "@supports";
          out.push(`${at} ${rule.conditionText} {\n  ${inner.join("\n  ")}\n}`);
        }
      } else if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) out.push(...walk(rule.styleSheet.cssRules, rule.styleSheet.href ?? base));
      } else if (rule instanceof CSSFontFaceRule) {
        deferred.push({ key: rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim(), text: absolutize(rule.cssText, base) });
      } else if (rule instanceof CSSKeyframesRule) {
        deferred.push({ key: rule.name, text: rule.cssText });
      }
    }
    return out;
  };

  const blocks = [];
  for (const sheet of document.styleSheets) {
    const href = sheet.href ?? sheet.ownerNode?.dataset?.href;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      warnings.push(`Skipped cross-origin stylesheet: ${sheet.href}`);
      continue;
    }
    const kept = walk(rules, href ?? location.href);
    if (kept.length) blocks.push(`/* ${href ? new URL(href).pathname : "inline <style>"} */\n${kept.join("\n")}`);
  }
  const used = blocks.join("\n");
  const extras = deferred.filter((d) => d.key && used.includes(d.key)).map((d) => d.text);
  const css = [...extras, ...blocks].join("\n\n");

  const clone = root.cloneNode(true);
  clone.querySelectorAll("script").forEach((s) => s.remove());
  // Absolutize links/images using the live element's resolved property.
  const live = [root, ...root.querySelectorAll("*")];
  [clone, ...clone.querySelectorAll("*")].forEach((el, i) => {
    for (const attr of ["src", "href"]) {
      if (el.hasAttribute(attr) && typeof live[i]?.[attr] === "string") el.setAttribute(attr, live[i][attr]);
    }
  });

  // Keep wrappers between <body> and root so ancestor-scoped rules still apply.
  let node = clone;
  for (let el = root.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const shell = el.cloneNode(false);
    shell.append(node);
    node = shell;
  }

  // Runtime attributes on <html>/<body> (e.g. dir="rtl", class="lang-km") that kept rules depend on.
  const attrs = (el) =>
    [...el.attributes].map((a) => ` ${a.name}="${a.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join("");

  return { title: document.title, css, html: node.outerHTML, htmlAttrs: attrs(document.documentElement), bodyAttrs: attrs(document.body), warnings };
}

// Cross-origin sheets (e.g. Google Fonts) hide cssRules; refetch and inline them so they get filtered too.
async function inlineCrossOriginSheets(page) {
  const hrefs = await page.evaluate(() =>
    [...document.styleSheets]
      .filter((s) => {
        try {
          return !s.cssRules;
        } catch {
          return true;
        }
      })
      .map((s) => s.href));
  for (const href of hrefs) {
    const res = await page.request.get(href);
    if (!res.ok()) continue;
    await page.evaluate(([href, text]) => {
      const link = [...document.querySelectorAll("link[rel~=stylesheet]")].find((l) => l.href === href);
      const style = document.createElement("style");
      style.dataset.href = href;
      style.textContent = text;
      link?.replaceWith(style);
    }, [href, await res.text()]);
  }
}

const fileName = (u) => {
  const url = new URL(u);
  const slug = url.pathname.replace(/^\/+|\/+$/g, "").replace(/[^\w-]+/g, "-") || "index";
  const lang = url.searchParams.get("language");
  return `${slug}${lang ? `.${lang}` : ""}.html`;
};

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
let failed = 0;
try {
  for (const u of urls) {
    try {
      await page.goto(u, { waitUntil: "load" });
      await inlineCrossOriginSheets(page);
      const { title, css, html, htmlAttrs, bodyAttrs, warnings } = await page.evaluate(extract, selector);
      warnings.forEach((w) => console.warn(`  ! ${w}`));
      // Doctype avoids quirks mode (tables stop inheriting font/line-height without it).
      const doc = [
        "<!DOCTYPE html>",
        htmlAttrs && `<html${htmlAttrs}>`,
        '<meta charset="utf-8">',
        `<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>\n`,
        `<style>\n${css}\n</style>`,
        bodyAttrs && `<body${bodyAttrs}>`,
        html,
      ].filter(Boolean).join("\n") + "\n";
      const file = path.join(outDir, fileName(u));
      await writeFile(file, doc, "utf8");
      console.log(`OK   ${u}\n  -> ${file} (${(doc.length / 1024).toFixed(1)} KB)`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${u}\n  ${error.message}`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
