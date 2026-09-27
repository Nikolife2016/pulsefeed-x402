// Рассылки в радаре (27.09.2026).
//
// Радар берёт ветку, если в ней назван эндпоинт из каталога Bazaar. Рассылки это правило проходят:
// кампания называет собственный эндпоинт. За 10–26.09.2026 радар принёс 180 веток, и большинство
// оказались рассылками: один автор — 12–16 чужих репозиториев (Nano/XNO, Lightning, «провайдер без
// ключа» от blockrun.ai), один хост — до 26 репозиториев. Прежняя свёртка ловила только дословно
// одинаковый заголовок, а кампании перефразируют каждую ветку.
//
// Три признака, любого достаточно; порог — три разных репозитория:
//   автор     — открывал ветки в трёх и более ЧУЖИХ репозиториях. Свои репозитории автора не в
//               счёт: мейнтейнер, заводящий задачи у себя, рассылку не ведёт;
//   хост      — один названный хост в трёх и более репозиториях при малом числе авторов, не больше
//               max(2, репозитории/3). Органический интерес — много разных людей, кампания — один-два;
//   заголовок — дословно одинаковый нормализованный заголовок в трёх и более репозиториях.
// Считается по сегодняшней выдаче поиска и по выпускам радара за последние 14 дней: кампании капают
// по одной-две ветки в сутки, и за одно окно поиска (3 дня) порог часто не набирается.

const REPO_MIN = 3;
const LOOKBACK_DAYS = 14;
const HEADER = /Свежие вопросы, где у нас есть конкретный ответ — (\d{4}-\d{2}-\d{2}) UTC/g;
const THREAD = /\[([\w.-]+\/[\w.-]+)#(\d+)\]\((https:\/\/github\.com\/[^)\s]+)\)/;
const AUTHOR = /· @([A-Za-z0-9-]+(?:\[bot\])?)/;
const LISTED_HOST = /([a-z0-9.-]+\.[a-z]{2,}): \d+ листинг/g;
const CUT_HOSTS = /· хост ([a-z0-9., -]+)/;

const normTitle = t => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
const ownerOf = repo => String(repo || "").split("/")[0].toLowerCase();
const foreign = x => !!x.author && ownerOf(x.repo) !== String(x.author).toLowerCase();

function tally(items, keysOf) {
  const m = new Map();
  for (const x of items) {
    for (const k of [].concat(keysOf(x) || [])) {
      if (!k) continue;
      if (!m.has(k)) m.set(k, { repos: new Set(), authors: new Set() });
      m.get(k).repos.add(x.repo);
      if (x.author) m.get(k).authors.add(x.author);
    }
  }
  return m;
}

/**
 * rows    — сегодняшние кандидаты: { url, repo, author, hosts[], title }
 * raw     — вся сегодняшняя выдача поиска: { url, repo, author } (разброс автора виден и по веткам без хоста)
 * history — ветки из прошлых выпусков за окно: { url, repo, author|null, hosts[] }
 * Возвращает Map(url → { kind: "author" | "host" | "title", key, repos }).
 */
function findCampaigns({ rows, raw = [], history = [] }) {
  const byAuthor = tally([...raw, ...history, ...rows].filter(foreign), x => x.author);
  const byHost = tally([...history, ...rows], x => x.hosts);
  const byTitle = tally(rows, x => normTitle(x.title));
  const out = new Map();
  for (const r of rows) {
    const a = foreign(r) ? byAuthor.get(r.author) : null;
    if (a && a.repos.size >= REPO_MIN) { out.set(r.url, { kind: "author", key: "@" + r.author, repos: a.repos.size }); continue; }
    let hit = null;
    for (const h of r.hosts || []) {
      const g = byHost.get(h);
      if (g && g.repos.size >= REPO_MIN && g.authors.size <= Math.max(2, Math.floor(g.repos.size / 3))) {
        hit = { kind: "host", key: h, repos: g.repos.size };
        break;
      }
    }
    if (hit) { out.set(r.url, hit); continue; }
    const t = byTitle.get(normTitle(r.title));
    if (t && t.repos.size >= REPO_MIN) out.set(r.url, { kind: "title", key: normTitle(r.title).slice(0, 60), repos: t.repos.size });
  }
  return out;
}

// Прошлые выпуски из текста трекера: ветка, репозиторий, автор (если записан — с 27.09.2026)
// и названные хосты. Выпуски старше окна не берём: без дат старый хвост копил бы «рассылки» вечно.
function parseHistory(text, nowMs, days = LOOKBACK_DAYS) {
  const out = [];
  const src = String(text || "");
  const marks = [...src.matchAll(HEADER)];
  for (let i = 0; i < marks.length; i++) {
    const at = Date.parse(marks[i][1] + "T00:00:00Z");
    if (!(nowMs - at <= days * 86_400_000)) continue;
    const block = src.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : src.length);
    const lines = block.split("\n");
    for (let j = 0; j < lines.length; j++) {
      const m = lines[j].match(THREAD);
      if (!m) continue;
      const hosts = new Set();
      const cut = lines[j].match(CUT_HOSTS);
      if (cut) for (const h of cut[1].split(/,\s*/)) if (h.trim()) hosts.add(h.trim());
      if (j + 1 < lines.length && lines[j + 1].startsWith("  у нас есть данные"))
        for (const h of lines[j + 1].matchAll(LISTED_HOST)) hosts.add(h[1]);
      out.push({ url: m[3], repo: m[1], author: (lines[j].match(AUTHOR) || [])[1] || null, hosts: [...hosts] });
    }
  }
  return out;
}

module.exports = { findCampaigns, parseHistory, REPO_MIN, LOOKBACK_DAYS };
