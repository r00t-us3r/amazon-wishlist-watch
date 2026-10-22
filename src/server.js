import path from "node:path";
import express from "express";
import { load, getDb } from "./store.js";
import { HttpError } from "./errors.js";
import {
  addWishlist,
  checkAll,
  checkWishlist,
  isChecking,
  removeWishlist,
  setItemStatus,
} from "./tracker.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const INTERVAL_MINUTES = Math.max(5, Number(process.env.CHECK_INTERVAL_MINUTES) || 30);

let nextCheckAt = null;
let checkAllRunning = false;

async function scheduledCheck() {
  if (checkAllRunning) return;
  checkAllRunning = true;
  try {
    await checkAll();
  } finally {
    checkAllRunning = false;
    nextCheckAt = new Date(Date.now() + INTERVAL_MINUTES * 60_000).toISOString();
  }
}

function serialize(wl) {
  return { ...wl, checking: isChecking(wl.id) };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, "..", "public")));

app.get("/api/wishlists", (_req, res) => {
  res.json({
    intervalMinutes: INTERVAL_MINUTES,
    nextCheckAt,
    checkingAll: checkAllRunning,
    wishlists: getDb().wishlists.map(serialize),
  });
});

app.post("/api/wishlists", async (req, res) => {
  const wl = await addWishlist(req.body?.url);
  res.status(201).json(serialize(wl));
});

app.post("/api/wishlists/:id/check", async (req, res) => {
  const wl = await checkWishlist(req.params.id);
  res.json(serialize(wl));
});

app.delete("/api/wishlists/:id", async (req, res) => {
  await removeWishlist(req.params.id);
  res.status(204).end();
});

app.patch("/api/wishlists/:id/items/:itemId", async (req, res) => {
  const item = await setItemStatus(req.params.id, req.params.itemId, req.body?.status);
  res.json(item);
});

app.post("/api/check-all", (_req, res) => {
  scheduledCheck();
  res.status(202).json({ started: true });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 502;
  if (!(err instanceof HttpError)) console.error(err.message);
  res.status(status).json({ error: err.message || "Something went wrong" });
});

await load();
app.listen(PORT, HOST, () => {
  console.log(`Wishlist watch running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`Re-checking all wishlists every ${INTERVAL_MINUTES} minutes`);
});

nextCheckAt = new Date(Date.now() + 10_000).toISOString();
setTimeout(scheduledCheck, 10_000);
setInterval(scheduledCheck, INTERVAL_MINUTES * 60_000);
