const ADD_TAB = "__add__";
const POLL_MS = 30_000;

const state = {
  data: null,
  selected: localStorage.getItem("selectedTab"),
  busy: new Set(),
};

const $ = (sel) => document.querySelector(sel);

const CURRENCIES = {
  "co.uk": "GBP",
  com: "USD",
  ca: "CAD",
  "com.au": "AUD",
  "co.jp": "JPY",
  in: "INR",
  de: "EUR",
  fr: "EUR",
  it: "EUR",
  es: "EUR",
  nl: "EUR",
  ie: "EUR",
};

function currencyFor(origin) {
  const tld = new URL(origin).hostname.replace(/^www\.amazon\./, "");
  return CURRENCIES[tld] || "GBP";
}

function money(value, origin) {
  if (value == null) return "Unavailable";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyFor(origin) }).format(value);
}

function timeAgo(iso) {
  if (!iso) return "never";
  const secs = Math.round((Date.now() - new Date(iso)) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleString();
}

function timeUntil(iso) {
  if (!iso) return "";
  const mins = Math.round((new Date(iso) - Date.now()) / 60000);
  return mins <= 0 ? "any moment" : `in ${mins} min`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Not signed in");
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function seenKey(id) {
  return `seenPurchased:${id}`;
}

function unseenPurchases(wl) {
  const seen = new Set(JSON.parse(localStorage.getItem(seenKey(wl.id)) || "[]"));
  return wl.items.filter((i) => i.status === "purchased" && !seen.has(i.itemId)).length;
}

function markPurchasesSeen(wl) {
  const ids = wl.items.filter((i) => i.status === "purchased").map((i) => i.itemId);
  localStorage.setItem(seenKey(wl.id), JSON.stringify(ids));
}

function select(tab) {
  state.selected = tab;
  localStorage.setItem("selectedTab", tab);
  render();
}

let fastPoll = null;

async function refresh() {
  try {
    state.data = await api("/api/wishlists");
  } catch (err) {
    console.error(err);
    return;
  }
  render();

  clearTimeout(fastPoll);
  if (state.data.checkingAll || state.data.wishlists.some((w) => w.checking)) {
    fastPoll = setTimeout(refresh, 3000);
  }
}

function render() {
  const { data } = state;
  if (!data) return;

  const ids = data.wishlists.map((w) => w.id);
  if (!ids.includes(state.selected) && state.selected !== ADD_TAB) {
    state.selected = ids[0] ?? ADD_TAB;
  }

  const current = data.wishlists.find((w) => w.id === state.selected);
  if (current) markPurchasesSeen(current);

  $("#schedule").textContent = data.checkingAll
    ? "Checking all wishlists now…"
    : `Auto-checks every ${data.intervalMinutes} min · next check ${timeUntil(data.nextCheckAt)}`;
  $("#check-all").disabled = data.checkingAll || data.wishlists.length === 0;

  renderTabs();
  renderPanel(current);
}

function renderTabs() {
  const tabs = state.data.wishlists.map((wl) => {
    const active = wl.items.filter((i) => i.status === "active").length;
    const unseen = unseenPurchases(wl);
    return `
      <button class="tab" role="tab" data-tab="${esc(wl.id)}" aria-selected="${wl.id === state.selected}">
        ${esc(wl.name)}
        <span class="badge" title="Items still wanted">${active}</span>
        ${unseen ? `<span class="badge new" title="Newly purchased">${unseen} bought</span>` : ""}
      </button>`;
  });
  tabs.push(
    `<button class="tab add" role="tab" data-tab="${ADD_TAB}" aria-selected="${state.selected === ADD_TAB}">+ Add wishlist</button>`
  );
  $("#tabs").innerHTML = tabs.join("");
}

function renderPanel(wl) {
  const panel = $("#panel");

  if (!wl) {
    const existing = panel.querySelector("#add-form");
    if (!existing) {
      panel.replaceChildren($("#add-template").content.cloneNode(true));
      $("#add-form").addEventListener("submit", onAdd);
    }
    return;
  }

  const active = wl.items.filter((i) => i.status === "active").sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const purchased = wl.items
    .filter((i) => i.status === "purchased")
    .sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt));
  const remaining = active.reduce((sum, i) => sum + (i.price ?? 0) * Math.max(0, (i.requested ?? 1) - (i.has ?? 0)), 0);
  const checking = wl.checking || state.busy.has(wl.id);

  const change = wl.lastChange;
  const changeBanner =
    change && change.purchased.length && Date.now() - new Date(change.at) < 24 * 3600_000
      ? `<p class="notice banner">${change.purchased.length} item${change.purchased.length === 1 ? "" : "s"} marked as purchased ${timeAgo(change.at)}.</p>`
      : "";

  panel.innerHTML = `
    <div class="list-header">
      <div>
        <h2><a href="${esc(wl.url)}" target="_blank" rel="noopener">${esc(wl.name)}</a></h2>
        <div class="meta muted">
          Tracking since ${new Date(wl.addedAt).toLocaleDateString()} ·
          Last checked ${timeAgo(wl.lastSuccessAt)}
        </div>
      </div>
      <div class="actions">
        <button class="btn" data-action="check" ${checking ? "disabled" : ""}>${checking ? "Checking…" : "Check now"}</button>
        <button class="btn danger" data-action="remove">Stop tracking</button>
      </div>
    </div>
    ${wl.lastError ? `<p class="error banner">Last check failed ${timeAgo(wl.lastCheckedAt)}: ${esc(wl.lastError)}</p>` : ""}
    ${changeBanner}
    <div class="stats">
      <span><strong>${active.length}</strong> still wanted</span>
      <span><strong>${purchased.length}</strong> purchased</span>
      <span><strong>${money(remaining, wl.origin)}</strong> remaining</span>
    </div>
    <ul class="items">
      ${active.length ? active.map((i) => itemRow(wl, i)).join("") : `<li class="empty">Everything on this list has been purchased 🎉</li>`}
    </ul>
    <h3 class="section-title">Purchased (${purchased.length})</h3>
    <ul class="items">
      ${purchased.length ? purchased.map((i) => itemRow(wl, i)).join("") : `<li class="empty">Nothing purchased yet.</li>`}
    </ul>
  `;
}

function itemRow(wl, item) {
  const isPurchased = item.status === "purchased";
  const needs = item.requested ?? 1;
  const sub = [
    item.byline ? esc(item.byline) : null,
    !isPurchased && item.priority ? `<span class="pill ${esc(item.priority.toLowerCase())}">${esc(item.priority)}</span>` : null,
    !isPurchased ? `Needs ${needs} · Has ${item.has ?? 0}` : null,
    isPurchased
      ? `<span class="pill purchased">Purchased ${timeAgo(item.purchasedAt)}</span>${item.purchasedSource === "manual" ? " (marked manually)" : ""}`
      : null,
  ].filter(Boolean);

  const action = !isPurchased
    ? `<button class="btn small" data-action="status" data-item="${esc(item.itemId)}" data-status="purchased">Mark purchased</button>`
    : item.purchasedSource === "manual"
      ? `<button class="btn small" data-action="status" data-item="${esc(item.itemId)}" data-status="active">Undo</button>`
      : `<button class="btn small" data-action="status" data-item="${esc(item.itemId)}" data-status="dismissed" title="Use this if the owner removed the item rather than someone buying it">Not bought · hide</button>`;

  return `
    <li class="item ${isPurchased ? "purchased" : ""}">
      ${item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy" />` : "<span></span>"}
      <div>
        <a class="title" href="${esc(item.url)}" target="_blank" rel="noopener" title="${esc(item.title)}">${esc(item.title)}</a>
        <div class="sub">${sub.join("")}</div>
        ${item.comment ? `<div class="comment">“${esc(item.comment)}”</div>` : ""}
      </div>
      <div class="side">
        <span class="price">${money(item.price, wl.origin)}</span>
        ${action}
      </div>
    </li>`;
}

async function onAdd(event) {
  event.preventDefault();
  const input = $("#add-url");
  const button = event.target.querySelector("button");
  const errorEl = $("#add-error");
  errorEl.hidden = true;
  button.disabled = true;
  button.textContent = "Fetching wishlist…";
  try {
    const wl = await api("/api/wishlists", { method: "POST", body: { url: input.value } });
    state.data.wishlists.push(wl);
    markPurchasesSeen(wl);
    select(wl.id);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Add wishlist";
  }
}

async function onPanelClick(event) {
  const button = event.target.closest("button[data-action]");
  const wl = state.data?.wishlists.find((w) => w.id === state.selected);
  if (!button || !wl) return;

  const { action } = button.dataset;
  try {
    if (action === "check") {
      state.busy.add(wl.id);
      render();
      try {
        await api(`/api/wishlists/${wl.id}/check`, { method: "POST" });
      } finally {
        state.busy.delete(wl.id);
      }
    } else if (action === "remove") {
      if (!confirm(`Stop tracking "${wl.name}"? Its purchase history will be deleted.`)) return;
      await api(`/api/wishlists/${wl.id}`, { method: "DELETE" });
    } else if (action === "status") {
      button.disabled = true;
      await api(`/api/wishlists/${wl.id}/items/${button.dataset.item}`, {
        method: "PATCH",
        body: { status: button.dataset.status },
      });
    }
  } catch (err) {
    alert(err.message);
  }
  await refresh();
}

$("#tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) select(tab.dataset.tab);
});

$("#panel").addEventListener("click", onPanelClick);

$("#check-all").addEventListener("click", async () => {
  await api("/api/check-all", { method: "POST" });
  await refresh();
});

refresh();
setInterval(refresh, POLL_MS);
