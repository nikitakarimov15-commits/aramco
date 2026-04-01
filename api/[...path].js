/**
 * API for the bundled SPA. Persists users + sessions + balances when Vercel Postgres is linked (POSTGRES_URL).
 * Memory fallback if POSTGRES_URL is unset (local dev without DB).
 *
 * Env:
 *   POSTGRES_URL       — auto-set when you add Vercel Postgres
 *   STUB_ADMIN_SECRET  — POST /api/admin/balance with header x-admin-secret
 */

const bcrypt = require("bcryptjs");
const db = require("../lib/db");

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
      balance: "10000.00",
      base_money: "10000.00",
      available_money: "10000.00",
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

function appInfoData() {
  return {
    site_info: {
      site_name: "Aramco",
      site_domain_type: "2",
      site_domain_prefix: "www",
      logo: "",
      ico: "",
    },
    setting: {
      index_is_login: "false",
      user_invite_link: "",
      index_force_notice: "false",
      is_enable_sign: "false",
      is_enable_lottery: "false",
      is_show_fake_data: "false",
      register_is_captcha: "false",
      tg_status: "",
      telegram_register_status: "",
      salesmartly_src: "",
    },
    register_info: {
      invitation_code_require: "false",
      is_repeat_password: "true",
      register_account_status: "true",
      tg_status: "",
      ws_app_status: "",
      register_is_captcha: "false",
      phone_register_email_status: "true",
    },
    theme: 1,
  };
}

function indexInfoData() {
  return ok({
    notice: [],
    slide: [],
    sys_info: {
      salesmartly_src: "",
      index_video_is_show: "false",
      index_video_url: "",
      buy_product_is_pwd: "false",
      invest_show_type: "",
      is_show_fake_data: "false",
      index_force_notice: "false",
      is_enable_sign: "false",
      is_enable_lottery: "false",
      lottery_type: "",
    },
    index: {
      user: null,
      new_message_count: 0,
      new_pop_message_count: 0,
    },
  }).data;
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

  try {
    if (db.usePostgres()) {
      await db.ensureSchema();
    }

    if (route === "/admin/balance" && req.method === "POST") {
      const secret = process.env.STUB_ADMIN_SECRET;
      if (!secret || req.headers["x-admin-secret"] !== secret) {
        return json(req, res, 403, err("Forbidden", 403));
      }
      const b = await parseBody(req);
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

    if (route === "/public/index_info" && req.method === "GET") {
      const inner = indexInfoData();
      return json(req, res, 200, { status: 200, msg: "ok", data: inner });
    }

    if (route === "/public/get_lang_json" && req.method === "GET") {
      return json(req, res, 200, ok({ en: {}, zh: {} }));
    }

    if (route === "/public/reset" && req.method === "GET") {
      return json(req, res, 200, ok({}));
    }

    if (route.startsWith("/public/") && req.method === "GET") {
      return json(req, res, 200, ok([]));
    }

    if (route === "/user/login_info" && req.method === "POST") {
      return json(req, res, 200, ok(appInfoData()));
    }

    if (route === "/user/app_info" && req.method === "GET") {
      return json(req, res, 200, ok(appInfoData()));
    }

    if (route.startsWith("/user/register") && req.method === "POST") {
      const b = await parseBody(req);
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
        balance: "10000.00",
        base_money: "10000.00",
        available_money: "10000.00",
      };
      usersByEmail.set(email, u);
      const { token, expires_time } = await issueToken(email);
      return json(req, res, 200, ok({ token, expires_time, user: userRow(u) }));
    }

    if (route.startsWith("/user/login") && req.method === "POST") {
      const b = await parseBody(req);
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

    const email = await sessionEmail(req);
    if (
      [
        "/user/user_info",
        "/user/mine",
        "/user/invite_info",
        "/user/share_config",
        "/user/get_share_task",
        "/user/invite_give",
        "/user/team_recharge",
        "/user/task_center",
        "/user/task_center_detail",
        "/user/vip_level_record",
        "/user/user_rank",
      ].includes(route) &&
      req.method === "GET"
    ) {
      if (!email) return json(req, res, 200, err("unauthorized", 401));
      const u = await loadUser(email);
      if (!u) return json(req, res, 200, err("unauthorized", 401));
      if (route === "/user/mine" || route === "/user/user_info") {
        return json(req, res, 200, ok(userRow(u)));
      }
      return json(req, res, 200, ok({ list: [], rows: [], user: userRow(u) }));
    }

    if (route.startsWith("/task/") && req.method === "GET") {
      return json(req, res, 200, ok({ list: [], count: 0, info: {} }));
    }

    if (route.startsWith("/task/") && req.method === "POST") {
      return json(req, res, 200, ok({}));
    }

    if (route.startsWith("/user/") && (req.method === "GET" || req.method === "POST")) {
      if (!route.includes("login") && !route.includes("register") && !email) {
        return json(req, res, 200, err("unauthorized", 401));
      }
      return json(req, res, 200, ok({}));
    }

    return json(req, res, 200, ok({}));
  } catch (e) {
    return json(req, res, 500, err(e.message || "error", 500));
  }
};
