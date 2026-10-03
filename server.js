// Clidex Studio: сервер для Render (Express + Postgres).
// Змінні середовища: DATABASE_URL, ADMIN_PASSWORD, BOT_TOKEN, CHAT_ID, (необов'язково) SESSION_SECRET.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const GLYPHS = ["♥", "▲", "✦", "☻"];

const SCHEMA = `
create table if not exists posts (
  id serial primary key,
  text text,
  media text,
  created_at timestamptz not null default now()
);
create table if not exists reactions (
  post_id int not null references posts(id) on delete cascade,
  voter text not null,
  glyph text not null,
  primary key (post_id, voter)
);
create table if not exists comments (
  id serial primary key,
  post_id int not null references posts(id) on delete cascade,
  voter text not null,
  name text,
  text text not null,
  created_at timestamptz not null default now()
);
`;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const voterOk = (v) => typeof v === "string" && /^[A-Za-z0-9-]{16,64}$/.test(v);
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const urlOk = (u) => /^https?:\/\/\S+$/i.test(u);

async function init(pool) {
  await pool.query(SCHEMA);
}

async function sendTelegram(env, text) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) throw new Error("BOT_TOKEN або CHAT_ID не задано");
  const r = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.CHAT_ID, text }),
  });
  if (!r.ok) throw new Error("Telegram відповів " + r.status);
}

function createApp(pool, env, notify) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "10kb" }));
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  });

  // ---- вхід власника: пароль з env, токен підписаний HMAC ----
  const secret = env.SESSION_SECRET || sha("clidex:" + (env.ADMIN_PASSWORD || "")).toString("hex");
  const hmac = (s) => crypto.createHmac("sha256", secret).update(s).digest("hex");
  const makeToken = () => {
    const exp = String(Date.now() + 30 * 864e5);
    return exp + "." + hmac(exp);
  };
  const okToken = (t) => {
    if (!env.ADMIN_PASSWORD || typeof t !== "string") return false;
    const [exp, sig] = t.split(".");
    if (!exp || !sig || !(Number(exp) > Date.now())) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(hmac(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const isAdmin = (req) => okToken((req.get("authorization") || "").replace(/^Bearer /, ""));
  const needAdmin = (req, res, next) =>
    isAdmin(req) ? next() : res.status(401).json({ error: "Потрібен вхід власника" });

  // ---- прості обмеження частоти ----
  const hits = new Map();
  const limit = (name, max, ms) => (req, res, next) => {
    const k = name + ":" + req.ip;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < ms);
    if (arr.length >= max) return res.status(429).json({ error: "Забагато спроб, зачекайте" });
    arr.push(now);
    hits.set(k, arr);
    next();
  };
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (!v.some((t) => now - t < 3600000)) hits.delete(k);
  }, 600000).unref();

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: "Помилка сервера" });
    });

  // ---- реальний час (SSE) ----
  const clients = new Set();
  const broadcast = () => {
    for (const r of clients) r.write("data: u\n\n");
  };
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    clients.add(res);
    const hb = setInterval(() => res.write(": hb\n\n"), 25000);
    req.on("close", () => {
      clearInterval(hb);
      clients.delete(res);
    });
  });

  // ---- власник ----
  app.post("/api/login", limit("login", 5, 15 * 60 * 1000), (req, res) => {
    if (!env.ADMIN_PASSWORD) return res.status(503).json({ error: "ADMIN_PASSWORD не задано на сервері" });
    const p = (req.body && req.body.password) || "";
    if (typeof p !== "string" || !safeEq(p, env.ADMIN_PASSWORD))
      return res.status(401).json({ error: "Невірний пароль" });
    res.json({ token: makeToken() });
  });
  app.get("/api/me", needAdmin, (req, res) => res.json({ admin: true }));

  // ---- стрічка ----
  app.get(
    "/api/feed",
    wrap(async (req, res) => {
      const voter = voterOk(req.query.voter) ? req.query.voter : null;
      const posts = (
        await pool.query("select id, text, media, created_at from posts order by created_at desc, id desc limit 100")
      ).rows;
      if (!posts.length) return res.json({ posts: [] });
      const rx = (await pool.query("select post_id, voter, glyph from reactions limit 50000")).rows;
      const cm = (
        await pool.query("select id, post_id, voter, name, text, created_at from comments order by id desc limit 5000")
      ).rows;
      const byPost = new Map(posts.map((p) => [p.id, { ...p, counts: {}, mine: null, comments: [] }]));
      for (const r of rx) {
        const p = byPost.get(r.post_id);
        if (!p) continue;
        p.counts[r.glyph] = (p.counts[r.glyph] || 0) + 1;
        if (voter && r.voter === voter) p.mine = r.glyph;
      }
      for (const c of cm.reverse()) {
        const p = byPost.get(c.post_id);
        if (p)
          p.comments.push({
            id: c.id,
            name: c.name,
            text: c.text,
            created_at: c.created_at,
            mine: !!voter && c.voter === voter,
          });
      }
      res.json({ posts: [...byPost.values()] });
    })
  );

  app.post(
    "/api/posts",
    needAdmin,
    wrap(async (req, res) => {
      const b = req.body || {};
      const text = str(b.text, 2000);
      const media = str(b.media, 500);
      if (!text && !media) return res.status(400).json({ error: "Порожній пост" });
      if (media && !urlOk(media))
        return res.status(400).json({ error: "Посилання на медіа має починатися з http:// або https://" });
      await pool.query("insert into posts (text, media) values ($1, $2)", [text || null, media || null]);
      broadcast();
      res.json({ ok: true });
    })
  );

  app.delete(
    "/api/posts/:id",
    needAdmin,
    wrap(async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Некоректний id" });
      await pool.query("delete from posts where id = $1", [id]);
      broadcast();
      res.json({ ok: true });
    })
  );

  // ---- реакції ----
  app.post(
    "/api/react",
    limit("w", 40, 60000),
    wrap(async (req, res) => {
      const b = req.body || {};
      const pid = Number.parseInt(b.post_id, 10);
      if (!Number.isInteger(pid) || !voterOk(b.voter) || !GLYPHS.includes(b.glyph))
        return res.status(400).json({ error: "Некоректні дані" });
      const ex = (await pool.query("select glyph from reactions where post_id = $1 and voter = $2", [pid, b.voter]))
        .rows[0];
      if (ex && ex.glyph === b.glyph) {
        await pool.query("delete from reactions where post_id = $1 and voter = $2", [pid, b.voter]);
      } else if (ex) {
        await pool.query("update reactions set glyph = $3 where post_id = $1 and voter = $2", [pid, b.voter, b.glyph]);
      } else {
        const p = (await pool.query("select id from posts where id = $1", [pid])).rows[0];
        if (!p) return res.status(404).json({ error: "Поста немає" });
        await pool.query("insert into reactions (post_id, voter, glyph) values ($1, $2, $3)", [pid, b.voter, b.glyph]);
      }
      broadcast();
      res.json({ ok: true });
    })
  );

  // ---- коментарі ----
  app.post(
    "/api/comments",
    limit("w", 40, 60000),
    wrap(async (req, res) => {
      const b = req.body || {};
      const pid = Number.parseInt(b.post_id, 10);
      const text = str(b.text, 300);
      const name = str(b.name, 30) || "Гість";
      if (!Number.isInteger(pid) || !voterOk(b.voter) || !text) return res.status(400).json({ error: "Некоректні дані" });
      const p = (await pool.query("select id from posts where id = $1", [pid])).rows[0];
      if (!p) return res.status(404).json({ error: "Поста немає" });
      await pool.query("insert into comments (post_id, voter, name, text) values ($1, $2, $3, $4)", [
        pid,
        b.voter,
        name,
        text,
      ]);
      broadcast();
      res.json({ ok: true });
    })
  );

  app.delete(
    "/api/comments/:id",
    wrap(async (req, res) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Некоректний id" });
      if (isAdmin(req)) {
        await pool.query("delete from comments where id = $1", [id]);
      } else if (voterOk(req.query.voter)) {
        await pool.query("delete from comments where id = $1 and voter = $2", [id, req.query.voter]);
      } else {
        return res.status(403).json({ error: "Немає доступу" });
      }
      broadcast();
      res.json({ ok: true });
    })
  );

  // ---- заявка в команду -> Telegram-бот ----
  app.post(
    "/api/apply",
    limit("apply", 3, 10 * 60 * 1000),
    wrap(async (req, res) => {
      const b = req.body || {};
      const nick = str(b.nick, 40);
      const tg = str(b.tg, 40);
      const exp = str(b.exp, 600);
      if (!nick || !tg || !exp) return res.status(400).json({ error: "Заповніть усі поля" });
      const text = "Нова заявка в команду Clidex Studio\n\nНік: " + nick + "\nTelegram: " + tg + "\nДосвід: " + exp;
      try {
        await notify(env, text);
      } catch (e) {
        console.error("apply:", e.message);
        return res.status(502).json({ error: "Не вдалося надіслати заявку" });
      }
      res.json({ ok: true });
    })
  );

  // Сайт лежить у public/index.html. Якщо index.html завантажили в корінь репозиторію,
  // віддаємо його звідти (лише цей файл, а не всю папку).
  const pubDir = path.join(__dirname, "public");
  if (fs.existsSync(path.join(pubDir, "index.html"))) {
    app.use(express.static(pubDir));
  } else {
    app.get("/", (req, res) => {
      const f = path.join(__dirname, "index.html");
      if (fs.existsSync(f)) return res.sendFile(f);
      res.status(404).send("index.html не знайдено. Покладіть його в папку public у репозиторії.");
    });
  }
  return app;
}

module.exports = { createApp, init, sendTelegram };

if (require.main === module) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Задайте змінну DATABASE_URL");
    process.exit(1);
  }
  const local = /@(localhost|127\.0\.0\.1)/.test(url) || process.env.PGSSL === "off";
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  init(pool)
    .then(() => {
      const port = process.env.PORT || 3000;
      createApp(pool, process.env, sendTelegram).listen(port, () => console.log("Clidex Studio запущено на порту " + port));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
  
