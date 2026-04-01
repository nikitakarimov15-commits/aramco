/**
 * Vercel / Prisma Postgres persistence.
 *
 * Reality on Vercel:
 * - Some env vars are POOLING (PgBouncer) and work with `@vercel/postgres` `sql`.
 * - Some env vars are DIRECT and will throw invalid_connection_string with `sql`.
 *
 * This module uses `pg` so it works with Prisma Postgres / Neon URLs too.
 */

let schemaReady = null;
let poolPromise = null;

function pickFirst(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function isPostgresConnectionString(url) {
  return /^postgres(ql)?:\/\//i.test(String(url || "").trim());
}

function resolvePostgresUrl() {
  // Prefer pooling variants first, then fall back to direct variants.
  const url = pickFirst(
    process.env.POSTGRES_PRISMA_URL,
    process.env.POSTGRES_URL,
    process.env.DATABASE_URL,
    process.env.STORAGE_PRISMA_URL,
    process.env.STORAGE_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.STORAGE_URL_NON_POOLING
  );
  // Prisma Postgres integrations sometimes provide Prisma/data-proxy URLs
  // (not tcp postgres://) which will not work with @vercel/postgres client.
  return isPostgresConnectionString(url) ? url : "";
}

function usePostgres() {
  return !!resolvePostgresUrl();
}

async function getClient() {
  if (!usePostgres()) return null;
  if (!poolPromise) {
    const { Pool } = require("pg");
    const connectionString = resolvePostgresUrl();
    const pool = new Pool({
      connectionString,
      // Neon/managed Postgres typically requires SSL in serverless.
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    poolPromise = Promise.resolve(pool);
  }
  return poolPromise;
}

async function query(text, params = []) {
  const pool = await getClient();
  return pool.query(text, params);
}

async function ensureSchema() {
  if (!usePostgres()) return;
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await query(
      `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        account VARCHAR(255) NOT NULL,
        balance NUMERIC(20, 2) NOT NULL DEFAULT 10.00,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `.trim()
    );
    await query(
      `
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        email VARCHAR(255) NOT NULL REFERENCES users (email) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      )
    `.trim()
    );
    await query(
      `CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)`
    );
  })();
  return schemaReady;
}

function rowToUser(row) {
  if (!row) return null;
  const bal = row.balance != null ? String(row.balance) : "0.00";
  return {
    email: row.email,
    password: null,
    password_hash: row.password_hash,
    account: row.account,
    balance: bal,
    base_money: bal,
    available_money: bal,
  };
}

async function findUserByEmail(email) {
  await ensureSchema();
  const { rows } = await query(`SELECT * FROM users WHERE email = $1 LIMIT 1`, [
    email,
  ]);
  return rowToUser(rows[0] || null);
}

async function createUser({ email, passwordHash, account, balance }) {
  await ensureSchema();
  const b = balance != null ? balance : "10.00";
  await query(
    `INSERT INTO users (email, password_hash, account, balance) VALUES ($1, $2, $3, $4)`,
    [email, passwordHash, account, b]
  );
  return findUserByEmail(email);
}

async function emailExists(email) {
  await ensureSchema();
  const { rows } = await query(`SELECT 1 FROM users WHERE email = $1 LIMIT 1`, [
    email,
  ]);
  return rows.length > 0;
}

async function saveSession(token, email, expiresAtUnix) {
  await ensureSchema();
  await query(
    `INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, $3)`,
    [token, email, expiresAtUnix]
  );
}

async function findEmailByToken(token) {
  if (!token) return null;
  await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await query(
    `SELECT email FROM sessions WHERE token = $1 AND expires_at > $2 LIMIT 1`,
    [token, now]
  );
  return rows[0] ? rows[0].email : null;
}

async function updateBalanceByEmail(email, balanceStr) {
  await ensureSchema();
  await query(`UPDATE users SET balance = $1::numeric WHERE email = $2`, [
    balanceStr,
    email,
  ]);
  return findUserByEmail(email);
}

async function listAllUsers() {
  await ensureSchema();
  const { rows } = await query(
    `SELECT id, email, account, balance, created_at FROM users ORDER BY created_at DESC`
  );
  return rows;
}

async function deleteUserByEmail(email) {
  await ensureSchema();
  // Sessions are cascade-deleted via FK
  const { rowCount } = await query(`DELETE FROM users WHERE email = $1`, [email]);
  return rowCount > 0;
}

module.exports = {
  usePostgres,
  ensureSchema,
  resolvePostgresUrl,
  findUserByEmail,
  createUser,
  emailExists,
  saveSession,
  findEmailByToken,
  updateBalanceByEmail,
  rowToUser,
  listAllUsers,
  deleteUserByEmail,
};
