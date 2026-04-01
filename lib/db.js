/**
 * Vercel / Prisma Postgres persistence.
 * Uses POSTGRES_URL, or DATABASE_URL / POSTGRES_PRISMA_URL (common with Prisma Postgres on Vercel).
 */
let sql = null;
let schemaReady = null;

function resolvePostgresUrl() {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.STORAGE_URL ||
    ""
  );
}

function usePostgres() {
  return !!resolvePostgresUrl();
}

function getSql() {
  if (!usePostgres()) return null;
  if (!sql) {
    const url = resolvePostgresUrl();
    if (!process.env.POSTGRES_URL && url) {
      process.env.POSTGRES_URL = url;
    }
    sql = require("@vercel/postgres").sql;
  }
  return sql;
}

async function ensureSchema() {
  if (!usePostgres()) return;
  const s = getSql();
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await s`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        account VARCHAR(255) NOT NULL,
        balance NUMERIC(20, 2) NOT NULL DEFAULT 10000.00,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await s`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        email VARCHAR(255) NOT NULL REFERENCES users (email) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      )
    `;
    await s`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)`;
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
  const s = getSql();
  const { rows } = await s`SELECT * FROM users WHERE email = ${email} LIMIT 1`;
  return rowToUser(rows[0]);
}

async function createUser({ email, passwordHash, account, balance }) {
  await ensureSchema();
  const s = getSql();
  const b = balance != null ? balance : "10000.00";
  await s`
    INSERT INTO users (email, password_hash, account, balance)
    VALUES (${email}, ${passwordHash}, ${account}, ${b})
  `;
  return findUserByEmail(email);
}

async function emailExists(email) {
  await ensureSchema();
  const s = getSql();
  const { rows } = await s`SELECT 1 FROM users WHERE email = ${email} LIMIT 1`;
  return rows.length > 0;
}

async function saveSession(token, email, expiresAtUnix) {
  await ensureSchema();
  const s = getSql();
  await s`
    INSERT INTO sessions (token, email, expires_at)
    VALUES (${token}, ${email}, ${expiresAtUnix})
  `;
}

async function findEmailByToken(token) {
  if (!token) return null;
  await ensureSchema();
  const s = getSql();
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await s`
    SELECT email FROM sessions WHERE token = ${token} AND expires_at > ${now} LIMIT 1
  `;
  return rows[0] ? rows[0].email : null;
}

async function updateBalanceByEmail(email, balanceStr) {
  await ensureSchema();
  const s = getSql();
  await s`UPDATE users SET balance = ${balanceStr}::numeric WHERE email = ${email}`;
  return findUserByEmail(email);
}

module.exports = {
  usePostgres,
  ensureSchema,
  getSql,
  findUserByEmail,
  createUser,
  emailExists,
  saveSession,
  findEmailByToken,
  updateBalanceByEmail,
  rowToUser,
};
