/*
 * ProGuard Worker: Discord sign-in, owner-only dashboard API, Firestore bridge
 * (service-account REST, no secrets in the browser), and a bot command queue.
 *
 * Worker VARIABLES (plain text, set in wrangler.jsonc or the dashboard):
 *   DISCORD_CLIENT_ID, DISCORD_REDIRECT_URI, OWNER_DISCORD_ID, FIREBASE_PROJECT_ID
 * Worker SECRETS (dashboard or `wrangler secret put`):
 *   DISCORD_CLIENT_SECRET, SESSION_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON, DISCORD_BOT_TOKEN
 * Binding: ASSETS (static site in ./public)
 */

const DISCORD = {
  authorize: "https://discord.com/oauth2/authorize",
  token: "https://discord.com/api/v10/oauth2/token",
  revoke: "https://discord.com/api/v10/oauth2/token/revoke",
  me: "https://discord.com/api/v10/users/@me",
  myGuilds: "https://discord.com/api/v10/users/@me/guilds",
  api: "https://discord.com/api/v10",
};

const GOOGLE = {
  token: "https://oauth2.googleapis.com/token",
  scope: "https://www.googleapis.com/auth/datastore",
  firestore: "https://firestore.googleapis.com/v1",
};

const SESSION_COOKIE = "proguard_session";
const STATE_COOKIE = "proguard_oauth_state";
const SESSION_SECONDS = 12 * 3600;
const STATE_SECONDS = 600;
const BOT_STALE_MS = 150 * 1000; // heartbeat is written every 60s; 150s without one = stale
const MANAGE_GUILD = 0x20n;
const SAMPLE_LIMIT = 2000;

const SNOWFLAKE = /^\d{17,20}$/;
const REPORT_ID = /^[A-Za-z0-9_-]{6,128}$/;
const CASE_ID = /^\d{1,12}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[\x21-\x7e]{10,512}$/;
const REPORT_ACTIONS = ["open", "reviewing", "resolved", "dismissed"];
const CASE_STATUSES = ["open", "investigating", "resolved", "dismissed"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const RANGES = {
  "24h": { buckets: 24, unit: 3600e3 },
  "7d": { buckets: 7, unit: 86400e3 },
  "30d": { buckets: 30, unit: 86400e3 },
};
const REQUIRED_VARS = ["DISCORD_CLIENT_ID", "DISCORD_REDIRECT_URI", "OWNER_DISCORD_ID", "FIREBASE_PROJECT_ID"];
const REQUIRED_SECRETS = ["DISCORD_CLIENT_SECRET", "SESSION_SECRET", "FIREBASE_SERVICE_ACCOUNT_JSON", "DISCORD_BOT_TOKEN"];

const WORKER_VERSION = "2.0.0";
const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------------------------------------------ encoding helpers */

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlToBytes(str) {
  const b = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
  return Uint8Array.from(atob(b + pad), (c) => c.charCodeAt(0));
}

function b64urlJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}

function parseB64urlJson(str) {
  return JSON.parse(dec.decode(b64urlToBytes(str)));
}

function randomId(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ signing (HMAC) */

async function hmacSign(secret, value) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return b64url(new Uint8Array(sig));
}

async function makeSigned(secret, obj) {
  const payload = b64urlJson(obj);
  return `${payload}.${await hmacSign(secret, payload)}`;
}

async function readSigned(secret, value) {
  if (!value || value.length > 4096) return null;
  const i = value.lastIndexOf(".");
  if (i < 1) return null;
  const payload = value.slice(0, i);
  const sig = value.slice(i + 1);
  if (!timingSafeEqual(await hmacSign(secret, payload), sig)) return null;
  try {
    return parseB64urlJson(payload);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ responses & cookies */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' https://cdn.discordapp.com data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self' https://discord.com",
  "object-src 'none'",
].join("; ");

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": CSP,
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...extra,
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }),
  });
}

function fail(status, error, message) {
  return json({ error, message }, status);
}

function redirect(location, cookies = []) {
  const headers = new Headers(securityHeaders({ Location: location, "Cache-Control": "no-store" }));
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function cookieString(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function withSecurityHeaders(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(securityHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

/* ------------------------------------------------------------------ rate limiting (best effort, per isolate) */

const buckets = new Map();
function rateOk(key, limit, windowMs = 60000) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) {
    b.n = 0;
    b.reset = now + windowMs;
  }
  b.n += 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return b.n <= limit;
}

/* ------------------------------------------------------------------ configuration */

function missingConfig(env) {
  const missing = [...REQUIRED_VARS, ...REQUIRED_SECRETS].filter((k) => !env[k] || !String(env[k]).trim());
  if (!SNOWFLAKE.test(String(env.OWNER_DISCORD_ID || ""))) missing.push("OWNER_DISCORD_ID (must be a Discord ID)");
  return missing;
}

function configProblem(env) {
  const missing = missingConfig(env);
  if (missing.length) {
    console.error("ProGuard misconfigured. Missing or invalid:", missing.join(", "));
    return fail(500, "misconfigured", "ProGuard is not configured yet. The owner needs to finish the setup.");
  }
  return null;
}

/* ------------------------------------------------------------------ Google service-account auth (RS256 JWT) */

let tokenCache = { token: null, exp: 0 };

function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!sa.client_email || !sa.private_key) throw new Error("service account JSON is incomplete");
  if (sa.project_id && sa.project_id !== env.FIREBASE_PROJECT_ID) throw new Error("service account project mismatch");

  const header = b64urlJson({ alg: "RS256", typ: "JWT" });
  const claims = b64urlJson({
    iss: sa.client_email,
    scope: GOOGLE.scope,
    aud: GOOGLE.token,
    iat: now,
    exp: now + 3600,
  });
  const input = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input));
  const assertion = `${input}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch(GOOGLE.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

/* ------------------------------------------------------------------ Firestore value encoding */

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  return { stringValue: String(v) };
}

function encodeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = encodeValue(v);
  return out;
}

function decodeValue(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("stringValue" in v) return v.stringValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

/* ------------------------------------------------------------------ Firestore REST */

function fsBase(env) {
  return `${GOOGLE.firestore}/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;
}

async function fsFetch(env, method, url, body) {
  const token = await googleAccessToken(env);
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function fsError(res, op) {
  const e = new Error(`Firestore ${op} failed (${res.status})`);
  e.status = res.status;
  return e;
}

async function fsGet(env, path) {
  const res = await fsFetch(env, "GET", `${fsBase(env)}/${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw fsError(res, "get");
  const d = await res.json();
  return { id: d.name.split("/").pop(), data: decodeFields(d.fields) };
}

async function fsSet(env, path, fields, { mustExist = false } = {}) {
  const keys = Object.keys(fields);
  if (!keys.length) throw new Error("fsSet needs at least one field");
  const params = new URLSearchParams();
  for (const k of keys) params.append("updateMask.fieldPaths", k);
  if (mustExist) params.append("currentDocument.exists", "true");
  const res = await fsFetch(env, "PATCH", `${fsBase(env)}/${path}?${params}`, { fields: encodeFields(fields) });
  if (!res.ok) throw fsError(res, "write");
  return true;
}

async function fsCreate(env, collection, id, fields) {
  const params = new URLSearchParams();
  if (id) params.set("documentId", id);
  const res = await fsFetch(env, "POST", `${fsBase(env)}/${collection}?${params}`, { fields: encodeFields(fields) });
  if (!res.ok) throw fsError(res, "create");
  const d = await res.json();
  return d.name.split("/").pop();
}

async function fsDelete(env, path) {
  const res = await fsFetch(env, "DELETE", `${fsBase(env)}/${path}`);
  if (!res.ok && res.status !== 404) throw fsError(res, "delete");
}

// Firestore REST expects enum names, not symbols.
const FS_OPS = {
  "==": "EQUAL",
  ">": "GREATER_THAN",
  ">=": "GREATER_THAN_OR_EQUAL",
  "<": "LESS_THAN",
  "<=": "LESS_THAN_OR_EQUAL",
};

function buildStructured(q) {
  const s = { from: [{ collectionId: q.collection }] };
  if (q.where && q.where.length) {
    const filters = q.where.map(([field, op, value]) => {
      const fsOp = FS_OPS[op];
      if (!fsOp) throw new Error(`unsupported filter operator ${op}`);
      return { fieldFilter: { field: { fieldPath: field }, op: fsOp, value: encodeValue(value) } };
    });
    s.where = filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } };
  }
  if (q.orderBy && q.orderBy.length) {
    s.orderBy = q.orderBy.map(([field, direction = "DESCENDING"]) => ({ field: { fieldPath: field }, direction }));
  }
  if (q.select && q.select.length) s.select = { fields: q.select.map((f) => ({ fieldPath: f })) };
  if (q.limit) s.limit = q.limit;
  return s;
}

function queryUrl(env, parentPath, op) {
  return parentPath ? `${fsBase(env)}/${parentPath}:${op}` : `${fsBase(env)}:${op}`;
}

async function fsQuery(env, parentPath, q) {
  const res = await fsFetch(env, "POST", queryUrl(env, parentPath, "runQuery"), { structuredQuery: buildStructured(q) });
  if (!res.ok) throw fsError(res, "query");
  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => ({ id: r.document.name.split("/").pop(), data: decodeFields(r.document.fields) }));
}

async function fsCount(env, parentPath, q) {
  const body = {
    structuredAggregationQuery: {
      structuredQuery: buildStructured(q),
      aggregations: [{ alias: "n", count: {} }],
    },
  };
  const res = await fsFetch(env, "POST", queryUrl(env, parentPath, "runAggregationQuery"), body);
  if (!res.ok) throw fsError(res, "count");
  const rows = await res.json();
  return Number(rows?.[0]?.result?.aggregateFields?.n?.integerValue || 0);
}

/* ------------------------------------------------------------------ Discord helpers */

const installCache = new Map();
const channelCache = new Map();

async function botInstalled(env, gid) {
  const c = installCache.get(gid);
  if (c && c.exp > Date.now()) return c.v;
  let v = "unknown";
  try {
    const r = await fetch(`${DISCORD.api}/guilds/${gid}`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
    if (r.status === 200) v = "installed";
    else if (r.status === 404 || r.status === 403) v = "missing";
  } catch {
    v = "unknown";
  }
  installCache.set(gid, { v, exp: Date.now() + 60e3 });
  return v;
}

async function textChannels(env, gid) {
  const c = channelCache.get(gid);
  if (c && c.exp > Date.now()) return c.v;
  const r = await fetch(`${DISCORD.api}/guilds/${gid}/channels`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
  if (!r.ok) return [];
  const all = await r.json();
  const v = all.filter((ch) => ch.type === 0 || ch.type === 5).map((ch) => ({ id: String(ch.id), name: ch.name }));
  channelCache.set(gid, { v, exp: Date.now() + 60e3 });
  return v;
}

/* ------------------------------------------------------------------ sessions & authorization */

async function getSession(request, env) {
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const i = raw.lastIndexOf(".");
  if (i < 1) return null;
  const sid = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  if (!SESSION_ID.test(sid)) return null;
  if (!timingSafeEqual(await hmacSign(env.SESSION_SECRET, sid), sig)) return null;

  const doc = await fsGet(env, `dashboard_sessions/${sid}`);
  if (!doc) return null;
  const d = doc.data;
  if (!d.expires_at || Date.parse(d.expires_at) <= Date.now()) return null;
  if (String(d.user_id) !== String(env.OWNER_DISCORD_ID)) return null;

  return {
    sid,
    user: { id: String(d.user_id), username: d.username, global_name: d.global_name, avatar: d.avatar, email: d.email },
    guilds: Array.isArray(d.guilds) ? d.guilds : [],
  };
}

async function authOwner(request, env) {
  const session = await getSession(request, env);
  if (!session) return { res: fail(401, "unauthenticated", "Sign in with the owner Discord account to continue.") };
  return { session };
}

function requireGuild(session, url) {
  const gid = url.searchParams.get("guild_id") || "";
  if (!SNOWFLAKE.test(gid)) return { res: fail(400, "invalid_guild", "Choose a valid server.") };
  if (!session.guilds.some((g) => g.id === gid)) {
    return { res: fail(403, "guild_forbidden", "You do not have access to this server.") };
  }
  return { gid };
}

function csrfOk(request, url) {
  if (request.headers.get("X-ProGuard-Request") !== "1") return false;
  return request.headers.get("Origin") === url.origin;
}

async function audit(env, session, action, gid, target, detail = {}) {
  // Fail closed: the caller must not perform the sensitive action if this throws.
  await fsCreate(env, "audit_log", null, {
    ts: new Date(),
    action,
    actor_id: session.user.id,
    actor_name: session.user.global_name || session.user.username,
    guild_id: gid || null,
    target: target == null ? null : String(target),
    detail,
  });
}

/* ------------------------------------------------------------------ OAuth sign-in */

function startLogin(env) {
  const state = randomId(32);
  const exp = Math.floor(Date.now() / 1000) + STATE_SECONDS;
  return makeSigned(env.SESSION_SECRET, { state, exp }).then((cookieValue) => {
    const u = new URL(DISCORD.authorize);
    u.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
    u.searchParams.set("redirect_uri", env.DISCORD_REDIRECT_URI);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "identify email guilds");
    u.searchParams.set("state", state);
    return redirect(u.toString(), [cookieString(STATE_COOKIE, cookieValue, STATE_SECONDS)]);
  });
}

async function revokeDiscordToken(env, token) {
  try {
    await fetch(DISCORD.revoke, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        token,
      }),
    });
  } catch {
    /* best effort */
  }
}

async function finishLogin(request, env, url) {
  if (url.searchParams.get("error")) {
    return redirect("/?login=cancelled", [clearCookie(STATE_COOKIE)]);
  }
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!CODE_RE.test(code) || !STATE_RE.test(state)) {
    return fail(400, "bad_callback", "Sign-in information was incomplete. Start sign-in again.");
  }

  const saved = await readSigned(env.SESSION_SECRET, getCookie(request, STATE_COOKIE) || "");
  const nowS = Math.floor(Date.now() / 1000);
  if (!saved || typeof saved.state !== "string" || !saved.exp || saved.exp <= nowS || !timingSafeEqual(saved.state, state)) {
    const res = fail(400, "bad_state", "Sign-in session expired. Start sign-in again.");
    res.headers.append("Set-Cookie", clearCookie(STATE_COOKIE));
    return res;
  }

  const tokenRes = await fetch(DISCORD.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: env.DISCORD_REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) return fail(502, "oauth_exchange", "Discord rejected the sign-in. Try again.");
  const tok = await tokenRes.json();
  if (!tok.access_token) return fail(502, "oauth_exchange", "Discord did not return a session.");

  const auth = { Authorization: `Bearer ${tok.access_token}` };
  const [meRes, guildsRes] = await Promise.all([fetch(DISCORD.me, { headers: auth }), fetch(DISCORD.myGuilds, { headers: auth })]);
  const meOk = meRes.ok;
  const me = meOk ? await meRes.json() : null;
  const guildsAll = guildsRes.ok ? await guildsRes.json() : [];
  await revokeDiscordToken(env, tok.access_token);
  if (!meOk || !me || !SNOWFLAKE.test(String(me.id))) {
    return fail(502, "oauth_identity", "Discord account verification failed. Try again.");
  }

  const clearState = clearCookie(STATE_COOKIE);
  if (String(me.id) !== String(env.OWNER_DISCORD_ID)) {
    try {
      await fsCreate(env, "audit_log", null, {
        ts: new Date(),
        action: "login.denied",
        actor_id: String(me.id),
        actor_name: me.global_name || me.username || null,
        guild_id: null,
        target: null,
        detail: {},
      });
    } catch {
      /* denied logins are still refused even if logging fails */
    }
    return redirect("/?access=denied", [clearState]);
  }

  const guilds = (Array.isArray(guildsAll) ? guildsAll : [])
    .filter((g) => g.owner || (BigInt(g.permissions || "0") & MANAGE_GUILD) === MANAGE_GUILD)
    .slice(0, 100)
    .map((g) => ({ id: String(g.id), name: String(g.name || "Server").slice(0, 100), icon: g.icon || null, owner: !!g.owner }));

  const sid = randomId(32);
  const session = {
    user: { id: String(me.id), username: me.username || null, global_name: me.global_name || null, avatar: me.avatar || null, email: me.email || null },
    guilds,
  };
  await audit(env, session, "login", null, me.id, { guilds: guilds.length });
  await fsSet(env, `dashboard_sessions/${sid}`, {
    user_id: session.user.id,
    username: session.user.username,
    global_name: session.user.global_name,
    avatar: session.user.avatar,
    email: session.user.email,
    guilds,
    created_at: new Date(),
    expires_at: new Date(Date.now() + SESSION_SECONDS * 1000),
  });
  const signed = `${sid}.${await hmacSign(env.SESSION_SECRET, sid)}`;
  return redirect("/", [cookieString(SESSION_COOKIE, signed, SESSION_SECONDS), clearState]);
}

async function logout(request, env) {
  const raw = getCookie(request, SESSION_COOKIE) || "";
  const i = raw.lastIndexOf(".");
  if (i > 0) {
    const sid = raw.slice(0, i);
    const sig = raw.slice(i + 1);
    if (SESSION_ID.test(sid) && timingSafeEqual(await hmacSign(env.SESSION_SECRET, sid), sig)) {
      try {
        await fsDelete(env, `dashboard_sessions/${sid}`);
      } catch (e) {
        console.error("session delete failed", e.message);
      }
    }
  }
  const headers = new Headers(securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }));
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
  headers.append("Set-Cookie", clearCookie(STATE_COOKIE));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/* ------------------------------------------------------------------ data mapping */

function mapReport(id, d) {
  return {
    id,
    reportId: id,
    reporter: d.reporter_id ? `User ${d.reporter_id}` : "Unknown",
    reporterId: d.reporter_id || null,
    reportedUser: d.target_id ? `User ${d.target_id}` : "Not specified",
    targetId: d.target_id || null,
    reason: (d.description || "").slice(0, 120) || "No description",
    description: d.description || "",
    status: d.status || "open",
    priority: d.priority || "medium",
    createdAt: d.created_at || null,
    reviewedBy: d.reviewed_by || null,
    reviewedAt: d.reviewed_at || null,
    reviewNotes: d.review_notes || "",
    resolvedBy: d.resolved_by || null,
    resolvedAt: d.resolved_at || null,
  };
}

function mapCase(id, d) {
  return {
    id,
    caseId: id,
    subject: d.target_id ? `User ${d.target_id}` : "Unspecified",
    targetId: d.target_id || null,
    reportId: d.report_id || null,
    status: d.status || "recorded",
    assignedTo: d.moderator_id ? `Moderator ${d.moderator_id}` : "Unassigned",
    action: d.action || "Action",
    reason: d.reason || "",
    notes: d.case_notes || "",
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || d.created_at || null,
    updatedBy: d.updated_by || null,
  };
}

function bucketize(dates, r, now) {
  const end = Math.floor(now / r.unit) * r.unit + r.unit;
  const start = end - r.buckets * r.unit;
  const counts = new Array(r.buckets).fill(0);
  for (const d of dates) {
    const t = Date.parse(d);
    if (!Number.isFinite(t) || t < start || t >= end) continue;
    counts[Math.floor((t - start) / r.unit)]++;
  }
  const labels = Array.from({ length: r.buckets }, (_, i) => new Date(start + i * r.unit).toISOString());
  return { counts, labels };
}

async function botHeartbeat(env) {
  const doc = await fsGet(env, "bot_status/current");
  if (!doc) return { status: "unknown", lastHeartbeat: null, latencyMs: null, guildCount: null, version: null, botName: null, ageSeconds: null };
  const d = doc.data;
  const upd = Date.parse(d.updated_at);
  const age = Number.isFinite(upd) ? Date.now() - upd : null;
  let status;
  if (age === null) status = "unknown";
  else if (age > BOT_STALE_MS) status = "stale";
  else status = d.online === true ? "online" : "offline";
  return {
    status,
    lastHeartbeat: d.updated_at || null,
    latencyMs: d.latency_ms ?? null,
    guildCount: d.guild_count ?? null,
    version: d.version || null,
    botName: d.bot_username || null,
    startedAt: d.started_at || null,
    ageSeconds: age === null ? null : Math.round(age / 1000),
  };
}

async function guildDoc(env, gid) {
  const doc = await fsGet(env, `guilds/${gid}`);
  return doc ? doc.data : {};
}

/* ------------------------------------------------------------------ endpoints */

async function listGuilds(env, session) {
  const guilds = await Promise.all(
    session.guilds.map(async (g) => ({ id: g.id, name: g.name, icon: g.icon, owner: g.owner, botInstalled: await botInstalled(env, g.id) }))
  );
  return json({ guilds });
}

async function overview(env, session, gid, range) {
  const r = RANGES[range];
  const now = Date.now();
  const cutoff = new Date(now - r.buckets * r.unit);
  const parent = `guilds/${gid}`;
  const [openReports, resolvedCases, securityEvents, logRows, resolvedRows, bot] = await Promise.all([
    fsCount(env, parent, { collection: "reports", where: [["status", "==", "open"]] }),
    fsCount(env, parent, { collection: "cases", where: [["status", "==", "resolved"]] }),
    fsCount(env, parent, { collection: "moderation_logs", where: [["created_at", ">=", cutoff]] }),
    fsQuery(env, parent, { collection: "moderation_logs", where: [["created_at", ">=", cutoff]], select: ["created_at"], limit: SAMPLE_LIMIT }),
    fsQuery(env, parent, { collection: "reports", where: [["resolved_at", ">=", cutoff]], select: ["resolved_at"], limit: SAMPLE_LIMIT }),
    botHeartbeat(env),
  ]);
  const events = bucketize(logRows.map((x) => x.data.created_at), r, now);
  const resolved = bucketize(resolvedRows.map((x) => x.data.resolved_at), r, now);
  return json({
    range,
    metrics: { openReports, resolvedCases, securityEvents, uptimePercent: null },
    activity: events.labels.map((label, i) => ({ label, events: events.counts[i], resolved: resolved.counts[i] })),
    truncated: logRows.length >= SAMPLE_LIMIT || resolvedRows.length >= SAMPLE_LIMIT,
    bot,
    services: { firebase: "online", discord: "online" },
  });
}

async function listReports(env, gid, status) {
  const rows = await fsQuery(env, `guilds/${gid}`, { collection: "reports", orderBy: [["created_at"]], limit: 200 });
  const items = rows.map((x) => mapReport(x.id, x.data)).filter((r) => status === "all" || r.status === status);
  return json({ items, truncated: rows.length >= 200 });
}

async function reportAction(env, session, gid, reportId, body) {
  const action = body.action;
  if (!REPORT_ACTIONS.includes(action)) return fail(400, "invalid_action", "Choose a valid report action.");
  if (body.status !== undefined && body.status !== action) return fail(400, "status_mismatch", "Status does not match the action.");
  let priority;
  if (body.priority !== undefined && body.priority !== null && body.priority !== "") {
    if (!PRIORITIES.includes(body.priority)) return fail(400, "invalid_priority", "Choose a valid priority.");
    priority = body.priority;
  }
  let notes;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== "string") return fail(400, "invalid_notes", "Notes must be text.");
    notes = body.notes.trim().slice(0, 2000);
  }

  const path = `guilds/${gid}/reports/${reportId}`;
  const existing = await fsGet(env, path);
  if (!existing) return fail(404, "not_found", "That report was not found.");

  const now = new Date();
  const fields = { status: action, reviewed_by: session.user.id, reviewed_at: now };
  if (priority !== undefined) fields.priority = priority;
  if (notes !== undefined) fields.review_notes = notes;
  if (action === "resolved") {
    fields.resolved_by = session.user.id;
    fields.resolved_at = now;
  }

  await audit(env, session, `report.${action}`, gid, reportId, { priority: priority || null, notes_length: notes ? notes.length : 0 });
  await fsSet(env, path, fields, { mustExist: true });
  if (action !== "open") {
    try {
      await enqueueBotCommand(env, session, gid, "post_report_update", { report_id: reportId, status: action });
    } catch (e) {
      console.error("bot notify enqueue failed", e.message);
    }
  }
  return json({ ok: true, report: mapReport(reportId, { ...existing.data, ...fields }) });
}

async function listCases(env, gid) {
  const rows = await fsQuery(env, `guilds/${gid}`, { collection: "cases", orderBy: [["created_at"]], limit: 200 });
  return json({ items: rows.map((x) => mapCase(x.id, x.data)), truncated: rows.length >= 200 });
}

async function caseAction(env, session, gid, caseId, body) {
  if (body.action !== "update") return fail(400, "invalid_action", "Unsupported case action.");
  if (!CASE_STATUSES.includes(body.status)) return fail(400, "invalid_status", "Choose a valid case status.");
  let notes;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== "string") return fail(400, "invalid_notes", "Notes must be text.");
    notes = body.notes.trim().slice(0, 2000);
  }
  const path = `guilds/${gid}/cases/${caseId}`;
  const existing = await fsGet(env, path);
  if (!existing) return fail(404, "not_found", "That case was not found.");

  const fields = { status: body.status, updated_at: new Date(), updated_by: session.user.id };
  if (notes !== undefined) fields.case_notes = notes;
  await audit(env, session, `case.${body.status}`, gid, caseId, { notes_length: notes ? notes.length : 0 });
  await fsSet(env, path, fields, { mustExist: true });
  return json({ ok: true, case: mapCase(caseId, { ...existing.data, ...fields }) });
}

async function analytics(env, gid, range) {
  const r = RANGES[range];
  const now = Date.now();
  const cutoff = new Date(now - r.buckets * r.unit);
  const parent = `guilds/${gid}`;
  const [totalEvents, reportsReceived, reportsResolved, logRows, typeRows, timingRows, resolvedRows] = await Promise.all([
    fsCount(env, parent, { collection: "moderation_logs", where: [["created_at", ">=", cutoff]] }),
    fsCount(env, parent, { collection: "reports", where: [["created_at", ">=", cutoff]] }),
    fsCount(env, parent, { collection: "reports", where: [["created_at", ">=", cutoff], ["status", "==", "resolved"]] }),
    fsQuery(env, parent, { collection: "moderation_logs", where: [["created_at", ">=", cutoff]], select: ["created_at"], limit: SAMPLE_LIMIT }),
    fsQuery(env, parent, { collection: "moderation_logs", where: [["created_at", ">=", cutoff]], select: ["type"], limit: SAMPLE_LIMIT }),
    fsQuery(env, parent, { collection: "reports", where: [["created_at", ">=", cutoff]], select: ["created_at", "resolved_at"], limit: 500 }),
    fsQuery(env, parent, { collection: "reports", where: [["resolved_at", ">=", cutoff]], select: ["resolved_at"], limit: SAMPLE_LIMIT }),
  ]);

  const counts = {};
  for (const row of typeRows) {
    const t = row.data.type || "Unknown";
    counts[t] = (counts[t] || 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([label, count]) => ({ label, count }));

  const timings = timingRows
    .filter((x) => x.data.resolved_at && x.data.created_at)
    .map((x) => Date.parse(x.data.resolved_at) - Date.parse(x.data.created_at))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  let averageResponseTime = null;
  if (timings.length) {
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length / 60000;
    averageResponseTime = avg >= 60 ? `${(avg / 60).toFixed(1)}h` : `${Math.round(avg)}m`;
  }

  const events = bucketize(logRows.map((x) => x.data.created_at), r, now);
  const resolved = bucketize(resolvedRows.map((x) => x.data.resolved_at), r, now);
  return json({
    range,
    metrics: {
      totalEvents,
      reportsReceived,
      resolutionRate: reportsReceived ? Math.round((reportsResolved / reportsReceived) * 1000) / 10 : null,
      averageResponseTime,
    },
    activity: events.labels.map((label, i) => ({ label, events: events.counts[i], resolved: resolved.counts[i] })),
    breakdown,
    truncated: logRows.length >= SAMPLE_LIMIT || typeRows.length >= SAMPLE_LIMIT || resolvedRows.length >= SAMPLE_LIMIT,
  });
}

async function settingsGet(env, gid) {
  const d = await guildDoc(env, gid);
  const installed = (await botInstalled(env, gid)) === "installed";
  const channels = installed ? await textChannels(env, gid) : [];
  return json({
    installed,
    settings: {
      guildName: d.guild_name || null,
      enabled: d.enabled === true,
      automodEnabled: d.automod_enabled === true,
      logChannelId: d.log_channel_id || null,
      reportChannelId: d.report_channel_id || null,
      blockedWordCount: Array.isArray(d.blocked_words) ? d.blocked_words.length : 0,
    },
    channels,
  });
}

async function settingsAction(env, session, gid, body) {
  const action = body.action;
  const fields = {};
  if (action === "set_report_channel" || action === "set_log_channel") {
    const key = action === "set_report_channel" ? "report_channel_id" : "log_channel_id";
    if (body.channelId === null) {
      fields[key] = null;
    } else {
      const cid = String(body.channelId || "");
      if (!SNOWFLAKE.test(cid)) return fail(400, "invalid_channel", "Choose a valid channel.");
      const channels = await textChannels(env, gid);
      if (!channels.some((c) => c.id === cid)) return fail(400, "channel_not_found", "That channel is not a text channel in this server.");
      fields[key] = cid;
    }
  } else if (action === "set_automod") {
    if (typeof body.enabled !== "boolean") return fail(400, "invalid_value", "Automod needs true or false.");
    fields.automod_enabled = body.enabled;
  } else {
    return fail(400, "invalid_action", "Unsupported setting.");
  }
  await audit(env, session, action, gid, null, { ...fields });
  await fsSet(env, `guilds/${gid}`, fields);
  return json({ ok: true });
}

async function enqueueBotCommand(env, session, gid, type, payload) {
  const now = new Date();
  return fsCreate(env, "bot_commands", null, {
    guild_id: gid,
    type,
    payload,
    status: "queued",
    requested_by: session.user.id,
    requested_at: now,
  });
}

const CLIENT_BOT_COMMANDS = { send_test_message: true };

async function botCommandCreate(env, session, gid, body) {
  if (!CLIENT_BOT_COMMANDS[body.type]) return fail(400, "invalid_command", "That bot command is not available here.");
  await audit(env, session, `bot.${body.type}`, gid, null, {});
  const id = await enqueueBotCommand(env, session, gid, body.type, {});
  return json({ ok: true, id, status: "queued" }, 202);
}

async function botCommandStatus(env, gid, id) {
  const doc = await fsGet(env, `bot_commands/${id}`);
  if (!doc || doc.data.guild_id !== gid) return fail(404, "not_found", "Command not found.");
  const d = doc.data;
  return json({ id, status: d.status || "unknown", result: d.result || null, error: d.error || null, requestedAt: d.requested_at || null, finishedAt: d.finished_at || null });
}

async function listAudit(env) {
  const rows = await fsQuery(env, "", { collection: "audit_log", orderBy: [["ts"]], limit: 100 });
  return json({
    items: rows.map((x) => ({
      id: x.id,
      action: x.data.action,
      actorId: x.data.actor_id,
      actorName: x.data.actor_name,
      guildId: x.data.guild_id,
      target: x.data.target,
      timestamp: x.data.ts,
    })),
  });
}

/* ------------------------------------------------------------------ routing */

async function readJsonBody(request) {
  const ct = request.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) return { res: fail(415, "bad_content_type", "Send JSON.") };
  const text = await request.text();
  if (text.length > 8192) return { res: fail(413, "too_large", "Request is too large.") };
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) return { res: fail(400, "invalid_body", "Send a JSON object.") };
    return { body };
  } catch {
    return { res: fail(400, "invalid_json", "Request body is not valid JSON.") };
  }
}

async function api(request, env, url, ip) {
  const path = url.pathname;
  const method = request.method;
  if (method !== "GET" && method !== "POST") return fail(405, "method_not_allowed", "Method not allowed.");
  const write = method === "POST";
  if (write && !csrfOk(request, url)) return fail(403, "csrf", "Request blocked. Refresh the page and try again.");
  if (!rateOk(`${ip}:${write ? "w" : "r"}`, write ? 30 : 180)) return fail(429, "rate_limited", "Too many requests. Wait a moment.");

  const { res: authRes, session } = await authOwner(request, env);
  if (authRes) return authRes;

  if (path === "/api/me" && method === "GET") {
    return json({ authenticated: true, isOwner: true, user: session.user });
  }
  if (path === "/api/guilds" && method === "GET") return listGuilds(env, session);
  if (path === "/api/admin/audit" && method === "GET") return listAudit(env);

  // Everything below is scoped to one server the session is allowed to manage.
  const guildScoped = [
    "/api/overview", "/api/reports", "/api/cases", "/api/analytics", "/api/bot/status",
    "/api/settings", "/api/bot/command",
  ];
  const actionMatch = path.match(/^\/api\/(reports|cases)\/([^/]+)\/action$/);
  const cmdStatusMatch = path.match(/^\/api\/bot\/command\/([^/]+)$/);
  const isScoped = guildScoped.includes(path) || actionMatch || cmdStatusMatch;
  if (!isScoped) return fail(404, "not_found", "Unknown API route.");

  const scope = requireGuild(session, url);
  if (scope.res) return scope.res;
  const gid = scope.gid;

  if (path === "/api/overview" && method === "GET") {
    const range = url.searchParams.get("range") || "7d";
    if (!RANGES[range]) return fail(400, "invalid_range", "Range must be 24h, 7d or 30d.");
    return overview(env, session, gid, range);
  }
  if (path === "/api/reports" && method === "GET") {
    const status = url.searchParams.get("status") || "all";
    if (status !== "all" && !REPORT_ACTIONS.includes(status)) return fail(400, "invalid_status", "Invalid report filter.");
    return listReports(env, gid, status);
  }
  if (actionMatch && actionMatch[1] === "reports" && method === "POST") {
    const id = decodeURIComponent(actionMatch[2]);
    if (!REPORT_ID.test(id)) return fail(400, "invalid_id", "Invalid report ID.");
    const { res, body } = await readJsonBody(request);
    if (res) return res;
    return reportAction(env, session, gid, id, body);
  }
  if (path === "/api/cases" && method === "GET") return listCases(env, gid);
  if (actionMatch && actionMatch[1] === "cases" && method === "POST") {
    const id = decodeURIComponent(actionMatch[2]);
    if (!CASE_ID.test(id)) return fail(400, "invalid_id", "Invalid case ID.");
    const { res, body } = await readJsonBody(request);
    if (res) return res;
    return caseAction(env, session, gid, id, body);
  }
  if (path === "/api/analytics" && method === "GET") {
    const range = url.searchParams.get("range") || "7d";
    if (!RANGES[range]) return fail(400, "invalid_range", "Range must be 24h, 7d or 30d.");
    return analytics(env, gid, range);
  }
  if (path === "/api/bot/status" && method === "GET") {
    const [bot, d, installed] = await Promise.all([botHeartbeat(env), guildDoc(env, gid), botInstalled(env, gid)]);
    return json({ bot, guild: { installed: installed === "installed", enabled: d.enabled === true, logChannelId: d.log_channel_id || null, reportChannelId: d.report_channel_id || null } });
  }
  if (path === "/api/settings" && method === "GET") return settingsGet(env, gid);
  if (path === "/api/settings" && method === "POST") {
    const { res, body } = await readJsonBody(request);
    if (res) return res;
    return settingsAction(env, session, gid, body);
  }
  if (path === "/api/bot/command" && method === "POST") {
    const { res, body } = await readJsonBody(request);
    if (res) return res;
    return botCommandCreate(env, session, gid, body);
  }
  if (cmdStatusMatch && method === "GET") {
    const id = cmdStatusMatch[1];
    if (!REPORT_ID.test(id)) return fail(400, "invalid_id", "Invalid command ID.");
    return botCommandStatus(env, gid, id);
  }
  return fail(405, "method_not_allowed", "Method not allowed for this route.");
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Public health check: no sign-in, no secrets. Lets the site and the owner confirm the new Worker is live.
  if (path === "/api/health") {
    if (method !== "GET") return fail(405, "method_not_allowed", "Use GET.");
    return json({ ok: true, service: "proguard", version: WORKER_VERSION, configured: missingConfig(env).length === 0 });
  }

  if (path.startsWith("/auth/") || path.startsWith("/api/")) {
    const bad = configProblem(env);
    if (bad) return bad;
  }

  if (path === "/auth/discord") {
    if (method !== "GET") return fail(405, "method_not_allowed", "Use GET.");
    if (!rateOk(`${ip}:auth`, 20)) return fail(429, "rate_limited", "Too many sign-in attempts. Wait a minute.");
    return startLogin(env);
  }
  if (path === "/auth/discord/callback") {
    if (method !== "GET") return fail(405, "method_not_allowed", "Use GET.");
    if (!rateOk(`${ip}:auth`, 20)) return fail(429, "rate_limited", "Too many sign-in attempts. Wait a minute.");
    return finishLogin(request, env, url);
  }
  if (path === "/auth/logout") {
    if (method !== "POST") return fail(405, "method_not_allowed", "Use POST to sign out.");
    if (!csrfOk(request, url)) return fail(403, "csrf", "Request blocked. Refresh the page and try again.");
    return logout(request, env);
  }
  if (path.startsWith("/api/")) return api(request, env, url, ip);

  if (method !== "GET" && method !== "HEAD") return fail(405, "method_not_allowed", "Method not allowed.");
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return fail(500, "misconfigured", "Static assets are not bound.");
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error("ProGuard Worker error:", e && e.message);
      return fail(500, "internal", "Something went wrong. Try again.");
    }
  },
};
