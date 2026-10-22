import * as cheerio from "cheerio";
import { HttpError } from "./errors.js";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "en-GB,en;q=0.9",
  Accept: "text/html,application/xhtml+xml",
};

const MAX_PAGES = 50;
const PAGE_DELAY_MS = 750;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseWishlistUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new HttpError(400, "Wishlist URL is required");

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, "That doesn't look like a valid URL");
  }
  if (!/(^|\.)amazon\.[a-z.]+$/i.test(url.hostname)) {
    throw new HttpError(400, "Only Amazon wishlist URLs are supported");
  }

  const match =
    url.pathname.match(/\/hz\/wishlist\/ls\/([A-Z0-9]+)/i) ||
    url.pathname.match(/\/registry\/wishlist\/([A-Z0-9]+)/i) ||
    url.pathname.match(/\/gp\/registry\/wishlist\/([A-Z0-9]+)/i);
  if (!match) throw new HttpError(400, "Couldn't find a wishlist ID in that URL");

  const id = match[1].toUpperCase();
  const origin = `https://${url.hostname.replace(/^smile\./, "www.")}`;
  return { id, origin, url: `${origin}/hz/wishlist/ls/${id}` };
}

function clean(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function parseItems($, origin) {
  const items = [];
  $("li[data-itemid]").each((_, el) => {
    const li = $(el);
    const itemId = li.attr("data-itemid");
    const nameLink = li.find("a[id^=itemName_]").first();

    let asin = null;
    try {
      const params = JSON.parse(li.attr("data-reposition-action-params") || "{}");
      asin = (params.itemExternalId || "").match(/ASIN:([A-Z0-9]+)/)?.[1] ?? null;
    } catch {}

    const href = nameLink.attr("href");
    const price = Number.parseFloat(li.attr("data-price"));

    items.push({
      itemId,
      asin,
      title: clean(nameLink.attr("title") || nameLink.text()) || "(untitled item)",
      url: href ? new URL(href.split("?")[0], origin).href : asin ? `${origin}/dp/${asin}` : null,
      image: li.find("img").first().attr("src") || null,
      byline: clean(li.find("[id^=item-byline-]").text()) || null,
      price: Number.isFinite(price) ? price : null,
      priority: clean(li.find("[id^=itemPriorityLabel_]").text()).replace(/^>\s*/, "") || null,
      comment: clean(li.find("[id^=itemComment_]").text()) || null,
      requested: Number.parseInt(clean(li.find("[id^=itemRequested_]").text()), 10) || null,
      has: Number.parseInt(clean(li.find("[id^=itemPurchased_]").text()), 10) || 0,
    });
  });
  return items;
}

function findShowMoreUrl($, html) {
  let next = null;
  $("script[data-a-state]").each((_, s) => {
    if (next || !($(s).attr("data-a-state") || "").includes("scrollState")) return;
    try {
      next = JSON.parse($(s).html()).showMoreUrl || null;
    } catch {}
  });
  if (!next) next = html.match(/"showMoreUrl":"([^"]+)"/)?.[1] ?? null;
  return next;
}

/**
 * Fetches every item on a public Amazon wishlist.
 * Throws unless the end-of-list marker was reached, so callers never act on a partial list.
 */
export async function scrapeWishlist(input) {
  const { id, origin, url } = parseWishlistUrl(input);
  const seen = new Map();
  let name = null;
  let pageUrl = url;
  let reachedEnd = false;

  for (let page = 0; page < MAX_PAGES && pageUrl; page++) {
    if (page > 0) await sleep(PAGE_DELAY_MS);

    const res = await fetch(pageUrl, { headers: HEADERS, redirect: "follow" });
    if (!res.ok) throw new Error(`Amazon returned HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    if (page === 0) {
      if ($("form[action*='validateCaptcha']").length || /captcha/i.test($("title").text())) {
        throw new Error("Amazon served a captcha; try again later");
      }
      name = clean($("#profile-list-name").text()) || clean($("title").text()).split("|")[0].trim() || id;
    }

    for (const item of parseItems($, origin)) {
      if (!seen.has(item.itemId)) seen.set(item.itemId, item);
    }

    if ($("#endOfListMarker").length) {
      reachedEnd = true;
      break;
    }

    const next = findShowMoreUrl($, html);
    pageUrl = next ? new URL(next, origin).href : null;
  }

  if (!reachedEnd) {
    throw new Error("Couldn't read the whole wishlist (is it public?)");
  }

  return { id, origin, url, name, items: [...seen.values()] };
}
