import crypto from "node:crypto";

const COOKIE_NAME = "wlw_session";
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 30;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

const PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECURE_COOKIE = process.env.COOKIE_SECURE === "true";

if (!PASSWORD) {
  console.error("ADMIN_PASSWORD is not set. Add it to your .env file (see .env.example).");
  process.exit(1);
}

// Folding the password into the key means changing ADMIN_PASSWORD logs everyone out.
const signingKey = crypto
  .createHmac("sha256", process.env.SESSION_SECRET || crypto.randomBytes(32))
  .update(`session:${PASSWORD}`)
  .digest();

const failures = new Map();

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function sign(payload) {
  return crypto.createHmac("sha256", signingKey).update(payload).digest("base64url");
}

function createToken() {
  const expires = String(Date.now() + SESSION_DAYS * 86_400_000);
  return `${expires}.${sign(expires)}`;
}

function isValidToken(token) {
  const [expires, sig] = String(token || "").split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(expires));
  const actual = Buffer.from(sig);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function cookieOptions(maxAgeSeconds) {
  return [
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${maxAgeSeconds}`,
    SECURE_COOKIE ? "Secure" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

function isLockedOut(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > LOCKOUT_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > LOCKOUT_MS) {
    failures.set(ip, { count: 1, first: Date.now() });
  } else {
    entry.count++;
  }
}

export function isAuthenticated(req) {
  return isValidToken(readCookie(req, COOKIE_NAME));
}

export function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not signed in" });
  res.redirect(302, "/login");
}

export function handleLogin(req, res) {
  const ip = req.ip;
  if (isLockedOut(ip)) {
    return res.status(429).send(loginPage("Too many failed attempts. Try again in 15 minutes."));
  }

  const ok = crypto.timingSafeEqual(sha256(req.body?.password ?? ""), sha256(PASSWORD));
  if (!ok) {
    recordFailure(ip);
    return res.status(401).send(loginPage("Incorrect password."));
  }

  failures.delete(ip);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${createToken()}; ${cookieOptions(SESSION_DAYS * 86_400)}`);
  res.redirect(303, "/");
}

export function handleLogout(_req, res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; ${cookieOptions(0)}`);
  res.redirect(303, "/login");
}

export function loginPage(error = "") {
  const escaped = error.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Sign in · Wishlist Watch</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f5f7;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d2330; }
    form { background: #fff; border: 1px solid #e3e5ea; border-radius: 10px; padding: 2rem; width: min(340px, 90vw); }
    h1 { margin: 0 0 1.25rem; font-size: 1.3rem; }
    label { display: block; font-size: 0.85rem; color: #6b7280; margin-bottom: 0.35rem; }
    input { width: 100%; box-sizing: border-box; font: inherit; padding: 0.55rem 0.75rem; border: 1px solid #e3e5ea; border-radius: 8px; }
    button { margin-top: 1rem; width: 100%; font: inherit; font-weight: 600; padding: 0.55rem; border: none; border-radius: 8px; background: #ff9900; cursor: pointer; }
    button:hover { background: #e68a00; }
    .error { color: #b42318; background: #fef3f2; padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Wishlist Watch</h1>
    ${escaped ? `<p class="error">${escaped}</p>` : ""}
    <label for="password">Admin password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}
