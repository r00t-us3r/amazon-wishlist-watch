import { scrapeWishlist, parseWishlistUrl } from "./scraper.js";
import { getDb, save } from "./store.js";
import { HttpError } from "./errors.js";

const inFlight = new Map();

function findWishlist(id) {
  const wl = getDb().wishlists.find((w) => w.id === id);
  if (!wl) throw new HttpError(404, "Wishlist not found");
  return wl;
}

function snapshotFields(scraped) {
  const { itemId, ...rest } = scraped;
  return rest;
}

export async function addWishlist(input) {
  const { id } = parseWishlistUrl(input);
  if (getDb().wishlists.some((w) => w.id === id)) {
    throw new HttpError(409, "That wishlist is already being tracked");
  }

  const result = await scrapeWishlist(input);
  const now = new Date().toISOString();
  const wishlist = {
    id: result.id,
    origin: result.origin,
    url: result.url,
    name: result.name,
    addedAt: now,
    lastCheckedAt: now,
    lastSuccessAt: now,
    lastError: null,
    lastChange: null,
    items: result.items.map((item, position) => ({
      itemId: item.itemId,
      ...snapshotFields(item),
      position,
      status: "active",
      firstSeenAt: now,
      lastSeenAt: now,
      purchasedAt: null,
      purchasedSource: null,
    })),
  };

  getDb().wishlists.push(wishlist);
  await save();
  return wishlist;
}

async function runCheck(wishlist) {
  const now = new Date().toISOString();
  wishlist.lastCheckedAt = now;

  let result;
  try {
    result = await scrapeWishlist(wishlist.url);
  } catch (err) {
    wishlist.lastError = err.message;
    await save();
    throw err;
  }

  const scraped = new Map(result.items.map((item, position) => [item.itemId, { ...item, position }]));
  const change = { at: now, purchased: [], added: [], restored: [] };

  for (const item of wishlist.items) {
    const fresh = scraped.get(item.itemId);
    if (fresh) {
      Object.assign(item, snapshotFields(fresh), { lastSeenAt: now });
      const autoRemoved =
        (item.status === "purchased" && item.purchasedSource === "auto") || item.status === "dismissed";
      if (autoRemoved) {
        Object.assign(item, { status: "active", purchasedAt: null, purchasedSource: null });
        change.restored.push(item.title);
      }
      scraped.delete(item.itemId);
    } else if (item.status === "active") {
      Object.assign(item, { status: "purchased", purchasedAt: now, purchasedSource: "auto" });
      change.purchased.push(item.title);
    }
  }

  for (const fresh of scraped.values()) {
    wishlist.items.push({
      itemId: fresh.itemId,
      ...snapshotFields(fresh),
      status: "active",
      firstSeenAt: now,
      lastSeenAt: now,
      purchasedAt: null,
      purchasedSource: null,
    });
    change.added.push(fresh.title);
  }

  wishlist.name = result.name || wishlist.name;
  wishlist.lastSuccessAt = now;
  wishlist.lastError = null;
  if (change.purchased.length || change.added.length || change.restored.length) {
    wishlist.lastChange = change;
    console.log(
      `[${wishlist.name}] purchased: ${change.purchased.length}, added: ${change.added.length}, restored: ${change.restored.length}`
    );
  }

  await save();
  return wishlist;
}

export function checkWishlist(id) {
  const wishlist = findWishlist(id);
  if (!inFlight.has(id)) {
    const p = runCheck(wishlist).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
  }
  return inFlight.get(id);
}

export async function checkAll() {
  const results = [];
  for (const wl of [...getDb().wishlists]) {
    try {
      await checkWishlist(wl.id);
      results.push({ id: wl.id, ok: true });
    } catch (err) {
      console.error(`Check failed for ${wl.name} (${wl.id}): ${err.message}`);
      results.push({ id: wl.id, ok: false, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return results;
}

export async function removeWishlist(id) {
  const db = getDb();
  findWishlist(id);
  db.wishlists = db.wishlists.filter((w) => w.id !== id);
  await save();
}

export async function setItemStatus(id, itemId, status) {
  if (!["active", "purchased", "dismissed"].includes(status)) {
    throw new HttpError(400, "status must be 'active', 'purchased' or 'dismissed'");
  }
  const item = findWishlist(id).items.find((i) => i.itemId === itemId);
  if (!item) throw new HttpError(404, "Item not found");

  if (status === "purchased") {
    Object.assign(item, { status, purchasedAt: new Date().toISOString(), purchasedSource: "manual" });
  } else if (status === "dismissed") {
    Object.assign(item, { status });
  } else {
    Object.assign(item, { status, purchasedAt: null, purchasedSource: null });
  }
  await save();
  return item;
}

export function isChecking(id) {
  return inFlight.has(id);
}
