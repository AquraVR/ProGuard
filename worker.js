
/*
 * PROGUARD WORKER
 *
 * Required files:
 *   worker.js
 *   wrangler.jsonc
 *   public/index.html
 *
 * Replace the (fill) placeholders below.
 * Never commit real secrets to a repository you share with anyone.
 */

const CONFIG = {
  DISCORD_CLIENT_ID: "1558816067948642455",
  DISCORD_CLIENT_SECRET: "wrRWmXnwgM7l6W72Z5i5dHlQ0gg0GNjz",
  DISCORD_REDIRECT_URI:
    "https://proguard.guardianpro.workers.dev/auth/discord/callback",
  OWNER_DISCORD_ID: "1406333881023594576",
  SESSION_SECRET: "u#rzNGoj9RbW!Sf&AsV#LA$VNq*vsHRX%S#MhFWW$SKYSBiMubYU&aa!qFNm^rEaToTvhW^eJq5#WPrT!haKPkeaNVQAr9sx^uteA@6muTP3sWfvoxw34VS8CnDC4BCw"
};

const DISCORD_AUTHORIZE =
  "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN =
  "https://discord.com/api/v10/oauth2/token";
const DISCORD_USER =
  "https://discord.com/api/v10/users/@me";

const SESSION_COOKIE = "proguard_session";
const STATE_COOKIE = "proguard_oauth_state";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function message(text, status = 400) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function redirect(location, cookies = []) {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store"
  });

  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 302, headers });
}

function setCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";

  for (const item of cookies.split(";")) {
    const index = item.indexOf("=");

    if (
      index !== -1 &&
      item.slice(0, index).trim() === name
    ) {
      return item.slice(index + 1).trim();
    }
  }

  return null;
}

function base64url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encode(value) {
  return base64url(encoder.encode(value));
}

function decode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );

  return decoder.decode(bytes);
}

async function sign(value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(CONFIG.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value)
  );

  return base64url(new Uint8Array(signature));
}

async function signaturesMatch(a, b) {
  const first = encoder.encode(a);
  const second = encoder.encode(b);

  if (first.length !== second.length) return false;

  let difference = 0;

  for (let i = 0; i < first.length; i++) {
    difference |= first[i] ^ second[i];
  }

  return difference === 0;
}

function missingConfig() {
  return Object.entries(CONFIG)
    .filter(([name, value]) =>
      !value ||
      value === "(fill)" ||
      value.trim() === ""
    )
    .map(([name]) => name);
}

function safePath(value) {
  if (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  ) {
    return value;
  }

  return "/";
}

async function createSession(user) {
  const session = {
    id: user.id,
    username: user.username,
    global_name: user.global_name || user.username,
    avatar: user.avatar || null,
    email: user.email || null,
    expires: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  };

  const payload = encode(JSON.stringify(session));

  return `${payload}.${await sign(payload)}`;
}

async function readSession(request) {
  const value = getCookie(request, SESSION_COOKIE);
  if (!value) return null;

  try {
    const separator = value.lastIndexOf(".");
    if (separator < 1) return null;

    const payload = value.slice(0, separator);
    const suppliedSignature = value.slice(separator + 1);
    const expectedSignature = await sign(payload);

    if (
      !(await signaturesMatch(
        suppliedSignature,
        expectedSignature
      ))
    ) {
      return null;
    }

    const session = JSON.parse(decode(payload));

    if (
      !session.id ||
      !session.expires ||
      session.expires <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    // Derive owner status from the configured owner ID.
    session.owner = session.id === CONFIG.OWNER_DISCORD_ID;

    return session;
  } catch {
    return null;
  }
}

async function startLogin(request) {
  const missing = missingConfig();

  if (missing.length) {
    return message(
      `ProGuard configuration is incomplete. Fill in: ${missing.join(", ")}`,
      500
    );
  }

  const url = new URL(request.url);
  const returnTo = safePath(url.searchParams.get("return"));

  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const state = base64url(randomBytes);

  const statePayload = encode(JSON.stringify({
    state,
    returnTo,
    expires: Math.floor(Date.now() / 1000) + 600
  }));

  const stateCookieValue =
    `${statePayload}.${await sign(statePayload)}`;

  const authorizeUrl = new URL(DISCORD_AUTHORIZE);

  authorizeUrl.searchParams.set(
    "client_id",
    CONFIG.DISCORD_CLIENT_ID
  );
  authorizeUrl.searchParams.set(
    "redirect_uri",
    CONFIG.DISCORD_REDIRECT_URI
  );
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "identify email guilds");
  authorizeUrl.searchParams.set("state", state);

  return redirect(authorizeUrl.toString(), [
    setCookie(STATE_COOKIE, stateCookieValue, 600)
  ]);
}

async function handleCallback(request) {
  const missing = missingConfig();

  if (missing.length) {
    return message(
      `ProGuard configuration is incomplete. Fill in: ${missing.join(", ")}`,
      500
    );
  }

  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return redirect("/", [clearCookie(STATE_COOKIE)]);
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const savedState = getCookie(request, STATE_COOKIE);

  if (!code || !returnedState || !savedState) {
    return message(
      "Login verification information is missing. Return to ProGuard and try again.",
      400
    );
  }

  let stateData;

  try {
    const separator = savedState.lastIndexOf(".");
    if (separator < 1) throw new Error("Missing signature");

    const payload = savedState.slice(0, separator);
    const signature = savedState.slice(separator + 1);
    const expected = await sign(payload);

    if (!(await signaturesMatch(signature, expected))) {
      throw new Error("Invalid signature");
    }

    stateData = JSON.parse(decode(payload));

    if (
      stateData.state !== returnedState ||
      stateData.expires <= Math.floor(Date.now() / 1000)
    ) {
      throw new Error("Invalid or expired state");
    }
  } catch {
    return new Response(
      "Login verification failed. Please start Discord Login again.",
      {
        status: 400,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": clearCookie(STATE_COOKIE)
        }
      }
    );
  }

  let tokenResponse;

  try {
    tokenResponse = await fetch(DISCORD_TOKEN, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: CONFIG.DISCORD_CLIENT_ID,
        client_secret: CONFIG.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: CONFIG.DISCORD_REDIRECT_URI
      })
    });
  } catch {
    return message("Unable to contact Discord. Try again.", 502);
  }

  if (!tokenResponse.ok) {
    console.error("Discord token exchange failed:", tokenResponse.status);

    return message(
      "Discord rejected the login exchange. Check the Client ID, Client Secret, and redirect URI.",
      502
    );
  }

  const tokenData = await tokenResponse.json();

  if (!tokenData.access_token) {
    return message("Discord did not return an access token.", 502);
  }

  let userResponse;

  try {
    userResponse = await fetch(DISCORD_USER, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`
      }
    });
  } catch {
    return message("Unable to verify your Discord account.", 502);
  }

  if (!userResponse.ok) {
    return message("Discord account verification failed.", 502);
  }

  const user = await userResponse.json();

  if (!user.id || !user.username) {
    return message("Discord returned incomplete account information.", 502);
  }

  const sessionCookie = await createSession(user);
  const destination = new URL(
    safePath(stateData.returnTo),
    url.origin
  ).toString();

  return redirect(destination, [
    setCookie(SESSION_COOKIE, sessionCookie, SESSION_SECONDS),
    clearCookie(STATE_COOKIE)
  ]);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith("/auth/") && request.method !== "GET") {
    return message("Method not allowed.", 405);
  }

  if (path === "/auth/discord") {
    return startLogin(request);
  }

  if (path === "/auth/discord/callback") {
    return handleCallback(request);
  }

  if (path === "/auth/logout") {
    return redirect("/", [
      clearCookie(SESSION_COOKIE),
      clearCookie(STATE_COOKIE)
    ]);
  }

  if (path === "/api/me") {
    const session = await readSession(request);

    if (!session) {
      return json({ authenticated: false }, 401);
    }

    return json({
      authenticated: true,
      user: {
        id: session.id,
        username: session.username,
        global_name: session.global_name,
        avatar: session.avatar,
        email: session.email,
        owner: session.id === CONFIG.OWNER_DISCORD_ID
      }
    });
  }

  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return message(
      "Static assets are not configured. Check the ASSETS binding in wrangler.jsonc.",
      500
    );
  }

  try {
    const response = await env.ASSETS.fetch(request);

    if (response.status === 404) {
      return message(
        "Page not found. Check that the file exists in your public directory.",
        404
      );
    }

    return response;
  } catch (error) {
    console.error("Asset request failed:", error);
    return message("Unable to load ProGuard website assets.", 500);
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("ProGuard Worker error:", error);
      return message("ProGuard encountered an internal error.", 500);
    }
  }
};
