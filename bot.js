// Telegram 推送机器人：定时扫描 → 去重 → 把 ⭐聪明钱信号 推到频道。
//
// 运行方式：
//   node bot.js --test   只发一条连通性测试消息
//   node bot.js --once    扫描一次并推送(不循环)，适合测试
//   node bot.js --preview-now  手动推一次「持仓分析 + 今日预判」(改版后看效果)
//   node bot.js --refresh-pin  只就地刷新置顶战绩(不跑完整轮询)
//   node bot.js           持续运行，每 POLL_MINUTES 分钟扫描一次

const fs = require("fs");
const path = require("path");
const { scan, scanWatchlist, marketSentiment, analyzeTopTraders, getMatchEvents, getWcResults, matchPrediction, getExactScoreBoard, cryptoPrediction, getMarketResolution, fmtUSD } = require("./radar");

// ---------- 读取 .env（自己解析，跨 Node 版本稳定）----------
function loadEnv(p) {
  try {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}
loadEnv(path.join(__dirname, ".env"));

// 多赛道支持：PROFILE 选用哪套 token/频道(如 SPORTS)，空=默认(加密)。
const PROFILE = (process.env.PROFILE || "").toUpperCase();
const TAG = (process.env.POLY_TAG || "crypto").toLowerCase();
const LABEL = process.env.VERTICAL_LABEL || "Crypto"; // 消息中显示的赛道名
const VERSION = "V4.8"; // 版本号(每次迭代升级时更新; 同步 CHANGELOG.md 与启动脚本横幅)
const TOKEN = process.env[`${PROFILE}_BOT_TOKEN`] || process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL =
  process.env[`${PROFILE}_CHANNEL`] || process.env.TELEGRAM_CHANNEL || "@polarisresearch2000";
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 3);
// 本地想要"秒级近实时"就设 POLL_SECONDS（如 20），优先级高于 POLL_MINUTES
const POLL_MS = process.env.POLL_SECONDS
  ? Number(process.env.POLL_SECONDS) * 1000
  : POLL_MINUTES * 60 * 1000;
const MAX_AGE_MIN = Number(process.env.MAX_SIGNAL_AGE_MIN || 180); // 大单信号只推这么多分钟内的
const WATCH_MAX_AGE_MIN = Number(process.env.WATCHLIST_MAX_AGE_MIN || 90); // 观察名单只推这么多分钟内的
const WATCH_MAX_PER_RUN = Number(process.env.WATCHLIST_MAX_PER_RUN || 5); // 单轮最多推几条观察名单信号(防刷屏)
const SIGNAL_MAX_PER_RUN = Number(process.env.SIGNAL_MAX_PER_RUN || 5); // 单轮最多推几条大额信号(防刷屏)
const WHALE_PULL = process.env.POLL_SECONDS ? 500 : 2000; // 快速轮询模式拉少一点成交，省流量
const SEEN_FILE = path.join(__dirname, "data", `seen_${TAG}.json`); // 每个赛道独立去重
// 定时摘要：持仓快照 + 赢家风格
const DIGESTS = (process.env.DIGESTS || "on") !== "off";
const PROFILES_ENABLED = (process.env.PROFILES_ENABLED || "on") !== "off"; // 顶级赢家风格榜(全站; 体育频道可关)
const SIGNALS_ENABLED = (process.env.SIGNALS_ENABLED || "on") !== "off"; // 逐条实时信号; off=整合进精华版, 不再逐条刷屏
const POSITIONING_MIN = Number(process.env.POSITIONING_MIN || 120); // 持仓快照间隔(分钟)
const PROFILES_MIN = Number(process.env.PROFILES_MIN || 1440); // 赢家风格榜间隔(分钟)
const DIGEST_FILE = path.join(__dirname, "data", `digest_${TAG}.json`);
// 赛果追踪(仅体育赛道自动开启)
const RESULTS_ON = /world-cup|soccer|sports/.test(TAG);
const RESULTS_FILE = path.join(__dirname, "data", `results_${TAG}.json`);
const PREVIEW_HOUR = Number(process.env.PREVIEW_HOUR || 9); // 每天几点(HKT)推「今日巨鲸预判」

if (!TOKEN) {
  console.error("❌ 缺少 TELEGRAM_BOT_TOKEN（请检查 .env）");
  process.exit(1);
}

// ---------- 去重存储 ----------
function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
  } catch {
    return new Set();
  }
}
function saveSeen(set) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-5000)));
}
function loadDigest() {
  try {
    return JSON.parse(fs.readFileSync(DIGEST_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveDigest(s) {
  try {
    fs.mkdirSync(path.dirname(DIGEST_FILE), { recursive: true });
    fs.writeFileSync(DIGEST_FILE, JSON.stringify(s));
  } catch {}
}
function loadResults() {
  let r;
  try {
    r = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  } catch {
    r = {};
  }
  r.predictions = r.predictions || {};
  r.settled = Array.isArray(r.settled) ? r.settled : [];
  r.strategies = r.strategies || {}; // key -> { bets, wins, profit }
  delete r.stats; // 旧字段(单一命中率)弃用
  return r;
}
function saveResults(r) {
  try {
    fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(r, null, 2));
  } catch {}
}
const sideLabel = (side, home, away) =>
  side === "home" ? home : side === "away" ? away : side === "draw" ? "平局" : /yes/i.test(side || "") ? "是" : /no/i.test(side || "") ? "否" : side || "?";
// 赛果/结算结果的展示文字(体育: X勝/平局; 加密: 是✓/否✗)
const resultLabel = (s) => {
  if (s.actual === "draw") return "平局";
  if (/^yes$/i.test(s.actual)) return "是 ✓";
  if (/^no$/i.test(s.actual)) return "否 ✗";
  return sideLabel(s.actual, s.home, s.away) + "勝";
};
const leadStr = (min) => (min == null ? "" : min < 0 ? "賽後" : min < 60 ? `賽前${min}分鐘` : `賽前${(min / 60).toFixed(1)}小時`);
// 最大单大户一行: 押哪边 + 入场价 + 距开赛多久下注 (+可选输赢)
const bigLine = (bb, home, away, win) => {
  if (!bb) return "最大戶 —";
  const p = bb.entryPrice != null ? ` @${bb.entryPrice.toFixed(2)}` : "";
  const lead = bb.leadMin != null ? ` · ${leadStr(bb.leadMin)}下注` : "";
  const mark = win === true ? " ✅" : win === false ? " ❌" : "";
  return `最大戶押 ${sideLabel(bb.side, home, away)}${p}${lead}${mark}`;
};

// 并行前向测试的 4 条策略
const STRATS = [
  { key: "followWhale", label: "🐋 跟巨鯨多數方" },
  { key: "followBig", label: "👑 跟最大單大戶" },
  { key: "highConsensus", label: "🔒 高共識(>85%)才跟" },
  { key: "fadeFav", label: "🔄 反向 fade 大眾" },
];

// 给定预测 p 与实际结果, 算每条策略这场的下注(方向/下注价/输赢/单位ROI)
function evalStrategies(p, actual) {
  const priceOf = (side) => {
    const x = p.sides?.[side]?.price;
    return Number.isFinite(x) && x > 0 && x < 1 ? x : null;
  };
  const back = (side) => {
    const price = priceOf(side);
    if (!side || price == null) return null;
    const win = actual === side;
    return { side, price, win, profit: win ? (1 - price) / price : -1 }; // 每 $1 成本的盈亏
  };
  const out = {
    followWhale: back(p.whaleSide),
    followBig: back(p.bigBettor?.side),
    highConsensus: p.consensusPct >= 0.85 ? back(p.whaleSide) : null,
    fadeFav: null,
  };
  // 反向: 在巨鲸热门结果上买 No
  const yes = priceOf(p.whaleSide);
  if (yes != null) {
    const noPrice = 1 - yes;
    if (noPrice > 0 && noPrice < 1) {
      const win = actual !== p.whaleSide;
      out.fadeFav = { side: `No(${p.whaleSide})`, price: noPrice, win, profit: win ? (1 - noPrice) / noPrice : -1 };
    }
  }
  return out;
}

// 捕捉(赛前/早段)预测 + 结算完赛 + 累计各策略 ROI + 推送
// 捕捉赛前预判: 只在【赛前 state=pre】捕捉(杜绝赛中追涨的前视偏差), 含准确比分概率榜。被 trackResults 与 --preview-now 复用。
async function capturePredictions(res, wc, pmEvents) {
  for (const m of wc) {
    if (m.completed || m.state !== "pre") continue;
    const ex = res.predictions[m.id];
    if (ex && ex.sides) {
      // 回填准确比分榜: 仅在"从未尝试过"(undefined)时补一次, 失败置 null 不再每轮重试
      if (ex.scoreBoard === undefined && ex.eventSlug) ex.scoreBoard = (await getExactScoreBoard(ex.eventSlug, 5).catch(() => null)) || null;
      continue;
    }
    const pred = await matchPrediction(m, pmEvents).catch(() => null);
    if (pred && pred.sides) {
      const scoreBoard = await getExactScoreBoard(pred.eventSlug, 5).catch(() => null); // 准确比分市场概率榜
      res.predictions[m.id] = {
        match: `${m.home} vs ${m.away}`, home: m.home, away: m.away,
        whaleSide: pred.whaleSide, consensusPct: pred.consensusPct, bigBettor: pred.bigBettor,
        sides: pred.sides, eventSlug: pred.eventSlug, scoreBoard, state: m.state, capturedAt: new Date().toISOString(),
      };
    }
  }
}

async function trackResults() {
  const res = loadResults();
  let wc, pmEvents;
  try {
    [wc, pmEvents] = await Promise.all([getWcResults(), getMatchEvents(20)]);
  } catch (e) {
    console.error("赛果追踪取数出错:", e.message);
    return;
  }
  // 1) 捕捉赛前预判
  await capturePredictions(res, wc, pmEvents);
  // 2) 结算完赛、有(带价)预测、未结算的
  let newSettle = 0;
  for (const m of wc) {
    if (!m.completed || !m.actual) continue;
    const p = res.predictions[m.id];
    if (!p || !p.sides || res.settled.find((s) => s.espnId === m.id)) continue;
    const strat = evalStrategies(p, m.actual);
    for (const { key } of STRATS) {
      const r = strat[key];
      if (!r) continue;
      const s = (res.strategies[key] = res.strategies[key] || { bets: 0, wins: 0, profit: 0 });
      s.bets++;
      if (r.win) s.wins++;
      s.profit += r.profit;
    }
    const rec = {
      espnId: m.id, match: p.match, home: p.home, away: p.away, actual: m.actual,
      score: `${m.homeScore}-${m.awayScore}`, whaleSide: p.whaleSide, bigBettor: p.bigBettor,
      strat, settledAt: new Date().toISOString(),
    };
    // 准确比分: 实际比分在赛前概率榜的名次 → 累计 Top3/榜首命中率
    if (p.scoreBoard?.top?.length) {
      const idx = p.scoreBoard.top.findIndex((e) => e.home === m.homeScore && e.away === m.awayScore);
      const ss = (res.scoreStats = res.scoreStats || { n: 0, hit1: 0, hit3: 0 });
      ss.n++;
      if (idx === 0) ss.hit1++;
      if (idx >= 0 && idx < 3) ss.hit3++;
      rec.scoreBoard = p.scoreBoard.top.slice(0, 3);
      rec.scoreRank = idx;
    }
    res.settled.push(rec);
    newSettle++;
  }
  // 有新结算: 推赛果总结 + 更新置顶战绩
  if (newSettle > 0) {
    await send(fmtResultSummary(res));
    await postOrUpdateTrackRecord(res);
    console.log(`  → 已推赛果总结+更新置顶(新结算 ${newSettle})`);
  }

  // 每日固定节奏: 香港时间 PREVIEW_HOUR 点后首次, 推「今日巨鲸预判」(每天一次)
  const hk = hkNow();
  const hkDay = hk.toISOString().slice(0, 10);
  if (hk.getUTCHours() >= PREVIEW_HOUR && res.previewDay !== hkDay) {
    const upcoming = wc.filter((m) => !m.completed && res.predictions[m.id]);
    if (upcoming.length) {
      await send(fmtDailyPreview(upcoming, res));
      res.previewDay = hkDay;
      await postOrUpdateTrackRecord(res); // 顺手刷新置顶
      console.log(`  → 已推今日巨鲸预判(${upcoming.length}场)`);
    }
  }

  // 置顶①战绩定期刷新(即使无新结算也保持新鲜; 时间戳变化故 edit 不会"未修改")
  if (Date.now() - (res.trackUpdatedAt || 0) >= 30 * 60000) await postOrUpdateTrackRecord(res);
  // 置顶②即将开赛预判: 只显示未开赛(state=pre)且有预判的场, 每≥30分钟刷新(开赛的自动掉出、新场补进)
  if (Date.now() - (res.previewUpdatedAt || 0) >= 30 * 60000) {
    const upcomingPre = wc.filter((m) => m.state === "pre" && res.predictions[m.id]);
    await postOrUpdatePreviewPin(res, upcomingPre);
  }
  saveResults(res);
}

// 加密版赛果追踪: 二元市场(Yes/No)预判 + 按市场解析结算 + 同样的多策略 ROI/置顶
async function trackResultsCrypto() {
  const res = loadResults();
  let events;
  try {
    events = await getMatchEvents(15);
  } catch (e) {
    console.error("加密赛果取数出错:", e.message);
    return;
  }
  // 1) 捕捉: 活跃加密市场(排除 up/down 高频), 每个市场捕捉一次; 每轮限量控制请求
  const candidates = [];
  for (const ev of events)
    for (const mk of ev.markets || []) {
      const id = mk.conditionId;
      if (!id || !mk.id || mk.closed) continue;
      if (/up or down/i.test(mk.question || "")) continue;
      if ((res.predictions[id] && res.predictions[id].sides) || res.settled.find((s) => s.espnId === id)) continue;
      candidates.push({ ev, mk });
    }
  for (const { ev, mk } of candidates.slice(0, 25)) {
    const pred = await cryptoPrediction(mk).catch(() => null);
    if (pred && pred.sides) {
      res.predictions[mk.conditionId] = {
        match: mk.question, slug: ev.slug, gammaId: mk.id,
        whaleSide: pred.whaleSide, consensusPct: pred.consensusPct, bigBettor: pred.bigBettor,
        sides: pred.sides, capturedAt: new Date().toISOString(),
      };
    }
  }
  // 2) 结算: 检查已捕捉但未结算市场的解析结果(每轮限量查, 控制请求)
  const pending = Object.entries(res.predictions).filter(([id, p]) => p.gammaId && p.sides && !res.settled.find((s) => s.espnId === id));
  let newSettle = 0;
  for (const [id, p] of pending.slice(0, 30)) {
    const actual = await getMarketResolution(p.gammaId).catch(() => null);
    if (!actual) continue;
    const strat = evalStrategies(p, actual);
    for (const { key } of STRATS) {
      const r = strat[key];
      if (!r) continue;
      const s = (res.strategies[key] = res.strategies[key] || { bets: 0, wins: 0, profit: 0 });
      s.bets++;
      if (r.win) s.wins++;
      s.profit += r.profit;
    }
    res.settled.push({ espnId: id, match: p.match, slug: p.slug, actual, whaleSide: p.whaleSide, bigBettor: p.bigBettor, strat, settledAt: new Date().toISOString() });
    newSettle++;
  }
  if (newSettle > 0) {
    await send(fmtResultSummary(res));
    await postOrUpdateTrackRecord(res);
    console.log(`  → 加密赛果结算 ${newSettle} + 更新置顶`);
  }
  // 3) 每日预判
  const hk = hkNow();
  const hkDay = hk.toISOString().slice(0, 10);
  if (hk.getUTCHours() >= PREVIEW_HOUR && res.previewDay !== hkDay) {
    const upcoming = Object.entries(res.predictions)
      .filter(([id]) => !res.settled.find((s) => s.espnId === id))
      .slice(0, 5)
      .map(([id, p]) => ({ id, ...p }));
    if (upcoming.length) {
      await send(fmtDailyPreview(upcoming, res));
      res.previewDay = hkDay;
      await postOrUpdateTrackRecord(res);
      console.log(`  → 加密今日预判(${upcoming.length})`);
    }
  }
  if (Date.now() - (res.trackUpdatedAt || 0) >= 30 * 60000) await postOrUpdateTrackRecord(res);
  saveResults(res);
}

const roiPct = (s) => (s.bets ? Math.round((s.profit / s.bets) * 100) : 0);
const hkNow = () => new Date(Date.now() + 8 * 3600 * 1000); // 香港时间

// 目前 ROI 最高的策略(至少 1 场)
function bestStrategy(res) {
  let best = null;
  for (const { key, label } of STRATS) {
    const s = res.strategies[key];
    if (!s || !s.bets) continue;
    const roi = roiPct(s);
    if (!best || roi > best.roi) best = { label, bets: s.bets, roi };
  }
  return best;
}

// 置顶用: 策略战绩(简洁, 持续更新)
function fmtTrackRecord(res) {
  const settled = res.settled || [];
  const lines = [
    "📌 <b>策略戰績 Track Record</b>",
    `（賽前預判 vs 賽果 · 按下注價算 · 共 <b>${settled.length}</b> 場已結算）`,
    "",
  ];
  // 置顶只展示正向策略; fade 持续垫底、对频道形象无益, 但底层仍照常追踪做诚实对照
  let rows = STRATS.filter((s) => s.key !== "fadeFav");
  // 「跟巨鲸多数方」与「跟最大单大户」若每场都同侧 → 数据雷同, 合并成一行(免得被当凑数); 一旦分歧自动拆回两行
  const wbDiverged = settled.some((x) => {
    const a = x.strat?.followWhale, b = x.strat?.followBig;
    if (!a && !b) return false;
    if (!a || !b) return true;
    return a.side !== b.side;
  });
  if (!wbDiverged && res.strategies.followWhale?.bets && res.strategies.followBig?.bets) {
    rows = rows.flatMap((s) =>
      s.key === "followBig" ? [] : s.key === "followWhale" ? [{ key: "followWhale", label: "🐋👑 跟巨鯨多數方／最大單大戶（同側 · 全部出手）" }] : [s]
    );
  }
  let any = false, best = null;
  for (const { key, label } of rows) {
    const s = res.strategies[key];
    if (!s || !s.bets) {
      lines.push(`${label}: 暫無`);
      continue;
    }
    any = true;
    const losses = s.bets - s.wins;
    const wr = Math.round((s.wins / s.bets) * 100);
    const roi = roiPct(s);
    const mine = settled.filter((x) => x.strat?.[key]);
    const prices = mine.map((x) => x.strat[key].price).filter((p) => p > 0);
    const avgOdds = prices.length ? 1 / (prices.reduce((a, b) => a + b, 0) / prices.length) : null; // 入场价隐含赔率(押中赔几倍)
    const form = mine.slice(-6).map((x) => (x.strat[key].win ? "✅" : "❌")).join("");
    // 把"高共识子集"明确标成"你真会下单的子集"(= paper/live 里的 live)
    const lbl = key === "highConsensus" ? "🔒 只在高共識≥85%才跟（= 你真會下單的子集）" : label;
    const units = `${s.profit >= 0 ? "+" : ""}${s.profit.toFixed(1)}u`; // 累计盈亏(单位: 注; 1u=一注固定本金)
    lines.push(`<b>${lbl}</b>`);
    lines.push(`   ${s.wins}勝${losses}負 · 命中 ${wr}% · ROI <b>${roi >= 0 ? "+" : ""}${roi}%</b> · 累計 <b>${units}</b>`);
    const sub = [avgOdds ? `均入場賠率 ${avgOdds.toFixed(2)}x` : "", form ? `近期 ${form}` : ""].filter(Boolean).join(" · ");
    if (sub) lines.push(`   ${sub}`);
    if (!best || roi > best.roi) best = { label: lbl, roi };
  }
  lines.push("");
  // 逐场赛果明细(跟巨鲸方向, 最近6场, 新到旧): 押了谁/几比几/入场价/单注盈亏 —— 透明度
  const recent = settled.filter((x) => x.strat?.followWhale).slice(-6).reverse();
  if (recent.length) {
    lines.push("📋 <b>近期逐場賽果</b>（跟巨鯨方向）");
    for (const x of recent) {
      const fw = x.strat.followWhale;
      const backed = fw.side === "home" ? tTeam(x.home) : fw.side === "away" ? tTeam(x.away) : "平局";
      lines.push(`${fw.win ? "✅" : "❌"} ${esc(tTeam(x.home))} ${esc(x.score)} ${esc(tTeam(x.away))} · 押${esc(backed)} @${fw.price != null ? fw.price.toFixed(2).slice(1) : "?"} · ${fw.profit >= 0 ? "+" : ""}${fw.profit.toFixed(2)}u`);
    }
    lines.push("");
  }
  if (best && any) lines.push(`🏆 目前最佳: ${best.label} (ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%)`);
  const shr = scoreHitRateLine(res);
  if (shr) lines.push(shr);
  lines.push(any ? `⚠️ 樣本仍小(${settled.length}場)、噪聲大; 跑滿幾十場才有統計意義` : "⏳ 等待首批賽果結算中…");
  lines.push(`🔭 ROI=每$1淨回報 · 賠率=入場價隱含倍數 · 更新 ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT · ${VERSION}`);
  return lines.join("\n");
}

// 准确比分概率榜(一行, 主-客视角): "2-1 12% · 1-1 12% · 1-0 11%"
const scoreBoardInline = (board, topN = 3) =>
  board && board.top && board.top.length
    ? board.top.slice(0, topN).map((e) => `${e.home}-${e.away} ${Math.round(e.prob * 100)}%`).join(" · ")
    : null;

// 赛后: 赛前比分榜 → 实际比分 + 命中标签(榜首/Top3/未中)
function scoreResultLine(s) {
  if (!s.scoreBoard || !s.scoreBoard.length) return null;
  const board = s.scoreBoard.map((e) => `${e.home}-${e.away} ${Math.round(e.prob * 100)}%`).join(" · ");
  const r = s.scoreRank;
  const tag = r === 0 ? "✅ 命中榜首" : r >= 1 && r <= 2 ? "✅ 命中Top3" : "❌ 未中Top3";
  return `   🎯 賽前比分榜 ${board} → 實際 ${esc(s.score)} ${tag}`;
}

// 准确比分 Top3 累计命中率(一行, 用于赛果总结/置顶)
function scoreHitRateLine(res) {
  const ss = res.scoreStats;
  if (!ss || !ss.n) return null;
  return `🎯 準確比分 Top3 命中率: <b>${ss.hit3}/${ss.n}</b> (${Math.round((ss.hit3 / ss.n) * 100)}%) · 榜首 ${ss.hit1}/${ss.n}`;
}

// 每日固定: 今日巨鲸预判
function fmtDailyPreview(matches, res) {
  const sub = LABEL === "World Cup" ? "今日世界盃 · 大戶押哪邊" : "當前熱門 · 大戶押哪邊";
  const lines = ["☀️ <b>今日巨鯨預判 Daily Preview</b>", `（${sub}）`, ""];
  for (const m of matches) {
    const p = res.predictions[m.id];
    if (!p) continue;
    const cons = Math.round((p.consensusPct || 0) * 100);
    lines.push(`${p.home ? "🆚" : "🔥"} ${esc(p.match)}`);
    lines.push(`   巨鯨預判: <b>${esc(sideLabel(p.whaleSide, p.home, p.away))}</b> (共識 ${cons}%)`);
    lines.push(`   🐋 ${esc(bigLine(p.bigBettor, p.home, p.away))}`);
    const sb = scoreBoardInline(p.scoreBoard);
    if (sb) lines.push(`   🎯 市場比分榜(主-客): ${sb}`);
  }
  if (matches.some((m) => res.predictions[m.id]?.scoreBoard)) lines.push("", "💡 比分榜=市場共識熱度(非穩贏)，準確比分本就難中");
  const best = bestStrategy(res);
  if (best) lines.push("", `📊 目前最佳策略: ${best.label} ${best.bets}場 ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%`);
  lines.push("", `🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`);
  return lines.join("\n");
}

// 置顶用: 即将开赛预判(只列未开赛场次, 就地编辑、持续刷新; 复用每日预判的逐场渲染)
function fmtUpcomingPin(matches, res) {
  const show = (matches || []).slice(0, 6); // 最多6场, 保持可扫读
  const lines = ["📅 <b>即將開賽 · 巨鯨預判</b>（持續更新）", "（未開賽場次 · 大戶押哪邊 + 市場比分榜）", ""];
  if (!show.length) {
    lines.push("⏳ 暫無即將開賽的場次,稍後自動更新");
  } else {
    for (const m of show) {
      const p = res.predictions[m.id];
      if (!p) continue;
      const cons = Math.round((p.consensusPct || 0) * 100);
      lines.push(`${p.home ? "🆚" : "🔥"} ${esc(p.match)}`);
      lines.push(`   巨鯨預判: <b>${esc(sideLabel(p.whaleSide, p.home, p.away))}</b> (共識 ${cons}%)`);
      lines.push(`   🐋 ${esc(bigLine(p.bigBettor, p.home, p.away))}`);
      const sb = scoreBoardInline(p.scoreBoard);
      if (sb) lines.push(`   🎯 市場比分榜(主-客): ${sb}`);
    }
    lines.push("", "💡 比分榜=市場共識熱度(非穩贏)，準確比分本就難中");
  }
  const best = bestStrategy(res);
  if (best) lines.push("", `📊 目前最佳策略: ${best.label} ${best.bets}場 ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%`);
  lines.push(`🔭 更新 ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT · ${VERSION}`);
  return lines.join("\n");
}

function fmtResultSummary(res) {
  const lines = ["🏁 <b>賽果總結 + 策略戰績</b>", "（巨鯨方向 vs 賽果 · 按下注價算 ROI）", ""];
  for (const s of res.settled.slice(-5)) {
    const fw = s.strat?.followWhale, fb = s.strat?.followBig;
    const score = s.score ? ` <b>${s.score}</b>` : "";
    lines.push(`${fw?.win ? "✅" : "❌"} ${esc(s.match)}${score} → ${esc(resultLabel(s))}`);
    lines.push(`   巨鯨押 ${esc(sideLabel(s.whaleSide, s.home, s.away))} ${fw?.win ? "✅" : "❌"}`);
    lines.push(`   🐋 ${esc(bigLine(s.bigBettor, s.home, s.away, fb?.win))}`);
    const scoreLine = scoreResultLine(s);
    if (scoreLine) lines.push(scoreLine);
  }
  const shr = scoreHitRateLine(res);
  if (shr) lines.push("", shr);
  lines.push("");
  lines.push("📊 <b>策略累計戰績（前向測試 · ROI）</b>");
  for (const { key, label } of STRATS) {
    const s = res.strategies[key];
    if (!s || !s.bets) {
      lines.push(`${label}: 暫無`);
      continue;
    }
    const wr = Math.round((s.wins / s.bets) * 100);
    const roi = roiPct(s);
    lines.push(`${label}: ${s.bets}場 命中${wr}% · ROI <b>${roi >= 0 ? "+" : ""}${roi}%</b>`);
  }
  lines.push("");
  lines.push("⚠️ 樣本小時 ROI 噪聲大; 跑滿幾十場才算數");
  lines.push(`🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`);
  return lines.join("\n");
}

// ---------- Telegram ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 把"分钟前"转成易读的相对时间
function ago(min) {
  if (min < 1) return "剛剛";
  if (min < 60) return `${min}分鐘前`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}小時${min % 60}分前` : `${h}小時前`;
  return `${Math.floor(h / 24)}天前`;
}

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method} 失败: ${j.error_code} ${j.description}`);
  return j.result;
}

const tagEn = (p) =>
  p > 50000
    ? "🐋🟢 巨鯨贏家 Profitable Whale"
    : p > 5000
    ? "🟢 贏家錢包 Winning wallet"
    : p < -5000
    ? "🔴 虧損錢包 Losing wallet"
    : "⚪ 普通錢包 Neutral";

// 繁中輔助：買賣方向、結果選項
const sideZh = (s) => (s === "BUY" ? "買入" : s === "SELL" ? "賣出" : s);
const ocZh = (o) =>
  ({ yes: "是", no: "否", over: "大/高", under: "小/低", draw: "平局" }[String(o).toLowerCase()] || "");

// ---- 市場標題翻譯(規則+詞典，繁中港式譯名，無法解析則保留英文) ----
const TEAMS = {
  france: "法國", senegal: "塞內加爾", iraq: "伊拉克", norway: "挪威", argentina: "阿根廷",
  algeria: "阿爾及利亞", austria: "奧地利", jordan: "約旦", portugal: "葡萄牙",
  "dr congo": "剛果民主共和國", congo: "剛果", england: "英格蘭", croatia: "克羅地亞",
  ecuador: "厄瓜多爾", mexico: "墨西哥", "korea republic": "韓國", "south korea": "韓國", korea: "韓國",
  ghana: "加納", panama: "巴拿馬", brazil: "巴西", haiti: "海地", "united states": "美國", usa: "美國",
  australia: "澳洲", spain: "西班牙", "saudi arabia": "沙地阿拉伯", uzbekistan: "烏茲別克",
  colombia: "哥倫比亞", canada: "加拿大", qatar: "卡塔爾", scotland: "蘇格蘭", morocco: "摩洛哥",
  "new zealand": "紐西蘭", egypt: "埃及", uruguay: "烏拉圭", "cabo verde": "佛得角", "cape verde": "佛得角",
  belgium: "比利時", switzerland: "瑞士", "bosnia-herzegovina": "波斯尼亞", bosnia: "波斯尼亞",
  germany: "德國", "côte d'ivoire": "象牙海岸", "cote d'ivoire": "象牙海岸", "ivory coast": "象牙海岸",
  netherlands: "荷蘭", sweden: "瑞典", "türkiye": "土耳其", turkey: "土耳其", paraguay: "巴拉圭",
  italy: "意大利", japan: "日本", iran: "伊朗", nigeria: "尼日利亞", denmark: "丹麥", poland: "波蘭",
  serbia: "塞爾維亞", cameroon: "喀麥隆", tunisia: "突尼斯", peru: "秘魯", chile: "智利", greece: "希臘",
  wales: "威爾士", ukraine: "烏克蘭", "curaçao": "庫拉索", curacao: "庫拉索",
  czechia: "捷克", "czech republic": "捷克", "south africa": "南非",
};
const tTeam = (s) => TEAMS[String(s).trim().toLowerCase()] || String(s).trim();
// 整场三方: 把结果(home/draw/away)转成中文队名/平局
const outLabel = (oc, home, away) => (oc === "draw" ? "平局" : oc === "home" ? tTeam(home) : oc === "away" ? tTeam(away) : String(oc));
const STAGE = {
  final: "決賽", quarterfinals: "八強", "quarter-finals": "八強", semifinals: "四強",
  "semi-finals": "四強", "round of 16": "16強", "knockout stages": "淘汰賽",
  "knockout stage": "淘汰賽", knockout: "淘汰賽",
};
const cryptoZh = (c) =>
  ({ bitcoin: "比特幣", ethereum: "以太坊", solana: "Solana", xrp: "瑞波幣 XRP", dogecoin: "狗狗幣" }[
    String(c).toLowerCase()
  ] || c);
const MONTH = { january: "1月", february: "2月", march: "3月", april: "4月", may: "5月", june: "6月", july: "7月", august: "8月", september: "9月", october: "10月", november: "11月", december: "12月" };
const tMonth = (mo) => MONTH[String(mo).toLowerCase()] || mo;
const tDate = (s) => {
  const m = String(s).match(/^([A-Za-z]+)\s+(\d+)$/);
  return m && MONTH[m[1].toLowerCase()] ? `${MONTH[m[1].toLowerCase()]}${m[2]}日` : s;
};

function translateTitle(t) {
  const s = String(t || "").trim();
  let m;
  if ((m = s.match(/^(?:Will\s+)?(.+?)\s+vs\.?\s+(.+?)\s+end in a draw\??$/i)))
    return `${tTeam(m[1])} vs ${tTeam(m[2])}：會打成平手嗎？`;
  if ((m = s.match(/^Will\s+(.+?)\s+win(?:\s+on\s+(.+?))?\??$/i)))
    return `${tTeam(m[1])} 會贏嗎？${m[2] ? `（${m[2]}）` : ""}`;
  if (/^world cup winner$/i.test(s)) return "世界盃冠軍";
  if (/golden boot/i.test(s)) return "世界盃：金靴獎得主";
  if ((m = s.match(/^world cup group (\w+) winner$/i))) return `世界盃 ${m[1].toUpperCase()} 組頭名`;
  if (/advance to knockout/i.test(s)) return "世界盃：晉級淘汰賽的球隊";
  if ((m = s.match(/(?:nation|team) to reach (.+)$/i)))
    return `世界盃：晉級${STAGE[m[1].trim().toLowerCase()] || m[1]}的國家`;
  if (/which continent.*win/i.test(s)) return "哪個大洲奪得世界盃？";
  if ((m = s.match(/^Will\s+(.+?)\s+play in the World Cup\??$/i))) return `${m[1]} 會在世界盃上場嗎？`;
  // 加密
  if ((m = s.match(/^Will\s+(Bitcoin|Ethereum|Solana|XRP|Dogecoin)\s+reach\s+(\$[\d,.]+k?)\s+in\s+(\w+)\??$/i)))
    return `${cryptoZh(m[1])} ${tMonth(m[3])}內會漲到 ${m[2]} 嗎？`;
  if ((m = s.match(/^Will\s+(Bitcoin|Ethereum|Solana|XRP|Dogecoin)\s+dip to\s+(\$[\d,.]+k?)\s+in\s+(\w+)\??$/i)))
    return `${cryptoZh(m[1])} ${tMonth(m[3])}內會跌到 ${m[2]} 嗎？`;
  if ((m = s.match(/^Will the price of\s+(Bitcoin|Ethereum|Solana|XRP)\s+be (above|below|between)\s+(.+?)\s+on\s+(.+?)\??$/i)))
    return `${tDate(m[4])} ${cryptoZh(m[1])}會${{ above: "高於", below: "低於", between: "介於" }[m[2].toLowerCase()]} ${m[3]} 嗎？`;
  // 純對陣 X vs Y(放最後，避免吃掉上面更具体的句式)
  if ((m = s.match(/^(.+?)\s+vs\.?\s+(.+?)$/i))) return `${tTeam(m[1])} vs ${tTeam(m[2])}`;
  return s; // 兜底：保留原文
}

// 標題區塊：中文為主，原英文小字附在下一行(翻不出来则只显示英文)
function titleBlock(w) {
  const en = String(w.title || "").trim();
  const zh = translateTitle(en);
  return zh !== en ? `📊 ${esc(zh)}\n   <i>${esc(en)}</i>` : `📊 ${esc(en)}`;
}

function fmtSignal(w) {
  const name = esc(w.name || w.pseudonym || w.proxyWallet.slice(0, 8));
  const conv = w.directional ? "🎯 方向性下注 Directional" : "🛡 吃息套保 Yield";
  const slug = w.eventSlug || w.slug || "";
  const url = slug ? `https://polymarket.com/event/${slug}` : "https://polymarket.com";
  const isYes = /yes/i.test(w.outcome || "");
  const sq = isYes ? "🟩" : "🟥";
  const oc = String(w.outcome || "").toUpperCase();
  const ocz = ocZh(w.outcome) ? `（${ocZh(w.outcome)}）` : "";
  const price = Number(w.price).toFixed(3);
  const pct = Math.round(Number(w.price) * 100);
  return [
    `${tagEn(w.allTimePnl)}  ·  ${conv}`,
    ``,
    `${sq} <b>${sideZh(w.side)} ${oc}${ocz}</b>  @ ${price}  (隱含機率 ${pct}%)`,
    `💰 金額 Size <b>${fmtUSD(w.notional)}</b>  ·  🕐 ${ago(w.ageMin)}`,
    ``,
    titleBlock(w),
    ``,
    `👤 <b>${name}</b>`,
    `   歷史盈虧 PnL <b>${fmtUSD(w.allTimePnl)}</b>  ·  持倉市值 ${fmtUSD(w.value)}`,
    `   <code>${esc(w.proxyWallet)}</code>`,
    ``,
    `🔗 <a href="${url}">查看市場 View on Polymarket ↗</a>`,
    `🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`,
  ].join("\n");
}

// 观察名单信号：榜首赢家的动作(用排行榜的盈利数据，无需额外查询)
function fmtWatchlistSignal(w) {
  const conv = w.directional ? "🎯 方向性下注 Directional" : "🛡 吃息套保 Yield";
  const slug = w.eventSlug || w.slug || "";
  const url = slug ? `https://polymarket.com/event/${slug}` : "https://polymarket.com";
  const isYes = /yes/i.test(w.outcome || "");
  const sq = isYes ? "🟩" : "🟥";
  const oc = String(w.outcome || "").toUpperCase();
  const price = Number(w.price).toFixed(3);
  const pct = Math.round(Number(w.price) * 100);
  const name = esc(w.name || w.proxyWallet.slice(0, 8));
  const ocz = ocZh(w.outcome) ? `（${ocZh(w.outcome)}）` : "";
  return [
    `👑 <b>頂級贏家出手 TOP TRADER MOVE</b>  ·  ${conv}`,
    ``,
    `${sq} <b>${sideZh(w.side)} ${oc}${ocz}</b>  @ ${price}  (隱含機率 ${pct}%)`,
    `💰 金額 Size <b>${fmtUSD(w.notional)}</b>  ·  🕐 ${ago(w.ageMin)}`,
    ``,
    titleBlock(w),
    ``,
    `👤 <b>${name}</b>  (盈利榜第 #${w.rank} 名)`,
    `   歷史總盈利 Profit <b>${fmtUSD(w.profit)}</b>`,
    `   <code>${esc(w.proxyWallet)}</code>`,
    ``,
    `🔗 <a href="${url}">查看市場 View on Polymarket ↗</a>`,
    `🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`,
  ].join("\n");
}

// ---------- 一轮扫描 ----------
// 持仓快照：各市场大额买入的多空分布
function fmtPositioning(markets, threshold) {
  const top = markets.slice(0, 6); // 纯中文, 可多放几个盘
  const url = (m) => (m.eventSlug ? `https://polymarket.com/event/${m.eventSlug}` : "https://polymarket.com");

  const cn = [
    "📊 <b>巨鯨持倉分析</b>",
    `（大戶下注的多空分布）`,
    "",
  ];
  for (const m of top) {
    const dm = (m.eventSlug || "").match(/(\d{4}-\d{2}-\d{2})$/);
    const dateStr = dm ? `（${dm[1]}）` : "";
    cn.push(`🔥 <a href="${url(m)}">${esc(translateTitle(m.title))}</a>${dateStr}  <i>(共 ${m.wallets} 人 · ${fmtUSD(m.total)})</i>`);
    if (m.sides) {
      // 体育: 整场三方分布(主胜 / 平 / 客胜)
      const topTeamUsd = Math.max(m.sides.home.usd, m.sides.away.usd);
      const rows = [["home", m.sides.home], ["draw", m.sides.draw], ["away", m.sides.away]]
        .map(([oc, v]) => ({ oc, usd: v.usd, wallets: v.wallets, price: v.price }))
        .filter((x) => x.usd > 0)
        .sort((a, b) => b.usd - a.usd);
      for (const x of rows) {
        const pct = m.total ? Math.round((x.usd / m.total) * 100) : 0;
        const icon = x.oc === "draw" ? "⚪" : x.usd === topTeamUsd ? "🟩" : "🟥";
        const odds = x.price != null ? `盤口${Math.round(x.price * 100)}¢ · ` : "";
        cn.push(`   ${icon} ${esc(outLabel(x.oc, m.home, m.away))}  ${odds}${fmtUSD(x.usd)} · ${x.wallets}人 · 佔${pct}%`);
      }
      if (m.topWinner) {
        const w = m.topWinner;
        cn.push(`   💎 最賺大戶 押 ${esc(outLabel(w.outcome, m.home, m.away))} · ${fmtUSD(w.usd)} · 歷史盈利 ${fmtUSD(w.allTimePnl)}`);
        cn.push(`      <code>${esc(w.wallet)}</code>`);
      } else if (m.topWhale) {
        const tw = m.topWhale, pnl = tw.allTimePnl;
        const tag = pnl == null ? "" : pnl > 0 ? ` · 歷史盈利 ${fmtUSD(pnl)}` : pnl < 0 ? ` · 歷史虧損 ${fmtUSD(Math.abs(pnl))}` : "";
        cn.push(`   🐋 最大注大戶 押 ${esc(outLabel(tw.outcome, m.home, m.away))} · ${fmtUSD(tw.usd)}${tag}`);
        cn.push(`      <code>${esc(tw.wallet)}</code>`);
      }
      const big = m.topWhale;
      if (big && big.allTimePnl != null && big.allTimePnl <= -50000 && (!m.topWinner || big.wallet !== m.topWinner.wallet)) {
        cn.push(`   ⚠️ 最大注卻是輸家 押 ${esc(outLabel(big.outcome, m.home, m.away))} · ${fmtUSD(big.usd)} (歷史虧損 ${fmtUSD(Math.abs(big.allTimePnl))})`);
      }
      cn.push("");
      continue;
    }
    // 加密: 逐个二元市场 Yes/No
    m.breakdown.slice(0, 3).forEach((b, i) => {
      const ocz = ocZh(b.outcome) ? `（${ocZh(b.outcome)}）` : "";
      cn.push(`   ${i === 0 ? "🟩" : "🔻"} ${esc(String(b.outcome))}${ocz}  ${fmtUSD(b.usd)} · ${b.wallets}人 · ${b.pct}%`);
    });
    // 💎 主推"最赚大户"(proven winner); 没有则退回最大注大户
    if (m.topWinner) {
      const w = m.topWinner;
      const ocz = ocZh(w.outcome) ? `（${ocZh(w.outcome)}）` : "";
      cn.push(`   💎 最賺大戶 押 ${esc(String(w.outcome))}${ocz} · ${fmtUSD(w.usd)} · 歷史盈利 ${fmtUSD(w.allTimePnl)}`);
      cn.push(`      <code>${esc(w.wallet)}</code>`);
    } else if (m.topWhale) {
      const tw = m.topWhale;
      const ocz = ocZh(tw.outcome) ? `（${ocZh(tw.outcome)}）` : "";
      const pnl = tw.allTimePnl;
      const tag = pnl == null ? "" : pnl > 0 ? ` · 歷史盈利 ${fmtUSD(pnl)}` : pnl < 0 ? ` · 歷史虧損 ${fmtUSD(Math.abs(pnl))}` : "";
      cn.push(`   🐋 最大注大戶 押 ${esc(String(tw.outcome))}${ocz} · ${fmtUSD(tw.usd)}${tag}`);
      cn.push(`      <code>${esc(tw.wallet)}</code>`);
    }
    // ⚠️ 反向提示: 若"最大注"是大输家(且不是上面展示的赢家)
    const big = m.topWhale;
    if (big && big.allTimePnl != null && big.allTimePnl <= -50000 && (!m.topWinner || big.wallet !== m.topWinner.wallet)) {
      cn.push(`   ⚠️ 最大注卻是輸家 押 ${esc(String(big.outcome))} · ${fmtUSD(big.usd)} (歷史虧損 ${fmtUSD(Math.abs(big.allTimePnl))})`);
    }
    cn.push("");
  }
  cn.push(`🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`);
  return cn.join("\n");
}

// 顶级赢家风格榜
function fmtProfiles(profiles) {
  const lines = [
    "🏆 <b>頂級贏家風格 Top Traders</b>",
    "（盈利榜前列玩家怎麼下注）",
    "",
  ];
  profiles.slice(0, 12).forEach((w) => {
    const name = esc(w.name || w.wallet.slice(0, 8));
    lines.push(`<b>#${w.rank} ${name}</b> ${fmtUSD(w.profit)}`);
    lines.push(`   ${w.mainCat} · 方向性 ${w.dirPct}% · 均價 ${w.avgPrice.toFixed(2)}(${w.priceStyle}) · 均注 ${fmtUSD(w.avgSize)}`);
  });
  lines.push("");
  lines.push("💡 共性：頂級贏家多為「方向性大額下注」，極少吃息刷量");
  lines.push(`🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`);
  return lines.join("\n");
}

async function send(text) {
  await tg("sendMessage", {
    chat_id: CHANNEL,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  await new Promise((r) => setTimeout(r, 1200)); // 避免触发限频
}
async function sendReturn(text) {
  const r = await tg("sendMessage", { chat_id: CHANNEL, text, parse_mode: "HTML", disable_web_page_preview: true });
  return r?.message_id;
}
async function pinMsg(id) {
  try {
    await tg("pinChatMessage", { chat_id: CHANNEL, message_id: id, disable_notification: true });
  } catch {}
}
async function editMsg(id, text) {
  try {
    await tg("editMessageText", { chat_id: CHANNEL, message_id: id, text, parse_mode: "HTML", disable_web_page_preview: true });
    return true;
  } catch {
    return false;
  }
}
// 置顶一条"策略战绩"并持续更新(就地编辑; 不存在则重发+置顶)
async function postOrUpdateTrackRecord(res) {
  res.trackUpdatedAt = Date.now();
  const text = fmtTrackRecord(res);
  if (res.pinnedMsgId && (await editMsg(res.pinnedMsgId, text))) return;
  const id = await sendReturn(text);
  if (id) {
    res.pinnedMsgId = id;
    await pinMsg(id);
  }
}

// 置顶②: 即将开赛预判(就地编辑; 不存在则发+置顶)。previewMsgId 持久化在 results, 故云端始终编辑同一条, 不会重复置顶。
async function postOrUpdatePreviewPin(res, matches) {
  res.previewUpdatedAt = Date.now();
  const text = fmtUpcomingPin(matches || [], res);
  if (res.previewMsgId && (await editMsg(res.previewMsgId, text))) return;
  const id = await sendReturn(text);
  if (id) {
    res.previewMsgId = id;
    await pinMsg(id);
  }
}

async function pollOnce() {
  const seen = loadSeen();

  // 逐条信号(大额交易 + 观察名单): 可整体关闭, 整合进精华版(SIGNALS_ENABLED=off)
  let posted = 0;
  if (SIGNALS_ENABLED) {
    const { signals, stats } = await scan({ whaleTradesToPull: WHALE_PULL, maxAgeMinutes: MAX_AGE_MIN });
    const freshWhalesAll = signals.filter((s) => !seen.has(s.key)).sort((a, b) => (b.allTimePnl || 0) - (a.allTimePnl || 0));
    let freshWatchAll = [];
    let watchStats = { watchSize: 0 };
    try {
      const wl = await scanWatchlist({ maxAgeMinutes: WATCH_MAX_AGE_MIN });
      watchStats = wl.stats;
      freshWatchAll = wl.hits.filter((s) => !seen.has(s.key));
    } catch (e) {
      console.error("观察名单扫描出错:", e.message);
    }
    const whalesPost = freshWhalesAll.slice(0, SIGNAL_MAX_PER_RUN);
    const watchPost = freshWatchAll.slice(0, WATCH_MAX_PER_RUN);
    console.log(`[${new Date().toISOString()}] 大单 ${stats.cryptoWhaleCount}/新${freshWhalesAll.length}/推${whalesPost.length} ｜ 名单 ${watchStats.watchSize}人/新${freshWatchAll.length}/推${watchPost.length}`);
    for (const s of whalesPost) await send(fmtSignal(s));
    for (const s of watchPost) await send(fmtWatchlistSignal(s));
    for (const s of freshWhalesAll) seen.add(s.key);
    for (const s of freshWatchAll) seen.add(s.key);
    saveSeen(seen);
    posted = whalesPost.length + watchPost.length;
  } else {
    console.log(`[${new Date().toISOString()}] 逐条信号已关(整合进精华版)`);
  }

  // 定时摘要：持仓快照 / 赢家风格(到点才推)
  if (DIGESTS) {
    const d = loadDigest();
    const now = Date.now();
    if (now - (d.positioning || 0) >= POSITIONING_MIN * 60000) {
      try {
        const { markets, threshold } = await marketSentiment({ topMarkets: 5 });
        if (markets.length) {
          await send(fmtPositioning(markets, threshold));
          d.positioning = now;
          console.log("  → 已推持仓快照");
        }
      } catch (e) {
        console.error("持仓快照出错:", e.message);
      }
    }
    if (PROFILES_ENABLED && now - (d.profiles || 0) >= PROFILES_MIN * 60000) {
      try {
        const p = await analyzeTopTraders(12);
        if (p.length) {
          await send(fmtProfiles(p));
          d.profiles = now;
          console.log("  → 已推赢家风格榜");
        }
      } catch (e) {
        console.error("赢家风格出错:", e.message);
      }
    }
    saveDigest(d);
  }

  // 赛果追踪: 体育(ESPN结算) / 加密(市场解析结算) 各走一套, 共用策略ROI+置顶
  try {
    if (RESULTS_ON) await trackResults();
    else if (TAG === "crypto") await trackResultsCrypto();
  } catch (e) {
    console.error("赛果追踪出错:", e.message);
  }

  return posted;
}

// ---------- 入口 ----------
async function main() {
  if (process.argv.includes("--test")) {
    await tg("sendMessage", {
      chat_id: CHANNEL,
      text: "✅ <b>Polaris Radar</b> connected and standing by.",
      parse_mode: "HTML",
    });
    console.log("✅ 测试消息已发送到", CHANNEL);
    return;
  }
  if (process.argv.includes("--results")) {
    const r = loadResults();
    console.log(`赛果追踪 (${TAG}): 已结算 ${r.settled.length} 场 | 待结算预测 ${Object.keys(r.predictions).length} 场`);
    for (const { key, label } of STRATS) {
      const s = r.strategies[key];
      if (!s || !s.bets) { console.log(`  ${label}: 暂无`); continue; }
      console.log(`  ${label}: ${s.bets}场 命中${Math.round((s.wins / s.bets) * 100)}% ROI ${roiPct(s) >= 0 ? "+" : ""}${roiPct(s)}%`);
    }
    r.settled.slice(-10).forEach((s) => console.log(`    ${s.strat?.followWhale?.win ? "✅" : "❌"} ${s.match} ${s.score} 实际${s.actual}`));
    return;
  }

  if (process.argv.includes("--refresh-pin")) {
    const r = loadResults();
    await postOrUpdateTrackRecord(r);
    saveResults(r);
    console.log(`📌 已刷新置顶战绩 → ${CHANNEL} (msgId ${r.pinnedMsgId})`);
    return;
  }

  if (process.argv.includes("--preview-now")) {
    // 手动推一次: 持仓分析(实时) + 今日预判(强制, 不受 PREVIEW_HOUR/previewDay 限制), 用于改版后看效果
    try {
      const { markets, threshold } = await marketSentiment({ topMarkets: 5 });
      if (markets.length) await send(fmtPositioning(markets, threshold));
      console.log(`📊 持仓分析已推 (${markets.length} 条)`);
    } catch (e) {
      console.error("持仓分析出错:", e.message);
    }
    if (RESULTS_ON) {
      const res = loadResults();
      let wc = [], pmEvents = [];
      try { [wc, pmEvents] = await Promise.all([getWcResults(), getMatchEvents(20)]); } catch (e) { console.error("取赛程出错:", e.message); }
      await capturePredictions(res, wc, pmEvents); // 先捕捉今日赛前预判(含比分榜)
      saveResults(res);
      const upcoming = wc.filter((m) => !m.completed && res.predictions[m.id]);
      if (upcoming.length) { await send(fmtDailyPreview(upcoming, res)); console.log(`☀️ 今日预判已推 (${upcoming.length} 场)`); }
      else console.log("☀️ 今日预判: 暂无可推的赛前预判(可能今天暂无赛前场次)");
    }
    return;
  }

  const everyDesc = process.env.POLL_SECONDS ? `${process.env.POLL_SECONDS} 秒` : `${POLL_MINUTES} 分钟`;
  console.log(`🔭 Polaris 雷达 ${VERSION} 启动 ｜ 频道 ${CHANNEL} ｜ 每 ${everyDesc}扫描一次`);
  const n = await pollOnce();
  console.log(`首轮推送 ${n} 条`);

  if (process.argv.includes("--once")) return;
  setInterval(() => {
    pollOnce().catch((e) => console.error("轮询出错:", e.message));
  }, POLL_MS);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("启动失败:", e.message);
    process.exit(1);
  });
}

module.exports = { translateTitle, titleBlock, fmtPositioning, fmtProfiles, fmtResultSummary, evalStrategies, fmtTrackRecord, fmtDailyPreview, fmtUpcomingPin };
