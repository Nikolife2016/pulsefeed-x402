// Правила отсева рассылок в радаре. Запуск: node --test .github/scripts/radar-campaigns.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { findCampaigns, parseHistory } = require("./radar-campaigns.cjs");

const row = (repo, n, author, hosts = [], title = `thread ${repo}#${n}`) =>
  ({ url: `https://github.com/${repo}/issues/${n}`, repo, author, hosts, title });

test("один автор в трёх чужих репозиториях — рассылка, даже с разными заголовками", () => {
  const rows = [row("a/x", 1, "pitcher", ["blockrun.ai"], "Is the key optional?"),
    row("b/y", 2, "pitcher", ["blockrun.ai"], "Does every provider need a token?"),
    row("c/z", 3, "pitcher", ["blockrun.ai"], "Which auth_kind for no key?")];
  const c = findCampaigns({ rows });
  assert.equal(c.size, 3);
  for (const v of c.values()) assert.deepEqual([v.kind, v.key, v.repos], ["author", "@pitcher", 3]);
});

test("мейнтейнер, заводящий задачи в своих репозиториях, — не рассылка", () => {
  const rows = [row("alice/a", 1, "alice"), row("alice/b", 2, "alice"), row("alice/c", 3, "alice")];
  assert.equal(findCampaigns({ rows }).size, 0);
});

test("хост в трёх репозиториях у двух авторов — рассылка; у трёх разных авторов — живой интерес", () => {
  const camp = [row("a/x", 1, "op1", ["api.zfinia.com"]), row("b/y", 2, "op1", ["api.zfinia.com"]), row("c/z", 3, "op2", ["api.zfinia.com"])];
  const c = findCampaigns({ rows: camp });
  assert.equal(c.size, 3);
  assert.ok([...c.values()].every(v => v.kind === "host" && v.key === "api.zfinia.com"));
  const organic = [row("a/x", 1, "u1", ["api.bitrefill.com"]), row("b/y", 2, "u2", ["api.bitrefill.com"]), row("c/z", 3, "u3", ["api.bitrefill.com"])];
  assert.equal(findCampaigns({ rows: organic }).size, 0);
});

test("дословно одинаковый заголовок в трёх репозиториях — рассылка", () => {
  const t = "Complement (not a clone): Nock free /check + $0.05 /report";
  const rows = [row("a/x", 1, "u1", [], t), row("b/y", 2, "u2", [], t.toUpperCase()), row("c/z", 3, "u3", [], ` ${t} `)];
  const c = findCampaigns({ rows });
  assert.equal(c.size, 3);
  assert.ok([...c.values()].every(v => v.kind === "title"));
});

test("рассылка, растянутая на дни: две ветки в прошлых выпусках и одна сегодня — отсечь сегодняшнюю", () => {
  const history = [{ url: "https://github.com/a/x/issues/1", repo: "a/x", author: "dhyabi2", hosts: ["api.stelardigital.com"] },
    { url: "https://github.com/b/y/issues/2", repo: "b/y", author: "dhyabi2", hosts: ["api.stelardigital.com"] }];
  const today = [row("c/z", 9, "dhyabi2", ["api.stelardigital.com"])];
  const c = findCampaigns({ rows: today, history });
  assert.equal(c.get(today[0].url)?.kind, "author");
});

test("разброс автора виден и по веткам без названного хоста (вся выдача поиска)", () => {
  const raw = [{ url: "https://github.com/a/x/issues/1", repo: "a/x", author: "babyblueviper1" },
    { url: "https://github.com/b/y/issues/2", repo: "b/y", author: "babyblueviper1" }];
  const today = [row("c/z", 3, "babyblueviper1", ["api.babyblueviper.com"])];
  assert.equal(findCampaigns({ rows: today, raw }).get(today[0].url)?.kind, "author");
});

test("одиночная ветка по делу остаётся", () => {
  const rows = [row("aws/agent-toolkit-for-aws", 335, "ayoubsalem-spec", ["pennyregwatch.com"]),
    row("PublicAgents/public-agents", 147, "cto-public-agents-bot", ["agents.allium.so", "api.bitrefill.com"])];
  assert.equal(findCampaigns({ rows }).size, 0);
});

test("разбор прошлых выпусков: только окно, автор и хосты из обычной строки и из строки отсева", () => {
  const text = [
    "Свежие вопросы, где у нас есть конкретный ответ — 2026-09-01 UTC", "",
    "- **[old/repo#1](https://github.com/old/repo/issues/1)** — too old · @someone",
    "  у нас есть данные по названному эндпоинту: old.example.com: 1 листинг(ов) в Bazaar, оплаченных вызовов за 30 дней 1, уникальных плательщиков 1",
    "Свежие вопросы, где у нас есть конкретный ответ — 2026-09-26 UTC", "",
    "- **[a/x#5](https://github.com/a/x/issues/5)** — a question · @pitcher",
    "  у нас есть данные по названному эндпоинту: blockrun.ai: 83 листинг(ов) в Bazaar, оплаченных вызовов за 30 дней 1, уникальных плательщиков 1; x.example.org: 1 листинг(ов) в Bazaar, оплаченных вызовов за 30 дней 1, уникальных плательщиков 1",
    "- **[b/y#6](https://github.com/b/y/issues/6)** — before authors were recorded",
    "  у нас есть данные по названному эндпоинту: api.stelardigital.com: 3 листинг(ов) в Bazaar, оплаченных вызовов за 30 дней 24, уникальных плательщиков 4",
    "<details><summary>отсечённые ветки</summary>", "",
    "- ⛔ [c/z#7](https://github.com/c/z/issues/7) · @dhyabi2 · хост api.stelardigital.com, kbv.example.app — автор в 5 репозиториях",
    "</details>",
  ].join("\n");
  const h = parseHistory(text, Date.parse("2026-09-27T05:00:00Z"));
  assert.deepEqual(h.map(x => x.url), ["https://github.com/a/x/issues/5", "https://github.com/b/y/issues/6", "https://github.com/c/z/issues/7"]);
  assert.deepEqual(h[0], { url: "https://github.com/a/x/issues/5", repo: "a/x", author: "pitcher", hosts: ["blockrun.ai", "x.example.org"] });
  assert.equal(h[1].author, null);
  assert.deepEqual(h[1].hosts, ["api.stelardigital.com"]);
  assert.deepEqual(h[2], { url: "https://github.com/c/z/issues/7", repo: "c/z", author: "dhyabi2", hosts: ["api.stelardigital.com", "kbv.example.app"] });
});
