// 核心扫描逻辑（被 index.js 命令行 和 bot.js Telegram 共用）
// 从 Polymarket 拉取加密市场大额成交，给钱包标注真实战绩，挑出「聪明钱方向性下注」信号。

const CONFIG = {
  MIN_NOTIONAL_USDC: Number(process.env.MIN_NOTIONAL || 1000), // 多大金额(USDC)才算「巨鲸」信号(可按赛道调)
  POSITIONING_MIN_NOTIONAL: Number(process.env.POSITIONING_MIN_NOTIONAL || 500), // 持仓快照独立(低)门槛, 与信号门槛分开
  WHALE_TRADES_TO_PULL: 1000, // 默认拉多少笔「大额」成交
  CRYPTO_EVENT_PAGES: 6,      // 抓多少页加密市场建立过滤名单 (每页100)
  EXCLUDE_HFT: true,          // 排除「Up or Down」超短线刷单市场(纯赌博噪音)
  MAX_WALLETS_TO_SCORE: 60,   // 最多给多少笔(按金额)查钱包战绩
  SIGNAL_MIN_PNL: Number(process.env.SIGNAL_MIN_PNL || 5000), // 钱包全期盈亏超过此值才算「聪明钱」(可按赛道调)
  MIN_MIN_TO_RESOLUTION: 60,  // 距结算少于这么多分钟(或已结束)的市场不推
  TOP_N: 15,                  // 完整榜单展示前 N 笔
  WALLET_CONCURRENCY: 6,      // 同时查询多少个钱包
  SCORE_TTL_MS: 60 * 60 * 1000, // 钱包战绩缓存时长(战绩变化慢，1小时足够)
  MARKETS_TTL_MS: 30 * 60 * 1000, // 加密市场名单缓存(高频轮询时不重复拉取)
  // ② 观察名单(主动盯"加密活跃的常胜钱包")
  WATCHLIST_MIN_PNL: Number(process.env.WATCHLIST_MIN_PNL || 30000), // 全期盈亏达到此值才纳入观察名单(可按赛道调)
  WATCHLIST_DISCOVERY_MAX: 80,     // 每次最多评估多少个加密活跃钱包来建名单
  WATCHLIST_TTL_MS: 6 * 60 * 60 * 1000, // 名单缓存(6小时重建一次)
  WATCHLIST_TRADES_PER_WALLET: 20, // 每个名单钱包查最近多少笔成交
  WATCHLIST_MIN_NOTIONAL: Number(process.env.WATCHLIST_MIN_NOTIONAL || 100), // 名单成交最小金额(可按赛道调)
  WATCHLIST_MAX_AGE_MIN: 90,       // 只推这么多分钟内的动作
};

const fs = require("fs");
const path = require("path");

const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const PNL = "https://user-pnl-api.polymarket.com";
const LB = "https://lb-api.polymarket.com";
// 赛道(可配置)：crypto / fifa-world-cup / sports / politics ... 默认 crypto
const TAG = (process.env.POLY_TAG || "crypto").toLowerCase();
const WL_FILE = path.join(__dirname, "data", `watchlist_${TAG}.json`); // 每个赛道独立缓存

// ---------------- 工具 ----------------
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

const fmtUSD = (n) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

const tagOf = (p) =>
  p > 50000 ? "🐋🟢 巨鲸赢家" : p > 5000 ? "🟢 赢家" : p < -5000 ? "🔴 输家" : "⚪ 普通";
// 价格 0.15~0.85 = 真有方向判断；接近 1 = 吃息/套保，没信息量
const isDirectional = (price) => price > 0.15 && price < 0.85;

const HFT_RE = /\bup or down\b/i;
const CRYPTO_WORDS =
  /\b(bitcoin|btc|ethereum|eth|crypto|solana|\bsol\b|xrp|ripple|dogecoin|doge|binance|coinbase|stablecoin|usdc|usdt|altcoin|memecoin|nft|defi)\b/i;
// 关键词兜底：仅加密用标题判断；其他赛道只靠 tag 名单，避免误判
const KEYWORDS = TAG === "crypto" ? CRYPTO_WORDS : null;

// 各赛道的「噪音」市场过滤(衍生玩法/prop，无聪明钱信号价值)
const SPORTS_NOISE = /more markets|exact score|halftime|total corners|total goals|player props|first (team|goal)|both teams|anytime|to score|over\/?under|o\/u|\bo\.u\.?|announcer|corners|cards|booking/i;
const NOISE_BY_TAG = {
  "fifa-world-cup": SPORTS_NOISE,
  soccer: SPORTS_NOISE,
  sports: SPORTS_NOISE,
};
const EXCLUDE_EXTRA = NOISE_BY_TAG[TAG] || null;

// ---------------- 数据拉取 ----------------
// 返回 Map: conditionId(小写) -> { endMs, closed }，用于过滤已结束/即将结算的市场
// 带缓存：高频轮询时不重复拉取整张市场名单
let _cmCache = { t: 0, map: null };
async function getCryptoMarkets() {
  if (_cmCache.map && Date.now() - _cmCache.t < CONFIG.MARKETS_TTL_MS) return _cmCache.map;
  const map = new Map();
  for (let page = 0; page < CONFIG.CRYPTO_EVENT_PAGES; page++) {
    let events;
    try {
      events = await getJSON(
        `${GAMMA}/events?tag_slug=${TAG}&closed=false&limit=100&offset=${page * 100}`
      );
    } catch {
      break;
    }
    if (!Array.isArray(events) || events.length === 0) break;
    for (const ev of events)
      for (const m of ev.markets || []) {
        if (!m.conditionId) continue;
        map.set(m.conditionId.toLowerCase(), {
          endMs: m.endDate ? Date.parse(m.endDate) : 0,
          closed: !!m.closed,
        });
      }
  }
  _cmCache = { t: Date.now(), map };
  return map;
}

async function getWhaleTrades(pull) {
  const all = [];
  const PAGE = 500;
  for (let off = 0; off < pull; off += PAGE) {
    let batch;
    try {
      batch = await getJSON(
        `${DATA}/trades?limit=${PAGE}&offset=${off}&filterType=CASH&filterAmount=${CONFIG.MIN_NOTIONAL_USDC}&takerOnly=false`
      );
    } catch {
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE) break;
  }
  return all;
}

// 钱包战绩：用 user-pnl 的全期累计盈亏(最后一个点) + 当前市值，带缓存
const _scoreCache = new Map();
async function getWalletScore(wallet) {
  const c = _scoreCache.get(wallet);
  if (c && Date.now() - c.t < CONFIG.SCORE_TTL_MS) return c.data;
  let data;
  try {
    const [valueArr, pnlSeries] = await Promise.all([
      getJSON(`${DATA}/value?user=${wallet}`),
      getJSON(`${PNL}/user-pnl?user_address=${wallet}&interval=all&fidelity=1d`),
    ]);
    const value = Array.isArray(valueArr) && valueArr[0] ? valueArr[0].value : 0;
    let allTimePnl = 0;
    if (Array.isArray(pnlSeries) && pnlSeries.length) allTimePnl = pnlSeries[pnlSeries.length - 1].p || 0;
    data = { value, allTimePnl };
  } catch {
    data = { value: 0, allTimePnl: 0, error: true };
  }
  _scoreCache.set(wallet, { t: Date.now(), data });
  return data;
}

// ---------------- 主扫描 ----------------
async function scan(opts = {}) {
  const pull = opts.whaleTradesToPull || CONFIG.WHALE_TRADES_TO_PULL;
  const maxAgeMin = opts.maxAgeMinutes || 0; // 0 = 不按时间过滤
  const nowMs = Date.now();
  const nowSec = nowMs / 1000;

  const [cryptoMap, trades] = await Promise.all([getCryptoMarkets(), getWhaleTrades(pull)]);

  const cryptoWhales = trades
    .map((t) => ({
      ...t,
      notional: (t.size || 0) * (t.price || 0),
      ageMin: Math.max(0, Math.round((nowSec - (t.timestamp || nowSec)) / 60)),
    }))
    .filter((t) => {
      const meta = cryptoMap.get((t.conditionId || "").toLowerCase());
      const isCrypto = !!meta || (KEYWORDS && KEYWORDS.test(t.title || ""));
      if (!isCrypto) return false;
      if (CONFIG.EXCLUDE_HFT && HFT_RE.test(t.title || "")) return false;
      if (EXCLUDE_EXTRA && EXCLUDE_EXTRA.test(t.title || "")) return false;
      // 排除已结束 / 即将结算的市场(对这种市场的信号没有意义)
      if (meta && meta.closed) return false;
      if (meta && meta.endMs && meta.endMs <= nowMs + CONFIG.MIN_MIN_TO_RESOLUTION * 60000) return false;
      // 排除太旧的成交(只在传入 maxAgeMinutes 时生效)
      if (maxAgeMin && t.ageMin > maxAgeMin) return false;
      return true;
    })
    .sort((a, b) => b.notional - a.notional);

  const working = cryptoWhales.slice(0, CONFIG.MAX_WALLETS_TO_SCORE);
  const uniqWallets = [...new Set(working.map((w) => w.proxyWallet))];
  const scoreList = await mapLimit(uniqWallets, CONFIG.WALLET_CONCURRENCY, getWalletScore);
  const scores = Object.fromEntries(uniqWallets.map((w, i) => [w, scoreList[i]]));

  for (const w of working) {
    const s = scores[w.proxyWallet] || { value: 0, allTimePnl: 0 };
    w.value = s.value || 0;
    w.allTimePnl = s.allTimePnl || 0;
    w.tag = tagOf(w.allTimePnl);
    w.directional = isDirectional(w.price);
    // 去重用的唯一键：交易哈希 + 这笔的 token
    w.key = `${w.transactionHash || ""}_${w.asset || ""}`;
  }

  const signals = working
    .filter((w) => w.allTimePnl > CONFIG.SIGNAL_MIN_PNL && w.directional)
    .sort((a, b) => b.allTimePnl - a.allTimePnl);

  return {
    signals,
    top: working.slice(0, CONFIG.TOP_N),
    stats: {
      marketCount: cryptoMap.size,
      tradeCount: trades.length,
      cryptoWhaleCount: cryptoWhales.length,
    },
  };
}

// ---------------- ② 观察名单：主动盯历史盈利榜前列的钱包 ----------------
// 思路：不等大单，而是盯住"证明过自己"的常胜钱包，他们一进加密市场(任何金额)就报警。
async function getTopWallets(limit) {
  let arr;
  try {
    arr = await getJSON(`${LB}/profit?window=all&limit=${limit}`);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((w, i) => ({
      wallet: (w.proxyWallet || "").toLowerCase(),
      profit: w.amount || 0,
      name: w.name || w.pseudonym || "",
      rank: i + 1,
    }))
    .filter((w) => w.wallet);
}

// 动态构建"加密活跃的常胜钱包"名单：从近期加密大单里找出活跃钱包，
// 打分(全期盈亏)，只留下达到盈利门槛的赢家。带缓存(6小时重建)。
let _wlCache = { t: 0, list: null };
async function buildCryptoWatchlist() {
  // 内存缓存(同一进程内)
  if (_wlCache.list && Date.now() - _wlCache.t < CONFIG.WATCHLIST_TTL_MS) return _wlCache.list;
  // 文件缓存(跨进程/跨云端每次运行复用，避免每 5 分钟重建一次)
  try {
    const c = JSON.parse(fs.readFileSync(WL_FILE, "utf8"));
    if (
      c && c.t && Array.isArray(c.list) &&
      Date.now() - c.t < CONFIG.WATCHLIST_TTL_MS &&
      c.minPnl === CONFIG.WATCHLIST_MIN_PNL // 门槛变了就重建
    ) {
      _wlCache = c;
      return c.list;
    }
  } catch {}

  const [cryptoMap, trades] = await Promise.all([
    getCryptoMarkets(),
    getWhaleTrades(CONFIG.WHALE_TRADES_TO_PULL),
  ]);

  // 收集在加密市场活跃的钱包(顺带记下名字)
  const nameOf = new Map();
  for (const t of trades) {
    const meta = cryptoMap.get((t.conditionId || "").toLowerCase());
    const isCrypto = !!meta || (KEYWORDS && KEYWORDS.test(t.title || ""));
    if (!isCrypto) continue;
    if (CONFIG.EXCLUDE_HFT && HFT_RE.test(t.title || "")) continue;
    if (EXCLUDE_EXTRA && EXCLUDE_EXTRA.test(t.title || "")) continue;
    const w = (t.proxyWallet || "").toLowerCase();
    if (w && !nameOf.has(w)) nameOf.set(w, t.name || t.pseudonym || "");
  }

  const uniq = [...nameOf.keys()].slice(0, CONFIG.WATCHLIST_DISCOVERY_MAX);
  const scored = await mapLimit(uniq, CONFIG.WALLET_CONCURRENCY, async (w) => ({
    wallet: w,
    score: await getWalletScore(w),
  }));

  const winners = scored
    .filter((s) => (s.score.allTimePnl || 0) >= CONFIG.WATCHLIST_MIN_PNL)
    .sort((a, b) => b.score.allTimePnl - a.score.allTimePnl)
    .map((s, i) => ({
      wallet: s.wallet,
      profit: s.score.allTimePnl,
      value: s.score.value,
      name: nameOf.get(s.wallet) || "",
      rank: i + 1,
    }));

  _wlCache = { t: Date.now(), list: winners, minPnl: CONFIG.WATCHLIST_MIN_PNL };
  try {
    fs.mkdirSync(path.dirname(WL_FILE), { recursive: true });
    fs.writeFileSync(WL_FILE, JSON.stringify(_wlCache));
  } catch {}
  return winners;
}

async function scanWatchlist(opts = {}) {
  const maxAgeMin = opts.maxAgeMinutes || CONFIG.WATCHLIST_MAX_AGE_MIN;
  const nowMs = Date.now();
  const nowSec = nowMs / 1000;

  const [cryptoMap, top] = await Promise.all([
    getCryptoMarkets(),
    buildCryptoWatchlist(),
  ]);

  // 并发查每个榜首钱包的最近成交
  const lists = await mapLimit(top, CONFIG.WALLET_CONCURRENCY, async (w) => {
    try {
      const tr = await getJSON(
        `${DATA}/trades?user=${w.wallet}&limit=${CONFIG.WATCHLIST_TRADES_PER_WALLET}`
      );
      return { w, trades: Array.isArray(tr) ? tr : [] };
    } catch {
      return { w, trades: [] };
    }
  });

  const hits = [];
  for (const { w, trades } of lists) {
    for (const t of trades) {
      const meta = cryptoMap.get((t.conditionId || "").toLowerCase());
      const isCrypto = !!meta || (KEYWORDS && KEYWORDS.test(t.title || ""));
      if (!isCrypto) continue;
      if (CONFIG.EXCLUDE_HFT && HFT_RE.test(t.title || "")) continue;
    if (EXCLUDE_EXTRA && EXCLUDE_EXTRA.test(t.title || "")) continue;
      if (meta && meta.closed) continue;
      if (meta && meta.endMs && meta.endMs <= nowMs + CONFIG.MIN_MIN_TO_RESOLUTION * 60000) continue;
      if (!isDirectional(t.price)) continue; // 只要「方向性」下注，过滤吃息噪音
      const notional = (t.size || 0) * (t.price || 0);
      if (notional < CONFIG.WATCHLIST_MIN_NOTIONAL) continue;
      const ageMin = Math.max(0, Math.round((nowSec - (t.timestamp || nowSec)) / 60));
      if (ageMin > maxAgeMin) continue;
      hits.push({
        ...t,
        proxyWallet: w.wallet,
        name: w.name,
        notional,
        ageMin,
        profit: w.profit,
        rank: w.rank,
        allTimePnl: w.profit,
        directional: isDirectional(t.price),
        key: `${w.wallet}_${t.conditionId}_${t.timestamp}_${t.outcomeIndex}`,
      });
    }
  }
  // 排名靠前(更赚)优先，其次更新鲜
  hits.sort((a, b) => a.rank - b.rank || a.ageMin - b.ageMin);
  return { hits, stats: { watchSize: top.length, marketCount: cryptoMap.size } };
}

// ---- 巨鯨持倉快照：按「每个市场」精确拉大額買入, 统计多空分布(独立低门槛) ----
// 取活跃赛事(按24h量) → 展开主胜负/平市场 → 逐个市场用 /trades?market= 拉买入 → 聚合人数/金额/比例。
async function getMatchEvents(maxEvents) {
  const events = [];
  for (let p = 0; p < 2; p++) {
    let evs;
    try {
      evs = await getJSON(`${GAMMA}/events?tag_slug=${TAG}&closed=false&limit=100&offset=${p * 100}&order=volume24hr&ascending=false`);
    } catch {
      break;
    }
    if (!Array.isArray(evs) || !evs.length) break;
    events.push(...evs);
    if (evs.length < 100) break;
  }
  const filtered =
    TAG === "crypto"
      ? events
      : events.filter((e) => / vs\.? /i.test(e.title) && !(EXCLUDE_EXTRA && EXCLUDE_EXTRA.test(e.title)));
  return filtered.slice(0, maxEvents);
}

async function marketSentiment(opts = {}) {
  const topN = opts.topMarkets || 6;
  const minUsd = opts.minNotional || CONFIG.POSITIONING_MIN_NOTIONAL;
  const events = await getMatchEvents(opts.maxEvents || 12);

  const isSports = TAG !== "crypto";
  const DIR_MIN = 0.8; // 方向性集中度门槛: 主押结果占其本场总额 ≥80% 才算"有方向观点"; 否则=对冲/套利/做市, 不当聪明钱
  // 收集要统计的市场(主胜负/平, 排除衍生玩法); 体育额外标注该盘属于本场哪个结果(home/draw/away)
  const targets = [];
  for (const ev of events) {
    let homeName = null, awayName = null, homeTok = [], awayTok = [], kickoffMs = null;
    if (isSports) {
      // #7: 只统计【未开赛】比赛, 排除 in-play/已完赛 —— 开赛后场上的钱不算"赛前布局聪明钱"
      const gs = ev.startTime || (ev.markets || []).find((x) => x.gameStartTime)?.gameStartTime;
      kickoffMs = gs ? Date.parse(String(gs).replace(" ", "T")) : null;
      if (kickoffMs && Date.now() >= kickoffMs) continue;
      const parts = String(ev.title || "").split(/\s+vs\.?\s+/i);
      if (parts.length >= 2) { homeName = parts[0].trim(); awayName = parts[1].trim(); homeTok = teamToks(homeName); awayTok = teamToks(awayName); }
    }
    for (const m of ev.markets || []) {
      if (!m.conditionId) continue;
      if (EXCLUDE_EXTRA && EXCLUDE_EXTRA.test(m.question || "")) continue;
      if (/spread|o\/u|over\/under|exact|corner|halftime|player|total/i.test(m.question || "")) continue;
      let outcome = null;
      if (isSports) {
        const q = (m.question || "").toLowerCase();
        if (/draw/.test(q)) outcome = "draw";
        else if (homeTok.some((t) => q.includes(t))) outcome = "home";
        else if (awayTok.some((t) => q.includes(t))) outcome = "away";
      }
      let price = null; // 该结果的盘口价(Yes 隐含概率 0~1), 来自已拉取的 outcomePrices, 零额外请求
      try {
        const outs = JSON.parse(m.outcomes || "[]");
        const px = JSON.parse(m.outcomePrices || "[]");
        const yi = outs.findIndex((o) => /yes/i.test(o));
        if (yi >= 0) price = Number(px[yi]);
      } catch {}
      targets.push({ cid: m.conditionId, title: m.question, eventSlug: ev.slug, eventTitle: ev.title, outcome, home: homeName, away: awayName, price, kickoffMs });
    }
  }

  // 逐个市场精确拉「大额买入」
  const enriched = await mapLimit(targets, CONFIG.WALLET_CONCURRENCY, async (mk) => {
    let tr;
    try {
      tr = await getJSON(`${DATA}/trades?market=${mk.cid}&filterType=CASH&filterAmount=${minUsd}&limit=500`);
    } catch {
      tr = null;
    }
    const buys = Array.isArray(tr) ? tr.filter((t) => t.side === "BUY") : [];
    const byOut = new Map();
    const byWallet = new Map();
    const allWallets = new Set();
    const yesByWallet = new Map(); // 仅 Yes 一侧(供体育整场三方合并: 每盘 Yes = 押该结果发生)
    for (const t of buys) {
      const o = t.outcome || "?";
      const u = (t.size || 0) * (t.price || 0);
      if (!byOut.has(o)) byOut.set(o, { usd: 0, wallets: new Set() });
      const e = byOut.get(o);
      e.usd += u;
      e.wallets.add(t.proxyWallet);
      allWallets.add(t.proxyWallet);
      if (!byWallet.has(t.proxyWallet)) byWallet.set(t.proxyWallet, { usd: 0, byOut: new Map(), name: t.name || t.pseudonym || "" });
      const wr = byWallet.get(t.proxyWallet);
      wr.usd += u;
      wr.byOut.set(o, (wr.byOut.get(o) || 0) + u);
      if (/yes/i.test(o)) {
        if (!yesByWallet.has(t.proxyWallet)) yesByWallet.set(t.proxyWallet, { usd: 0, name: t.name || t.pseudonym || "" });
        yesByWallet.get(t.proxyWallet).usd += u;
      }
    }
    const total = [...byOut.values()].reduce((s, v) => s + v.usd, 0);
    const breakdown = [...byOut.entries()]
      .map(([outcome, v]) => ({ outcome, usd: v.usd, wallets: v.wallets.size, pct: total ? Math.round((v.usd / total) * 100) : 0 }))
      .sort((a, b) => b.usd - a.usd);
    // 金额最大的前几个大户(待 PnL 评分后再选"最赚的"与"最大注的")
    const topWallets = [...byWallet.entries()]
      .map(([w, wr]) => {
        const ents = [...wr.byOut.entries()].sort((a, b) => b[1] - a[1]);
        const dir = wr.usd > 0 ? (ents[0]?.[1] || 0) / wr.usd : 0; // 方向集中度: 同时押 Yes+No(对冲/做市)→ 低
        return { wallet: w, name: wr.name, usd: wr.usd, outcome: ents[0]?.[0], dir, directional: dir >= 0.8 };
      })
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 6);
    const yesUsd = [...yesByWallet.values()].reduce((s, v) => s + v.usd, 0);
    return { title: mk.title, eventSlug: mk.eventSlug, eventTitle: mk.eventTitle, outcome: mk.outcome, home: mk.home, away: mk.away, price: mk.price, kickoffMs: mk.kickoffMs, total, wallets: allWallets.size, breakdown, topWallets, yesUsd, yesByWallet };
  });

  // 给"前几大户"标注历史战绩(交叉 user-pnl, 缓存) → 选出 💎最赚大户 / 🐋最大注大户(两条路径共用)
  const scorePnL = (arr) =>
    mapLimit(arr, CONFIG.WALLET_CONCURRENCY, async (m) => {
      for (const tw of m.topWallets || []) {
        const sc = await getWalletScore(tw.wallet).catch(() => null);
        tw.allTimePnl = sc ? sc.allTimePnl : null;
      }
      // 只把"有方向观点"的钱包当聪明钱信号: 押注分散在多个互斥结果(对冲/套利/做市)的不算。
      // 加密路径 topWallets 无 directional 字段 → 全部保留, 不受影响。
      const dirOnly = (m.topWallets || []).filter((w) => w.directional !== false);
      m.topWhale = dirOnly[0] || null; // 最大注(方向性·按金额)
      const winners = dirOnly.filter((w) => w.allTimePnl != null && w.allTimePnl >= 50000);
      m.topWinner = winners.length ? winners.reduce((a, b) => (b.allTimePnl > a.allTimePnl ? b : a)) : null; // 最赚(proven winner)
    });

  if (!isSports) {
    // 加密: 逐个二元市场 Yes/No 视图; 跳过近乎确定的废盘(Yes价>0.88或<0.12), 只留有分歧的竞争盘 → 才有信号
    const markets = enriched
      .filter((m) => m.total > 0 && (m.price == null || (m.price >= 0.12 && m.price <= 0.88)))
      .sort((a, b) => b.total - a.total)
      .slice(0, topN);
    await scorePnL(markets);
    return { markets, threshold: minUsd };
  }

  // 体育: 把同一场(eventSlug)的 主胜/平/客胜 三个 Yes 盘合并成「整场三方分布」, 每场只出一条
  const byEvent = new Map();
  for (const m of enriched) {
    if (!m.outcome || m.yesUsd <= 0) continue;
    if (!byEvent.has(m.eventSlug))
      byEvent.set(m.eventSlug, { eventSlug: m.eventSlug, title: m.eventTitle, home: m.home, away: m.away, kickoffMs: m.kickoffMs, sides: { home: { usd: 0, wallets: 0, price: null }, draw: { usd: 0, wallets: 0, price: null }, away: { usd: 0, wallets: 0, price: null } }, walletAgg: new Map() });
    const ev = byEvent.get(m.eventSlug);
    ev.sides[m.outcome].usd += m.yesUsd;
    ev.sides[m.outcome].wallets += m.yesByWallet.size;
    if (m.price != null) ev.sides[m.outcome].price = m.price; // 盘口价(隐含概率)
    for (const [w, wr] of m.yesByWallet) {
      if (!ev.walletAgg.has(w)) ev.walletAgg.set(w, { usd: 0, name: wr.name, byOutcome: new Map() });
      const a = ev.walletAgg.get(w);
      a.usd += wr.usd;
      a.byOutcome.set(m.outcome, (a.byOutcome.get(m.outcome) || 0) + wr.usd);
    }
  }
  const matches = [...byEvent.values()]
    .map((ev) => {
      const total = ev.sides.home.usd + ev.sides.draw.usd + ev.sides.away.usd;
      const topWallets = [...ev.walletAgg.entries()]
        .map(([w, wr]) => {
          const ents = [...wr.byOutcome.entries()].sort((a, b) => b[1] - a[1]);
          const dir = wr.usd > 0 ? (ents[0]?.[1] || 0) / wr.usd : 0; // 押注集中度: 主押结果占其本场总额
          return { wallet: w, name: wr.name, usd: wr.usd, outcome: ents[0]?.[0], dir, directional: dir >= DIR_MIN };
        })
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 6);
      return { eventSlug: ev.eventSlug, title: ev.title, home: ev.home, away: ev.away, kickoffMs: ev.kickoffMs, total, wallets: ev.walletAgg.size, sides: ev.sides, topWallets };
    })
    .filter((m) => m.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);
  await scorePnL(matches);
  return { markets: matches, threshold: minUsd };
}

// ---- 顶级赢家风格画像 ----
const catOf = (title) => {
  const t = String(title || "").toLowerCase();
  if (/bitcoin|btc|ethereum|eth|crypto|solana|xrp|dogecoin/.test(t)) return "加密";
  if (/trump|election|president|senate|congress|\bvote|government|\bwar\b|israel|iran|ukraine|tariff|\bfed\b/.test(t)) return "政治/地緣";
  if (/ vs\.? |world cup|nba|nfl|premier|league|\bcup\b|golden boot|group \w winner|tennis|\bufc\b/.test(t)) return "體育";
  return "其他";
};

async function analyzeTopTraders(limit = 20) {
  const top = await getTopWallets(limit);
  const profiles = await mapLimit(top, CONFIG.WALLET_CONCURRENCY, async (w) => {
    let trades = [];
    try {
      trades = await getJSON(`${DATA}/trades?user=${w.wallet}&limit=100`);
    } catch {}
    trades = Array.isArray(trades) ? trades : [];
    const buys = trades.filter((t) => t.side === "BUY");
    const n = buys.length || 1;
    const avgPrice = buys.reduce((s, t) => s + (t.price || 0), 0) / n;
    const avgSize = buys.reduce((s, t) => s + (t.size || 0) * (t.price || 0), 0) / n;
    const dirPct = Math.round((buys.filter((t) => t.price > 0.15 && t.price < 0.85).length / n) * 100);
    const cat = {};
    for (const t of trades) cat[catOf(t.title)] = (cat[catOf(t.title)] || 0) + 1;
    const mainCat = Object.entries(cat).sort((a, b) => b[1] - a[1])[0]?.[0] || "?";
    const priceStyle = avgPrice > 0.72 ? "押熱門" : avgPrice < 0.45 ? "博冷門" : "均衡";
    return { ...w, avgPrice, avgSize, dirPct, mainCat, nTrades: trades.length, priceStyle };
  });
  return profiles;
}

// ---- 赛果追踪: 巨鲸方向 / 最大单大户 的命中率 ----
const ESPN_SB_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const teamToks = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && w !== "the");
// ESPN ↔ Polymarket 队名差异: 给某些 ESPN 名补"会出现在 Polymarket 标题里"的额外关键词。
// 只新增 token、从不删除, 故不破坏既有匹配。键 = ESPN 名归一化(小写、去非字母)。新增差异往这里加即可。
const TEAM_ALIAS_TOKENS = {
  "ivory coast": ["ivoire"], // Polymarket 用 Côte d'Ivoire → 含子串 "ivoire"
};
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const matchToks = (s) => [...teamToks(s), ...(TEAM_ALIAS_TOKENS[normName(s)] || [])];

// ESPN 世界杯赛果(含完赛结果 home/draw/away)
async function getWcResults() {
  const sb = await getJSON(ESPN_SB_URL).catch(() => null);
  if (!sb) return [];
  const out = [];
  for (const ev of sb.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    const completed = !!(comp.status?.type?.completed || ev.status?.type?.completed);
    const hs = Number(home.score), as = Number(away.score);
    out.push({
      id: ev.id, home: home.team.displayName, away: away.team.displayName,
      homeTokens: matchToks(home.team.displayName), awayTokens: matchToks(away.team.displayName),
      state: ev.status?.type?.state, completed, homeScore: hs, awayScore: as,
      kickoffMs: ev.date ? Date.parse(ev.date) : null, // 开赛时间, 算大户下注领先量
      actual: completed ? (hs > as ? "home" : hs < as ? "away" : "draw") : null,
    });
  }
  return out;
}

// 某场比赛当前的"巨鲸多数方"和"最大单大户"押注方向(用持仓低门槛统计买入)
async function matchPrediction(m, pmEvents) {
  const pmEvent = pmEvents.find((e) => {
    const t = e.title.toLowerCase();
    return m.homeTokens.some((x) => t.includes(x)) && m.awayTokens.some((x) => t.includes(x));
  });
  if (!pmEvent) return null;
  const markets = [];
  for (const mk of pmEvent.markets || []) {
    if (!mk.conditionId) continue;
    const q = mk.question.toLowerCase();
    let side = null;
    if (/draw/.test(q)) side = "draw";
    else if (m.homeTokens.some((t) => q.includes(t))) side = "home";
    else if (m.awayTokens.some((t) => q.includes(t))) side = "away";
    if (!side || markets.find((x) => x.side === side)) continue;
    // 该结果的 Polymarket 下注价(Yes 隐含概率), 算 ROI 必需
    let price = null;
    try {
      const outs = JSON.parse(mk.outcomes || "[]");
      const px = JSON.parse(mk.outcomePrices || "[]");
      const yi = outs.findIndex((o) => /yes/i.test(o));
      if (yi >= 0) price = Number(px[yi]);
    } catch {}
    markets.push({ side, cid: mk.conditionId, price });
  }
  const sides = { home: { usd: 0, price: null }, draw: { usd: 0, price: null }, away: { usd: 0, price: null } };
  for (const mm of markets) if (sides[mm.side]) sides[mm.side].price = Number.isFinite(mm.price) ? mm.price : null;
  const walletAgg = new Map();
  for (const mm of markets) {
    const tr = await getJSON(`${DATA}/trades?market=${mm.cid}&filterType=CASH&filterAmount=${CONFIG.POSITIONING_MIN_NOTIONAL}&limit=500`).catch(() => null);
    const buys = Array.isArray(tr) ? tr.filter((t) => t.side === "BUY" && /yes/i.test(t.outcome || "")) : [];
    for (const t of buys) {
      const u = (t.size || 0) * (t.price || 0);
      sides[mm.side].usd += u;
      if (!walletAgg.has(t.proxyWallet)) walletAgg.set(t.proxyWallet, { usd: 0, bySide: new Map() });
      const w = walletAgg.get(t.proxyWallet);
      w.usd += u;
      let bs = w.bySide.get(mm.side);
      if (!bs) { bs = { usd: 0, shares: 0, minTs: Infinity }; w.bySide.set(mm.side, bs); }
      bs.usd += u;
      bs.shares += t.size || 0;
      if (t.timestamp && t.timestamp < bs.minTs) bs.minTs = t.timestamp;
    }
  }
  const totalUsd = sides.home.usd + sides.draw.usd + sides.away.usd;
  if (totalUsd <= 0) return null;
  const whaleSide = ["home", "draw", "away"].reduce((a, b) => (sides[b].usd > sides[a].usd ? b : a));
  const consensusPct = sides[whaleSide].usd / totalUsd;
  let bigBettor = null;
  for (const [w, wr] of walletAgg) {
    if (!bigBettor || wr.usd > bigBettor.usd) {
      const side = [...wr.bySide.entries()].sort((a, b) => b[1].usd - a[1].usd)[0]?.[0];
      const bs = wr.bySide.get(side);
      const entryPrice = bs && bs.shares > 0 ? bs.usd / bs.shares : null;
      const betTs = bs && Number.isFinite(bs.minTs) ? bs.minTs : null;
      const leadMin = betTs && m.kickoffMs ? Math.round((m.kickoffMs - betTs * 1000) / 60000) : null;
      bigBettor = { wallet: w, side, usd: wr.usd, entryPrice, betTs, leadMin };
    }
  }
  // 历史盈利最大的赢家(PnL≥$50k)押哪边 —— 用来和"最大注(by size)"对比是否分歧。只评前6大钱包省 API
  let proWinner = null, bestPnl = null;
  const ranked = [...walletAgg.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 6);
  for (const [w, wr] of ranked) {
    const sc = await getWalletScore(w).catch(() => null);
    if (sc && sc.allTimePnl >= 50000 && (bestPnl == null || sc.allTimePnl > bestPnl)) {
      const side = [...wr.bySide.entries()].sort((a, b) => b[1].usd - a[1].usd)[0]?.[0];
      bestPnl = sc.allTimePnl;
      proWinner = { wallet: w, side, pnl: Math.round(sc.allTimePnl) };
    }
  }
  return { whaleSide, consensusPct, bigBettor, proWinner, sides, eventSlug: pmEvent.slug };
}

// ---- 准确比分市场: 返回市场概率榜(按隐含概率排序的具体比分 + "其他比分"桶) ----
// 注意: 准确比分盘成交极小(单笔多为几百刀散户, 无巨鲸), 故只用"价格=市场共识概率", 不追大户.
// ---- 大小球(O/U 2.5)聪明钱信号: 大户在「整场总进球 大/小」上偏哪边 ----
// (数据证明: 盈利大户第二大类就押大小球; 准确比分则全是散户, 故弃用)
async function getTotalsSignal(eventSlug) {
  if (!eventSlug) return null;
  const arr = await getJSON(`${GAMMA}/events?slug=${eventSlug}-more-markets`).catch(() => null);
  const e = Array.isArray(arr) ? arr[0] : null;
  if (!e || !Array.isArray(e.markets)) return null;
  // 整场总进球标准盘: "{Home} vs. {Away}: O/U 2.5"(排除半场/单队/其它线)
  const mk = e.markets.find((m) => /:\s*o\/u\s*2\.5\b/i.test(m.question || "") && !/half|1st|2nd/i.test(m.question || ""));
  if (!mk || !mk.conditionId) return null;
  // 盘口当前价(算 ROI 用): Over/Under 各自概率价
  let overPrice = null, underPrice = null;
  try {
    const outs = JSON.parse(mk.outcomes || "[]");
    const px = JSON.parse(mk.outcomePrices || "[]");
    const oi = outs.findIndex((o) => /over|yes/i.test(o));
    const ui = outs.findIndex((o) => /under|no/i.test(o));
    if (oi >= 0) overPrice = Number(px[oi]);
    if (ui >= 0) underPrice = Number(px[ui]);
  } catch {}
  const tr = await getJSON(`${DATA}/trades?market=${mk.conditionId}&filterType=CASH&filterAmount=${CONFIG.POSITIONING_MIN_NOTIONAL}&limit=500`).catch(() => null);
  const buys = Array.isArray(tr) ? tr.filter((t) => t.side === "BUY") : [];
  let overUsd = 0, underUsd = 0;
  const byWallet = new Map(); // 每钱包押大/小各多少, 用来找"盈利大户在押哪边"
  for (const t of buys) {
    const u = (t.size || 0) * (t.price || 0);
    const isOver = /over|yes/i.test(t.outcome || "");
    if (isOver) overUsd += u; else underUsd += u;
    if (!byWallet.has(t.proxyWallet)) byWallet.set(t.proxyWallet, { over: 0, under: 0 });
    const w = byWallet.get(t.proxyWallet);
    if (isOver) w.over += u; else w.under += u;
  }
  const total = overUsd + underUsd;
  if (total <= 0) return null;
  const side = overUsd >= underUsd ? "Over" : "Under"; // 大户(资金多数方)偏哪边
  const pct = Math.round((Math.max(overUsd, underUsd) / total) * 100);
  // 找历史盈利 ≥$5万的最大赢家押哪边(测"跟💎盈利大户大小球"假设); 只评前6大钱包省 API
  const tops = [...byWallet.entries()]
    .map(([w, v]) => ({ w, usd: v.over + v.under, side: v.over >= v.under ? "Over" : "Under" }))
    .sort((a, b) => b.usd - a.usd).slice(0, 6);
  let winnerSide = null, winnerPnl = null;
  for (const tw of tops) {
    const sc = await getWalletScore(tw.w).catch(() => null);
    if (sc && sc.allTimePnl >= 50000 && (winnerPnl == null || sc.allTimePnl > winnerPnl)) {
      winnerPnl = sc.allTimePnl; winnerSide = tw.side;
    }
  }
  return { line: 2.5, side, pct, overUsd: Math.round(overUsd), underUsd: Math.round(underUsd), overPrice, underPrice, winnerSide, winnerPnl: winnerPnl ? Math.round(winnerPnl) : null };
}

// ---- 收盘线价值(CLV)用: 仅抓"临近开赛"的当前盘口价(零钱包分析), 胜负盘 + O/U 2.5 ----
// 用于对比"入场价 vs 近开赛价": 价格朝你那一侧移动(close>entry)=你买在了好价位=正 CLV(有 edge 的领先指标)
async function getClosingPrices(eventSlug, homeTokens, awayTokens) {
  if (!eventSlug) return null;
  const out = { moneyline: {}, ou: {} };
  const yesPrice = (mk) => {
    try {
      const outs = JSON.parse(mk.outcomes || "[]"), px = JSON.parse(mk.outcomePrices || "[]");
      const yi = outs.findIndex((o) => /yes/i.test(o));
      return yi >= 0 ? Number(px[yi]) : null;
    } catch { return null; }
  };
  // 胜负盘(主事件): 每个结果是独立 Yes/No 盘, 按问题里的队名/draw 映射 side
  const ev = await getJSON(`${GAMMA}/events?slug=${eventSlug}`).catch(() => null);
  const e = Array.isArray(ev) ? ev[0] : null;
  for (const mk of (e && e.markets) || []) {
    const q = (mk.question || "").toLowerCase();
    let side = null;
    if (/draw/.test(q)) side = "draw";
    else if ((homeTokens || []).some((t) => q.includes(t))) side = "home";
    else if ((awayTokens || []).some((t) => q.includes(t))) side = "away";
    if (side && out.moneyline[side] == null) out.moneyline[side] = yesPrice(mk);
  }
  // O/U 2.5(more-markets)
  const arr = await getJSON(`${GAMMA}/events?slug=${eventSlug}-more-markets`).catch(() => null);
  const e2 = Array.isArray(arr) ? arr[0] : null;
  const mk2 = ((e2 && e2.markets) || []).find((m) => /:\s*o\/u\s*2\.5\b/i.test(m.question || "") && !/half|1st|2nd/i.test(m.question || ""));
  if (mk2) {
    try {
      const outs = JSON.parse(mk2.outcomes || "[]"), px = JSON.parse(mk2.outcomePrices || "[]");
      const oi = outs.findIndex((o) => /over|yes/i.test(o)), ui = outs.findIndex((o) => /under|no/i.test(o));
      if (oi >= 0) out.ou.overPrice = Number(px[oi]);
      if (ui >= 0) out.ou.underPrice = Number(px[ui]);
    } catch {}
  }
  return out;
}

// ---- 加密版预判: 单个二元市场(Yes/No)的巨鲸方向 ----
async function cryptoPrediction(mk) {
  if (!mk.conditionId) return null;
  let outs;
  try {
    outs = JSON.parse(mk.outcomes || "[]");
  } catch {
    return null;
  }
  let px = [];
  try {
    px = JSON.parse(mk.outcomePrices || "[]");
  } catch {}
  const sides = {};
  outs.forEach((o, i) => (sides[o] = { usd: 0, price: Number(px[i]) }));
  const tr = await getJSON(`${DATA}/trades?market=${mk.conditionId}&filterType=CASH&filterAmount=${CONFIG.POSITIONING_MIN_NOTIONAL}&limit=500`).catch(() => null);
  const buys = Array.isArray(tr) ? tr.filter((t) => t.side === "BUY") : [];
  const walletAgg = new Map();
  for (const t of buys) {
    const o = t.outcome;
    if (!sides[o]) continue;
    const u = (t.size || 0) * (t.price || 0);
    sides[o].usd += u;
    if (!walletAgg.has(t.proxyWallet)) walletAgg.set(t.proxyWallet, { usd: 0, bySide: new Map() });
    const w = walletAgg.get(t.proxyWallet);
    w.usd += u;
    let bs = w.bySide.get(o);
    if (!bs) { bs = { usd: 0, shares: 0, minTs: Infinity }; w.bySide.set(o, bs); }
    bs.usd += u;
    bs.shares += t.size || 0;
    if (t.timestamp && t.timestamp < bs.minTs) bs.minTs = t.timestamp;
  }
  const total = Object.values(sides).reduce((s, v) => s + v.usd, 0);
  if (total <= 0) return null;
  const whaleSide = Object.keys(sides).reduce((a, b) => (sides[b].usd > sides[a].usd ? b : a));
  const consensusPct = sides[whaleSide].usd / total;
  let bigBettor = null;
  for (const [w, wr] of walletAgg) {
    if (!bigBettor || wr.usd > bigBettor.usd) {
      const side = [...wr.bySide.entries()].sort((a, b) => b[1].usd - a[1].usd)[0]?.[0];
      const bs = wr.bySide.get(side);
      const entryPrice = bs && bs.shares > 0 ? bs.usd / bs.shares : null;
      const betTs = bs && Number.isFinite(bs.minTs) ? bs.minTs : null;
      bigBettor = { wallet: w, side, usd: wr.usd, entryPrice, betTs, leadMin: null };
    }
  }
  return { whaleSide, consensusPct, bigBettor, sides };
}

// 按 gamma 数字 id 读市场结算结果, 返回获胜的 outcome 字符串(未结算返回 null)
async function getMarketResolution(gammaId) {
  const m = await getJSON(`${GAMMA}/markets/${gammaId}`).catch(() => null);
  if (!m || !m.closed) return null;
  let outs, px;
  try {
    outs = JSON.parse(m.outcomes || "[]");
    px = JSON.parse(m.outcomePrices || "[]");
  } catch {
    return null;
  }
  const wi = px.findIndex((p) => Number(p) >= 0.99);
  return wi >= 0 ? outs[wi] : null;
}

module.exports = {
  scan, scanWatchlist, buildCryptoWatchlist, getTopWallets,
  marketSentiment, analyzeTopTraders, getMatchEvents,
  getWcResults, matchPrediction, getTotalsSignal, getClosingPrices, cryptoPrediction, getMarketResolution,
  fmtUSD, CONFIG, isDirectional,
};
