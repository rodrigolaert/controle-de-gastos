"use strict";

require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");

const COOKIE_NAME = "gastos_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN = "Casa";

// Keep aligned with DEFAULT_CATEGORIES and LEGACY_DEFAULT_SETS in app.js.
const KNOWN_CATEGORY_NAMES = new Set(
  [
    "Condomínio",
    "Energia",
    "Gás",
    "Impostos",
    "Funcionários",
    "Escola",
    "Cartão",
    "Consórcio",
    "Aluguel",
    "Água",
    "Luz",
    "Internet",
    "Mercado",
    "Streaming",
    "Outros",
  ].map((name) => name.toLocaleLowerCase("pt-BR"))
);

function sessionSecret() {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 16) {
    throw new Error("SESSION_SECRET must be a random string of at least 16 characters.");
  }
  return secret;
}

function householdUsername() {
  const configured = process.env.APP_LOGIN;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return DEFAULT_LOGIN;
}

function appPassword() {
  const password = process.env.APP_PASSWORD;
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("APP_PASSWORD is required.");
  }
  return password;
}

function timingSafeEqualString(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  const length = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  };
}

function clearSessionCookieOptions() {
  const { maxAge, ...options } = sessionCookieOptions();
  return options;
}

function resolveSsl({ sslmode, local, internal }) {
  // An explicit sslmode always wins. Render internal URLs omit it and use a
  // hostname without a dot; external URLs should use sslmode=require.
  if (sslmode === "disable") return false;
  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    return { rejectUnauthorized: true };
  }
  if (
    sslmode === "require" ||
    sslmode === "prefer" ||
    sslmode === "no-verify" ||
    sslmode === "allow"
  ) {
    // Render's public chain is not always in Node's default trust store.
    return { rejectUnauthorized: false };
  }
  if (local || internal) return false;
  return { rejectUnauthorized: false };
}

function buildPgConfig(connectionString) {
  let sslmode = "";
  let rewritten = connectionString;
  let local = false;
  let internal = false;

  try {
    const url = new URL(connectionString);
    sslmode = (url.searchParams.get("sslmode") || "").toLowerCase();
    url.searchParams.delete("sslmode");
    rewritten = url.toString();
    const host = url.hostname;
    local = host === "localhost" || host === "127.0.0.1" || host === "::1";
    internal = !host.includes(".");
  } catch {
    const match = /[?&]sslmode=([^&]+)/i.exec(connectionString);
    sslmode = match ? decodeURIComponent(match[1]).toLowerCase() : "";
    local = /@(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(connectionString);
    internal = false;
  }

  return {
    connectionString: rewritten,
    ssl: resolveSsl({ sslmode, local, internal }),
  };
}

function emptyState() {
  const now = new Date();
  return {
    version: 1,
    months: {},
    lastYear: now.getFullYear(),
    lastMonth: now.getMonth(),
  };
}

function amountOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function monthHasUserData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (String(raw.comments || "").trim()) return true;
  if (raw.settled === true) return true;
  const pctR = raw.pctRodrigo;
  const pctC = raw.pctCamila;
  const rSet = pctR !== undefined && pctR !== null && pctR !== "";
  const cSet = pctC !== undefined && pctC !== null && pctC !== "";
  if ((rSet && Math.round(Number(pctR)) !== 50) || (cSet && Math.round(Number(pctC)) !== 50)) {
    return true;
  }
  const categories = Array.isArray(raw.categories) ? raw.categories : [];
  for (const category of categories) {
    if (amountOf(category?.rodrigo) > 0 || amountOf(category?.camila) > 0) return true;
    const name = String(category?.name || "").trim().toLocaleLowerCase("pt-BR");
    if (name && !KNOWN_CATEGORY_NAMES.has(name)) return true;
  }
  return false;
}

function stateHasUserData(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const months = parsed.months;
  if (!months || typeof months !== "object" || Array.isArray(months)) return false;
  return Object.values(months).some(monthHasUserData);
}

function sanitizeState(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Estado inválido.");
    error.status = 400;
    throw error;
  }
  const months = {};
  const monthsIn = body.months;
  if (monthsIn && typeof monthsIn === "object" && !Array.isArray(monthsIn)) {
    const keys = Object.keys(monthsIn);
    if (keys.length > 240) {
      const error = new Error("Há meses demais para salvar.");
      error.status = 400;
      throw error;
    }
    for (const key of keys) {
      if (!/^\d{4}-\d{2}$/.test(key)) continue;
      const value = monthsIn[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      months[key] = JSON.parse(JSON.stringify(value));
    }
  }
  const now = new Date();
  const year = Number(body.lastYear);
  const month = Number(body.lastMonth);
  return {
    version: 1,
    months,
    lastYear: Number.isFinite(year) ? Math.min(2100, Math.max(2000, Math.round(year))) : now.getFullYear(),
    lastMonth: Number.isFinite(month) ? Math.min(11, Math.max(0, Math.round(month))) : now.getMonth(),
  };
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

function asState(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function readWriter(req) {
  const tab = String(req.get("x-tab-id") || "").trim().slice(0, 64);
  const seq = Number(req.get("x-tab-seq"));
  if (!tab || !Number.isSafeInteger(seq) || seq < 0) return { tab: null, seq: 0 };
  return { tab, seq };
}

async function migrate(pool) {
  const legacy = await pool.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'household_state'
      AND column_name = 'household_id'
  `);
  if (legacy.rowCount > 0) {
    await pool.query("DROP TABLE IF EXISTS household_state, users, households, schema_migrations CASCADE");
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS household_state (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      writer_tab TEXT,
      writer_seq BIGINT NOT NULL DEFAULT 0,
      CONSTRAINT household_state_singleton CHECK (id = 1)
    )
  `);
  await pool.query(
    `INSERT INTO household_state (id, state)
     VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(emptyState())]
  );
}

async function saveHouseholdState(pool, state, options) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT state, writer_tab, writer_seq FROM household_state WHERE id = 1 FOR UPDATE"
    );
    const row = current.rows[0];
    if (options.onlyIfEmpty && row && stateHasUserData(asState(row.state))) {
      await client.query("COMMIT");
      return { conflict: true, state: asState(row.state) };
    }
    const stale =
      row &&
      options.tab &&
      row.writer_tab === options.tab &&
      Number(row.writer_seq) > options.seq;
    if (stale) {
      await client.query("COMMIT");
      return { stale: true, state: asState(row.state) };
    }
    const saved = await client.query(
      `INSERT INTO household_state (id, state, updated_at, writer_tab, writer_seq)
       VALUES (1, $1::jsonb, now(), $2, $3)
       ON CONFLICT (id) DO UPDATE
       SET state = EXCLUDED.state,
           updated_at = now(),
           writer_tab = EXCLUDED.writer_tab,
           writer_seq = EXCLUDED.writer_seq
       RETURNING state`,
      [JSON.stringify(state), options.tab, options.seq || 0]
    );
    await client.query("COMMIT");
    return { state: asState(saved.rows[0].state) };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
  }
}

function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    if (process.env.NODE_ENV === "test") return next();
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= max) {
      return sendError(res, 429, "Muitas tentativas. Espere um pouco e tente de novo.");
    }
    recent.push(now);
    hits.set(req.ip, recent);
    next();
  };
}

function requireJson(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const type = req.headers["content-type"] || "";
  if (!type.toLowerCase().includes("application/json")) {
    return sendError(res, 415, "Envie os dados em JSON.");
  }
  next();
}

function requireSameOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.get("origin");
  if (!origin) return next();
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    return sendError(res, 403, "Origem inválida.");
  }
  if (originHost !== req.get("host")) return sendError(res, 403, "Origem inválida.");
  next();
}

function buildApp(pool) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use("/api", express.json({ limit: "1mb" }));
  app.use("/api", requireSameOrigin);
  app.use("/api", requireJson);

  const limitAuth = rateLimit(30, 15 * 60 * 1000);

  function requireUser(req, res, next) {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) return sendError(res, 401, "Não autenticado.");
    try {
      const payload = jwt.verify(token, sessionSecret());
      if (!payload || payload.sub !== "household") {
        return sendError(res, 401, "Não autenticado.");
      }
    } catch {
      return sendError(res, 401, "Não autenticado.");
    }
    next();
  }

  function setSession(res) {
    const token = jwt.sign({ sub: "household" }, sessionSecret(), { expiresIn: "30d" });
    res.cookie(COOKIE_NAME, token, sessionCookieOptions());
  }

  app.get("/api/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.post("/api/auth/login", limitAuth, (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const expectedUsername = householdUsername();
    const expectedPassword = appPassword();
    const usernameOk = timingSafeEqualString(username, expectedUsername);
    const passwordOk = timingSafeEqualString(password, expectedPassword);
    if (!usernameOk || !passwordOk) {
      return sendError(res, 401, "Usuário ou senha incorretos.");
    }
    setSession(res);
    res.json({ username: expectedUsername });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie(COOKIE_NAME, clearSessionCookieOptions());
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireUser, (req, res) => {
    res.json({ username: householdUsername() });
  });

  app.get("/api/state", requireUser, async (req, res, next) => {
    try {
      const { rows } = await pool.query("SELECT state FROM household_state WHERE id = 1");
      res.json(rows[0] ? asState(rows[0].state) : emptyState());
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/state", requireUser, async (req, res, next) => {
    try {
      const state = sanitizeState(req.body);
      const result = await saveHouseholdState(pool, state, {
        onlyIfEmpty: req.query.onlyIfEmpty === "1",
        ...readWriter(req),
      });
      if (result.conflict) {
        return res.status(409).json({
          error: "A casa na nuvem já tem gastos.",
          state: result.state,
        });
      }
      res.json(result.state);
    } catch (error) {
      if (error.status) return sendError(res, error.status, error.message);
      next(error);
    }
  });

  const root = __dirname;
  function sendPublic(res, file) {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(root, file));
  }

  app.get("/", (req, res) => sendPublic(res, "index.html"));
  app.get("/index.html", (req, res) => sendPublic(res, "index.html"));
  app.get("/app.js", (req, res) => sendPublic(res, "app.js"));
  app.get("/styles.css", (req, res) => sendPublic(res, "styles.css"));

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return sendError(res, 404, "Não encontrado.");
    res.status(404).type("text/plain").send("Não encontrado");
  });

  app.use((error, req, res, next) => {
    if (error.type === "entity.parse.failed") return sendError(res, 400, "JSON inválido.");
    if (error.type === "entity.too.large") return sendError(res, 413, "Os dados são grandes demais.");
    console.error(error);
    if (res.headersSent) return next(error);
    return sendError(res, 500, "Erro interno.");
  });

  return app;
}

async function connectPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required (see .env.example).");
  }
  sessionSecret();
  appPassword();
  const pool = new Pool({
    ...buildPgConfig(process.env.DATABASE_URL),
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  const attempts = process.env.NODE_ENV === "test" ? 1 : 5;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      console.error(`Banco indisponível (tentativa ${attempt}): ${error.message}`);
      if (attempt < attempts) {
        const wait = Math.min(8000, 500 * 2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  if (lastError) {
    await pool.end().catch(() => {});
    throw lastError;
  }
  await migrate(pool);
  return pool;
}

async function createServer() {
  const pool = await connectPool();
  const app = buildApp(pool);
  return { app, pool };
}

async function main() {
  const { app, pool } = await createServer();
  const port = Number(process.env.PORT) || 10000;
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Gastos Mensais escutando em 0.0.0.0:${port}`);
  });

  async function shutdown() {
    server.close();
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
  }

  process.on("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  buildPgConfig,
  sessionCookieOptions,
  sanitizeState,
  stateHasUserData,
  monthHasUserData,
  timingSafeEqualString,
};
