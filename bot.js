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
const { scan, scanWatchlist, marketSentiment, analyzeTopTraders, getMatchEvents, getWcResults, matchPrediction, getTotalsSignal, getSpreadSignal, getClosingPrices, multiSportSentiment, winnerRecentBets, walletActivity, quoteMatch, cryptoPrediction, getMarketResolution, getMarketNow, findBetMarket, dkEdges, fmtUSD } = require("./radar");

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
const VERSION = "V8.0"; // 版本号(每次迭代升级时更新; 同步 CHANGELOG.md 与启动脚本横幅)
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
      if (ex.kickoffMs == null && m.kickoffMs) ex.kickoffMs = m.kickoffMs; // 回填开赛时间(老预判没存)
      // 回填大小球信号: 仅在"从未尝试过"(undefined)时补一次, 失败置 null 不再每轮重试
      if (ex.totals === undefined && ex.eventSlug) ex.totals = (await getTotalsSignal(ex.eventSlug).catch(() => null)) || null;
      // 回填让球信号(同上): 从未尝试过才补
      if (ex.spread === undefined && ex.eventSlug) ex.spread = (await getSpreadSignal(ex.eventSlug).catch(() => null)) || null;
      // 回填胜负盘"最大赢家"(老预判没存); 只取 proWinner, 不覆盖已锁定的入场价/sides
      if (ex.proWinner === undefined) {
        const pr = await matchPrediction(m, pmEvents).catch(() => null);
        ex.proWinner = (pr && pr.proWinner) || null;
      }
      continue;
    }
    const pred = await matchPrediction(m, pmEvents).catch(() => null);
    if (pred && pred.sides) {
      const totals = await getTotalsSignal(pred.eventSlug).catch(() => null); // 大小球 O/U 2.5 聪明钱偏向
      const spread = await getSpreadSignal(pred.eventSlug).catch(() => null); // 让球 -1.5 聪明钱偏向
      res.predictions[m.id] = {
        match: `${m.home} vs ${m.away}`, home: m.home, away: m.away, kickoffMs: m.kickoffMs,
        whaleSide: pred.whaleSide, consensusPct: pred.consensusPct, bigBettor: pred.bigBettor, proWinner: pred.proWinner || null,
        sides: pred.sides, eventSlug: pred.eventSlug, totals, spread, state: m.state, capturedAt: new Date().toISOString(),
      };
    }
  }
  // 兜底回填开赛时间: 对仍缺 kickoffMs 的预判(尤其改版前捕捉、已不在 ESPN 赛程上的), 从已拉取的 Polymarket 事件 startTime 补(零额外请求)
  for (const id in res.predictions) {
    const p = res.predictions[id];
    if (p.kickoffMs == null && p.eventSlug) {
      const pe = (pmEvents || []).find((e) => e.slug === p.eventSlug);
      if (pe && pe.startTime) p.kickoffMs = Date.parse(pe.startTime);
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
  // 1.5) 捕捉「近开赛收盘价」算 CLV(收盘线价值): 每场只抓一次, 临近开赛(≤90分钟)首次轮询时锁定
  //      CLV = 近开赛价 − 入场价, 正=价格朝你那侧移动=你买在好价位; 是"有没有 edge"最快的领先指标(不必等赛果)
  const CLV_WINDOW_MS = 90 * 60 * 1000;
  for (const id in res.predictions) {
    const p = res.predictions[id];
    if (p.clvCaptured || p.kickoffMs == null) continue;
    if (Date.now() < p.kickoffMs - CLV_WINDOW_MS) continue; // 还没临近开赛, 下轮再看
    const m = wc.find((x) => x.id === id);
    const hT = m ? m.homeTokens : (p.home || "").toLowerCase().split(/\s+/).filter(Boolean);
    const aT = m ? m.awayTokens : (p.away || "").toLowerCase().split(/\s+/).filter(Boolean);
    const close = await getClosingPrices(p.eventSlug, hT, aT).catch(() => null);
    if (!close) continue; // 抓不到下轮再试(不置 captured)
    const clv = { capturedAt: new Date().toISOString() };
    const entryMl = p.sides && p.sides[p.whaleSide] ? p.sides[p.whaleSide].price : null;
    const closeMl = close.moneyline ? close.moneyline[p.whaleSide] : null;
    if (entryMl > 0 && entryMl < 1 && closeMl > 0 && closeMl < 1)
      clv.ml = { side: p.whaleSide, entry: entryMl, close: closeMl, clv: +(closeMl - entryMl).toFixed(4) };
    if (p.totals && p.totals.side) {
      const entryOu = p.totals.side === "Over" ? p.totals.overPrice : p.totals.underPrice;
      const closeOu = p.totals.side === "Over" ? close.ou.overPrice : close.ou.underPrice;
      if (entryOu > 0 && entryOu < 1 && closeOu > 0 && closeOu < 1)
        clv.ou = { side: p.totals.side, entry: entryOu, close: closeOu, clv: +(closeOu - entryOu).toFixed(4) };
    }
    if (p.spread && p.spread.side && close.spread && close.spread.favTeam === p.spread.favTeam) {
      const entrySp = p.spread.side === "cover" ? p.spread.coverPrice : p.spread.notPrice;
      const closeSp = p.spread.side === "cover" ? close.spread.coverPrice : close.spread.notPrice;
      if (entrySp > 0 && entrySp < 1 && closeSp > 0 && closeSp < 1)
        clv.spread = { side: p.spread.side, entry: entrySp, close: closeSp, clv: +(closeSp - entrySp).toFixed(4) };
    }
    p.clv = clv;
    p.clvCaptured = true;
  }
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
      espnId: m.id, match: p.match, home: p.home, away: p.away, actual: m.actual, kickoffMs: p.kickoffMs,
      score: `${m.homeScore}-${m.awayScore}`, whaleSide: p.whaleSide, bigBettor: p.bigBettor,
      strat, settledAt: new Date().toISOString(),
    };
    // 大小球前向测: 实际总进球 → Over/Under(2.5), 评 O/U 策略 ROI(跟大户 / 跟💎盈利大户 / 强共识)
    if (p.totals && (p.totals.overPrice != null || p.totals.underPrice != null) && m.homeScore != null && m.awayScore != null) {
      const t = p.totals;
      const goals = m.homeScore + m.awayScore;
      const actualOU = goals >= 3 ? "Over" : "Under"; // 总进球≥3 = 大球(O/U 2.5)中
      const priceOf = (sd) => (sd === "Over" ? t.overPrice : t.underPrice);
      const evalOU = (betSide) => {
        if (!betSide) return null;
        const price = priceOf(betSide);
        if (!(price > 0 && price < 1)) return null;
        const win = actualOU === betSide;
        return { side: betSide, price, win, profit: win ? (1 - price) / price : -1 };
      };
      const ouStrat = {
        followBig: evalOU(t.side),                              // 跟大户(资金多数方)
        followWinner: t.winnerSide ? evalOU(t.winnerSide) : null, // 跟💎盈利大户押的那边
        highConsensus: t.pct >= 75 ? evalOU(t.side) : null,      // 仅强共识(≥75%)才跟
      };
      const ouS = (res.ouStrategies = res.ouStrategies || {});
      for (const key in ouStrat) {
        const r = ouStrat[key];
        if (!r) continue;
        const s = (ouS[key] = ouS[key] || { bets: 0, wins: 0, profit: 0 });
        s.bets++; if (r.win) s.wins++; s.profit += r.profit;
      }
      // 逐场记录(供分段分析: 大球/小球各自 ROI、共识强弱、有无盈利大户); price=跟大户那一侧的入场价
      (res.ouSettled = res.ouSettled || []).push({
        match: p.match, goals, actualOU, side: t.side, pct: t.pct, price: priceOf(t.side),
        winnerSide: t.winnerSide, win: ouStrat.followBig ? ouStrat.followBig.win : null, settledAt: rec.settledAt,
      });
      rec.ou = { actualOU, goals, side: t.side, winnerSide: t.winnerSide, win: ouStrat.followBig ? ouStrat.followBig.win : null };
    }
    // 让球前向测: 让球方赢2+球=cover, 否则受让方+1.5=not; 评策略 ROI(跟大户 / 跟💎盈利大户 / 强共识)
    if (p.spread && p.spread.favTeam && m.homeScore != null && m.awayScore != null) {
      const sp = p.spread;
      const favTok = String(sp.favTeam).toLowerCase().split(/\s+/).filter(Boolean);
      const hitH = favTok.filter((tk) => String(p.home).toLowerCase().includes(tk)).length;
      const hitA = favTok.filter((tk) => String(p.away).toLowerCase().includes(tk)).length;
      const favHome = hitH >= hitA; // 让球方是主队?
      const favGoals = favHome ? m.homeScore : m.awayScore;
      const dogGoals = favHome ? m.awayScore : m.homeScore;
      const actualSide = favGoals - dogGoals > sp.line ? "cover" : "not"; // 赢>1.5球=cover
      const priceOf = (sd) => (sd === "cover" ? sp.coverPrice : sp.notPrice);
      const evalSp = (betSide) => {
        if (!betSide) return null;
        const price = priceOf(betSide);
        if (!(price > 0 && price < 1)) return null;
        const win = actualSide === betSide;
        return { side: betSide, price, win, profit: win ? (1 - price) / price : -1 };
      };
      const spStrat = {
        followBig: evalSp(sp.side),
        followWinner: sp.winnerSide ? evalSp(sp.winnerSide) : null,
        highConsensus: sp.pct >= 75 ? evalSp(sp.side) : null,
      };
      const spS = (res.spreadStrategies = res.spreadStrategies || {});
      for (const key in spStrat) {
        const r = spStrat[key];
        if (!r) continue;
        const s = (spS[key] = spS[key] || { bets: 0, wins: 0, profit: 0 });
        s.bets++; if (r.win) s.wins++; s.profit += r.profit;
      }
      (res.spreadSettled = res.spreadSettled || []).push({
        match: p.match, favTeam: sp.favTeam, favGoals, dogGoals, actualSide, side: sp.side, pct: sp.pct, price: priceOf(sp.side),
        winnerSide: sp.winnerSide, win: spStrat.followBig ? spStrat.followBig.win : null, settledAt: rec.settledAt,
      });
      rec.spread = { actualSide, favTeam: sp.favTeam, side: sp.side, winnerSide: sp.winnerSide, win: spStrat.followBig ? spStrat.followBig.win : null };
    }
    res.settled.push(rec);
    newSettle++;
  }
  // 有新结算: 推赛果总结 + 更新置顶战绩
  if (newSettle > 0) {
    await send(fmtResultSummary(res, newSettle));
    await postOrUpdateTrackRecord(res);
    await postOrUpdateResultsPin(res); // 置顶③: 今日赛果
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
  // 置顶③今日赛果定期刷新
  if (Date.now() - (res.resultsUpdatedAt || 0) >= 30 * 60000) await postOrUpdateResultsPin(res);
  // DraftKings 差价信号: 前向捕捉/结算(测差价到底赚不赚) + 有可下注信号时节流推送(默6h一次)
  if ((process.env.DK_ENABLED || "on") !== "off") {
    try {
      const edges = await dkEdges(wc, pmEvents, { minGap: Number(process.env.DK_MIN_GAP || 0.04) });
      trackDkEdges(wc, edges);
      if (edges.length && Date.now() - (res.dkPushedAt || 0) >= Number(process.env.DK_MIN || 360) * 60000) {
        const t = fmtDkEdges(edges); if (t) { await send(t); res.dkPushedAt = Date.now(); console.log(`  → 已推差价信号(${edges.length}条)`); }
      }
    } catch (e) { console.error("差价信号出错:", e.message); }
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
    if (!pred || !pred.sides) continue;
    // 竞争性过滤: 跳过近乎确定的废盘(巨鲸侧价 >0.90 或 <0.10) —— 100%胜但+0 ROI, 是噪声不是信号
    const wp = pred.sides[pred.whaleSide]?.price;
    if (wp != null && (wp > 0.9 || wp < 0.1)) continue;
    res.predictions[mk.conditionId] = {
      match: mk.question, slug: ev.slug, gammaId: mk.id,
      whaleSide: pred.whaleSide, consensusPct: pred.consensusPct, bigBettor: pred.bigBettor,
      sides: pred.sides, capturedAt: new Date().toISOString(),
    };
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
    await send(fmtResultSummary(res, newSettle));
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
  // 置顶②预判(加密: 未结算的预判, 每≥30分钟刷新)
  if (Date.now() - (res.previewUpdatedAt || 0) >= 30 * 60000) {
    const up = Object.entries(res.predictions).filter(([id]) => !res.settled.find((s) => s.espnId === id)).slice(0, 6).map(([id, p]) => ({ id, ...p }));
    await postOrUpdatePreviewPin(res, up);
  }
  saveResults(res);
}

const roiPct = (s) => (s.bets ? Math.round((s.profit / s.bets) * 100) : 0);
const hkNow = () => new Date(Date.now() + 8 * 3600 * 1000); // 香港时间
// 开赛时间 → 香港时间 "M/D HH:MM"
const koHKT = (ms) => {
  if (!ms) return "";
  const d = new Date(ms + 8 * 3600 * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

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
  // 逐场结算明细(跟巨鲸方向, 最近6场, 新到旧): 押了谁/结果/入场价/单注盈亏 —— 透明度。兼容体育(主客比分)与加密(Yes/No)。
  const recent = settled.filter((x) => x.strat?.followWhale).slice(-6).reverse();
  if (recent.length) {
    lines.push("📋 <b>近期逐場結果</b>（跟巨鯨方向）");
    for (const x of recent) {
      const fw = x.strat.followWhale;
      const px = `@${fw.price != null ? fw.price.toFixed(2).slice(1) : "?"}`;
      const u = `${fw.profit >= 0 ? "+" : ""}${fw.profit.toFixed(2)}u`;
      let body;
      if (x.home && x.away) {
        // 体育: 主队 比分 客队
        const backed = fw.side === "home" ? tTeam(x.home) : fw.side === "away" ? tTeam(x.away) : "平局";
        body = `${esc(tTeam(x.home))} ${esc(x.score || "")} ${esc(tTeam(x.away))} · 押${esc(backed)}`;
      } else {
        // 加密: 市场问题(译中文+截断) + 押 是/否
        const q = translateTitle(x.match || "");
        const backed = /yes|是/i.test(fw.side) ? "是" : /no|否/i.test(fw.side) ? "否" : esc(String(fw.side));
        body = `${esc(q.length > 24 ? q.slice(0, 24) + "…" : q)} · 押${backed}`;
      }
      lines.push(`${fw.win ? "✅" : "❌"} ${body} ${px} · ${u}`);
    }
    lines.push("");
  }
  if (best && any) lines.push(`🏆 目前最佳: ${best.label} (ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%)`);
  if (!any) lines.push("⏳ 等待首批賽果結算中…"); // 取消"样本仍小"警告行(保留空态占位)
  for (const l of ouStatsLines(res)) lines.push(l); // ⚽ 大小球前向战绩(有结算才显示)
  for (const l of spreadStatsLines(res)) lines.push(l); // ⚖️ 让球前向战绩(有结算才显示)
  for (const l of clvStatsLines(res)) lines.push(l); // 📈 CLV 收盘线价值(有捕捉才显示)
  lines.push(`🔭 ROI=每$1淨回報 · 賠率=入場價隱含倍數 · 更新 ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT · ${VERSION}`);
  return lines.join("\n");
}

// 大小球(O/U 2.5)前向战绩: 跟💎盈利大户 / 跟大户 / 强共识 三条策略命中率+ROI + 大/小球分段(诚实小样本)
function ouStatsLines(res) {
  const os = res.ouStrategies;
  if (!os) return [];
  const order = [
    ["followWinner", "跟💎盈利大戶"],
    ["followBig", "跟大戶(資金多數方)"],
    ["highConsensus", "僅強共識≥75%才跟"],
  ];
  const body = [];
  for (const [key, label] of order) {
    const s = os[key];
    if (!s || !s.bets) continue;
    const wr = Math.round((s.wins / s.bets) * 100);
    const roi = Math.round((s.profit / s.bets) * 100);
    body.push(`${label}: ${s.bets}場 命中${wr}% · ROI ${roi >= 0 ? "+" : ""}${roi}%`);
  }
  if (!body.length) return [];
  // 大/小球分段(跟大户口径): 偏大球 vs 偏小球 各自命中率 + ROI —— 区分"准"与"赚"(命中高但入场价更高可能仍亏)
  const seg = (sideVal) => {
    const a = (res.ouSettled || []).filter((x) => x.side === sideVal && x.win != null);
    if (!a.length) return null;
    const w = a.filter((x) => x.win).length;
    const priced = a.filter((x) => x.price > 0 && x.price < 1);
    const roi = priced.length ? Math.round((priced.reduce((s, x) => s + (x.win ? (1 - x.price) / x.price : -1), 0) / priced.length) * 100) : null;
    const avgPx = priced.length ? (priced.reduce((s, x) => s + x.price, 0) / priced.length) : null;
    return `   ${sideVal === "Over" ? "偏大球" : "偏小球"}: ${a.length}場 命中${Math.round((w / a.length) * 100)}%${roi != null ? ` · ROI ${roi >= 0 ? "+" : ""}${roi}%` : ""}${avgPx != null ? ` · 均入場價${avgPx.toFixed(2)}` : ""}`;
  };
  const segs = [seg("Over"), seg("Under")].filter(Boolean);
  return ["", "⚽ <b>大小球戰績</b>（O/U 2.5 · 前向測試）", ...body, ...(segs.length ? ["   ── 分段（跟大戶口徑）──", ...segs] : [])];
}

// CLV(收盘线价值)前向战绩: 入场价 vs 近开赛价。正 CLV=你买在了好价位; 是"有没有 edge"最快的领先指标(不必等赛果)
function clvStatsLines(res) {
  const preds = Object.values(res.predictions || {});
  const pick = (kind) => preds.map((p) => p.clv && p.clv[kind]).filter(Boolean);
  const row = (arr, label) => {
    if (!arr.length) return null;
    const avg = arr.reduce((s, x) => s + x.clv, 0) / arr.length;
    const pos = arr.filter((x) => x.clv > 0).length;
    return `   ${label}: ${arr.length}場 · 均CLV ${avg >= 0 ? "+" : ""}${(avg * 100).toFixed(1)}pt · 贏線率 ${Math.round((pos / arr.length) * 100)}%`;
  };
  const ml = row(pick("ml"), "勝負盤"), ou = row(pick("ou"), "大小球"), sp = row(pick("spread"), "讓球");
  if (!ml && !ou && !sp) return [];
  return ["", "📈 <b>CLV 收盤線價值</b>（入場價 vs 近開賽價 · 正=買在好價位 → edge 領先指標）", ...(ml ? [ml] : []), ...(ou ? [ou] : []), ...(sp ? [sp] : [])];
}

// 大小球(O/U 2.5)聪明钱偏向(一行): "大戶偏 大球 66%（O/U 2.5）"
const totalsLine = (t) =>
  t && t.side ? `大戶偏 ${t.side === "Over" ? "大球" : "小球"} ${t.pct}%（O/U 2.5）` : null;
// 让球(-1.5)聪明钱偏向(一行): cover=让球方赢2+; not=受让方+1.5
const spreadLine = (s) =>
  s && s.favTeam ? (s.side === "cover" ? `大戶偏 ${tTeam(s.favTeam)} -1.5（贏2+球）${s.pct}%` : `大戶偏 ${tTeam(s.dogTeam)} +1.5（受讓）${s.pct}%`) : null;

// 详细信号行(个人自用版): 💎最大贏家 vs 🐋最大注 是否分歧(胜负盘) + 大小球(含💎赢家方向)。p 缺字段则自动省略对应行
function signalDetailLines(p) {
  const out = [];
  const sideZh = (s) => esc(tTeam(sideLabel(s, p.home, p.away)));
  const w = p.proWinner, b = p.bigBettor;
  // 胜负盘: 最大赢家 vs 最大注
  if (w && w.side) {
    const bPart = b && b.side ? ` · 🐋最大注 押${sideZh(b.side)}（${cUSD(b.usd)}）` : "";
    const tag = b && b.side ? (w.side === b.side ? " · ✓同向" : " · ⚠️分歧") : "";
    out.push(`   💎最大贏家 押${sideZh(w.side)}（+${cUSD(w.pnl)}）${bPart}${tag}`);
  } else if (b && b.side) {
    out.push(`   🐋最大注 押${sideZh(b.side)}（${cUSD(b.usd)}）`);
  }
  // 大小球: 大户偏向 + 💎赢家是否同向
  const tl = totalsLine(p.totals);
  if (tl) {
    const t = p.totals;
    let extra = "";
    if (t.winnerSide) extra = ` · 💎贏家偏${t.winnerSide === "Over" ? "大" : "小"}球${t.winnerSide === t.side ? "✓同向" : "⚠️分歧"}`;
    out.push(`   ⚽ 大小球: ${esc(tl)}${extra}`);
  }
  // 让球: 大户偏向 + 💎赢家是否同向
  const sl = spreadLine(p.spread);
  if (sl) {
    const sp = p.spread;
    let extra = "";
    if (sp.winnerSide) {
      const wZh = sp.winnerSide === "cover" ? `${tTeam(sp.favTeam)}-1.5` : `${tTeam(sp.dogTeam)}+1.5`;
      extra = ` · 💎贏家偏${esc(wZh)}${sp.winnerSide === sp.side ? "✓同向" : "⚠️分歧"}`;
    }
    out.push(`   ⚖️ 讓球: ${esc(sl)}${extra}`);
  }
  return out;
}

// 让球(-1.5)前向战绩: 跟💎盈利大户 / 跟大户 / 强共识 + 让球方/受让方 分段
function spreadStatsLines(res) {
  const os = res.spreadStrategies;
  if (!os) return [];
  const order = [["followWinner", "跟💎盈利大戶"], ["followBig", "跟大戶(資金多數方)"], ["highConsensus", "僅強共識≥75%才跟"]];
  const body = [];
  for (const [key, label] of order) {
    const s = os[key];
    if (!s || !s.bets) continue;
    body.push(`${label}: ${s.bets}場 命中${Math.round((s.wins / s.bets) * 100)}% · ROI ${Math.round((s.profit / s.bets) * 100) >= 0 ? "+" : ""}${Math.round((s.profit / s.bets) * 100)}%`);
  }
  if (!body.length) return [];
  const seg = (sd) => {
    const a = (res.spreadSettled || []).filter((x) => x.side === sd && x.win != null);
    if (!a.length) return null;
    const w = a.filter((x) => x.win).length;
    const priced = a.filter((x) => x.price > 0 && x.price < 1);
    const roi = priced.length ? Math.round((priced.reduce((s, x) => s + (x.win ? (1 - x.price) / x.price : -1), 0) / priced.length) * 100) : null;
    return `   ${sd === "cover" ? "讓球方(-1.5)" : "受讓方(+1.5)"}: ${a.length}場 命中${Math.round((w / a.length) * 100)}%${roi != null ? ` · ROI ${roi >= 0 ? "+" : ""}${roi}%` : ""}`;
  };
  const segs = [seg("cover"), seg("not")].filter(Boolean);
  return ["", "⚖️ <b>讓球戰績</b>（-1.5 · 前向測試）", ...body, ...(segs.length ? ["   ── 分段 ──", ...segs] : [])];
}

// 每日固定: 今日巨鲸预判
function fmtDailyPreview(matches, res) {
  const sub = LABEL === "World Cup" ? "今日世界盃 · 開賽時間 HKT" : "當前焦點";
  const lines = ["☀️ <b>今日賽前預判</b>", `（${sub}）`, ""];
  for (const m of matches) {
    const p = res.predictions[m.id];
    if (!p) continue;
    const cons = Math.round((p.consensusPct || 0) * 100);
    const pick = tTeam(sideLabel(p.whaleSide, p.home, p.away));
    const ko = koHKT(p.kickoffMs);
    lines.push(`${p.home ? "🆚" : "🔥"} ${esc(translateTitle(p.match))}${ko ? ` · ⏰ ${ko}` : ""}`);
    lines.push(`   ⭐ 看好 <b>${esc(pick)}</b>（信心 ${cons}%）`);
    for (const l of signalDetailLines(p)) lines.push(l);
  }
  lines.push("", "⚠️ 數據分析 · 非投注建議");
  const best = bestStrategy(res);
  if (best) lines.push("", `📊 本屆預判戰績: ${best.bets}場 · ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%（詳見置頂戰績）`);
  lines.push(`🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`);
  return lines.join("\n");
}

// 置顶用: 即将开赛预判(只列未开赛场次, 就地编辑、持续刷新; 复用每日预判的逐场渲染)
function fmtUpcomingPin(matches, res) {
  const show = (matches || []).slice(0, 6); // 最多6场, 保持可扫读
  const sportsLike = show.some((m) => res.predictions[m.id]?.home); // 体育有主客; 加密无
  const lines = sportsLike
    ? ["📅 <b>即將開賽 · 賽前預判</b>（持續更新）", "（💎贏家vs🐋最大注 · 大小球 · 讓球 · 開賽 HKT）", ""]
    : ["📅 <b>待結算 · 賽前預判</b>（持續更新）", "（活躍市場 · 預判方向）", ""];
  if (!show.length) {
    lines.push("⏳ 暫無可顯示的場次,稍後自動更新");
  } else {
    for (const m of show) {
      const p = res.predictions[m.id];
      if (!p) continue;
      const cons = Math.round((p.consensusPct || 0) * 100);
      const pick = tTeam(sideLabel(p.whaleSide, p.home, p.away)); // 中文队名/平局/是否
      const ko = koHKT(p.kickoffMs);
      lines.push(`${p.home ? "🆚" : "🔥"} ${esc(translateTitle(p.match))}${ko ? ` · ⏰ ${ko}` : ""}`);
      lines.push(`   ⭐ 看好 <b>${esc(pick)}</b>（信心 ${cons}%）`);
      for (const l of signalDetailLines(p)) lines.push(l);
    }
    lines.push("", "⚠️ 數據分析 · 非投注建議");
  }
  const best = bestStrategy(res);
  if (best) lines.push("", `📊 本屆預判戰績: ${best.bets}場 · ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%（詳見置頂戰績）`);
  lines.push(`🔭 更新 ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT · ${VERSION}`);
  return lines.join("\n");
}

// 置顶③: 最近比赛日的赛果(预判 vs 结果, 就地编辑、持续刷新)。无可显示的赛果时返回 null。
function fmtResultsPin(res) {
  const settled = (res.settled || []).filter((s) => s.home && s.away && s.strat?.followWhale);
  const hkDate = (s) => {
    const ms = s.kickoffMs || (s.settledAt ? Date.parse(s.settledAt) : null);
    return ms ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) : null;
  };
  const withDate = settled.map((s) => ({ s, d: hkDate(s) })).filter((x) => x.d);
  if (!withDate.length) return null;
  const latest = withDate.map((x) => x.d).sort().pop(); // 最近比赛日(HKT)
  const todays = withDate.filter((x) => x.d === latest).map((x) => x.s).slice(-8);
  const hits = todays.filter((s) => s.strat.followWhale.win).length;
  const lines = [
    `🏁 <b>${latest.slice(5).replace("-", "/")} 賽果 · 預判 vs 結果</b>（持續更新）`,
    `（賽前看好 命中 <b>${hits}/${todays.length}</b>）`,
    "",
  ];
  for (const s of todays) {
    const fw = s.strat.followWhale;
    const pick = tTeam(sideLabel(s.whaleSide, s.home, s.away));
    lines.push(`${fw.win ? "✅" : "❌"} ${esc(tTeam(s.home))} ${esc(s.score || "")} ${esc(tTeam(s.away))} · 看好${esc(pick)} ${fw.win ? "✓" : "✗"}`);
  }
  const best = bestStrategy(res);
  if (best) lines.push("", `📊 本屆預判戰績: ${best.bets}場 · ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%（詳見置頂戰績）`);
  lines.push(`🔭 更新 ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT · ${VERSION}`);
  return lines.join("\n");
}

function fmtResultSummary(res, newCount) {
  const lines = ["🏁 <b>賽果總結</b>", "（巨鯨方向 vs 賽果 · 按下注價算 ROI）", ""];
  const n = newCount && newCount > 0 ? newCount : 3; // 只展示本次新结算的赛果, 不再每次重复推旧的
  for (const s of res.settled.slice(-n)) {
    const fw = s.strat?.followWhale, fb = s.strat?.followBig;
    const score = s.score ? ` <b>${s.score}</b>` : "";
    lines.push(`${fw?.win ? "✅" : "❌"} ${esc(s.match)}${score} → ${esc(resultLabel(s))}`);
    lines.push(`   胜负盘: 巨鯨押 ${esc(sideLabel(s.whaleSide, s.home, s.away))} ${fw?.win ? "✅" : "❌"}`);
    if (s.ou) lines.push(`   ⚽ 大小球: 進${s.ou.goals}球→${s.ou.actualOU === "Over" ? "大" : "小"}球 · 大戶偏${s.ou.side === "Over" ? "大" : "小"} ${s.ou.win == null ? "" : s.ou.win ? "✅" : "❌"}${s.ou.winnerSide ? ` · 💎偏${s.ou.winnerSide === "Over" ? "大" : "小"}` : ""}`);
    if (s.spread) lines.push(`   ⚖️ 讓球(-1.5): 大戶偏${s.spread.side === "cover" ? "讓球方" : "受讓方"}(${s.spread.actualSide === "cover" ? "實際讓過" : "沒讓過"}) ${s.spread.win == null ? "" : s.spread.win ? "✅" : "❌"}`);
    lines.push(`   🐋 ${esc(bigLine(s.bigBettor, s.home, s.away, fb?.win))}`);
  }
  // 不再重复列全部策略(含已隐藏的 fade、旧格式) —— 置顶才是详细正本; 这里只给一行头条 + 指向置顶
  const best = bestStrategy(res);
  if (best) lines.push("", `📊 目前最佳策略: ${best.label} ${best.bets}場 · ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%`);
  lines.push("📌 完整策略戰績(逐場明細 · 累計u)見置頂");
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
// 紧凑金额: $8.8M / $462k / $78k (持仓分析用, 更干净不刷数字)
const cUSD = (n) => {
  const x = Number(n) || 0, a = Math.abs(x), s = x < 0 ? "-" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}k`;
  return `${s}$${Math.round(a)}`;
};
// 持仓快照：各市场大额买入的多空分布
// 持仓分析里的"聪明钱内部"块(个人自用·更详细): 💎顶级赢家 vs 🐋最大注 是否分歧。label(outcome)→显示名
function smartMoneyLines(m, label) {
  const w = m.topWinner, b = m.topWhale;
  if (!w && !b) return [];
  // 最大注本身就是顶级赢家 → 合成一行
  if (w && b && w.wallet === b.wallet)
    return [`   💎🐋 最大注即頂級贏家 押${label(w.outcome)}（歷史盈利 ${cUSD(w.allTimePnl)}）`];
  const loseTag = (p) => (p != null && p <= -50000 ? `（⚠️歷史虧損 ${cUSD(Math.abs(p))}）` : p != null && p > 0 ? `（歷史盈利 ${cUSD(p)}）` : "");
  const out = [];
  if (w) out.push(`   💎 頂級贏家 押${label(w.outcome)}（歷史盈利 ${cUSD(w.allTimePnl)}）`);
  if (b) out.push(`   🐋 最大注 押${label(b.outcome)}${loseTag(b.allTimePnl)}`);
  if (w && b) out.push(w.outcome === b.outcome ? "   ✓ 同向（贏家與最大注一致）" : `   ⚠️ 分歧（贏家押${label(w.outcome)} / 最大注押${label(b.outcome)}）`);
  return out;
}

function fmtPositioning(markets, threshold) {
  const top = markets.slice(0, 6); // 纯中文, 可多放几个盘
  const url = (m) => (m.eventSlug ? `https://polymarket.com/event/${m.eventSlug}` : "https://polymarket.com");

  const cn = [
    "📊 <b>巨鯨持倉分析</b>",
    `（大戶資金流向 · 盤口 vs 聰明錢）`,
    "",
  ];
  for (const m of top) {
    const ko = koHKT(m.kickoffMs);
    cn.push(`🔥 <a href="${url(m)}">${esc(translateTitle(m.title))}</a>${ko ? ` · ⏰ ${ko}` : ""}  <i>${cUSD(m.total)} · ${m.wallets}人</i>`);
    if (m.sides) {
      // 体育: 整场三方分布(主胜 / 平 / 客胜)
      const topTeamUsd = Math.max(m.sides.home.usd, m.sides.away.usd);
      const rows = [["home", m.sides.home], ["draw", m.sides.draw], ["away", m.sides.away]]
        .map(([oc, v]) => ({ oc, usd: v.usd, price: v.price }))
        .filter((x) => x.usd > 0)
        .sort((a, b) => b.usd - a.usd);
      for (const x of rows) {
        const pct = m.total ? Math.round((x.usd / m.total) * 100) : 0;
        const icon = x.oc === "draw" ? "⚪" : x.usd === topTeamUsd ? "🟩" : "🟥";
        const odds = x.price != null ? `（盤口 ${Math.round(x.price * 100)}¢）` : "";
        cn.push(`   ${icon} ${esc(outLabel(x.oc, m.home, m.away))} <b>${pct}%</b>${odds}`);
      }
      for (const l of smartMoneyLines(m, (oc) => esc(outLabel(oc, m.home, m.away)))) cn.push(l);
      cn.push("");
      continue;
    }
    // 加密: 二元市场 Yes/No（只留 是/否 + 占比 + 盘口, 去掉地址/金额/人数）
    const ocLabel = (o) => ocZh(o) || esc(String(o));
    m.breakdown.slice(0, 2).forEach((b, i) => {
      let odds = "";
      if (m.price != null) {
        const p = /yes/i.test(b.outcome) ? m.price : /no/i.test(b.outcome) ? 1 - m.price : null;
        if (p != null) odds = `（盤口 ${Math.round(p * 100)}¢）`;
      }
      cn.push(`   ${i === 0 ? "🟩" : "🔻"} ${ocLabel(b.outcome)} <b>${b.pct}%</b>${odds}`);
    });
    for (const l of smartMoneyLines(m, (o) => ocLabel(o))) cn.push(l);
    cn.push("");
  }
  cn.push(`🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`);
  return cn.join("\n");
}

// 「今日聪明钱 · 全体育」: 世界杯以外(MLB/网球…)每场胜负盘的💎赢家 vs 🐋最大注(2-outcome 版)
const SPORT_EMOJI = { mlb: "⚾", tennis: "🎾", nba: "🏀", basketball: "🏀", nhl: "🏒", nfl: "🏈" };
// 某策略前向战绩判定: ROI + CLV + 样本闸门 → ✅可跟 / 🟡勉强 / ❌别跟 / ⏳样本不足
function msVerdict(s) {
  if (!s || !s.bets) return null;
  const n = s.bets, MIN = Number(process.env.SHARP_MIN_N || 15);
  const roi = Math.round((s.profit / n) * 100);
  const clv = s.clvN ? +((s.clvSum / s.clvN) * 100).toFixed(1) : null;
  const emo = n < MIN ? "⏳" : roi > 0 && clv != null && clv > 0 ? "✅" : roi > 0 ? "🟡" : "❌";
  const label = emo + (n < MIN ? "樣本不足" : emo === "✅" ? "可跟" : emo === "🟡" ? "勉強" : "別跟");
  return { n, roi, clv, emo, label };
}
// 内联小标签: " · 跟大戶歷史-8%❌"
function msInline(stats, kind, key) {
  const v = msVerdict(stats && stats[kind] && stats[kind][key]);
  if (!v) return "";
  return ` · ${key === "followWinner" ? "跟💎" : "跟大戶"}歷史${v.roi >= 0 ? "+" : ""}${v.roi}%${v.emo}`;
}
function fmtMultiSport(games, stats) {
  if (!games || !games.length) return null;
  const url = (g) => (g.eventSlug ? `https://polymarket.com/event/${g.eventSlug}` : "https://polymarket.com");
  const cn = ["🎯 <b>近期聰明錢 · 全體育</b>", "（世界盃以外 · 💎贏家在押誰 + 每條信號帶「歷史ROI+標籤」）", ""];
  for (const g of games) {
    const emo = SPORT_EMOJI[g.sport] || "🏟";
    const ko = koHKT(g.kickoffMs);
    cn.push(`${emo} <a href="${url(g)}">${esc(g.title)}</a>${ko ? ` · ⏰ ${ko}` : ""}  <i>${cUSD(g.total)} · ${g.wallets}人</i>`);
    const rows = g.outcomes.map((o, i) => ({ o, usd: g.sideUsd[i], price: g.prices[i] })).sort((a, b) => b.usd - a.usd);
    const topUsd = rows[0].usd;
    for (const x of rows) {
      const pct = g.total ? Math.round((x.usd / g.total) * 100) : 0;
      const odds = x.price != null ? `（盤口 ${Math.round(x.price * 100)}¢）` : "";
      cn.push(`   ${x.usd === topUsd ? "🟩" : "🟥"} ${esc(x.o)} <b>${pct}%</b>${odds}`);
    }
    for (const l of smartMoneyLines(g, (o) => esc(o))) cn.push(l);
    if (stats && (stats.ml?.followBig || stats.ml?.followWinner)) {
      const vb = msVerdict(stats.ml.followBig), vw = msVerdict(stats.ml.followWinner), p = [];
      if (vb) p.push(`跟大戶${vb.roi >= 0 ? "+" : ""}${vb.roi}%${vb.emo}`);
      if (vw) p.push(`跟💎${vw.roi >= 0 ? "+" : ""}${vw.roi}%${vw.emo}`);
      if (p.length) cn.push(`   ↳ 胜负盘歷史: ${p.join(" · ")}`);
    }
    if (g.ou) { const t = g.ou; const ex = t.winnerSide ? ` · 💎贏家偏${t.winnerSide === "Over" ? "大" : "小"}${t.winnerSide === t.side ? "✓" : "⚠️分歧"}` : ""; cn.push(`   ⚽ 大小球: 大戶偏 ${t.side === "Over" ? "大" : "小"} ${t.pct}%（O/U ${esc(t.line)}）${ex}${msInline(stats, "ou", "followBig")}`); }
    if (g.spread) { const s = g.spread; const disp = s.side === "cover" ? `${esc(s.favTeam)} -${esc(s.line)}` : `${esc(s.dogTeam)} +${esc(s.line)}`; const ex = s.winnerSide ? ` · 💎贏家${s.winnerSide === s.side ? "同向✓" : "分歧⚠️"}` : ""; cn.push(`   ⚖️ 讓球: 大戶偏 ${disp} ${s.pct}%${ex}${msInline(stats, "spread", "followBig")}`); }
    cn.push("");
  }
  if (stats) {
    const MIN = Number(process.env.SHARP_MIN_N || 15);
    cn.push(`📊 <b>板塊戰績</b>（跟著下的實測 · 樣本≥${MIN}才算數 · ✅雙正/🟡ROI正CLV不正/❌別跟）`);
    const kl = { ml: "胜负盘", ou: "大小球", spread: "让球" };
    for (const kind of ["ml", "ou", "spread"]) {
      for (const [key, kn] of [["followBig", "跟大戶"], ["followWinner", "跟💎"]]) {
        const v = msVerdict(stats[kind] && stats[kind][key]);
        if (!v) continue;
        cn.push(`   ${kl[kind]} ${kn}: ${v.n}場 ROI ${v.roi >= 0 ? "+" : ""}${v.roi}% · CLV ${v.clv != null ? (v.clv >= 0 ? "+" : "") + v.clv + "pt" : "-"} ${v.label}`);
      }
    }
    cn.push("");
  }
  cn.push("⚠️ 數據分析 · 非投注建議 · 標籤=歷史前向實測,不保證未來");
  cn.push(`🔭 Polaris Research · Polymarket 聰明錢雷達`);
  return cn.join("\n");
}

// 把一笔下注归到某个体育分类(标题/slug 关键词 + MLB 队名兜底)
function sportOf(b) {
  const x = ((b.title || "") + " " + (b.eventSlug || "")).toLowerCase();
  if (/fifwc|world.?cup/.test(x)) return "⚽ 世界盃";
  if (/tennis|wimbledon|\batp\b|\bwta\b|\bitf\b/.test(x)) return "🎾 網球";
  if (/\bmlb\b|baseball|\b(yankees|red sox|dodgers|mets|cubs|braves|astros|rays|phillies|pirates|cardinals|reds|marlins|rockies|brewers|guardians|orioles|padres|giants|mariners|rangers|angels|athletics|twins|royals|tigers|white sox|blue jays|nationals|diamondbacks)\b/.test(x)) return "⚾ 棒球(MLB)";
  if (/\bnba\b|\bwnba\b|basketball/.test(x)) return "🏀 籃球";
  if (/\bnhl\b|hockey/.test(x)) return "🏒 冰球";
  if (/\bnfl\b|super.?bowl/.test(x)) return "🏈 美式足球";
  if (/soccer|\bucl\b|\bepl\b|laliga|serie|bundesliga|premier| liga|copa/.test(x)) return "⚽ 其他足球";
  return "🏟 其他";
}
// 给每笔标质量: 核心方向性(胜负/大小球/让球)=值得看; 散户衍生盘 / 近乎必然收息(高胜率≠盈利)=标警告并排后
function betClass(b) {
  const t = (b.title || "").toLowerCase();
  const nearCertain = b.price != null && b.price >= 0.85; // 买近乎必然的一侧=收息, 高胜率但 edge≈0(输一次抹掉九次赢)
  const retail = /exact|both teams|\bbtts\b|to score|to advance|corner|halftime|1st half|2nd half|first half|player|to retire|completed match|set \d|games o\/u/i.test(t);
  const tags = [];
  if (retail) tags.push("散戶盤");
  if (nearCertain) tags.push("收息·高勝率≠盈利");
  return { tag: tags.length ? ` · ⚠️${tags.join(" · ")}` : "", rank: tags.length ? 1 : 0 };
}
// 赢家最新出手: 名单里盈利大户近期下注; 按体育分类; 核心方向性排前, 散户/收息盘标警告并排后
function fmtWinnerBets(bets) {
  if (!bets || !bets.length) return null;
  const ago = (ts) => { const m = Math.round(Date.now() / 1000 / 60 - ts / 60); return m < 60 ? `${m}分前` : `${Math.round(m / 60)}h前`; };
  const ORDER = ["⚽ 世界盃", "⚾ 棒球(MLB)", "🎾 網球", "🏀 籃球", "🏒 冰球", "🏈 美式足球", "⚽ 其他足球", "🏟 其他"];
  const groups = new Map();
  for (const b of bets) { const s = sportOf(b); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(b); }
  const cn = ["💎 <b>贏家最新出手</b>（盈利大戶近期下注 · 按體育分類）", "（核心=勝負/大小球/讓球排前；⚠️散戶盤·收息=高勝率但≠盈利,別被騙）", ""];
  const perSport = Number(process.env.WINNER_PER_SPORT || 6);
  for (const sport of ORDER) {
    const all0 = groups.get(sport);
    if (!all0 || !all0.length) continue;
    const scored = all0.map((b) => ({ b, c: betClass(b) }));
    const core = scored.filter((x) => x.c.rank === 0).sort((a, z) => z.b.ts - a.b.ts); // 核心方向性
    const flagged = scored.filter((x) => x.c.rank === 1).sort((a, z) => z.b.ts - a.b.ts); // 散户/收息
    const arr = [...core.slice(0, perSport), ...flagged.slice(0, Number(process.env.WINNER_FLAG_SHOW || 2))]; // 核心排前 + 少量带⚠️的仍可见
    cn.push(`━━ <b>${sport}</b>（${all0.length > arr.length ? `顯示${arr.length}/${all0.length}` : all0.length}）━━`);
    for (const { b, c } of arr) {
      const url = b.eventSlug ? `https://polymarket.com/event/${b.eventSlug}` : "https://polymarket.com";
      const ko = koHKT(b.kickoffMs);
      cn.push(`💎 <a href="${url}">${esc(translateTitle(b.title || ""))}</a>${ko ? ` · ⏰ ${ko}` : ""}`);
      const consensus = b.count > 1 ? ` · 💎×${b.count}同押` : "";
      cn.push(`   買 <b>${esc(String(b.outcome))}</b> @${Math.round(b.price * 100)}¢ · ${cUSD(b.maxUsd || b.usd)} · 下注${ago(b.ts)}（最賺贏家 ${cUSD(b.profit)}）${consensus}${c.tag}`);
    }
    cn.push("");
  }
  cn.push("⚠️ 數據分析 · 非投注建議 · 真賺看 ROI/CLV(記分卡),不是勝率");
  cn.push(`🔭 持續更新 · ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT`);
  return cn.join("\n");
}
// 置顶: 赢家最新出手(就地编辑同一条; winnerPinId 持久化在 digest 状态)
async function postOrUpdateWinnerPin(bets, state) {
  const text = fmtWinnerBets(bets);
  if (!text) return;
  if (state.winnerPinId && (await editMsg(state.winnerPinId, text))) return;
  const id = await sendReturn(text);
  if (id) { state.winnerPinId = id; await pinMsg(id); }
}

// 成本感知报价: 每个可下注方向的 能成交价 + 点差 + 滑点 + 流动性闸门(转个人下注/上 Kelly 前看真实成本)
function fmtQuote(qm) {
  const SPREAD_MAX = Number(process.env.SPREAD_MAX_CENTS || 5) / 100; // 点差上限(默认5¢)
  const c = (x) => (x == null ? "?" : `${Math.round(x * 100)}¢`);
  const lines = [`💰 <b>成本感知報價</b> · ${esc(qm.eventSlug)}`, `（目標下注 $${qm.notional} · 買價=你要付的價 · 閘門: 點差>${Math.round(SPREAD_MAX * 100)}¢ 或吃不滿=慎入）`, ""];
  const grp = (title, arr) => {
    if (!arr || !arr.length) return;
    lines.push(`<b>${title}</b>`);
    for (const r of arr) {
      if (r.none) { lines.push(`   ${esc(r.label)}: 無盤口/無流動性 ⚠️`); continue; }
      const bad = (!r.depthOk ? " ⚠️深度不足" : "") + (r.spread > SPREAD_MAX ? " ⚠️點差過大" : "");
      const slip = r.slippage != null ? `${r.slippage >= 0 ? "+" : ""}${Math.round(r.slippage * 100)}¢` : "?";
      lines.push(`   ${esc(r.label)}: 買 ${c(r.bestAsk)}（點差${c(r.spread)}）→ 成交均價 ${c(r.fillPrice)}（滑點${slip}）${bad || " ✅"}`);
    }
    lines.push("");
  };
  grp("胜负盘", qm.moneyline);
  grp("大小球 O/U 2.5", qm.ou);
  grp("让球 -1.5", qm.spread);
  lines.push("🔭 成本已计入才是真 ROI — 点差/滑点吃掉的就是你的 edge");
  return lines.join("\n");
}

// 全体育(MLB/网球…)前向战绩: 按 Polymarket 市场解析结算(非 ESPN, 免队名/球员名匹配), 胜负/大小球/让球 × 跟💎/跟大户
const MS_FILE = path.join(__dirname, "data", "results_multisport.json");
function fmtMultiSportStats(ms) {
  const lbl = { ml: "胜负盘", ou: "大小球", spread: "让球" };
  const out = ["🎯 <b>全體育戰績</b>（世界盃以外 · 按市場解析結算 · 前向）", ""];
  let any = false;
  for (const kind of ["ml", "ou", "spread"]) {
    const S = ms.strategies && ms.strategies[kind];
    if (!S) continue;
    const parts = [];
    for (const [key, name] of [["followWinner", "跟💎贏家"], ["followBig", "跟大戶"]]) {
      const v = msVerdict(S[key]);
      if (!v) continue;
      parts.push(`${name} ${v.n}場 ROI ${v.roi >= 0 ? "+" : ""}${v.roi}% CLV ${v.clv != null ? (v.clv >= 0 ? "+" : "") + v.clv + "pt" : "-"} ${v.label}`);
    }
    if (parts.length) { any = true; out.push(`<b>${lbl[kind]}</b>`, ...parts.map((p) => "  " + p)); }
  }
  if (!any) return null;
  out.push("", `⚠️ 樣本≥${Number(process.env.SHARP_MIN_N || 15)}才算數 · 標籤=前向實測,不保證未來`);
  return out.join("\n");
}
// 捕捉(锁定赛前信号) + 结算(市场解析) 全体育, 返回 {ms, newN, games}
async function trackMultiSport() {
  let ms;
  try { ms = JSON.parse(fs.readFileSync(MS_FILE, "utf8")); } catch { ms = {}; }
  ms.predictions = ms.predictions || {};
  ms.strategies = ms.strategies || {};
  ms.settled = ms.settled || [];
  const sports = (process.env.SHARP_SPORTS || "mlb,tennis").split(",").map((s) => s.trim()).filter(Boolean);
  let games = [];
  try {
    const r = await multiSportSentiment(sports, { topMarkets: Number(process.env.SHARP_TRACK_TOP || 15), windowMs: Number(process.env.SHARP_WINDOW_H || 504) * 3600 * 1000 });
    games = r.games || [];
  } catch (e) { console.error("全体育捕捉出错:", e.message); }
  // 1) 锁定赛前信号(每场每类只锁一次)
  for (const g of games) {
    if (ms.predictions[g.eventSlug]) continue;
    if (!g.kickoffMs || Date.now() >= g.kickoffMs) continue; // 只锁"有开赛时间且未开赛"的真·赛前场, 杜绝锁到已解析/in-play盘造成假 ROI
    const seg = (kind) => {
      if (kind === "ml") return g.mlId == null ? null : { id: g.mlId, outcomes: g.outcomes, prices: g.prices, backedIdx: g.mlBackedIdx, winnerIdx: g.mlWinnerIdx };
      const o = g[kind];
      return o && o.id != null ? { id: o.id, outcomes: o.outcomes, prices: o.prices, backedIdx: o.sideIdx, winnerIdx: o.winnerIdx } : null;
    };
    ms.predictions[g.eventSlug] = { eventSlug: g.eventSlug, title: g.title, sport: g.sport, kickoffMs: g.kickoffMs, capturedAt: new Date().toISOString(), ml: seg("ml"), ou: seg("ou"), spread: seg("spread") };
  }
  // 2) 临近开赛用真实盘口价刷新收盘价(CLV) + 结算已解析的市场
  let newN = 0;
  const REFRESH_MS = 3 * 3600 * 1000;
  for (const slug in ms.predictions) {
    const p = ms.predictions[slug];
    for (const kind of ["ml", "ou", "spread"]) {
      const s = p[kind];
      if (!s || s.settled || s.id == null) continue;
      if (!(p.kickoffMs && Date.now() >= p.kickoffMs - REFRESH_MS)) continue; // 临近开赛才刷/结算, 省 API
      const mk = await getMarketNow(s.id).catch(() => null);
      if (!mk) continue;
      if (mk.price && s.outcomes) s.last = s.outcomes.map((o) => mk.price[o]); // 最后观测价 ≈ 收盘价(CLV 用)
      if (!mk.closed || !mk.winner) continue; // 还没解析
      const evalOne = (idx) => {
        if (idx == null || !s.outcomes || !s.prices) return null;
        const price = Number(s.prices[idx]);
        if (!(price > 0 && price < 1)) return null;
        const win = s.outcomes[idx] === mk.winner;
        const lastP = s.last ? Number(s.last[idx]) : null;
        const clv = lastP > 0 && lastP < 1 ? +(lastP - price).toFixed(4) : null; // 近开赛价 − 入场价
        return { win, profit: win ? (1 - price) / price : -1, clv };
      };
      const strat = { followBig: evalOne(s.backedIdx), followWinner: evalOne(s.winnerIdx) };
      const S = (ms.strategies[kind] = ms.strategies[kind] || {});
      for (const key in strat) {
        const r = strat[key]; if (!r) continue;
        const st = (S[key] = S[key] || { bets: 0, wins: 0, profit: 0, clvSum: 0, clvN: 0 });
        st.bets++; if (r.win) st.wins++; st.profit += r.profit;
        if (r.clv != null) { st.clvSum = (st.clvSum || 0) + r.clv; st.clvN = (st.clvN || 0) + 1; }
      }
      s.settled = true;
      ms.settled.push({ eventSlug: slug, sport: p.sport, kind, winner: mk.winner, backed: s.outcomes[s.backedIdx], bigWin: strat.followBig ? strat.followBig.win : null, settledAt: new Date().toISOString() });
      newN++;
    }
  }
  try { fs.mkdirSync(path.dirname(MS_FILE), { recursive: true }); fs.writeFileSync(MS_FILE, JSON.stringify(ms, null, 2)); } catch {}
  return { ms, newN, games };
}

// ==== 每钱包前向记分卡: 找出"跟哪几个地址真能赚"(跟随者视角, 按能成交价算 ROI + CLV) ====
const SC_FILE = path.join(__dirname, "data", "wallet_scorecard.json");
function loadScorecard() { try { return JSON.parse(fs.readFileSync(SC_FILE, "utf8")); } catch { return { wallets: {} }; } }
// 稳定 watchlist: 记分卡里已跟踪过的地址(持续跟踪, 不因掉出活跃榜而断更)
function trackedWalletsFromScorecard() { const sc = loadScorecard(); return Object.entries(sc.wallets || {}).map(([wallet, W]) => ({ wallet, name: W.name, pnl: W.pnl })); }
function saveScorecard(sc) { try { fs.mkdirSync(path.dirname(SC_FILE), { recursive: true }); fs.writeFileSync(SC_FILE, JSON.stringify(sc, null, 2)); } catch {} }
// 锁定赢家赛前出手(按跟随者当前能成交价) → 每轮刷新近开赛价(CLV 用) → 赛后按市场解析结算
async function trackScorecard(raw) {
  const sc = loadScorecard(); sc.wallets = sc.wallets || {};
  const now = Date.now();
  let touched = 0;
  // 1) 捕捉 / 刷新最新价(只锁真赛前, 杜绝 look-ahead)
  for (const b of raw || []) {
    if (!b.wallet || !b.cid || b.gammaId == null) continue;
    const p = Number(b.mktPrice);
    if (!(p > 0.02 && p < 0.98)) continue;
    if (!(b.kickoffMs && now < b.kickoffMs)) continue;
    const W = (sc.wallets[b.wallet] = sc.wallets[b.wallet] || { name: b.name, pnl: b.profit, bets: {} });
    W.name = b.name || W.name; W.pnl = b.profit || W.pnl;
    const key = b.cid + "|" + b.outcome;
    if (!W.bets[key]) { W.bets[key] = { eventSlug: b.eventSlug, gammaId: b.gammaId, outcome: b.outcome, entry: p, entryTs: Math.round(now / 1000), kickoffMs: b.kickoffMs, last: p, settled: false }; touched++; }
    else if (!W.bets[key].settled) W.bets[key].last = p; // 最后观测价 ≈ 收盘价, 用来算 CLV
  }
  // 2) 临近开赛刷新收盘价(修 CLV) + 结算 —— 一次 getMarketNow 兼做两件事
  const REFRESH_MS = 3 * 3600 * 1000; // 开赛前3小时内的未结算注, 每轮用真实盘口价刷新 last(≈收盘价)
  for (const wallet in sc.wallets) {
    for (const key in sc.wallets[wallet].bets) {
      const bt = sc.wallets[wallet].bets[key];
      if (bt.settled || bt.gammaId == null) continue;
      const nearKick = bt.kickoffMs && now >= bt.kickoffMs - REFRESH_MS; // 临近开赛或已开赛
      if (!nearKick) continue; // 太早不动(省 API), 等临近再刷/结算
      const mk = await getMarketNow(bt.gammaId).catch(() => null);
      if (!mk) continue;
      const p = mk.price[bt.outcome];
      if (p > 0 && p < 1) bt.last = p; // 刷新收盘价(最后一次赛前刷新 ≈ 真收盘价)
      if (mk.closed && mk.winner) { // 已解析 → 结算
        bt.win = bt.outcome === mk.winner;
        bt.profit = bt.win ? (1 - bt.entry) / bt.entry : -1; // 按跟随者入场价算
        bt.clv = bt.last != null && bt.entry != null ? +(bt.last - bt.entry).toFixed(4) : null;
        bt.settled = true; touched++;
      }
    }
  }
  saveScorecard(sc);
  return touched;
}
// 每钱包汇总: n结算/命中/ROI/均CLV/未结算, 按 ROI 排序
function scorecardRows(sc) {
  const MIN_N = Number(process.env.SCORECARD_MIN_N || 15); // 样本量闸门: 低于此=噪声
  const rows = [];
  for (const wallet in (sc.wallets || {})) {
    const W = sc.wallets[wallet];
    const bets = Object.values(W.bets || {});
    const done = bets.filter((b) => b.settled);
    const open = bets.length - done.length;
    if (!done.length && !open) continue;
    const n = done.length, wins = done.filter((b) => b.win).length;
    const roi = n ? Math.round((done.reduce((s, b) => s + (b.profit || 0), 0) / n) * 100) : null;
    const cA = done.filter((b) => b.clv != null);
    const clv = cA.length ? +((cA.reduce((s, b) => s + b.clv, 0) / cA.length) * 100).toFixed(1) : null;
    const enough = n >= MIN_N;
    const candidate = enough && roi > 0 && clv != null && clv > 0; // 只有样本够 + ROI+CLV 双正才算候选
    rows.push({ wallet, name: W.name, pnl: W.pnl || 0, n, wins, wr: n ? Math.round((wins / n) * 100) : null, roi, clv, open, enough, candidate });
  }
  const tier = (r) => (r.candidate ? 0 : r.enough ? 1 : 2); // 候选 → 足够样本 → 小样本
  return rows.sort((a, b) => tier(a) - tier(b) || (b.roi ?? -999) - (a.roi ?? -999) || b.n - a.n);
}
// 总览: 跟所有💎信号的合计(所有钱包的已结算注)
function scorecardOverall(sc) {
  let n = 0, wins = 0, profit = 0, cN = 0, cSum = 0;
  for (const wallet in (sc.wallets || {})) {
    for (const b of Object.values(sc.wallets[wallet].bets || {})) {
      if (!b.settled) continue;
      n++; if (b.win) wins++; profit += b.profit || 0;
      if (b.clv != null) { cN++; cSum += b.clv; }
    }
  }
  return { n, wins, roi: n ? Math.round((profit / n) * 100) : null, wr: n ? Math.round((wins / n) * 100) : null, clv: cN ? +((cSum / cN) * 100).toFixed(1) : null };
}
function fmtScorecard(sc) {
  const MIN_N = Number(process.env.SCORECARD_MIN_N || 15);
  const all = scorecardRows(sc);
  const settled = all.filter((r) => r.n >= 1);
  const cn = ["📇 <b>每錢包前向記分卡</b>（跟隨者視角 · 按你能成交的價算）", "（✅候選=樣本夠且 ROI+CLV 雙正才值得跟；小樣本=噪聲別信）", ""];
  if (!settled.length) {
    cn.push(`⏳ 還沒有已結算的跟隨樣本（已鎖定 ${all.reduce((s, r) => s + r.open, 0)} 筆未結算）`);
    cn.push(`🔭 持續更新 · ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT`);
    return cn.join("\n");
  }
  const ov = scorecardOverall(sc);
  cn.push(`📊 <b>總覽（跟所有💎信號）</b>：${ov.n}注 命中${ov.wr}% · ROI ${ov.roi >= 0 ? "+" : ""}${ov.roi}% · 均CLV ${ov.clv != null ? (ov.clv >= 0 ? "+" : "") + ov.clv + "pt" : "-"}`);
  cn.push("（⚠️多為同一批世界盃賽事、樣本未跨不同行情,別當定論）", "");
  const cands = settled.filter((r) => r.candidate);
  if (cands.length) {
    cn.push(`✅ <b>候選可跟</b>（樣本≥${MIN_N} 且 ROI+CLV 雙正）`);
    for (const r of cands.slice(0, 8)) cn.push(`🟢 <code>${esc(r.wallet.slice(0, 6))}…</code>${r.name ? " " + esc(String(r.name).slice(0, 10)) : ""} — ${r.n}場 命中${r.wr}% · ROI +${r.roi}% · CLV +${r.clv}pt${r.open ? ` · 未結算${r.open}` : ""}`);
    cn.push("");
  } else {
    cn.push(`✅ 候選可跟：<b>暫無</b>（還沒地址達到 樣本≥${MIN_N} 且 ROI+CLV 雙正）`, "");
  }
  const others = settled.filter((r) => r.enough && !r.candidate);
  if (others.length) {
    cn.push(`<b>其餘足夠樣本（≥${MIN_N}·未雙正·僅參考）</b>`);
    for (const r of others.slice(0, 6)) cn.push(`${r.roi >= 0 ? "🟡" : "🔴"} <code>${esc(r.wallet.slice(0, 6))}…</code>${r.name ? " " + esc(String(r.name).slice(0, 8)) : ""} — ${r.n}場 ROI ${r.roi >= 0 ? "+" : ""}${r.roi}% CLV ${r.clv != null ? (r.clv >= 0 ? "+" : "") + r.clv + "pt" : "-"}`);
    cn.push("");
  }
  const smallN = settled.filter((r) => !r.enough).length;
  if (smallN) cn.push(`… 另有 ${smallN} 個地址樣本<${MIN_N}（噪聲,已隱藏,別信其 ROI）`);
  cn.push("", "⚠️ 只有 ROI 與 CLV 雙正、且跨不同行情仍成立的地址才值得跟 · 未證明 edge");
  cn.push(`🔭 持續更新 · ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT`);
  return cn.join("\n");
}
async function postOrUpdateScorecardPin(sc, state) {
  const text = fmtScorecard(sc);
  if (!text) return;
  if (state.scorecardPinId && (await editMsg(state.scorecardPinId, text))) return;
  const id = await sendReturn(text);
  if (id) { state.scorecardPinId = id; await pinMsg(id); }
}

// ==== 钱包深度画像: 按入场价拆"押热门/五五盘/押冷门"分桶 ROI+CLV → 分辨顺风车 vs 真本事 ====
// 一组注的汇总(只算已结算): n/命中/ROI(按入场价)/均CLV
function statsOf(bets) {
  const done = (bets || []).filter((b) => b.settled);
  const n = done.length, wins = done.filter((b) => b.win).length;
  const profit = done.reduce((s, b) => s + (b.profit || 0), 0);
  const cA = done.filter((b) => b.clv != null);
  const clv = cA.length ? +((cA.reduce((s, b) => s + b.clv, 0) / cA.length) * 100).toFixed(1) : null;
  return { n, wins, wr: n ? Math.round((wins / n) * 100) : null, roi: n ? Math.round((profit / n) * 100) : null, clv };
}
// 盘口画像分类(从 outcome + eventSlug 轻量推断)
function betKind(b) {
  const o = String(b.outcome || "").toLowerCase(), s = (String(b.eventSlug || "") + " " + String(b.title || "")).toLowerCase();
  // 衍生/散户盘先判(角球/黄牌/半场/球员等即使是 Over/Under 也算衍生, 不是核心进球大小球)
  if (/halftime|exact|btts|both-teams|advance|to-score|clean-sheet|corner|card|player|winning-margin|first-|anytime|set-|handicap-game/.test(s)) return "衍生/散戶";
  if (o === "over" || o === "under") return "大小球";
  if (o === "yes" || o === "no") return "是非盤";
  return "勝負/讓球";
}
// 按 地址前缀 / 名字 找钱包
function findWallet(sc, q) {
  q = String(q || "").toLowerCase().trim();
  if (!q) return null;
  const ws = sc.wallets || {};
  for (const w in ws) if (w.toLowerCase() === q) return w;
  for (const w in ws) if (w.toLowerCase().startsWith(q)) return w;
  for (const w in ws) if (String(ws[w].name || "").toLowerCase().includes(q)) return w;
  return null;
}
// 单钱包画像: 分桶 + 盘口 + 近期 + 判定(顺风车 vs 真本事)
function walletProfile(sc, query) {
  const wallet = findWallet(sc, query);
  if (!wallet) return null;
  const W = sc.wallets[wallet];
  const bets = Object.values(W.bets || {});
  const settled = bets.filter((b) => b.settled);
  const open = bets.length - settled.length;
  const MIN = Number(process.env.SHARP_MIN_N || 15);
  // 按"押的那一侧的入场价"分桶: 热门≥55¢ / 五五盘 / 冷门≤45¢
  const fav = settled.filter((b) => b.entry >= 0.55);
  const even = settled.filter((b) => b.entry > 0.45 && b.entry < 0.55);
  const dog = settled.filter((b) => b.entry <= 0.45);
  const nonFav = [...even, ...dog];
  // 盘口画像
  const types = {};
  for (const b of settled) { const k = betKind(b); (types[k] = types[k] || []).push(b); }
  const byType = Object.entries(types).map(([k, arr]) => ({ k, ...statsOf(arr) })).sort((a, b) => b.n - a.n);
  // 强项: 该地址真正擅长的盘口类型(样本够 + ROI+CLV 双正; 排除衍生/散户)。得分=ROI+CLV, 按得分排
  const S_MIN = Number(process.env.STRENGTH_MIN_N || 6);
  const strengths = byType
    .filter((t) => t.k !== "衍生/散戶" && t.n >= S_MIN && t.roi > 0 && t.clv != null && t.clv > 0)
    .map((t) => ({ ...t, score: t.roi + t.clv, tentative: t.n < MIN }))
    .sort((a, b) => b.score - a.score);
  const strengthKinds = new Set(strengths.map((s) => s.k));
  // 近期滑坡: 最近8场(按下注时间)
  const recentBets = [...settled].sort((a, b) => (b.entryTs || 0) - (a.entryTs || 0)).slice(0, 8);
  const all = statsOf(settled), sFav = statsOf(fav), sEven = statsOf(even), sDog = statsOf(dog), sNon = statsOf(nonFav), recent = statsOf(recentBets);
  // 判定: 赚从哪来? 只在押热门时赚=顺风车; 非热门也赚且CLV正=真本事
  let vemo, verdict;
  if (all.n < MIN) { vemo = "⏳"; verdict = `樣本不足（僅 ${all.n} 場，< ${MIN}），先別下結論`; }
  else if (all.roi == null || all.roi <= 0) { vemo = "❌"; verdict = "整體 ROI 為負 → 別跟"; }
  else if (sNon.n >= 5 && sNon.roi > 0 && sNon.clv != null && sNon.clv > 0) { vemo = "✅"; verdict = "冷門/五五盤也賺、CLV 正 → 更像真本事（抗爆冷）"; }
  else if (sFav.roi > 0 && (sNon.n < 5 || sNon.roi == null || sNon.roi <= 0)) { vemo = "🟡"; verdict = "賺幾乎只來自押熱門 → 順風車嫌疑，爆冷恐跳水"; }
  else { vemo = "🟡"; verdict = "混合、CLV 未穩定正 → 繼續觀察"; }
  return { wallet, name: W.name || "", pnl: W.pnl || 0, open, all, fav: sFav, even: sEven, dog: sDog, nonFav: sNon, recent, byType, strengths, strengthKinds, vemo, verdict, MIN };
}
function fmtProfileText(p) {
  const R = (s) => (s.n ? `${String(s.n).padStart(2)}場 命中${String(s.wr).padStart(3)}% ROI ${(s.roi >= 0 ? "+" : "") + s.roi}% CLV ${s.clv != null ? (s.clv >= 0 ? "+" : "") + s.clv + "pt" : "-"}` : "無");
  const L = [];
  L.push(`📇 深度畫像  ${p.wallet.slice(0, 10)}…  ${p.name}   (全期盈虧 $${Math.round(p.pnl).toLocaleString()})`);
  L.push(`總計: ${R(p.all)}   ·   未結算 ${p.open}`);
  L.push(`\n— 賺從哪來?(按入場價分桶,分辨順風車 vs 真本事) —`);
  L.push(`  押熱門 ≥55¢ : ${R(p.fav)}`);
  L.push(`  五五盤 45–55: ${R(p.even)}`);
  L.push(`  押冷門 ≤45¢ : ${R(p.dog)}`);
  L.push(`  ↳ 非熱門合計: ${R(p.nonFav)}   ← 這塊也 +ROI 且 CLV 正 才是真本事`);
  L.push(`\n— 盤口畫像 —`);
  for (const t of p.byType) L.push(`  ${t.k.padEnd(6)}: ${R(t)}`);
  L.push(`\n— 近期滑坡(最近${p.recent.n}場) —`);
  L.push(`  ${R(p.recent)}`);
  L.push(`\n🏅 擅長盤口: ${p.strengths.length ? p.strengths.map((s) => `${s.k} ${s.roi >= 0 ? "+" : ""}${s.roi}%/CLV${s.clv >= 0 ? "+" : ""}${s.clv}(${s.n}場${s.tentative ? "·樣本偏少" : ""})`).join(" · ") : "暫無達標的擅長盤(樣本不足或未雙正)"}`);
  L.push(`${p.vemo} 判定: ${p.verdict}`);
  return L.join("\n");
}

// ==== 值得跟进地址的"近期出手明细": 什么项目 / 方向 / 成本价¢ / 成本$ / 现价 / 状态 ====
const DETAIL_FILE = path.join(__dirname, "data", "wallet_detail.json");
function loadDetail() { try { return JSON.parse(fs.readFileSync(DETAIL_FILE, "utf8")); } catch { return { ts: 0, wallets: {} }; } }
async function refreshWalletDetail(wallets) {
  const cache = loadDetail(); cache.wallets = cache.wallets || {};
  for (const w of wallets || []) {
    try { const { bets } = await walletActivity(w); cache.wallets[String(w).toLowerCase()] = { ts: Math.round(Date.now() / 1000), bets }; } catch {}
  }
  cache.ts = Math.round(Date.now() / 1000);
  try { fs.mkdirSync(path.dirname(DETAIL_FILE), { recursive: true }); fs.writeFileSync(DETAIL_FILE, JSON.stringify(cache, null, 2)); } catch {}
  return cache;
}
const betStatusZh = (b) => (b.status === "settled" ? "已結算" : b.status === "live" ? "進行中" : "可跟");
const dHK = (ts) => new Date((ts || 0) * 1000 + 8 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " ");
function fmtDetailText(bets) {
  if (!bets || !bets.length) return "  (近期無達門檻的方向性出手)";
  const L = [];
  for (const b of bets.slice(0, 15)) {
    const now = b.mktPrice != null ? ` → 現價 ${Math.round(b.mktPrice * 100)}¢` : "";
    L.push(`  ${dHK(b.ts)}  ${(b.title || "").slice(0, 46)}`);
    L.push(`      押 ${b.outcome} · 成本 ${Math.round(b.price * 100)}¢(≈$${Math.round(b.usd).toLocaleString()})${now} · ${betStatusZh(b)}`);
  }
  return L.join("\n");
}
function detailRowsHtml(bets, strongKinds) {
  if (!bets || !bets.length) return `<div class="muted" style="margin-top:6px">近期無達門檻的方向性出手</div>`;
  const rows = bets.slice(0, 12).map((b) => {
    const st = betStatusZh(b), stc = b.status === "settled" ? "muted" : b.status === "live" ? "warn2" : "pos";
    const strong = strongKinds && strongKinds.has(betKind(b)); // 属该地址擅长盘 → 高亮
    const title = esc((b.title || "").slice(0, 44));
    const link = b.eventSlug ? `<a href="https://polymarket.com/event/${esc(b.eventSlug)}" target="_blank">${title}</a>` : title;
    return `<tr class="${strong ? "strong" : ""}"><td>${dHK(b.ts)}</td><td>${strong ? "🏅 " : ""}${link}</td><td>${esc(b.outcome)}</td><td>${Math.round(b.price * 100)}¢</td><td>$${Math.round(b.usd).toLocaleString()}</td><td>${b.mktPrice != null ? Math.round(b.mktPrice * 100) + "¢" : "-"}</td><td class="${stc}">${st}</td></tr>`;
  }).join("");
  return `<table class="grid det"><thead><tr><th>時間</th><th>項目</th><th>方向</th><th>成本</th><th>金額</th><th>現價</th><th>狀態</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ==== $1000 Kelly 模拟账户: 回放候选地址已追踪的赛前信号, 分数Kelly仓位, 出胜率/ROI/回撤 ====
// 候选地址的全部已结算注(标注盘口类型 + 是否属该地址擅长盘), 按下注时间排序供复利回放
function candidateBets(sc) {
  const cands = scorecardRows(sc).filter((r) => r.candidate);
  const out = [];
  for (const r of cands) {
    const p = walletProfile(sc, r.wallet);
    const strong = p ? p.strengthKinds : new Set();
    for (const b of Object.values((sc.wallets[r.wallet] || {}).bets || {})) {
      if (!b.settled || !(b.entry > 0 && b.entry < 1)) continue;
      const kind = betKind(b);
      out.push({ wallet: r.wallet, name: r.name, entry: b.entry, last: b.last, win: !!b.win, ts: b.entryTs || 0, kind, inStrength: strong.has(kind) });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
// 一次回放: 起始$1000, 每注按分数Kelly下注, 复利, 记最大回撤
// ⚠️ edge 用【固定保守假设】(假设跟随每注净赚 SIM_EDGE 分), 绝不用该注收盘价/赛果估仓位 → 杜绝 look-ahead
function simulateKelly(bets, opts = {}) {
  const start = opts.bankroll || 1000;
  const kf = opts.kf != null ? opts.kf : 0.25;   // 分数Kelly(¼/½)
  const maxFrac = opts.maxFrac || 0.10;          // 单注上限(占当前本金)
  const flat = opts.flat;                        // 设了=固定比例下注(对照组)
  const edge = opts.edge != null ? opts.edge : Number(process.env.SIM_EDGE || 0.03); // 假设的每注 edge, 保守固定值
  const qCap = opts.qCap || 0.95;
  let B = start, peak = start, maxDD = 0, n = 0, wins = 0;
  for (const b of bets) {
    const p = b.entry;
    if (!(p > 0 && p < 1)) continue;
    let frac;
    if (flat != null) frac = flat;
    else { const q = Math.min(p + edge, qCap); const fStar = (q - p) / (1 - p); frac = Math.max(0, Math.min(maxFrac, kf * fStar)); } // 仓位只用固定假设edge, 与赛果无关
    if (!(frac > 0)) continue;
    n++;
    const stake = frac * B;
    if (b.win) { B += stake * (1 - p) / p; wins++; } else { B -= stake; } // 输赢用真实赛果, 但仓位大小与赛果无关
    peak = Math.max(peak, B);
    maxDD = Math.max(maxDD, peak > 0 ? (peak - B) / peak : 0);
  }
  return { start, final: +B.toFixed(2), roi: Math.round((B / start - 1) * 100), n, wins, winrate: n ? Math.round((wins / n) * 100) : null, maxDD: Math.round(maxDD * 100) };
}
function runSimSet(sc) {
  const all = candidateBets(sc);
  const strong = all.filter((b) => b.inStrength);
  return {
    nAll: all.length, nStrong: strong.length,
    flat: simulateKelly(all, { flat: 0.02 }),
    q4: simulateKelly(all, { kf: 0.25 }),
    q2: simulateKelly(all, { kf: 0.5 }),
    strong4: simulateKelly(strong, { kf: 0.25 }),
  };
}
function fmtSimText(sc) {
  const s = runSimSet(sc);
  const row = (lbl, r) => `  ${lbl.padEnd(22)} $1000→$${String(r.final).padStart(7)}  ROI ${(r.roi >= 0 ? "+" : "") + r.roi}%  下注${r.n}注 胜率${r.winrate}%  最大回撤${r.maxDD}%`;
  return [
    `🎲 $1000 模拟账户（回放候选地址已追踪信号 · 分数Kelly · 复利）`,
    `  候选信号池: ${s.nAll} 注（其中"擅长盘" ${s.nStrong} 注）`,
    row("固定2%(不挑·全下)", s.flat),
    row("¼ Kelly(封顶10%)", s.q4),
    row("½ Kelly(封顶10%)", s.q2),
    row("¼ Kelly·只跟擅长盘", s.strong4),
    `  ⚠️ 这是【样本内回放】——候选地址是"因为赚过才被选中"的,必然偏乐观;叠加世界杯顺风窗口+小样本+复利放大,真实上线会差很多。它的用途是看仓位纪律与回撤,不是收益承诺。`,
  ].join("\n");
}

// ==== 仪表盘: 生成本地 dashboard.html(浏览器双击打开, 把记分卡/画像/板块战绩/台账可视化) ====
const DASH_FILE = path.join(__dirname, "dashboard.html");
const roiCls = (v) => (v == null ? "muted" : v > 0 ? "pos" : v < 0 ? "neg" : "muted");
const roiTxt = (v, suf) => (v == null ? "-" : (v >= 0 ? "+" : "") + v + (suf || ""));
function profileCardHtml(p, detEntry) {
  if (!p) return "";
  const cells = (s) => `<td>${s.n || 0}</td><td>${s.wr != null ? s.wr + "%" : "-"}</td><td class="${roiCls(s.roi)}">${roiTxt(s.roi, "%")}</td><td class="${roiCls(s.clv)}">${s.clv != null ? roiTxt(s.clv, "pt") : "-"}</td>`;
  const cls = p.vemo === "✅" ? "ok" : p.vemo === "🟡" ? "warn" : p.vemo === "❌" ? "bad" : "wait";
  const typeRows = p.byType.map((t) => `<tr><td>${esc(t.k)}</td>${cells(t)}</tr>`).join("");
  const detBets = detEntry && detEntry.bets;
  const detFresh = detEntry && detEntry.ts ? `（明細更新於 ${dHK(detEntry.ts)} HKT）` : "";
  const strHtml = p.strengths.length
    ? p.strengths.map((s) => `<span class="str-pill${s.tentative ? " tent" : ""}">${esc(s.k)} <b>${s.roi >= 0 ? "+" : ""}${s.roi}%</b>/CLV${s.clv >= 0 ? "+" : ""}${s.clv} <span class="muted">${s.n}場${s.tentative ? "·樣本少" : ""}</span></span>`).join("")
    : `<span class="muted">暫無達標的擅長盤</span>`;
  return `<div class="card">
    <div class="pc-head"><span class="badge ${cls}">${p.vemo}</span>
      <b><code>${esc(p.wallet.slice(0, 8))}…</code> ${esc(p.name)}</b>
      <span class="muted">全期盈虧 $${Math.round(p.pnl).toLocaleString()} · 未結算 ${p.open}</span></div>
    <div class="verdict">${esc(p.verdict)}</div>
    <div class="str-row">🏅 擅長盤口：${strHtml}</div>
    <table class="grid"><thead><tr><th>賺從哪來?（按入場價）</th><th>場</th><th>命中</th><th>ROI</th><th>CLV</th></tr></thead><tbody>
      <tr><td>總計</td>${cells(p.all)}</tr>
      <tr class="hi"><td>押熱門 ≥55¢</td>${cells(p.fav)}</tr>
      <tr><td>五五盤 45–55</td>${cells(p.even)}</tr>
      <tr class="hi"><td>押冷門 ≤45¢</td>${cells(p.dog)}</tr>
      <tr><td>↳ 非熱門合計</td>${cells(p.nonFav)}</tr>
      <tr><td>近期 ${p.recent.n} 場</td>${cells(p.recent)}</tr>
    </tbody></table>
    <table class="grid mini"><thead><tr><th>盤口畫像</th><th>場</th><th>命中</th><th>ROI</th><th>CLV</th></tr></thead><tbody>${typeRows}</tbody></table>
    <div class="det-h">🔎 近期出手明細（🏅=他的擅長盤）${detFresh}</div>${detailRowsHtml(detBets, p.strengthKinds)}
  </div>`;
}
function buildDashboard() {
  const sc = loadScorecard();
  const rows = scorecardRows(sc);
  const ov = scorecardOverall(sc);
  const MIN_N = Number(process.env.SCORECARD_MIN_N || 15);
  const cands = rows.filter((r) => r.candidate);
  const others = rows.filter((r) => r.enough && !r.candidate);
  const smallN = rows.filter((r) => r.n >= 1 && !r.enough).length;
  let ms = {}; try { ms = JSON.parse(fs.readFileSync(MS_FILE, "utf8")).strategies || {}; } catch {}
  let led = { bets: [] }; try { led = loadLedger(); } catch {}
  const det = loadDetail();
  const now = hkNow().toISOString().slice(0, 16).replace("T", " ");
  const ovHtml = `<section class="card overview">📊 總覽（跟所有💎信號） · <b class="${roiCls(ov.roi)}">${roiTxt(ov.roi, "%")}</b> ROI
    <div class="muted">${ov.n || 0} 注 · 命中 ${ov.wr != null ? ov.wr + "%" : "-"} · 均CLV ${ov.clv != null ? roiTxt(ov.clv, "pt") : "-"} · ⚠️ 多為同批世界盃、未跨行情</div></section>`;
  const candHtml = cands.length
    ? cands.map((r) => profileCardHtml(walletProfile(sc, r.wallet), (det.wallets || {})[r.wallet.toLowerCase()])).filter(Boolean).join("")
    : `<div class="card muted">暫無地址達到「樣本 ≥ ${MIN_N} 且 ROI+CLV 雙正」。繼續讓雷達跑、攢樣本。</div>`;
  const othRows = others.slice(0, 15).map((r) => `<tr><td><code>${esc(r.wallet.slice(0, 8))}…</code> ${esc((r.name || "").slice(0, 12))}</td><td>${r.n}</td><td>${r.wr}%</td><td class="${roiCls(r.roi)}">${roiTxt(r.roi, "%")}</td><td class="${roiCls(r.clv)}">${r.clv != null ? roiTxt(r.clv, "pt") : "-"}</td></tr>`).join("");
  const othHtml = others.length ? `<table class="grid"><thead><tr><th>地址（≥${MIN_N}·未雙正·僅參考）</th><th>場</th><th>命中</th><th>ROI</th><th>CLV</th></tr></thead><tbody>${othRows}</tbody></table>` : `<div class="muted">（暫無足夠樣本的地址）</div>`;
  const kinds = [["ml", "勝負盤"], ["ou", "大小球"], ["spread", "讓球"]], keys = [["followBig", "跟大戶"], ["followWinner", "跟💎"]];
  let msRows = "";
  for (const [kk, kl] of kinds) for (const [pk, pl] of keys) {
    const v = msVerdict(ms[kk] && ms[kk][pk]); if (!v) continue;
    msRows += `<tr><td>${kl} ${pl}</td><td>${v.n}</td><td class="${roiCls(v.roi)}">${roiTxt(v.roi, "%")}</td><td class="${roiCls(v.clv)}">${v.clv != null ? roiTxt(v.clv, "pt") : "-"}</td><td>${v.label}</td></tr>`;
  }
  const boardHtml = msRows ? `<table class="grid"><thead><tr><th>板塊信號</th><th>場</th><th>ROI</th><th>CLV</th><th>判定</th></tr></thead><tbody>${msRows}</tbody></table>` : `<div class="muted">（還沒有已結算的板塊樣本）</div>`;
  // 🏅 高信心组合: 候选地址×他们擅长盘, 按得分排 → 你真正只该盯的那几条
  const combos = [];
  for (const r of cands) { const pp = walletProfile(sc, r.wallet); for (const st of (pp.strengths || [])) combos.push({ wallet: r.wallet, name: r.name, ...st }); }
  combos.sort((a, b) => b.score - a.score);
  const comboRows = combos.slice(0, 12).map((c) => `<tr class="${c.tentative ? "" : "strong"}"><td><code>${esc(c.wallet.slice(0, 8))}…</code> ${esc((c.name || "").slice(0, 10))}</td><td><b>${esc(c.k)}</b></td><td>${c.n}${c.tentative ? "⚠" : ""}</td><td>${c.wr}%</td><td class="pos">+${c.roi}%</td><td class="pos">+${c.clv}pt</td></tr>`).join("");
  const comboHtml = combos.length ? `<table class="grid"><thead><tr><th>地址</th><th>擅長盤口</th><th>場</th><th>命中</th><th>ROI</th><th>CLV</th></tr></thead><tbody>${comboRows}</tbody></table><div class="meta">⚠=樣本&lt;${Number(process.env.SHARP_MIN_N || 15)}偏少 · 只跟「地址×他擅長的那類盤」,不要笼统跟人</div>` : `<div class="muted">（暫無達標的擅長組合）</div>`;
  // 🎲 $1000 Kelly 模拟
  const sim = runSimSet(sc);
  const simRow = (lbl, r, hi) => `<tr class="${hi ? "strong" : ""}"><td>${lbl}</td><td>$${r.final.toLocaleString()}</td><td class="${roiCls(r.roi)}">${roiTxt(r.roi, "%")}</td><td>${r.n}</td><td>${r.winrate != null ? r.winrate + "%" : "-"}</td><td class="neg">-${r.maxDD}%</td></tr>`;
  const simHtml = sim.nAll ? `<div class="card"><table class="grid"><thead><tr><th>策略（起始 $1000）</th><th>終值</th><th>ROI</th><th>下注</th><th>勝率</th><th>最大回撤</th></tr></thead><tbody>
    ${simRow("固定2%(不挑·全下)", sim.flat)}
    ${simRow("¼ Kelly(封頂10%)", sim.q4)}
    ${simRow("½ Kelly(封頂10%)", sim.q2)}
    ${simRow("¼ Kelly · 只跟擅長盤", sim.strong4, true)}
  </tbody></table><div class="banner" style="margin-top:12px">⚠️ 這是<b>樣本內回放</b>：候選地址是「因為賺過才被選中」的，必然偏樂觀；疊加世界盃順風窗口＋小樣本＋複利放大，真實上線會差很多。用途是看<b>倉位紀律與回撤</b>，不是收益承諾。信號池 ${sim.nAll} 注（擅長盤 ${sim.nStrong} 注）。</div></div>` : `<div class="muted">（候選信號不足，無法模擬）</div>`;
  const lb = (led.bets || []).filter((b) => b.settled);
  const staked = lb.reduce((s, b) => s + (b.stake || 0), 0), lpnl = lb.reduce((s, b) => s + (b.pnl || 0), 0);
  const lroi = staked ? Math.round((lpnl / staked) * 100) : null;
  const ledHtml = (led.bets || []).length
    ? `<div class="card">已結算 ${lb.length} 注 · 未結算 ${led.bets.length - lb.length} · 投入 $${Math.round(staked)} · 盈虧 <b class="${roiCls(lpnl)}">${lpnl >= 0 ? "+" : ""}$${Math.round(lpnl)}</b> · ROI <span class="${roiCls(lroi)}">${lroi != null ? roiTxt(lroi, "%") : "-"}</span></div>`
    : `<div class="muted">（台賬空 · 用 <code>node bot.js --log-bet</code> 記你真實下的注）</div>`;
  const css = ":root{--bg:#0f1420;--card:#161d2e;--line:#26304a;--tx:#e6ebf5;--mut:#8492ad;--pos:#3fd07f;--neg:#ff6b6b;--accent:#5b8def}"
    + "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 -apple-system,'Segoe UI',Roboto,'PingFang HK','Microsoft YaHei',sans-serif}"
    + ".wrap{max-width:920px;margin:0 auto;padding:22px 16px 70px}h1{font-size:22px;margin:0 0 4px}"
    + "h2{font-size:17px;margin:28px 0 10px;border-left:3px solid var(--accent);padding-left:8px}"
    + ".meta{color:var(--mut);font-size:13px;margin-bottom:12px}"
    + ".banner{background:#2a1f12;border:1px solid #5a4520;color:#ffce54;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:14px}"
    + ".card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}"
    + ".overview{font-size:16px}.overview b{font-size:20px}"
    + "table.grid{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px}"
    + "table.grid th,table.grid td{text-align:right;padding:5px 8px;border-bottom:1px solid var(--line)}"
    + "table.grid th:first-child,table.grid td:first-child{text-align:left}"
    + "table.grid th{color:var(--mut);font-weight:600;font-size:12px}table.grid tr.hi td{background:#1b2540}table.mini{margin-top:4px;opacity:.92}"
    + ".pos{color:var(--pos)}.neg{color:var(--neg)}.muted{color:var(--mut)}"
    + ".pc-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:4px}.pc-head .muted{font-size:12px;margin-left:auto}"
    + ".badge{display:inline-block;min-width:26px;text-align:center;border-radius:6px;padding:1px 6px;font-size:15px}"
    + ".badge.ok{background:#123524}.badge.warn{background:#3a2f10}.badge.bad{background:#3a1616}.badge.wait{background:#222b3f}"
    + ".verdict{font-size:14px;color:#cdd6ea;margin:2px 0 6px}code{background:#0c1120;padding:1px 5px;border-radius:4px;font-size:13px}"
    + "a{color:#8fb8ff;text-decoration:none}a:hover{text-decoration:underline}.warn2{color:#ffce54}"
    + ".det-h{font-size:13px;color:var(--mut);margin-top:12px;border-top:1px dashed var(--line);padding-top:8px}"
    + "table.det{font-size:12.5px}table.det td:nth-child(2){max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    + "table.grid tr.strong td{background:#12261b}"
    + ".str-row{font-size:13px;margin:4px 0 2px}.str-pill{display:inline-block;background:#12261b;border:1px solid #1f4a30;border-radius:6px;padding:1px 7px;margin:2px 4px 2px 0;font-size:12.5px}.str-pill.tent{background:#2a2410;border-color:#5a4520}.str-pill b{color:var(--pos)}"
    + ".foot{color:var(--mut);font-size:12px;margin-top:26px;border-top:1px solid var(--line);padding-top:12px}";
  const html = `<!doctype html><html lang="zh-HK"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris 記分卡儀表盤</title><style>${css}</style></head><body><div class="wrap">
    <h1>📇 聰明錢記分卡 · 儀表盤</h1>
    <div class="meta">生成於 ${now} HKT · 資料隨雷達運行更新（重跑「打开仪表盘.bat」刷新）</div>
    <div class="banner">⚠️ 判據：只有 ROI 與 CLV 雙正、<b>非熱門也賺</b>、且跨行情仍成立的地址才值得跟。目前多為世界盃順風窗口，未證明 edge。</div>
    ${ovHtml}
    <h2>🏅 高信心跟單組合（地址 × 他擅長的盤）</h2><div class="card">${comboHtml}</div>
    <h2>🎲 $1000 模擬賬戶（分數 Kelly · 回放候選信號）</h2>${simHtml}
    <h2>✅ 候選可跟（附「賺從哪來」拆解＋近期出手明細）</h2>${candHtml}
    <h2>📋 其餘足夠樣本（參考）</h2>${othHtml}
    <div class="meta">另有 ${smallN} 個地址樣本 < ${MIN_N}（噪聲，已隱藏）</div>
    <h2>🎯 全體育板塊戰績</h2>${boardHtml}
    <h2>📒 我的下注台賬</h2>${ledHtml}
    <div class="foot">Polaris Whale Radar · 跟隨者視角（按你能成交的價算 ROI）· CLV = 近開賽價 − 入場價<br>看穿一個地址：押熱門才賺=順風車；冷門/五五盤也賺且 CLV 穩定正=真本事。</div>
  </div></body></html>`;
  fs.writeFileSync(DASH_FILE, html);
  return { file: DASH_FILE, cands: cands.length, others: others.length, smallN };
}

// ==== DraftKings 差价信号: Polymarket 价 vs 博彩无水位公平价, 买在便宜的一侧=理论+EV + 前向追踪 ====
const DKEDGE_FILE = path.join(__dirname, "data", "dk_edges.json");
function fmtDkEdges(edges) {
  if (!edges || !edges.length) return null;
  const zh = (s, e) => (s === "draw" ? "平局" : s === "home" ? tTeam(e.home) : tTeam(e.away));
  const cn = ["⚖️ <b>差價信號 · Polymarket vs DraftKings 公平價</b>", "（買在 Polymarket 比博彩無水位公平價便宜的一側 = 理論 +EV）", ""];
  for (const e of edges) {
    const ko = koHKT(e.kickoffMs);
    cn.push(`🆚 ${esc(tTeam(e.home))} vs ${esc(tTeam(e.away))}${ko ? ` · ⏰ ${ko}` : ""}`);
    cn.push(`   💰 買 <b>${esc(zh(e.best.side, e))}</b> @${Math.round(e.best.pmPrice * 100)}¢ · DK公平 ${Math.round(e.best.fair * 100)}¢ · 便宜 <b>+${(e.best.gap * 100).toFixed(1)}pt</b>`);
  }
  cn.push("", "⚠️ 頂級盤口通常很有效(差價≈0);差價多出現在冷門/薄盤。未證明 edge");
  cn.push(`🔭 持續更新 · ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT`);
  return cn.join("\n");
}
// 前向追踪: 赛前锁定 value 侧 + PM入场价 → ESPN 结果结算 → ROI(测差价信号到底赚不赚)
function trackDkEdges(wc, edges) {
  let d; try { d = JSON.parse(fs.readFileSync(DKEDGE_FILE, "utf8")); } catch { d = { picks: {}, stat: { bets: 0, wins: 0, profit: 0 } }; }
  d.picks = d.picks || {}; d.stat = d.stat || { bets: 0, wins: 0, profit: 0 };
  const now = Date.now();
  for (const e of edges || []) { if (d.picks[e.id] || !(e.kickoffMs && now < e.kickoffMs)) continue; d.picks[e.id] = { home: e.home, away: e.away, side: e.best.side, entry: e.best.pmPrice, fair: e.best.fair, gap: e.best.gap, kickoffMs: e.kickoffMs, settled: false }; }
  let n = 0;
  for (const id in d.picks) {
    const p = d.picks[id]; if (p.settled) continue;
    const m = (wc || []).find((x) => x.id === id);
    if (!m || !m.completed || !m.actual) continue;
    p.win = m.actual === p.side; p.profit = p.win ? (1 - p.entry) / p.entry : -1; p.settled = true;
    d.stat.bets++; if (p.win) d.stat.wins++; d.stat.profit += p.profit; n++;
  }
  try { fs.mkdirSync(path.dirname(DKEDGE_FILE), { recursive: true }); fs.writeFileSync(DKEDGE_FILE, JSON.stringify(d, null, 2)); } catch {}
  return { d, n };
}

// ==== 个人下注台账: 记录你真实下的每一注 → 赛后自动结算 → 已实现 ROI(上 Kelly 前的第3步) ====
const LEDGER_FILE = path.join(__dirname, "data", "my_ledger.json");
function loadLedger() { try { return JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")); } catch { return { bets: [] }; } }
function saveLedger(l) { try { fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true }); fs.writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2)); } catch {} }
// 结算未结算的注(市场已解析则算输赢)
async function settleLedger(l) {
  let n = 0;
  for (const b of l.bets || []) {
    if (b.settled || b.gammaId == null) continue;
    const mk = await getMarketNow(b.gammaId).catch(() => null);
    if (!mk || !mk.closed || !mk.winner) continue;
    b.win = b.outcome === mk.winner;
    b.pnl = b.win ? b.stake * (1 - b.price) / b.price : -b.stake; // 赢: 赚 stake*(1-price)/price; 输: 亏 stake
    b.settled = true; n++;
  }
  if (n) saveLedger(l);
  return n;
}
function fmtLedgerText(l) {
  const bets = l.bets || [];
  const done = bets.filter((b) => b.settled), open = bets.filter((b) => !b.settled);
  const staked = done.reduce((s, b) => s + b.stake, 0);
  const pnl = done.reduce((s, b) => s + (b.pnl || 0), 0);
  const wins = done.filter((b) => b.win).length;
  const lines = ["📒 我的下注台账", `已结算 ${done.length} 注 · 未结算 ${open.length} 注`];
  if (done.length) lines.push(`总投入 $${Math.round(staked)} · 已实现盈亏 ${pnl >= 0 ? "+" : ""}$${Math.round(pnl)} · ROI ${staked ? (pnl / staked * 100 >= 0 ? "+" : "") + Math.round(pnl / staked * 100) + "%" : "-"} · 胜率 ${done.length ? Math.round(wins / done.length * 100) : 0}%`);
  lines.push("");
  for (const b of open.slice(-12)) lines.push(`  ⏳ ${b.eventSlug} · ${b.outcome} @${Math.round(b.price * 100)}¢ · $${b.stake}`);
  for (const b of done.slice(-12)) lines.push(`  ${b.win ? "✅" : "❌"} ${b.eventSlug} · ${b.outcome} @${Math.round(b.price * 100)}¢ · $${b.stake} → ${b.pnl >= 0 ? "+" : ""}$${Math.round(b.pnl)}`);
  return lines.join("\n");
}
// 置顶: 我的下注台账(HTML版, 就地刷新)。空台账返回 null(不置顶)
function fmtLedger(l) {
  const bets = l.bets || [];
  if (!bets.length) return null;
  const done = bets.filter((b) => b.settled), open = bets.filter((b) => !b.settled);
  const staked = done.reduce((s, b) => s + b.stake, 0);
  const pnl = done.reduce((s, b) => s + (b.pnl || 0), 0);
  const wins = done.filter((b) => b.win).length;
  const cn = ["📒 <b>我的下注台账</b>（你真實下的注 · 已實現盈虧）", ""];
  if (done.length) cn.push(`<b>已結算 ${done.length} 注</b>：投入 $${Math.round(staked)} · 盈虧 <b>${pnl >= 0 ? "+" : ""}$${Math.round(pnl)}</b> · ROI ${staked ? (pnl / staked >= 0 ? "+" : "") + Math.round((pnl / staked) * 100) + "%" : "-"} · 勝率 ${Math.round((wins / done.length) * 100)}%`);
  else cn.push("（暫無已結算 · 用 <code>--log-bet</code> 記你下的注）");
  if (open.length) { cn.push("", `<b>未結算 ${open.length}</b>`); for (const b of open.slice(-8)) cn.push(`  ⏳ ${esc(String(b.outcome))} @${Math.round(b.price * 100)}¢ · $${b.stake}`); }
  if (done.length) { cn.push("", "<b>最近結算</b>"); for (const b of done.slice(-8)) cn.push(`  ${b.win ? "✅" : "❌"} ${esc(String(b.outcome))} @${Math.round(b.price * 100)}¢ $${b.stake} → ${b.pnl >= 0 ? "+" : ""}$${Math.round(b.pnl)}`); }
  cn.push("", `🔭 持續更新 · ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT`);
  return cn.join("\n");
}
async function postOrUpdateLedgerPin(l, state) {
  const text = fmtLedger(l);
  if (!text) return;
  if (state.ledgerPinId && (await editMsg(state.ledgerPinId, text))) return;
  const id = await sendReturn(text);
  if (id) { state.ledgerPinId = id; await pinMsg(id); }
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
  } catch (e) {
    if (/not modified/i.test(e.message || "")) return true; // 内容没变=视为成功, 不重发(否则会多一条重复置顶)
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

// 置顶③已退休(V7.1): "今日赛果"领头是纯命中率(命中X/Y),与"命中率≠盈利"理念冲突, 且与①②重复。
// 这里改为一次性取消旧置顶并清掉 id; 之后 no-op。赛果 ROI 仍在①策略战绩里看。
async function postOrUpdateResultsPin(res) {
  if (res.resultsMsgId) {
    try { await tg("unpinChatMessage", { chat_id: CHANNEL, message_id: res.resultsMsgId }); } catch {}
    delete res.resultsMsgId;
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
    if ((process.env.POSITIONING_ENABLED || "on") !== "off" && now - (d.positioning || 0) >= POSITIONING_MIN * 60000) {
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
    // 全体育聪明钱(世界杯以外: MLB/网球…) —— 仅体育频道, 独立较慢节奏(默认6h), 给"更多可分析的场"
    const SHARP_ON = RESULTS_ON && (process.env.SHARP_ENABLED || "on") !== "off";
    if (SHARP_ON && now - (d.sharps || 0) >= Number(process.env.SHARP_MIN || 360) * 60000) {
      try {
        const { ms, newN, games } = await trackMultiSport(); // 一次扫描搞定: 快照 + 捕捉赛前信号 + 结算已解析市场
        const text = fmtMultiSport((games || []).slice(0, Number(process.env.SHARP_TOP || 8)), ms.strategies);
        if (text) { await send(text); console.log(`  → 已推全体育聪明钱(${games.length}场)`); }
        if (newN > 0) { const st = fmtMultiSportStats(ms); if (st) await send(st); console.log(`  → 全体育新结算 ${newN} 项`); }
        d.sharps = now;
      } catch (e) {
        console.error("全体育聪明钱出错:", e.message);
      }
    }
    // 💎 赢家最新出手(名单里盈利大户近期方向性注) —— 仅体育, 频率较高, tx 去重只推新的; 给"参与更多投注"
    const WB_ON = RESULTS_ON && (process.env.WINNER_BETS_ENABLED || "on") !== "off";
    if (WB_ON && now - (d.winnerBets || 0) >= Number(process.env.WINNER_MIN || 90) * 60000) {
      try {
        const { list, raw } = await winnerRecentBets({ hours: Number(process.env.WINNER_HOURS || 24), trackedWallets: trackedWalletsFromScorecard() });
        if (list.length) { await postOrUpdateWinnerPin(list, d); console.log(`  → 已更新赢家最新出手置顶(${list.length}笔)`); }
        try { const n = await trackScorecard(raw); if (n) console.log(`  → 记分卡: 新捕捉/结算 ${n}`); await postOrUpdateScorecardPin(loadScorecard(), d); } catch (e) { console.error("记分卡出错:", e.message); }
        try { const cds = scorecardRows(loadScorecard()).filter((r) => r.candidate).map((r) => r.wallet); await refreshWalletDetail(cds.slice(0, 10)); buildDashboard(); } catch (e) { console.error("仪表盘生成出错:", e.message); } // 顺带刷新候选出手明细 + 本地 dashboard.html
        try { const l = loadLedger(); if ((l.bets || []).some((b) => !b.settled)) { const sn = await settleLedger(l); if (sn) console.log(`  → 台账新结算 ${sn} 注`); } await postOrUpdateLedgerPin(l, d); } catch (e) { console.error("台账置顶出错:", e.message); }
        d.winnerBets = now;
      } catch (e) {
        console.error("赢家最新出手出错:", e.message);
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
    if (r.ouStrategies) {
      console.log("  ⚽ 大小球(O/U 2.5)前向战绩:");
      for (const l of ouStatsLines(r)) { const t = l.replace(/<[^>]+>/g, "").trim(); if (t) console.log(`     ${t}`); }
      (r.ouSettled || []).slice(-10).forEach((x) => console.log(`     ${x.win ? "✅" : "❌"} ${x.match} 进${x.goals}球→${x.actualOU === "Over" ? "大" : "小"} · 大户偏${x.side === "Over" ? "大" : "小"}${x.winnerSide ? ` · 💎偏${x.winnerSide === "Over" ? "大" : "小"}` : ""}`));
    }
    if (r.spreadStrategies) {
      console.log("  ⚖️ 让球(-1.5)前向战绩:");
      for (const l of spreadStatsLines(r)) { const t = l.replace(/<[^>]+>/g, "").trim(); if (t) console.log(`     ${t}`); }
      (r.spreadSettled || []).slice(-10).forEach((x) => console.log(`     ${x.win ? "✅" : "❌"} ${x.match} ${x.favTeam}${x.favGoals}-${x.dogGoals}→${x.actualSide === "cover" ? "让球方赢2+" : "受让方+1.5"} · 大户偏${x.side === "cover" ? "让球方" : "受让方"}${x.winnerSide ? ` · 💎偏${x.winnerSide === "cover" ? "让球方" : "受让方"}` : ""}`));
    }
    const clvL = clvStatsLines(r);
    if (clvL.length) { console.log("  📈 CLV 收盘线价值(入场价 vs 近开赛价):"); for (const l of clvL) { const t = l.replace(/<[^>]+>/g, "").trim(); if (t && !t.startsWith("📈")) console.log(`     ${t}`); } }
    return;
  }

  if (process.argv.includes("--refresh-pin")) {
    const r = loadResults();
    await postOrUpdateTrackRecord(r);
    saveResults(r);
    console.log(`📌 已刷新置顶战绩 → ${CHANNEL} (msgId ${r.pinnedMsgId})`);
    return;
  }

  if (process.argv.includes("--quote")) {
    const i = process.argv.indexOf("--quote");
    const slug = process.argv[i + 1];
    const notional = Number(process.argv[i + 2]) || 500;
    if (!slug || slug.startsWith("--")) { console.log("用法: node bot.js --quote <eventSlug> [美元额] [--dry]"); return; }
    const qm = await quoteMatch(slug, notional);
    const text = fmtQuote(qm);
    if (process.argv.includes("--dry")) console.log(text.replace(/<[^>]+>/g, ""));
    else { await send(text); console.log(`✅ 已推送报价 → ${CHANNEL}`); }
    return;
  }

  if (process.argv.includes("--winner-bets")) {
    const { list, raw } = await winnerRecentBets({ hours: Number(process.env.WINNER_HOURS || 24), trackedWallets: trackedWalletsFromScorecard() });
    try { await trackScorecard(raw); } catch (e) { console.error("记分卡出错:", e.message); }
    const text = fmtWinnerBets(list);
    if (process.argv.includes("--dry")) console.log(text ? text.replace(/<[^>]+>/g, "") : "(近期无赢家方向性大注; 可调 WINNER_HOURS/WINNER_MIN_BET/WINNER_MIN_PNL)");
    else if (text) { const d = loadDigest(); await postOrUpdateWinnerPin(list, d); saveDigest(d); console.log(`✅ 已更新赢家最新出手置顶(${list.length}笔) → ${CHANNEL} (msgId ${d.winnerPinId})`); }
    else console.log("(近期无符合条件的赢家出手)");
    return;
  }

  if (process.argv.includes("--scorecard")) {
    // 先跑一轮捕捉/结算(用当前赢家出手), 再打印每钱包前向记分卡
    try { const { raw } = await winnerRecentBets({ hours: Number(process.env.WINNER_HOURS || 24), trackedWallets: trackedWalletsFromScorecard() }); await trackScorecard(raw); } catch (e) { console.error("记分卡刷新出错:", e.message); }
    const sc = loadScorecard();
    const MIN_N = Number(process.env.SCORECARD_MIN_N || 15);
    const rows = scorecardRows(sc);
    const ov = scorecardOverall(sc);
    console.log(`每钱包前向记分卡（跟随者视角·按能成交价算·地址${rows.length}·已锁定${rows.reduce((s, r) => s + r.open, 0)}·已结算${rows.reduce((s, r) => s + r.n, 0)}）`);
    if (!rows.length) { console.log("(还没有任何跟随样本; 让它跑几天)"); return; }
    console.log(`📊 总览(跟所有信号): ${ov.n}注 命中${ov.wr}% ROI ${ov.roi >= 0 ? "+" : ""}${ov.roi}% 均CLV ${ov.clv != null ? (ov.clv >= 0 ? "+" : "") + ov.clv + "pt" : "-"}  ⚠️多为同批世界杯、未跨行情`);
    const cands = rows.filter((r) => r.candidate);
    console.log(`\n✅ 候选可跟(样本≥${MIN_N} 且 ROI+CLV 双正): ${cands.length ? "" : "暂无"}`);
    for (const r of cands) console.log(`  🟢 ${r.wallet.slice(0, 8)}… ${(r.name || "").slice(0, 12).padEnd(12)} ${r.n}场 命中${r.wr}% ROI +${r.roi}% CLV +${r.clv}pt 未结算${r.open}`);
    const others = rows.filter((r) => r.enough && !r.candidate);
    if (others.length) { console.log(`\n其余足够样本(≥${MIN_N}·未双正·参考):`); for (const r of others) console.log(`  ${r.roi >= 0 ? "🟡" : "🔴"} ${r.wallet.slice(0, 8)}… ${(r.name || "").slice(0, 12).padEnd(12)} ${r.n}场 ROI ${r.roi >= 0 ? "+" : ""}${r.roi}% CLV ${r.clv != null ? (r.clv >= 0 ? "+" : "") + r.clv + "pt" : "-"}`); }
    const small = rows.filter((r) => r.n >= 1 && !r.enough).length;
    console.log(`\n… 另有 ${small} 个地址样本<${MIN_N}(噪声,别信其ROI)`);
    return;
  }

  if (process.argv.includes("--profile")) {
    // 用法: node bot.js --profile <地址或名字>   (拆"押热门/押冷门"分桶 ROI+CLV → 顺风车 vs 真本事)
    const i = process.argv.indexOf("--profile");
    const q = process.argv.slice(i + 1).filter((x) => !x.startsWith("--")).join(" ");
    if (!q) { console.log("用法: node bot.js --profile <地址或名字>\n例:  node bot.js --profile riverskew   /   node bot.js --profile 0x076daa"); return; }
    try { const { raw } = await winnerRecentBets({ hours: Number(process.env.WINNER_HOURS || 24), trackedWallets: trackedWalletsFromScorecard() }); await trackScorecard(raw); } catch (e) { console.error("刷新出错(用现有数据继续):", e.message); }
    const p = walletProfile(loadScorecard(), q);
    if (!p) { console.log(`找不到匹配 "${q}" 的地址。试试地址前缀(如 0x076daa)或名字(如 riverskew)。先跑 node bot.js --scorecard 看已知地址`); return; }
    console.log(fmtProfileText(p));
    const dh = Number(process.env.DETAIL_HOURS || 336);
    try { const { bets } = await walletActivity(p.wallet, { hours: dh }); console.log(`\n— 近期出手明細（近${Math.round(dh / 24)}天 · 什麼項目 / 方向 / 成本¢($) / 現價 / 狀態）—\n${fmtDetailText(bets)}`); } catch (e) { console.error("拉取明细出错:", e.message); }
    return;
  }

  if (process.argv.includes("--simulate")) {
    // $1000 Kelly 模拟(回放候选地址已追踪信号)
    console.log(fmtSimText(loadScorecard()));
    return;
  }

  if (process.argv.includes("--dashboard")) {
    // 生成本地 dashboard.html(浏览器双击打开)。--refresh 顺带刷新候选地址的近期出手明细
    if (process.argv.includes("--refresh")) {
      try {
        const cds = scorecardRows(loadScorecard()).filter((r) => r.candidate).map((r) => r.wallet);
        console.log(`刷新 ${cds.length} 个候选地址的近期出手明细…`);
        await refreshWalletDetail(cds.slice(0, 10));
      } catch (e) { console.error("明细刷新出错(用缓存生成):", e.message); }
    }
    const r = buildDashboard();
    console.log(`✅ 仪表盘已生成: ${r.file}\n   候选 ${r.cands} · 其余足够样本 ${r.others} · 小样本 ${r.smallN}(隐藏)\n   双击「打开仪表盘.bat」或直接用浏览器打开该文件即可查看`);
    return;
  }

  if (process.argv.includes("--log-bet")) {
    // 用法: node bot.js --log-bet <eventSlug> <outcome...> <price0~1> <stake美元>
    const i = process.argv.indexOf("--log-bet");
    const rest = process.argv.slice(i + 1).filter((x) => x !== "--dry");
    if (rest.length < 4) { console.log("用法: node bot.js --log-bet <eventSlug> <outcome> <price(0~1)> <stake$>\n例:  node bot.js --log-bet fifwc-fra-swe-2026-06-30 France 0.55 100"); return; }
    const stake = Number(rest[rest.length - 1]), price = Number(rest[rest.length - 2]);
    const eventSlug = rest[0], outcomeQ = rest.slice(1, rest.length - 2).join(" ");
    if (!(price > 0 && price < 1) || !(stake > 0)) { console.log("price 要在 0~1 之间, stake 要 >0"); return; }
    const mk = await findBetMarket(eventSlug, outcomeQ).catch(() => null);
    if (!mk) { console.log(`找不到 ${eventSlug} 里名为 "${outcomeQ}" 的下注方向。检查 eventSlug 和 outcome 拼写`); return; }
    const l = loadLedger();
    l.bets.push({ eventSlug, gammaId: mk.gammaId, outcome: mk.outcome, question: mk.question, price, stake, ts: Math.round(Date.now() / 1000), settled: false });
    saveLedger(l);
    console.log(`✅ 已记录: ${eventSlug} · ${mk.outcome} @${Math.round(price * 100)}¢ · $${stake}（市场: ${mk.question}）。共 ${l.bets.length} 注`);
    return;
  }

  if (process.argv.includes("--ledger")) {
    const l = loadLedger();
    const n = await settleLedger(l);
    if (n) console.log(`(本次新结算 ${n} 注)`);
    console.log(fmtLedgerText(l));
    return;
  }

  if (process.argv.includes("--dk")) {
    const [wc, pm] = await Promise.all([getWcResults(), getMatchEvents(20)]);
    const minGap = Number(process.env.DK_MIN_GAP || 0.04);
    const all = await dkEdges(wc, pm, { minGap: 0 }); // 全部对比(看市场有多有效)
    console.log("Polymarket vs DraftKings 无水位公平价(未开赛场 · pm/公平 %):");
    const pct = (x) => (x == null ? "-" : Math.round(x * 100));
    for (const e of all) console.log(`  ${e.home} vs ${e.away}: 主 ${pct(e.pm.home)}/${pct(e.fair.home)} 平 ${pct(e.pm.draw)}/${pct(e.fair.draw)} 客 ${pct(e.pm.away)}/${pct(e.fair.away)} → 最便宜 ${e.best.side} +${(e.best.gap * 100).toFixed(1)}pt`);
    const sig = all.filter((e) => e.best.gap >= minGap);
    const { d } = trackDkEdges(wc, sig);
    console.log(`\n>=${Math.round(minGap * 100)}pt 的可下注信号: ${sig.length} 个`);
    const st = d.stat;
    if (st.bets) console.log(`前向战绩: ${st.bets}场 命中${Math.round(st.wins / st.bets * 100)}% ROI ${Math.round(st.profit / st.bets * 100) >= 0 ? "+" : ""}${Math.round(st.profit / st.bets * 100)}%`);
    else console.log("(还没有已结算的差价信号样本)");
    if (sig.length && !process.argv.includes("--dry")) { await send(fmtDkEdges(sig)); console.log(`✅ 已推 ${sig.length} 条差价信号 → ${CHANNEL}`); }
    return;
  }

  if (process.argv.includes("--repin")) {
    // 取消全部置顶 → 按 底→顶 顺序重排(最后pin的在最上): ①战绩 ②预判 📒台账 ④赢家 ⑤记分卡(顶)
    const res = loadResults(), d = loadDigest();
    const order = [res.pinnedMsgId, res.previewMsgId, d.ledgerPinId, d.winnerPinId, d.scorecardPinId].filter(Boolean);
    if (!order.length) { console.log("暂无已知置顶消息id(先让雷达跑一轮生成置顶, 或先 --winner-bets/--scorecard)"); return; }
    try { await tg("unpinAllChatMessages", { chat_id: CHANNEL }); } catch (e) { console.log("unpinAll:", e.message); }
    for (const id of order) { try { await tg("pinChatMessage", { chat_id: CHANNEL, message_id: id, disable_notification: true }); } catch (e) { console.log("pin", id, e.message); } }
    console.log(`✅ 已重排置顶(⑤记分卡在最上): ${order.join(" → ")}`);
    return;
  }

  if (process.argv.includes("--sharps-results")) {
    const { ms, newN } = await trackMultiSport();
    console.log(`全体育追踪: 已锁定 ${Object.keys(ms.predictions).length} 场 · 已结算 ${ms.settled.length} 项(本次新增 ${newN})`);
    const text = fmtMultiSportStats(ms);
    console.log(text ? text.replace(/<[^>]+>/g, "") : "(还没有已结算的全体育市场; 世界杯以外多为远期赛, 需等其解析)");
    return;
  }

  if (process.argv.includes("--sharps")) {
    // 「今日聪明钱 · 全体育」: 世界杯以外(默认 MLB+网球)每场胜负盘的💎赢家 vs 🐋最大注
    const sports = (process.env.SHARP_SPORTS || "mlb,tennis").split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`扫描全体育聪明钱: ${sports.join(", ")} …`);
    const { games } = await multiSportSentiment(sports, { topMarkets: Number(process.env.SHARP_TOP || 10), windowMs: Number(process.env.SHARP_WINDOW_H || 504) * 3600 * 1000 });
    let msStrat = {}; try { msStrat = (JSON.parse(fs.readFileSync(MS_FILE, "utf8")).strategies) || {}; } catch {}
    const text = fmtMultiSport(games, msStrat);
    if (!text) { console.log("(暂无未开赛的对局盘)"); return; }
    if (process.argv.includes("--dry")) console.log(text.replace(/<[^>]+>/g, ""));
    else { await send(text); console.log(`✅ 已推送 ${games.length} 场 → ${CHANNEL}`); }
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

module.exports = { translateTitle, titleBlock, fmtPositioning, fmtProfiles, fmtResultSummary, evalStrategies, fmtTrackRecord, fmtDailyPreview, fmtUpcomingPin, fmtResultsPin };
