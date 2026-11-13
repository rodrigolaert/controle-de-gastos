"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run tests.");
}

const appPassword = crypto.randomBytes(24).toString("hex");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.APP_PASSWORD = appPassword;
process.env.APP_LOGIN = "Casa";

const {
  createServer,
  buildPgConfig,
  sessionCookieOptions,
  stateHasUserData,
  timingSafeEqualString,
} = require("../server");

function cookieJar() {
  let cookie = "";
  return {
    async request(base, path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      if (cookie) headers.cookie = cookie;
      const response = await fetch(base + path, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const setCookies =
        typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [response.headers.get("set-cookie")].filter(Boolean);
      for (const raw of setCookies) {
        const pair = raw.split(";")[0];
        if (!pair.startsWith("gastos_session=")) continue;
        const value = pair.slice("gastos_session=".length);
        const expired = /max-age=0/i.test(raw) || /expires=thu, 01 jan 1970/i.test(raw);
        cookie = !value || expired ? "" : pair;
      }
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: response.status, data, setCookies, text };
    },
  };
}

test("string comparison does not treat different lengths as equal", () => {
  assert.equal(timingSafeEqualString("Casa", "Casa"), true);
  assert.equal(timingSafeEqualString("Casa", "casa"), false);
  assert.equal(timingSafeEqualString("Casa", "Casa "), false);
  assert.equal(timingSafeEqualString("", "Casa"), false);
});

test("postgres TLS mode follows internal and external Render URLs", () => {
  const internal = buildPgConfig("postgres://user@dpg-abc123-a/gastos");
  assert.equal(internal.ssl, false);
  assert.equal(internal.connectionString.includes("sslmode"), false);

  const external = buildPgConfig(
    "postgres://user@dpg-abc123-a.oregon-postgres.render.com/gastos?sslmode=require"
  );
  assert.deepEqual(external.ssl, { rejectUnauthorized: false });
  assert.equal(external.connectionString.includes("sslmode"), false);
  assert.match(external.connectionString, /oregon-postgres\.render\.com/);

  const disabled = buildPgConfig(
    "postgres://user@dpg-abc123-a.oregon-postgres.render.com/gastos?sslmode=disable"
  );
  assert.equal(disabled.ssl, false);

  const local = buildPgConfig("postgres://user@127.0.0.1:5432/gastos");
  assert.equal(local.ssl, false);

  const strict = buildPgConfig(
    "postgres://user@db.example.com/gastos?sslmode=verify-full"
  );
  assert.deepEqual(strict.ssl, { rejectUnauthorized: true });
});

test("session cookie is httpOnly, SameSite, and Secure in production", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const secure = sessionCookieOptions();
    assert.equal(secure.httpOnly, true);
    assert.equal(secure.secure, true);
    assert.equal(secure.sameSite, "lax");
    assert.equal(secure.path, "/");
  } finally {
    process.env.NODE_ENV = previous;
  }
  const local = sessionCookieOptions();
  assert.equal(local.httpOnly, true);
  assert.equal(local.secure, false);
  assert.equal(local.sameSite, "lax");
});

test("empty default months are not treated as household expenses", () => {
  assert.equal(
    stateHasUserData({
      version: 1,
      months: {
        "2026-11": {
          pctRodrigo: 50,
          pctCamila: 50,
          comments: "",
          settled: false,
          categories: [{ name: "Energia", rodrigo: 0, camila: 0 }],
        },
      },
    }),
    false
  );
  assert.equal(
    stateHasUserData({
      version: 1,
      months: {
        "2026-11": {
          pctRodrigo: 50,
          pctCamila: 50,
          comments: "conta de luz",
          categories: [],
        },
      },
    }),
    true
  );
});

test("one household login shares state and logged-out clients do not", async () => {
  const { app, pool } = await createServer();
  await pool.query("TRUNCATE TABLE household_state");
  await pool.query(
    "INSERT INTO household_state (id, state) VALUES (1, $1::jsonb)",
    [JSON.stringify({ version: 1, months: {}, lastYear: 2026, lastMonth: 10 })]
  );
  const server = app.listen(0, "0.0.0.0");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal(address.address, "0.0.0.0");

    const home = await fetch(base + "/");
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /Gastos Mensais/);
    assert.match(html, /Usuário/);
    assert.match(html, /value="Casa"/);
    assert.doesNotMatch(html, /Criar conta/);
    assert.doesNotMatch(html, /convite/i);
    assert.match(html, /Divisão do mês/);

    const script = await fetch(base + "/app.js");
    assert.equal(script.status, 200);
    assert.match(await script.text(), /gastos-mensais-v1/);
    assert.equal((await fetch(base + "/styles.css")).status, 200);
    assert.equal((await fetch(base + "/server.js")).status, 404);
    assert.equal((await fetch(base + "/package.json")).status, 404);
    assert.equal((await fetch(base + "/.env")).status, 404);
    const signup = await fetch(base + "/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(signup.status, 404);

    const health = await fetch(base + "/api/health");
    assert.equal(health.status, 200);

    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'household_state'`
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.equal(names.includes("password"), false);
    assert.equal(names.includes("password_hash"), false);

    const anonymous = cookieJar();
    assert.equal((await anonymous.request(base, "/api/state")).status, 401);

    const blocked = await anonymous.request(base, "/api/auth/login", {
      method: "POST",
      body: { username: "Casa", password: appPassword },
      headers: { origin: "https://evil.example" },
    });
    assert.equal(blocked.status, 403);

    const wrongUser = await anonymous.request(base, "/api/auth/login", {
      method: "POST",
      body: { username: "casa", password: appPassword },
    });
    const wrongPassword = await anonymous.request(base, "/api/auth/login", {
      method: "POST",
      body: { username: "Casa", password: `${appPassword}x` },
    });
    assert.equal(wrongUser.status, 401);
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongUser.data.error, wrongPassword.data.error);
    assert.equal(JSON.stringify(wrongUser.data).includes(appPassword), false);

    const first = cookieJar();
    const second = cookieJar();
    const loggedIn = await first.request(base, "/api/auth/login", {
      method: "POST",
      headers: { origin: base },
      body: { username: "Casa", password: appPassword },
    });
    assert.equal(loggedIn.status, 200);
    assert.deepEqual(loggedIn.data, { username: "Casa" });
    assert.equal(JSON.stringify(loggedIn.data).includes(appPassword), false);
    assert.match(loggedIn.setCookies.join("\n"), /HttpOnly/i);
    assert.match(loggedIn.setCookies.join("\n"), /SameSite=Lax/i);
    assert.doesNotMatch(loggedIn.setCookies.join("\n"), /Secure/i);

    const me = await first.request(base, "/api/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.data.username, "Casa");

    const also = await second.request(base, "/api/auth/login", {
      method: "POST",
      body: { username: "Casa", password: appPassword },
    });
    assert.equal(also.status, 200);

    const state = {
      version: 1,
      months: {
        "2026-04": {
          pctRodrigo: 60,
          pctCamila: 40,
          comments: "segredo-da-casa",
          settled: false,
          categories: [{ id: "energia", name: "Energia", rodrigo: 180, camila: 20 }],
        },
      },
      lastYear: 2026,
      lastMonth: 3,
    };
    const saved = await first.request(base, "/api/state", {
      method: "PUT",
      headers: { "x-tab-id": "telefone", "x-tab-seq": "2" },
      body: state,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.months["2026-04"].comments, "segredo-da-casa");

    const stale = await first.request(base, "/api/state", {
      method: "PUT",
      headers: { "x-tab-id": "telefone", "x-tab-seq": "1" },
      body: {
        ...state,
        months: {
          "2026-04": { ...state.months["2026-04"], comments: "versao-antiga" },
        },
      },
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.data.months["2026-04"].comments, "segredo-da-casa");

    const shared = await second.request(base, "/api/state");
    assert.equal(shared.status, 200);
    assert.equal(shared.data.months["2026-04"].comments, "segredo-da-casa");
    assert.equal(shared.data.months["2026-04"].categories[0].rodrigo, 180);

    assert.equal((await anonymous.request(base, "/api/state")).status, 401);

    const loggedOut = await first.request(base, "/api/auth/logout", {
      method: "POST",
      body: {},
    });
    assert.equal(loggedOut.status, 200);
    assert.equal((await first.request(base, "/api/auth/me")).status, 401);
    assert.equal((await first.request(base, "/api/state")).status, 401);
    assert.equal(
      (await second.request(base, "/api/state")).data.months["2026-04"].comments,
      "segredo-da-casa"
    );

    const again = await first.request(base, "/api/auth/login", {
      method: "POST",
      body: { username: "Casa", password: appPassword },
    });
    assert.equal(again.status, 200);
    assert.equal(
      (await first.request(base, "/api/state")).data.months["2026-04"].comments,
      "segredo-da-casa"
    );

    const previousLogin = process.env.APP_LOGIN;
    process.env.APP_LOGIN = "OutraCasa";
    try {
      const overridden = await cookieJar().request(base, "/api/auth/login", {
        method: "POST",
        body: { username: "Casa", password: appPassword },
      });
      assert.equal(overridden.status, 401);
      const renamed = await cookieJar().request(base, "/api/auth/login", {
        method: "POST",
        body: { username: "OutraCasa", password: appPassword },
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.data.username, "OutraCasa");
    } finally {
      process.env.APP_LOGIN = previousLogin;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
