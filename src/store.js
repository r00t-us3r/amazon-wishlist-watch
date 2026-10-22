import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

let db = null;
let writeChain = Promise.resolve();

export async function load() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse((await fs.readFile(DB_FILE, "utf8")).replace(/^\uFEFF/, ""));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    db = { wishlists: [] };
  }
  return db;
}

export function getDb() {
  if (!db) throw new Error("Store not loaded");
  return db;
}

export function save() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot);
    await fs.rename(tmp, DB_FILE);
  });
  return writeChain;
}
