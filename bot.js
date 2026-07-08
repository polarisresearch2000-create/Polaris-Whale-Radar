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
const { scan, scanWatchlist, marketSentiment, analyzeTopTraders, getMatchEvents, getWcResults, matchPrediction, getTotalsSignal, getSpreadSignal, getClosingPrices, multiSportSentiment, winnerRecentBets, walletActivity, marketExecQuote, quoteMatch, cryptoPrediction, getMarketResolution, getMarketNow, findBetMarket, dkEdges, fmtUSD } = require("./radar");

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
const VERSION = "V10.3"; // 版本号(每次迭代升级时更新; 同步 CHANGELOG.md 与启动脚本横幅)
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
const SPORT_EMOJI = { mlb: "⚾", tennis: "🎾", nba: "🏀", basketball: "🏀", nhl: "🏒", nfl: "🏈", esports: "🎮" };
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
  if (/\blol\b|league of legends|counter.?strike|\bcs2\b|\bdota\b|valorant|esports|\bbo[35]\b|\bmsi\b|\bvct\b|\blck\b|\blpl\b|\blec\b/.test(x)) return "🎮 電競";
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
      if (p > 0 && p < 1 && now < bt.kickoffMs) bt.last = p; // 修④: 只在赛前刷新(开赛后价格漂向结果, 会把 CLV 污染成"结果回声")
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
    const candidate = enough && roi > 0; // 盈利第一: 样本够 + ROI>0 即候选(CLV 仅参考列, 不再当准入门槛)
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
  const cn = ["📇 <b>每錢包前向記分卡</b>（跟隨者視角 · 按你能成交的價算）", "（✅候選=樣本夠且樣本外 ROI>0 就值得跟；CLV僅參考;小樣本=噪聲別信）", ""];
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
    cn.push(`✅ <b>候選可跟</b>（樣本≥${MIN_N} 且 ROI>0 · 盈利第一 · CLV僅參考）`);
    for (const r of cands.slice(0, 8)) cn.push(`🟢 <code>${esc(r.wallet.slice(0, 6))}…</code>${r.name ? " " + esc(String(r.name).slice(0, 10)) : ""} — ${r.n}場 命中${r.wr}% · ROI +${r.roi}% · CLV +${r.clv}pt${r.open ? ` · 未結算${r.open}` : ""}`);
    cn.push("");
  } else {
    cn.push(`✅ 候選可跟：<b>暫無</b>（還沒地址達到 樣本≥${MIN_N} 且 ROI>0）`, "");
  }
  const others = settled.filter((r) => r.enough && !r.candidate);
  if (others.length) {
    cn.push(`<b>其餘足夠樣本（≥${MIN_N}·未雙正·僅參考）</b>`);
    for (const r of others.slice(0, 6)) cn.push(`${r.roi >= 0 ? "🟡" : "🔴"} <code>${esc(r.wallet.slice(0, 6))}…</code>${r.name ? " " + esc(String(r.name).slice(0, 8)) : ""} — ${r.n}場 ROI ${r.roi >= 0 ? "+" : ""}${r.roi}% CLV ${r.clv != null ? (r.clv >= 0 ? "+" : "") + r.clv + "pt" : "-"}`);
    cn.push("");
  }
  const smallN = settled.filter((r) => !r.enough).length;
  if (smallN) cn.push(`… 另有 ${smallN} 個地址樣本<${MIN_N}（噪聲,已隱藏,別信其 ROI）`);
  cn.push("", "⚠️ 以樣本外 ROI 為準(盈利第一) · CLV僅樣本不足時防運氣 · 需跨行情仍成立 · 未證明 edge");
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

// ==== 擅长盘·前向验证器 + 实时匹配信号 ====
// 只在"对的人做对的事"(候选在其【已冻结】擅长盘出手)时亮灯 → 按能成交价纸面记账 → 前向 ROI/CLV(样本外)
const STRENGTH_FILE = path.join(__dirname, "data", "strength_track.json");
function loadStrengthTrack() { try { return JSON.parse(fs.readFileSync(STRENGTH_FILE, "utf8")); } catch { return { frozen: {}, signals: {} }; } }
function saveStrengthTrack(t) { try { fs.mkdirSync(path.dirname(STRENGTH_FILE), { recursive: true }); fs.writeFileSync(STRENGTH_FILE, JSON.stringify(t, null, 2)); } catch {} }
async function trackStrengthSignals() {
  const sc = loadScorecard();
  const t = loadStrengthTrack(); t.frozen = t.frozen || {}; t.signals = t.signals || {};
  const now = Date.now(), nowS = Math.round(now / 1000);
  const cands = scorecardRows(sc).filter((r) => r.candidate);
  // 1) 冻结/更新每个候选的擅长盘标签(首次达标即记冻结时间, 之后只前向捕捉)
  const byWallet = {};
  for (const r of cands) {
    const p = walletProfile(sc, r.wallet); if (!p) continue;
    const w = r.wallet.toLowerCase();
    const fz = (t.frozen[w] = t.frozen[w] || {});
    for (const s of p.strengths) { if (!fz[s.k]) fz[s.k] = { since: nowS, roi: s.roi, clv: s.clv, n: s.n }; }
    byWallet[w] = { name: p.name, kinds: new Set(Object.keys(fz)) };
  }
  // 🤖做市预过滤: 按上轮为止的对冲占比判定(单向, 永不回补); 判为做市的地址不再捕新亮灯
  const newMM = applyMMRule(t);
  if (newMM) console.log(`  🤖 做市预过滤: 新判定 ${newMM} 个地址为做市/梯子型(对冲占比≥${Math.round(Number(process.env.MM_HEDGE_RATIO || 0.6) * 100)}%), 永久停跟`);
  for (const w in (t.mm || {})) delete byWallet[w];
  // 2) 每钱包拉一次活动: 既用来捕捉新亮灯(BUY落在擅长盘), 也用来检测赢家离场(SELL同一cid+outcome)
  const fresh = [], exits = [];
  const openByWallet = {}; // 有未结算信号的钱包(即使已掉出候选也要查离场)
  for (const key in t.signals) { const s = t.signals[key]; if (!s.settled) (openByWallet[s.wallet] = openByWallet[s.wallet] || []).push(s); }
  const scanW = new Set([...Object.keys(byWallet), ...Object.keys(openByWallet)]);
  for (const w of scanW) {
    const { bets, sells } = await walletActivity(w, { hours: Number(process.env.STRENGTH_HOURS || 72) }).catch(() => ({ bets: [], sells: [] }));
    // 2a) 捕捉(只对当前候选)
    if (byWallet[w]) {
      const { name, kinds } = byWallet[w];
      for (const b of bets || []) {
        const kind = betKind(b);
        if (!kinds.has(kind)) continue;                      // 非擅长盘 → 忽略(噪声过滤)
        if (t.retired && t.retired[w + "|" + kind]) continue; // 🚫已退役(样本外双负) → 永不再捕
        if (!(b.kickoffMs && now < b.kickoffMs)) continue;   // 只捕赛前(杜绝 look-ahead)
        if (b.gammaId == null || !(b.mktPrice > 0.02 && b.mktPrice < 0.98)) continue;
        const key = (b.cid || b.eventSlug) + "|" + b.outcome + "|" + w;
        if (t.signals[key]) continue;                        // 已捕捉
        const since = (t.frozen[w][kind] || {}).since || nowS;
        // 成交闸门: 亮灯即查订单簿(点差/深度/能成交价)。跟不进的标死并剔出账户; 能跟的按真实成交价入场(成本感知)
        const SPREAD_MAX = Number(process.env.SPREAD_MAX_CENTS || 5);
        const testUsd = Number(process.env.GATE_TEST_USD || 50);
        const g = await marketExecQuote(b.gammaId, b.outcome, testUsd).catch(() => null);
        let gate, entry = b.mktPrice;
        if (g && g.bestAsk != null) {
          const spreadC = +((g.spread || 0) * 100).toFixed(1);
          const fill = g.fillPrice != null ? +g.fillPrice.toFixed(4) : null;
          const fillable = !!(g.depthOk && spreadC <= SPREAD_MAX && fill != null && fill < 0.98);
          gate = { ask: +g.bestAsk.toFixed(4), fill, spreadC, slipC: g.slippage != null ? +(g.slippage * 100).toFixed(1) : null, depthOk: !!g.depthOk, testUsd, fillable };
          if (fillable) entry = fill; // 成本感知: 用你真能成交的价当入场价(通常比盘口中价贵一点)
        } else gate = { fillable: null }; // 查不到盘口 → 不判死, 用中价
        t.signals[key] = { wallet: w, name, kind, title: b.title, eventSlug: b.eventSlug, gammaId: b.gammaId, cid: b.cid, outcome: b.outcome, entry, mid: b.mktPrice, entryTs: nowS, kickoffMs: b.kickoffMs, winUsd: Math.round(b.usd || 0), gate, frozenSince: since, afterFreeze: nowS >= since, last: entry, settled: false };
        fresh.push(t.signals[key]);
      }
    }
    // 2b) 离场检测: 该钱包对未结算信号的 cid+outcome 在 entryTs 之后有没有 SELL
    for (const sg of (openByWallet[w] || [])) {
      if (!sg.cid) continue; // #2 修: 无 cid 不做离场检测(别只按方向松匹配→误判成离场)
      const matched = (sells || []).filter((x) => x.cid === sg.cid && x.outcome === sg.outcome && x.ts >= (sg.entryTs || 0) - 3600);
      if (!matched.length) continue;
      const soldUsd = Math.round(matched.reduce((a, x) => a + (x.usd || 0), 0));
      const lastSell = matched.sort((a, b) => b.ts - a.ts)[0];
      const pct = sg.winUsd ? Math.min(100, Math.round((soldUsd / sg.winUsd) * 100)) : null;
      const wasExited = !!sg.exit;
      sg.exit = { ts: lastSell.ts, price: lastSell.price, usd: soldUsd, pct };
      sg.reduced = pct != null ? pct < 60 : soldUsd < 500; // <60%(或额小)=减仓仍持有; 否则=基本离场
      if (!wasExited) exits.push(sg); // 本轮新检测到的离场 → 亮红灯
    }
  }
  // 3) 每轮刷新未结算信号现价 + 临近开赛刷 last(CLV) + 结算(赛果) 或 跟卖平仓(赢家离场)
  const REFRESH_MS = 3 * 3600 * 1000;
  const VOID_MS = Number(process.env.VOID_HOURS || 48) * 3600 * 1000; // 僵尸清理: 开赛已过48h仍未结算=取消/延期
  let voided = 0;
  for (const key in t.signals) {
    const sg = t.signals[key];
    if (sg.settled || sg.void || sg.gammaId == null) continue;
    if (sg.kickoffMs && now - sg.kickoffMs > VOID_MS) { sg.void = true; sg.voidTs = nowS; voided++; continue; } // 🕳️作废: 剔出账户+停止查询
    const mk = await getMarketNow(sg.gammaId).catch(() => null); if (!mk) continue;
    if (mk.slug) sg.marketSlug = mk.slug; // 具体市场 slug(精确深链, 不再跳到赛事默认盘)
    const pr = mk.price[sg.outcome];
    if (pr > 0 && pr < 1) { sg.nowPrice = pr; sg.nowTs = nowS; if (sg.kickoffMs && now >= sg.kickoffMs - REFRESH_MS && now < sg.kickoffMs) sg.last = pr; } // 修④: last 只在赛前刷(开赛后价格漂向结果, 会把 CLV 污染成"结果回声")
    if (mk.closed && mk.winner) { // 赛果结算优先
      sg.win = sg.outcome === mk.winner; sg.profit = sg.win ? (1 - sg.entry) / sg.entry : -1;
      sg.clv = sg.last != null ? +(sg.last - sg.entry).toFixed(4) : null; sg.settled = true; sg.settledBy = "result";
    } else if (sg.exit && !sg.reduced) { // 赢家基本离场且比赛未结算 → 跟着卖出平仓(按现价, 你能拿到的)
      const exitP = sg.nowPrice != null ? sg.nowPrice : (sg.exit.price != null ? sg.exit.price : sg.entry);
      sg.profit = +((exitP - sg.entry) / sg.entry).toFixed(4); sg.win = exitP > sg.entry;
      sg.exitClose = exitP; sg.clv = sg.last != null ? +(sg.last - sg.entry).toFixed(4) : null; sg.settled = true; sg.settledBy = "exit";
    }
  }
  if (voided) console.log(`  🕳️ 作废清理: ${voided} 注开赛超${Number(process.env.VOID_HOURS || 48)}h未结算(取消/延期), 剔出账户`);
  // 修①: 每轮跑对冲检测(新捕捉可能补全一个对冲对); 亮灯推送里剔掉已成对冲的
  const newHedged = markHedges(t);
  if (newHedged) console.log(`  ⚖️ 对冲对消: 新标记 ${newHedged} 注(同钱包同场同类双向=做市/梯子, 剔出账户)`);
  // 退役规则: 每轮结算后跑一次(只退不进)
  const newRetired = applyRetireRule(t);
  if (newRetired) console.log(`  🚫 退役: ${newRetired} 个 地址×盘类 触发双负闸门(n≥${Number(process.env.RETIRE_MIN_N || 10)}·ROI<0·CLV不为正), 永久停捕`);
  saveStrengthTrack(t);
  return { fresh: fresh.filter((s) => !s.hedged), exits, track: t };
}
// 场级键: 同一场比赛的所有子盘(胜负/让球线/大小球线/平局…)归并到一个键(slug 截到日期)
const gameKeyOf = (s) => { const m = String(s.eventSlug || "").match(/^(.*?\d{4}-\d{2}-\d{2})/); return m ? m[1] : (s.eventSlug || s.title || ""); };
// 修①对冲对消: 同一钱包在 同场×同盘类 押了两个以上不同方向 = 做市/梯子交易, 不是方向信号 → 整组标 hedged 剔出账户
function markHedges(t) {
  const groups = {};
  for (const key in (t.signals || {})) {
    const s = t.signals[key];
    const gk = s.wallet + "|" + gameKeyOf(s) + "|" + s.kind;
    (groups[gk] = groups[gk] || []).push(s);
  }
  let newN = 0;
  for (const gk in groups) {
    const outs = new Set(groups[gk].map((s) => s.outcome));
    if (outs.size >= 2) for (const s of groups[gk]) { if (!s.hedged) { s.hedged = true; newN++; } }
  }
  return newN;
}
// 账户口径: 剔除 跟不进(⛔) 与 对冲对(⚖️) 的信号
const followable = (s) => !(s.gate && s.gate.fillable === false) && !s.hedged && !s.void;
// 🤝跨钱包分歧(方案C): 同场×同盘类, 不同钱包押不同方向 → 【账户层】弃权(动态计算, 不永久定罪);
// 【钱包层】(strengthGroupStats/退役规则)仍保留双方样本 —— 对决照打, 裁判照评分
function xconfKeys(sigs) {
  const g = {};
  for (const s of sigs) { const k = gameKeyOf(s) + "|" + s.kind; (g[k] = g[k] || []).push(s); }
  const bad = new Set();
  for (const k in g) { if (new Set(g[k].map((s) => s.outcome)).size >= 2) for (const s of g[k]) bad.add(s); }
  return bad;
}
// 地址×盘类 的样本外已结算分组统计(退役规则 + 盈亏榜 共用) —— 保留分歧样本(钱包层)
function strengthGroupStats(track) {
  const map = {};
  for (const s of Object.values((track || {}).signals || {})) {
    if (s.afterFreeze === false || !followable(s) || !s.settled) continue;
    const k = s.wallet + "|" + s.kind;
    const g = (map[k] = map[k] || { wallet: s.wallet, name: s.name, kind: s.kind, n: 0, wins: 0, profit: 0, clvSum: 0, clvN: 0 });
    g.n++; if (s.win) g.wins++; g.profit += s.profit || 0;
    if (s.clv != null && s.settledBy !== "exit") { g.clvSum += s.clv; g.clvN++; }
  }
  for (const k in map) { const g = map[k]; g.roi = g.n ? Math.round((g.profit / g.n) * 100) : null; g.clv = g.clvN ? +((g.clvSum / g.clvN) * 100).toFixed(1) : null; }
  return map;
}
// 📊 按运动板块拆分样本外战绩(账户口径:剔对冲/跟不进/作废/分歧) —— 电竞 vs 世界杯 vs 网球... 并排看
function strengthByVertical(track) {
  const all = Object.values((track || {}).signals || {}).filter((s) => s.afterFreeze !== false && followable(s));
  const xc = xconfKeys(all);
  const map = {};
  for (const s of all) {
    if (xc.has(s)) continue;
    const v = sportOf(s);
    const g = (map[v] = map[v] || { vertical: v, n: 0, wins: 0, profit: 0, clvSum: 0, clvN: 0, open: 0 });
    if (s.settled) { g.n++; if (s.win) g.wins++; g.profit += s.profit || 0; if (s.clv != null && s.settledBy !== "exit") { g.clvSum += s.clv; g.clvN++; } }
    else g.open++;
  }
  return Object.values(map).map((g) => ({ vertical: g.vertical, n: g.n, wins: g.wins, open: g.open, winrate: g.n ? Math.round((g.wins / g.n) * 100) : null, roi: g.n ? Math.round((g.profit / g.n) * 100) : null, clv: g.clvN ? +((g.clvSum / g.clvN) * 100).toFixed(1) : null }))
    .sort((a, b) => (b.n + b.open) - (a.n + a.open));
}
// 预承诺退役规则(纪律,非学习): 地址×盘类 样本外 n≥RETIRE_MIN_N 且 ROI<0 且 CLV不为正 → 永久退役
// 只退不进、不按热手回补、阈值不改 —— 事先写死的单向止损闸门
function applyRetireRule(t) {
  const MIN = Number(process.env.RETIRE_MIN_N || 10);
  t.retired = t.retired || {};
  const gs = strengthGroupStats(t);
  let newR = 0;
  for (const k in gs) {
    if (t.retired[k]) continue;
    const g = gs[k];
    if (g.n >= MIN && g.roi < 0) { t.retired[k] = { since: Math.round(Date.now() / 1000), n: g.n, roi: g.roi, clv: g.clv, name: g.name }; newR++; } // 盈利第一: 只看ROI<0退役(不再让CLV正保住亏钱的)
  }
  return newR;
}
// 🤖做市预过滤(预承诺, 单向): 地址被捕捉 ≥MM_MIN_N 注中对冲占比 ≥MM_HEDGE_RATIO → 判为做市/梯子型, 永久不再跟
// 依据: 双向下注者赚的是价差不是观点, 其"方向腿"只是梯子残渣(GoalLineGhost 15注14对冲=93% 即此型)
function applyMMRule(t) {
  const MIN = Number(process.env.MM_MIN_N || 8), RATIO = Number(process.env.MM_HEDGE_RATIO || 0.6);
  t.mm = t.mm || {};
  const byW = {};
  for (const s of Object.values(t.signals || {})) { const e = (byW[s.wallet] = byW[s.wallet] || { n: 0, hedged: 0, name: s.name }); e.n++; if (s.hedged) e.hedged++; }
  let newN = 0;
  for (const w in byW) {
    if (t.mm[w]) continue;
    const e = byW[w];
    if (e.n >= MIN && e.hedged / e.n >= RATIO) { t.mm[w] = { since: Math.round(Date.now() / 1000), n: e.n, hedged: e.hedged, name: e.name }; newN++; }
  }
  return newN;
}
// 前向战绩(只统计冻结后捕捉的信号 = 样本外)
function strengthStats(track) {
  const all = Object.values((track || {}).signals || {}).filter((s) => s.afterFreeze !== false);
  const blocked = all.filter((s) => s.gate && s.gate.fillable === false).length; // 跟不进(点差/深度), 已剔除
  const hedgedN = all.filter((s) => s.hedged).length; // 对冲对(同钱包同场同类双向), 已剔除
  const sigs0 = all.filter(followable);
  const xc = xconfKeys(sigs0); const xconfN = xc.size; // 🤝跨钱包分歧: 组合层弃权(钱包层统计仍保留)
  const sigs = sigs0.filter((s) => !xc.has(s));
  const done = sigs.filter((s) => s.settled), open = sigs.length - done.length;
  const n = done.length, wins = done.filter((s) => s.win).length;
  const roi = n ? Math.round((done.reduce((a, s) => a + (s.profit || 0), 0) / n) * 100) : null;
  const cA = done.filter((s) => s.clv != null && s.settledBy !== "exit"); // #3 修: 跟卖平仓没持有到收盘, 不计入均CLV
  const clv = cA.length ? +((cA.reduce((a, s) => a + s.clv, 0) / cA.length) * 100).toFixed(1) : null;
  let frozenAt = null;
  for (const w in (track.frozen || {})) for (const k in track.frozen[w]) { const s = track.frozen[w][k].since; if (s && (frozenAt == null || s < frozenAt)) frozenAt = s; }
  const exitN = done.filter((s) => s.settledBy === "exit").length; // 因赢家离场而跟卖平仓
  const reducedN = sigs.filter((s) => !s.settled && s.exit).length; // 进行中但赢家已减仓
  return { n, wins, winrate: n ? Math.round((wins / n) * 100) : null, roi, clv, open, total: sigs.length, frozenAt, exitN, reducedN, blocked, hedgedN, xconfN };
}
function sgVerdict(st) {
  // 判据: 盈利第一 —— 以样本外 ROI 为准; CLV 仅在样本不足时当"防运气"参考, 不否决盈利
  const MIN = Number(process.env.STRENGTH_VERDICT_N || 10);
  if (st.roi != null && st.roi > 0) {
    if (st.n >= MIN) return { emo: "✅", label: `樣本外 ROI +${st.roi}%（${st.n}注）→ 在賺,值得跟` };
    if (st.clv != null && st.clv < -5) return { emo: "⚠️", label: `ROI +${st.roi}% 但樣本少(${st.n})且CLV${st.clv} → 恐是運氣,別急著加注` };
    return { emo: "🟡", label: `樣本外 ROI +${st.roi}% 但樣本少(${st.n}<${MIN})→ 初步在賺,繼續攢` };
  }
  if (st.n < MIN) return { emo: "⏳", label: `樣本外僅 ${st.n} 注（<${MIN}），繼續攢` };
  return { emo: "❌", label: `樣本外 ROI ${st.roi}%（${st.n}注）→ 在虧, 別跟` };
}
function fmtStrengthStatsText(track) {
  const st = strengthStats(track), v = sgVerdict(st);
  const L = [`🏅 只跟擅長盤 · 樣本外前向戰績（凍結標籤後才捕捉）`];
  L.push(`  已捕捉 ${st.total} 注（已結算 ${st.n} · 未結算 ${st.open}）· 起算 ${st.frozenAt ? new Date(st.frozenAt * 1000 + 8 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " ") + " HKT" : "-"}`);
  if (st.n) L.push(`  命中 ${st.winrate}% · ROI ${st.roi >= 0 ? "+" : ""}${st.roi}% · 均CLV ${st.clv != null ? (st.clv >= 0 ? "+" : "") + st.clv + "pt" : "-"}  ${v.emo} ${v.label}`);
  else L.push(`  ⏳ 還沒有已結算的樣本外信號（等候選在其擅長盤出手、且賽事結算）`);
  L.push(`  ⚠️ 贏家離場: 已跟賣平倉 ${st.exitN} 注 · 進行中被減倉 ${st.reducedN} 注（贏家中途賣出=信號失效, 跟策略一起退出）`);
  if (st.hedgedN || st.blocked || st.xconfN) L.push(`  剔除: ⚖️對沖對 ${st.hedgedN} 注 · ⛔跟不進 ${st.blocked} 注 · 🤝分歧棄權 ${st.xconfN} 注(候選對賭,錢包層照記)`);
  return L.join("\n");
}
// ⚠️ 赢家离场亮红灯: 检测到候选卖出了他已亮灯的仓位(信号失效, 跟策略应一起退)
function fmtStrengthExitAlert(exits) {
  if (!exits || !exits.length) return null;
  const cn = ["⚠️ <b>贏家離場警報</b>（你在跟的候選, 把已亮燈的倉位賣了）", "（贏家中途賣出=他不信了/獲利了結 → 跟單策略應一起退出, 別死抱）", ""];
  for (const s of exits.slice(0, 8)) {
    const pctTxt = s.exit.pct != null ? `賣約${s.exit.pct}%` : `賣$${(s.exit.usd || 0).toLocaleString()}`;
    const sellP = s.exit.price != null ? ` @${Math.round(s.exit.price * 100)}¢` : "";
    cn.push(`🔴 <code>${esc(s.wallet.slice(0, 8))}…</code>${s.name ? " " + esc(String(s.name).slice(0, 10)) : ""} · <b>${esc(s.kind)}</b> · ${s.reduced ? "減倉" : "基本離場"}`);
    cn.push(`   ${esc((s.title || "").slice(0, 46))}`);
    cn.push(`   原押 ${esc(s.outcome)}@${Math.round(s.entry * 100)}¢ → ${pctTxt}${sellP} · 現價 ${s.nowPrice != null ? Math.round(s.nowPrice * 100) + "¢" : "-"}${s.reduced ? "（仍持部分, 觀察）" : "（紙面賬戶已跟賣平倉）"}`);
  }
  cn.push("", "⚠️ 非投注建議 · 這是「跟不跟得住」的關鍵風險");
  return cn.join("\n");
}
// 亮灯: 新捕捉的擅长盘匹配信号(推 Telegram)
function fmtStrengthAlert(fresh) {
  if (!fresh || !fresh.length) return null;
  const cn = ["🏅 <b>擅長盤亮燈</b>（候選在他擅長的盤出手了）", "（只推「對的人做對的事」· 按你能成交價記入樣本外驗證）", ""];
  for (const s of fresh.slice(0, 8)) {
    const ko = koHKT(s.kickoffMs);
    cn.push(`💎 <code>${esc(s.wallet.slice(0, 8))}…</code>${s.name ? " " + esc(String(s.name).slice(0, 10)) : ""} · <b>${esc(s.kind)}</b>`);
    cn.push(`   ${esc((s.title || "").slice(0, 48))}${ko ? ` · ⏰ ${ko}` : ""}`);
    cn.push(`   押 <b>${esc(s.outcome)}</b> · 現價 ${Math.round(s.entry * 100)}¢${s.eventSlug ? ` · <a href="https://polymarket.com/event/${esc(s.eventSlug)}">下注頁</a>` : ""}`);
  }
  cn.push("", "⚠️ 非投注建議 · 樣本外前向驗證中,未證明 edge");
  return cn.join("\n");
}
async function postOrUpdateStrengthPin(track, state) {
  const st = strengthStats(track), v = sgVerdict(st);
  const open = Object.values(track.signals || {}).filter((s) => s.afterFreeze !== false && !s.settled && followable(s)).sort((a, b) => (a.kickoffMs || 0) - (b.kickoffMs || 0));
  const cn = ["🏅 <b>只跟擅長盤 · 樣本外前向戰績</b>（凍結標籤後才算 · 真·出樣本）", ""];
  if (st.n) cn.push(`📊 已結算 ${st.n} 注：命中 <b>${st.winrate}%</b> · ROI <b>${st.roi >= 0 ? "+" : ""}${st.roi}%</b> · 均CLV ${st.clv != null ? (st.clv >= 0 ? "+" : "") + st.clv + "pt" : "-"}  ${v.emo} ${v.label}`);
  else cn.push(`⏳ 已捕捉 ${st.total} 注（未結算 ${st.open}）· 還沒有已結算的樣本外信號,等結算`);
  cn.push(`⚠️ 贏家離場：跟賣 ${st.exitN} · 進行中減倉 ${st.reducedN}（賣出=信號失效, 跟策略一起退）`);
  if (open.length) {
    cn.push("", `<b>🔦 進行中的亮燈信號（${open.length}）</b>`);
    for (const s of open.slice(0, 8)) cn.push(`  ${s.exit ? "🔴" : "💎"} ${esc(String(s.name || s.wallet.slice(0, 6)).slice(0, 10))} · <b>${esc(s.kind)}</b> · 押${esc(s.outcome)}@${Math.round(s.entry * 100)}¢${s.exit ? ` <b>⚠️贏家${s.reduced ? "減倉" : "已賣"}${s.exit.pct != null ? s.exit.pct + "%" : ""}</b>` : ""} · ${esc((s.title || "").slice(0, 28))}`);
  }
  cn.push("", `🔭 持續更新 · ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT`);
  const text = cn.join("\n");
  if (state.strengthPinId && (await editMsg(state.strengthPinId, text))) return;
  const id = await sendReturn(text);
  if (id) { state.strengthPinId = id; await pinMsg(id); }
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
  // 衍生/散户盘先判(角球/黄牌/半场/单节/球员等即使是 Over/Under 也算衍生, 不是核心全场大小球)
  if (/halftime|half.?time|1st.?half|2nd.?half|first.?half|second.?half|1st.?set|2nd.?set|period|quarter|exact|btts|both.?teams|advance|to.?score|clean.?sheet|corner|card|player|winning.?margin|first-|anytime|handicap-game|map ?\d|total maps|first blood|first map|pistol|round \d|kills/.test(s)) return "衍生/散戶";
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
  // 强项: 盈利第一 —— 该地址在赚钱的盘口类型(样本够 + ROI>0; 排除衍生/散户)。按 ROI 排, CLV 仅参考
  const S_MIN = Number(process.env.STRENGTH_MIN_N || 6);
  const strengths = byType
    .filter((t) => t.k !== "衍生/散戶" && t.n >= S_MIN && t.roi > 0)
    .map((t) => ({ ...t, score: t.roi + (t.clv || 0), tentative: t.n < MIN }))
    .sort((a, b) => b.roi - a.roi);
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
// 分数Kelly仓位比例(占本金): 用固定保守假设edge, 与赛果无关 → 杜绝 look-ahead
function kellyFraction(p, opts = {}) {
  if (!(p > 0 && p < 1)) return 0;
  const kf = opts.kf != null ? opts.kf : 0.25;
  const edge = opts.edge != null ? opts.edge : Number(process.env.SIM_EDGE || 0.03);
  const maxFrac = opts.maxFrac || 0.10;
  const qCap = opts.qCap || 0.95;
  const q = Math.min(p + edge, qCap);
  let f = Math.max(0, Math.min(maxFrac, kf * (q - p) / (1 - p)));
  // 修③低赔仓位封顶: 固定edge的Kelly在高价盘会吃满上限(≈9倍于冷门注), 而≥80¢收息注前向实测-26% → 封顶2%别让它绑架账户
  if (p >= 0.80) f = Math.min(f, opts.lowMaxFrac != null ? opts.lowMaxFrac : Number(process.env.LOWODDS_MAXFRAC || 0.02));
  return f;
}
function simulateKelly(bets, opts = {}) {
  const start = opts.bankroll || 1000;
  const flat = opts.flat;                        // 设了=固定比例下注(对照组)
  const used = {};                               // 修②每场限额: 同场累计仓位比例 ≤ capFrac
  let B = start, peak = start, maxDD = 0, n = 0, wins = 0;
  const trail = [];                              // 流水: 每笔 {ref,stake,pnl,after}
  for (const b of bets) {
    const p = b.entry;
    if (!(p > 0 && p < 1)) continue;
    let frac = flat != null ? flat : kellyFraction(p, opts);
    if (opts.capFrac && opts.keyOf) { const k = opts.keyOf(b); const u = used[k] || 0; frac = Math.min(frac, Math.max(0, opts.capFrac - u)); used[k] = u + frac; }
    if (!(frac > 0)) continue;
    n++;
    const stake = frac * B;
    const ret = b.profit != null ? b.profit : (b.win ? (1 - p) / p : -1); // 每$1回报: 赛果结算或跟卖平仓的已实现
    B += stake * ret; if (ret > 0) wins++; // 仓位大小与结果无关(杜绝look-ahead)
    trail.push({ ref: b, stake: +stake.toFixed(2), pnl: +(stake * ret).toFixed(2), after: +B.toFixed(2) });
    peak = Math.max(peak, B);
    maxDD = Math.max(maxDD, peak > 0 ? (peak - B) / peak : 0);
  }
  return { start, final: +B.toFixed(2), roi: Math.round((B / start - 1) * 100), n, wins, winrate: n ? Math.round((wins / n) * 100) : null, maxDD: Math.round(maxDD * 100), trail };
}
// 🎲 前向纸面账户: 只跟"擅长盘亮灯"信号(样本外·按能成交价·真赛果结算), $1000 分数Kelly 复利
function strengthPaper(track, opts = {}) {
  const kf = opts.kf != null ? opts.kf : Number(process.env.PAPER_KF || 0.25);
  const capFrac = Number(process.env.EVENT_CAP_FRAC || 0.05); // 修②: 同一场比赛总仓位 ≤ 本金5%
  const all = Object.values((track || {}).signals || {}).filter((s) => s.afterFreeze !== false);
  const blocked = all.filter((s) => s.gate && s.gate.fillable === false).length; // 跟不进, 剔出账户
  const hedgedN = all.filter((s) => s.hedged).length; // 修①: 对冲对, 剔出账户
  const voidN = all.filter((s) => s.void).length; // 🕳️作废(取消/延期), 剔出账户
  const sigs0 = all.filter(followable);
  const xc = xconfKeys(sigs0); const xconfN = xc.size; // 🤝分歧: 账户弃权(钱包层照记)
  for (const s of xc) s._xconf = true; // 瞬态标记(供仪表盘打标签, 不落盘)
  const sigs = sigs0.filter((s) => !xc.has(s));
  // #1 修: 按【实现时间】排序复利(赛果=开赛时间; 跟卖平仓=离场时间), 更贴近资金真实到账顺序
  const realTime = (s) => (s.settledBy === "exit" && s.exit ? (s.exit.ts || 0) * 1000 : (s.kickoffMs || 0));
  const settled = sigs.filter((s) => s.settled).sort((a, b) => realTime(a) - realTime(b));
  // 主账户 = 等注(flat) —— 测量期最不失真: 每信号投本金固定比例, 每注对结论贡献相等(V9.5)
  // ¼Kelly 降级为对照线(它按"假设edge"给高价盘配大仓, 会扭曲测量; 真Kelly等某组合过闸门后按实测edge再上)
  const stakeFrac = Number(process.env.PAPER_STAKE_FRAC || 0.02);
  const r = simulateKelly(settled, { flat: stakeFrac, capFrac, keyOf: gameKeyOf });        // 主: 等注2% + 每场限额
  const rK = simulateKelly(settled, { kf, capFrac, keyOf: gameKeyOf });                    // 对照: ¼Kelly(带低赔封顶)
  const kellyAlt = { bankroll: rK.final, roi: rK.roi, maxDD: rK.maxDD };
  const open = sigs.filter((s) => !s.settled);
  // 当前持仓明细: 按捕捉顺序配仓(等注+同场累计≤capFrac), 展示按开赛时间升序(最快开赛在前)
  const usedOpen = {};
  const positions = [...open].sort((a, b) => (a.entryTs || 0) - (b.entryTs || 0)).map((s) => {
    let frac = stakeFrac;
    const k = gameKeyOf(s); const u = usedOpen[k] || 0;
    frac = Math.min(frac, Math.max(0, capFrac - u)); usedOpen[k] = u + frac;
    const stake = frac * r.final;
    const unreal = (s.nowPrice > 0 && s.nowPrice < 1) ? ((s.nowPrice - s.entry) / s.entry) * stake : null;
    return { ...s, stake: Math.round(stake), capped: frac <= 0, unreal: unreal != null ? +unreal.toFixed(2) : null };
  }).filter((s) => !s.capped).sort((a, b) => (a.kickoffMs || 9e15) - (b.kickoffMs || 9e15));
  const openExposure = positions.reduce((sum, s) => sum + s.stake, 0);
  const unrealTotal = positions.reduce((sum, s) => sum + (s.unreal || 0), 0);
  // 📜 流水(最近在前) + 按 地址×盘类 的盈亏榜($) + 退役名单
  const history = r.trail.map((x) => ({ when: realTime(x.ref), name: x.ref.name || x.ref.wallet.slice(0, 6), kind: x.ref.kind, title: x.ref.title, eventSlug: x.ref.eventSlug, outcome: x.ref.outcome, entry: x.ref.entry, settledBy: x.ref.settledBy, win: x.ref.win, stake: x.stake, pnl: x.pnl, after: x.after })).reverse();
  const gs = strengthGroupStats(track);
  const pnlBy = {};
  for (const x of r.trail) { const k = (x.ref.name || x.ref.wallet.slice(0, 6)) + "|" + x.ref.kind; const e = (pnlBy[k] = pnlBy[k] || { n: 0, wins: 0, pnl: 0 }); e.n++; if (x.pnl > 0) e.wins++; e.pnl += x.pnl; }
  const board = Object.entries(pnlBy).map(([k, e]) => { const [nm, kd] = k.split("|"); const g = Object.values(gs).find((x) => (x.name || x.wallet.slice(0, 6)) === nm && x.kind === kd); return { name: nm, kind: kd, n: e.n, wins: e.wins, pnl: +e.pnl.toFixed(2), roi: g ? g.roi : null, clv: g ? g.clv : null }; }).sort((a, b) => (b.roi ?? -9999) - (a.roi ?? -9999)); // ROI优先: 赚的在前(盈利第一)
  const retired = Object.entries((track || {}).retired || {}).map(([k, v]) => ({ key: k, name: v.name || k.split("|")[0].slice(0, 8), kind: k.split("|")[1], ...v }));
  const mmList = Object.entries((track || {}).mm || {}).map(([w, v]) => ({ wallet: w, name: v.name || w.slice(0, 8), n: v.n, hedged: v.hedged }));
  const verticals = strengthByVertical(track); // 📊 板块分账(电竞 vs 世界杯 vs 网球...)
  return { start: 1000, bankroll: r.final, roi: r.roi, n: r.n, wins: r.wins, winrate: r.winrate, maxDD: r.maxDD, openN: open.length, openExposure: Math.round(openExposure), unrealTotal: Math.round(unrealTotal), positions, blocked, hedgedN, voidN, xconfN, history, board, retired, mmList, verticals, kellyAlt, stakeFrac, kf };
}
function fmtPaperText(track) {
  const p = strengthPaper(track);
  const L = [`🎲 $1000 前向紙面賬戶（只跟擅長盤亮燈 · 樣本外 · 等注${Math.round(p.stakeFrac * 100)}% · 按能成交價）`];
  L.push(`  本金 $1000 → 現值 $${p.bankroll.toLocaleString()}  ROI ${p.roi >= 0 ? "+" : ""}${p.roi}%   (對照¼Kelly: $${p.kellyAlt.bankroll.toLocaleString()} ${p.kellyAlt.roi >= 0 ? "+" : ""}${p.kellyAlt.roi}%)`);
  if (p.n) L.push(`  已結算 ${p.n} 注 · 勝率 ${p.winrate}% · 最大回撤 ${p.maxDD}%`);
  else L.push(`  ⏳ 尚無已結算(等亮燈信號的賽事結算)`);
  L.push(`  進行中 ${p.openN} 注 · 在押 ~$${p.openExposure} · 浮盈 ${p.unrealTotal >= 0 ? "+" : ""}$${p.unrealTotal}${p.blocked ? ` · ⛔${p.blocked}跟不進` : ""}${p.hedgedN ? ` · ⚖️${p.hedgedN}對沖對消` : ""}${p.voidN ? ` · 🕳️${p.voidN}作廢` : ""}${p.xconfN ? ` · 🤝${p.xconfN}分歧棄權` : ""}`);
  if (p.positions.length) {
    L.push(`  — 目前在押明細(⏰最快開賽在前 · 纸面注 · 浮盈) —`);
    for (const s of p.positions.slice(0, 20)) {
      const u = s.unreal != null ? `${s.unreal >= 0 ? "+" : ""}$${s.unreal.toFixed(1)}` : "-";
      const ex = s.exit ? ` ⚠️贏家${s.reduced ? "減倉" : "已賣"}` : "";
      L.push(`    ⏰${koHKT(s.kickoffMs) || "?"}  $${String(s.stake).padStart(3)}  ${(s.name || s.wallet.slice(0, 6)).slice(0, 9).padEnd(9)} ${s.kind} 押${s.outcome}@${Math.round(s.entry * 100)}¢${s.nowPrice != null ? `→${Math.round(s.nowPrice * 100)}¢` : ""} 浮${u}${ex} · ${(s.title || "").slice(0, 28)}`);
    }
  }
  if (p.verticals.length) {
    L.push(`  — 📊 板塊分帳(電競 vs 傳統體育 · 樣本外) —`);
    for (const v of p.verticals) L.push(`    ${v.vertical.padEnd(8)} 結算${String(v.n).padStart(2)} 進行中${String(v.open).padStart(2)}${v.n ? ` · 命中${v.winrate}% ROI ${(v.roi >= 0 ? "+" : "") + v.roi}% CLV ${v.clv != null ? (v.clv >= 0 ? "+" : "") + v.clv + "pt" : "-"}` : ""}`);
  }
  if (p.board.length) {
    L.push(`  — 盈虧榜(地址×盤類 · 誰在賺/虧你的錢) —`);
    for (const b of p.board) L.push(`    ${b.pnl >= 0 ? "🟢" : "🔴"} ${(b.name || "").slice(0, 9).padEnd(9)} ${b.kind.padEnd(5)} ${String(b.n).padStart(2)}注 ${b.pnl >= 0 ? "+" : ""}$${b.pnl.toFixed(1)}  ROI ${b.roi != null ? (b.roi >= 0 ? "+" : "") + b.roi + "%" : "-"} CLV ${b.clv != null ? (b.clv >= 0 ? "+" : "") + b.clv + "pt" : "-"}`);
  }
  if (p.history.length) {
    L.push(`  — 📜 賬戶流水(最近${Math.min(10, p.history.length)}筆) —`);
    for (const h of p.history.slice(0, 10)) L.push(`    ${dHK(Math.round((h.when || 0) / 1000))}  ${h.win ? "✅" : "❌"}${h.settledBy === "exit" ? "(跟賣)" : ""} ${(h.name || "").slice(0, 9).padEnd(9)} ${h.kind} 押${h.outcome}@${Math.round(h.entry * 100)}¢ 注$${h.stake} → ${h.pnl >= 0 ? "+" : ""}$${h.pnl}  餘額$${h.after}`);
  }
  if (p.retired.length) L.push(`  🚫 已退役(雙負閘門·永不再捕): ${p.retired.map((r) => `${(r.name || "").slice(0, 9)}·${r.kind}(${r.n}注 ${r.roi}%)`).join(" / ")}`);
  if (p.mmList.length) L.push(`  🤖 做市/梯子型(對沖占比≥60%·永久停跟): ${p.mmList.map((m) => `${(m.name || "").slice(0, 10)}(${m.hedged}/${m.n}對沖)`).join(" / ")}`);
  L.push(`  ✅ 前向·樣本外·等注(測量期最不失真; ¼Kelly只作對照) —— 這才是"跟不跟得賺"的誠實答案。`);
  return L.join("\n");
}
// Telegram 版(HTML): $1000 前向纸面账户 + 目前在押, 供定时推送
function fmtPaperTG(track) {
  const p = strengthPaper(track);
  const cn = [`🎲 <b>$1000 前向紙面賬戶</b>（只跟擅長盤亮燈 · 樣本外 · 等注${Math.round(p.stakeFrac * 100)}% · 按你能成交價）`, ""];
  cn.push(`本金 $1000 → 現值 <b>$${p.bankroll.toLocaleString()}</b> · ROI <b>${p.roi >= 0 ? "+" : ""}${p.roi}%</b> <i>（對照¼Kelly: $${p.kellyAlt.bankroll.toLocaleString()} ${p.kellyAlt.roi >= 0 ? "+" : ""}${p.kellyAlt.roi}%）</i>`);
  if (p.n) cn.push(`已結算 ${p.n} 注 · 勝率 ${p.winrate}% · 最大回撤 ${p.maxDD}%`);
  else cn.push(`⏳ 尚無已結算（等亮燈信號的賽事結算）`);
  cn.push(`進行中 <b>${p.openN}</b> 注 · 在押 ~<b>$${p.openExposure.toLocaleString()}</b> · 浮盈 <b>${p.unrealTotal >= 0 ? "+" : ""}$${p.unrealTotal.toLocaleString()}</b>`);
  if (p.blocked) cn.push(`⛔ ${p.blocked} 注跟不進（點差/深度不夠, 已剔出賬戶）`);
  if (p.hedgedN) cn.push(`⚖️ ${p.hedgedN} 注對沖對消（同錢包同場同類雙向=做市/梯子, 已剔出賬戶）`);
  if (p.voidN) cn.push(`🕳️ ${p.voidN} 注作廢（開賽超${Number(process.env.VOID_HOURS || 48)}h未結算=取消/延期, 已剔出）`);
  if (p.xconfN) cn.push(`🤝 ${p.xconfN} 注分歧棄權（候選互相對賭同一場, 賬戶不下·對決照評分）`);
  if (p.history.length) {
    cn.push("", "<b>📜 最近結算</b>");
    for (const h of p.history.slice(0, 4)) cn.push(`${h.win ? "✅" : "❌"}${h.settledBy === "exit" ? "跟賣" : ""} ${esc((h.name || "").slice(0, 9))} ${esc(h.kind)} 押${esc(h.outcome)}@${Math.round(h.entry * 100)}¢ 注$${h.stake} → <b>${h.pnl >= 0 ? "+" : ""}$${h.pnl}</b> · 餘$${h.after}`);
  }
  if (p.verticals.length) {
    cn.push("", "<b>📊 板塊分帳（電競 vs 傳統體育）</b>");
    for (const v of p.verticals) cn.push(`${esc(v.vertical)}: 結算 ${v.n}·進行 ${v.open}${v.n ? ` · 命中 ${v.winrate}% · ROI <b>${v.roi >= 0 ? "+" : ""}${v.roi}%</b> · CLV ${v.clv != null ? (v.clv >= 0 ? "+" : "") + v.clv + "pt" : "-"}` : ""}`);
  }
  if (p.retired.length) cn.push(`🚫 已退役: ${p.retired.map((r) => esc((r.name || "").slice(0, 9)) + "·" + esc(r.kind)).join(" / ")}（雙負閘門, 永不再捕）`);
  if (p.mmList.length) cn.push(`🤖 判為做市停跟: ${p.mmList.map((m) => esc((m.name || "").slice(0, 10))).join(" / ")}`);
  if (p.positions.length) {
    cn.push("", "<b>📌 目前在押（⏰最快開賽在前 · 紙面注 · 浮盈）</b>");
    for (const s of p.positions.slice(0, 12)) {
      const u = s.unreal != null ? `${s.unreal >= 0 ? "+" : ""}$${Math.abs(s.unreal) < 1 ? s.unreal.toFixed(1) : Math.round(s.unreal)}` : "-";
      const ex = s.exit ? ` ⚠️贏家${s.reduced ? "減倉" : "已賣"}` : "";
      const low = Math.round((s.entry || 0) * 100) >= 80 ? " ⚠️低賠" : "";
      cn.push(`⏰${esc(koHKT(s.kickoffMs) || "?")} 💵$${s.stake} · ${esc(String(s.name || s.wallet.slice(0, 6)).slice(0, 10))} <b>${esc(s.kind)}</b> 押${esc(s.outcome)}@${Math.round(s.entry * 100)}¢${s.nowPrice != null ? `→${Math.round(s.nowPrice * 100)}¢` : ""} 浮${u}${ex}${low} · <i>${esc((s.title || "").slice(0, 20))}</i>`);
    }
  }
  cn.push("", `🔭 ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT · 每${(Number(process.env.PAPER_PUSH_MIN || 120) / 60).toFixed(0)}h更新 · 非投注建議,未證明 edge`);
  return cn.join("\n");
}

// ===== 🎮 电竞影子账户: $500, 独立追踪4个"电竞原生方向专家"的赛前直向注(与主账户隔离) =====
const ESPORTS_ROSTER = path.join(__dirname, "data", "esports_roster.json");
const ESPORTS_FILE = path.join(__dirname, "data", "esports_shadow.json");
function loadEsportsRoster() { try { return JSON.parse(fs.readFileSync(ESPORTS_ROSTER, "utf8")); } catch { return { bankrollStart: 500, wallets: {} }; } }
function loadEsports() { try { return JSON.parse(fs.readFileSync(ESPORTS_FILE, "utf8")); } catch { return { signals: {} }; } }
function saveEsports(t) { try { fs.writeFileSync(ESPORTS_FILE, JSON.stringify(t, null, 2)); } catch {} }
async function trackEsportsShadow() {
  const roster = loadEsportsRoster(), t = loadEsports(); t.signals = t.signals || {};
  const now = Date.now(), nowS = Math.round(now / 1000), fresh = [];
  const SPREAD_MAX = Number(process.env.SPREAD_MAX_CENTS || 5), testUsd = Number(process.env.GATE_TEST_USD || 50);
  for (const [addr, name] of Object.entries(roster.wallets || {})) {
    const { bets } = await walletActivity(addr, { hours: Number(process.env.STRENGTH_HOURS || 72) }).catch(() => ({ bets: [] }));
    for (const b of bets || []) {
      if (sportOf(b) !== "🎮 電競") continue;                  // 只电竞
      if (betKind(b) !== "勝負/讓球") continue;                 // 只直向胜负盘(排除 map/props 衍生)
      if (!(b.kickoffMs && now < b.kickoffMs)) continue;        // 只赛前(杜绝赛中 look-ahead, 电竞尤其关键)
      if (b.gammaId == null || !(b.mktPrice > 0.02 && b.mktPrice < 0.98)) continue;
      const key = (b.cid || b.eventSlug) + "|" + b.outcome + "|" + addr;
      if (t.signals[key]) continue;
      const g = await marketExecQuote(b.gammaId, b.outcome, testUsd).catch(() => null);
      let gate, entry = b.mktPrice;
      if (g && g.bestAsk != null) { const spreadC = +((g.spread || 0) * 100).toFixed(1), fill = g.fillPrice != null ? +g.fillPrice.toFixed(4) : null, fillable = !!(g.depthOk && spreadC <= SPREAD_MAX && fill != null && fill < 0.98); gate = { spreadC, fillable }; if (fillable) entry = fill; } else gate = { fillable: null };
      t.signals[key] = { wallet: addr, name, title: b.title, eventSlug: b.eventSlug, gammaId: b.gammaId, cid: b.cid, outcome: b.outcome, entry, entryTs: nowS, kickoffMs: b.kickoffMs, gate, last: entry, settled: false };
      fresh.push(t.signals[key]);
    }
  }
  const VOID_MS = Number(process.env.VOID_HOURS || 48) * 3600 * 1000;
  for (const key in t.signals) {
    const sg = t.signals[key];
    if (sg.settled || sg.void || sg.gammaId == null) continue;
    if (sg.kickoffMs && now - sg.kickoffMs > VOID_MS) { sg.void = true; continue; }
    const mk = await getMarketNow(sg.gammaId).catch(() => null); if (!mk) continue;
    if (mk.slug) sg.marketSlug = mk.slug;
    const pr = mk.price[sg.outcome];
    if (pr > 0 && pr < 1) { sg.nowPrice = pr; sg.nowTs = nowS; if (sg.kickoffMs && now >= sg.kickoffMs - 3 * 3600e3 && now < sg.kickoffMs) sg.last = pr; }
    if (mk.closed && mk.winner) { sg.win = sg.outcome === mk.winner; sg.profit = sg.win ? (1 - sg.entry) / sg.entry : -1; sg.clv = sg.last != null ? +(sg.last - sg.entry).toFixed(4) : null; sg.settled = true; }
  }
  saveEsports(t);
  return { fresh, track: t };
}
const _median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
function esportsAccount() {
  const roster = loadEsportsRoster(), t = loadEsports();
  const start = roster.bankrollStart || 500, posFrac = Number(process.env.PAPER_STAKE_FRAC || 0.02);
  const eligible = (s) => !(s.gate && s.gate.fillable === false) && !s.void;
  const sigs = Object.values(t.signals || {}).filter(eligible);
  const settled = sigs.filter((s) => s.settled).sort((a, b) => (a.kickoffMs || 0) - (b.kickoffMs || 0));
  const r = simulateKelly(settled, { flat: posFrac, bankroll: start, capFrac: Number(process.env.EVENT_CAP_FRAC || 0.05), keyOf: gameKeyOf });
  const open = sigs.filter((s) => !s.settled);
  const positions = [...open].sort((a, b) => (a.kickoffMs || 9e15) - (b.kickoffMs || 9e15)).map((s) => { const stake = posFrac * r.final, unreal = (s.nowPrice > 0 && s.nowPrice < 1) ? ((s.nowPrice - s.entry) / s.entry) * stake : null; return { ...s, stake: Math.round(stake), unreal: unreal != null ? +unreal.toFixed(2) : null }; });
  const bw = {};
  for (const w of Object.entries(roster.wallets || {})) bw[w[1]] = { name: w[1], n: 0, wins: 0, profit: 0, clvs: [], open: 0 };
  for (const s of open) { const k = s.name; if (bw[k]) bw[k].open++; }
  for (const s of settled) { const k = s.name; const e = (bw[k] = bw[k] || { name: k, n: 0, wins: 0, profit: 0, clvs: [], open: 0 }); e.n++; if (s.win) e.wins++; e.profit += s.profit || 0; if (s.clv != null) e.clvs.push(s.clv); }
  const board = Object.values(bw).map((e) => ({ name: e.name, n: e.n, wins: e.wins, open: e.open, winrate: e.n ? Math.round(e.wins / e.n * 100) : null, roi: e.n ? Math.round(e.profit / e.n * 100) : null, clv: e.clvs.length ? Math.round(e.clvs.reduce((x, y) => x + y, 0) / e.clvs.length * 100) : null, clvMed: e.clvs.length ? Math.round(_median(e.clvs) * 100) : null })).sort((a, b) => (b.roi ?? -9999) - (a.roi ?? -9999) || (b.n + b.open) - (a.n + a.open)); // ROI优先(盈利第一), 无结算的垫底
  const n = settled.length, wins = settled.filter((s) => s.win).length, allClv = settled.filter((s) => s.clv != null).map((s) => s.clv);
  const history = r.trail.map((x) => ({ when: x.ref.kickoffMs, name: x.ref.name, title: x.ref.title, eventSlug: x.ref.eventSlug, outcome: x.ref.outcome, entry: x.ref.entry, win: x.ref.win, stake: x.stake, pnl: x.pnl, after: x.after })).reverse();
  return { start, bankroll: r.final, roi: r.roi, n, wins, winrate: n ? Math.round(wins / n * 100) : null, maxDD: r.maxDD, openN: open.length, openExposure: Math.round(positions.reduce((a, s) => a + s.stake, 0)), positions, board, history, clvMean: allClv.length ? Math.round(allClv.reduce((a, b) => a + b, 0) / allClv.length * 100) : null, clvMed: allClv.length ? Math.round(_median(allClv) * 100) : null };
}
function fmtEsportsTG(acc) {
  const a = acc || esportsAccount();
  const cn = ["🎮 <b>$500 電競影子賬戶</b>（只跟4個電競原生方向專家 · 賽前直向 · 樣本外 · 等注2%）", ""];
  cn.push(`本金 $${a.start} → 現值 <b>$${a.bankroll.toLocaleString()}</b> · ROI <b>${a.roi >= 0 ? "+" : ""}${a.roi}%</b>`);
  if (a.n) cn.push(`已結算 ${a.n} 注 · 勝率 ${a.winrate}% · 均CLV ${a.clvMean != null ? (a.clvMean >= 0 ? "+" : "") + a.clvMean : "-"}pt（中位 ${a.clvMed != null ? a.clvMed : "-"}pt）· 最大回撤 ${a.maxDD}%`);
  else cn.push(`⏳ 尚無已結算（等這4位在電競盤出賽前注 + 賽事結算）`);
  cn.push(`進行中 ${a.openN} 注 · 在押 ~$${a.openExposure}`);
  cn.push("", "<b>👤 各專家戰績</b>");
  for (const b of a.board) cn.push(`${esc(b.name)}: 結算${b.n}·進行${b.open}${b.n ? ` · 命中${b.winrate}% ROI ${b.roi >= 0 ? "+" : ""}${b.roi}% CLV均${b.clv != null ? b.clv : "-"}/中${b.clvMed != null ? b.clvMed : "-"}pt` : ""}`);
  if (a.positions.length) { cn.push("", "<b>📌 進行中（⏰最快開賽在前）</b>"); for (const s of a.positions.slice(0, 8)) cn.push(`⏰${esc(koHKT(s.kickoffMs) || "?")} $${s.stake} ${esc(s.name)} 押${esc(s.outcome)}@${Math.round(s.entry * 100)}¢${s.nowPrice != null ? `→${Math.round(s.nowPrice * 100)}¢` : ""} · <i>${esc((s.title || "").slice(0, 24))}</i>`); }
  cn.push("", `🔭 ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT · 電競實驗 · 非投注建議,未證明 edge`);
  return cn.join("\n");
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
  const strk = loadStrengthTrack();
  applyLiveOverlay(strk); // serve模式下用内存实时价覆盖(比文件新才覆盖; 不落盘)
  try { for (const s of xconfKeys(Object.values(strk.signals || {}).filter((x) => x.afterFreeze !== false && followable(x)))) s._xconf = true; } catch {} // 先标🤝分歧, 信号表才有标签
  const now = hkNow().toISOString().slice(0, 16).replace("T", " ");
  // 🏅 只跟擅长盘·样本外前向战绩
  const sst = strengthStats(strk), sv = sgVerdict(sst);
  const svCls = sv.emo === "✅" ? "ok" : sv.emo === "🟡" ? "warn" : sv.emo === "❌" ? "bad" : "wait";
  const sgAll = Object.values(strk.signals || {}).filter((s) => s.afterFreeze !== false);
  const sgOpen = sgAll.filter((s) => !s.settled).sort((a, b) => (a.kickoffMs || 0) - (b.kickoffMs || 0));
  const sgDone = sgAll.filter((s) => s.settled).sort((a, b) => (b.entryTs || 0) - (a.entryTs || 0));
  // 小标签: 子盘(连结落到赛事默认盘,需往下找) + 低赔(价高=收息型,上档小)
  const sgTags = (s) => {
    let x = "";
    if (s._xconf) x += ` <span class="warn2" title="候選互相對賭同一場同盤類: 賬戶棄權(白付點差), 但雙方樣本照記入各自戰績=最乾淨的對決">🤝分歧</span>`;
    if (s.void) x += ` <span class="muted" title="開賽超時未結算(取消/延期), 已剔出賬戶">🕳️作廢</span>`;
    if (s.hedged) x += ` <span class="neg" title="同一錢包在同場同盤類雙向持倉=做市/梯子交易, 不是方向信號, 整組已剔出賬戶">⚖️對沖</span>`;
    if (s.gate && s.gate.fillable === false) x += ` <span class="neg" title="點差${s.gate.spreadC}¢/深度不夠${s.gate.depthOk === false ? "(吃不滿$" + s.gate.testUsd + ")" : ""} → 跟不進, 已剔出賬戶">⛔跟不進</span>`;
    if (s.marketSlug && s.eventSlug && s.marketSlug !== s.eventSlug) x += ` <span class="muted" title="賽事子盤：點開落在賽事頁(默認勝負盤)，往下找此盤才是此價">子盤</span>`;
    if (Math.round((s.entry || 0) * 100) >= 80) x += ` <span class="warn2" title="價高=低賠率(收息型)，贏了上檔小、輸一次抹多次">⚠️低賠</span>`;
    return x;
  };
  const sgRow = (s, settled) => {
    const link = (s.eventSlug ? `<a href="https://polymarket.com/event/${esc(s.eventSlug)}" target="_blank">${esc((s.title || "").slice(0, 34))}</a>` : esc((s.title || "").slice(0, 34))) + sgTags(s);
    // 状态列: 已结算(赛果 ✅/❌ 或 跟卖 ⚠️) / 进行中(可能带减仓警告)
    let res;
    if (settled) res = s.settledBy === "exit"
      ? `<span class="warn2">⚠️跟賣 ${(s.profit || 0) >= 0 ? "+" : ""}${Math.round((s.profit || 0) * 100)}%</span>`
      : (s.win ? `<span class="pos">✅贏 +${Math.round((s.profit || 0) * 100)}%</span>` : `<span class="neg">❌輸</span>`);
    else res = s.exit ? `<span class="neg">⚠️贏家${s.reduced ? "減倉" : "已賣"}${s.exit.pct != null ? s.exit.pct + "%" : ""}</span>` : `<span class="warn2">進行中</span>`;
    // 現價(未结算才有意义): 相对成本涨=红(跟更贵)/跌=绿(更便宜); 结算后无現價
    let nowCell = "-";
    if (!settled && s.nowPrice != null) {
      const d = s.nowPrice - s.entry, dc = d > 0.02 ? "neg" : d < -0.02 ? "pos" : "muted";
      nowCell = `${Math.round(s.nowPrice * 100)}¢${Math.abs(d) >= 0.02 ? ` <span class="${dc}">${d >= 0 ? "+" : ""}${Math.round(d * 100)}</span>` : ""}`;
    }
    return `<tr class="${!settled && s.exit ? "exitrow" : ""}"><td>${esc(String(s.name || s.wallet.slice(0, 6)).slice(0, 10))}</td><td><b>${esc(s.kind)}</b></td><td>${link}</td><td>${esc(s.outcome)}</td><td>${Math.round(s.entry * 100)}¢</td><td>${nowCell}</td><td>${s.clv != null ? (s.clv >= 0 ? "+" : "") + Math.round(s.clv * 100) + "pt" : "-"}</td><td>${res}</td></tr>`;
  };
  const sgTable = (arr, settled) => arr.length ? `<table class="grid det"><thead><tr><th>地址</th><th>擅長盤</th><th>項目</th><th>方向</th><th>成本</th><th>現價</th><th>CLV</th><th>${settled ? "結果" : "狀態"}</th></tr></thead><tbody>${arr.slice(0, 12).map((s) => sgRow(s, settled)).join("")}</tbody></table>` : "";
  const strHtmlBody = sst.n
    ? `<div class="card"><div class="pc-head"><span class="badge ${svCls}">${sv.emo}</span><b>樣本外前向戰績</b><span class="muted">凍結標籤後才算 · 起算 ${sst.frozenAt ? dHK(sst.frozenAt) : "-"} HKT</span></div>
        <div style="font-size:16px;margin:6px 0">已結算 <b>${sst.n}</b> 注 · 命中 <b>${sst.winrate}%</b> · ROI <b class="${roiCls(sst.roi)}">${roiTxt(sst.roi, "%")}</b> · 均CLV <b class="${roiCls(sst.clv)}">${sst.clv != null ? roiTxt(sst.clv, "pt") : "-"}</b> · 未結算 ${sst.open}</div>
        <div class="verdict">${sv.label}</div>
        <div class="str-row"><span class="neg">⚠️ 贏家離場：跟賣平倉 ${sst.exitN} 注 · 進行中被減倉 ${sst.reducedN} 注</span> <span class="muted">（贏家中途賣出=信號失效，紙面賬戶已跟策略一起退出）</span></div></div>`
    : `<div class="card"><span class="badge wait">⏳</span> 已捕捉 <b>${sst.total}</b> 個亮燈信號（未結算 ${sst.open}）· 還沒有已結算的樣本外樣本，等賽事結算。<div class="str-row"><span class="neg">⚠️ 贏家離場：跟賣 ${sst.exitN} · 減倉 ${sst.reducedN}</span> <span class="muted">起算 ${sst.frozenAt ? dHK(sst.frozenAt) + " HKT" : "尚未凍結（等雷達跑一輪）"}</span></div></div>`;
  const strHtml = strHtmlBody
    + (sgOpen.length ? `<div class="det-h">🔦 進行中的亮燈信號（${sgOpen.length}）</div>${sgTable(sgOpen, false)}` : "")
    + (sgDone.length ? `<div class="det-h">📗 已結算的樣本外信號（${sgDone.length}）</div>${sgTable(sgDone, true)}` : "");
  const ovHtml = `<section class="card overview">📊 總覽（跟所有💎信號） · <b class="${roiCls(ov.roi)}">${roiTxt(ov.roi, "%")}</b> ROI
    <div class="muted">${ov.n || 0} 注 · 命中 ${ov.wr != null ? ov.wr + "%" : "-"} · 均CLV ${ov.clv != null ? roiTxt(ov.clv, "pt") : "-"} · ⚠️ 多為同批世界盃、未跨行情</div></section>`;
  const candHtml = cands.length
    ? cands.map((r) => profileCardHtml(walletProfile(sc, r.wallet), (det.wallets || {})[r.wallet.toLowerCase()])).filter(Boolean).join("")
    : `<div class="card muted">暫無地址達到「樣本 ≥ ${MIN_N} 且樣本外 ROI>0」。繼續讓雷達跑、攢樣本。</div>`;
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
  // 🎲 $1000 前向纸面账户: 只跟擅长盘亮灯信号(样本外·真赛果结算)
  const paper = strengthPaper(strk);
  const paperCls = paper.n ? (paper.roi > 0 ? "ok" : paper.roi < 0 ? "bad" : "wait") : "wait";
  const posRow = (s) => {
    const link = (s.eventSlug ? `<a href="https://polymarket.com/event/${esc(s.eventSlug)}" target="_blank">${esc((s.title || "").slice(0, 32))}</a>` : esc((s.title || "").slice(0, 32))) + sgTags(s);
    const u = s.unreal != null ? `<span class="${s.unreal > 0 ? "pos" : s.unreal < 0 ? "neg" : "muted"}">${s.unreal >= 0 ? "+" : ""}$${Math.abs(s.unreal) < 1 ? s.unreal.toFixed(1) : Math.round(s.unreal)}</span>` : "-";
    const st = s.exit ? `<span class="neg">⚠️贏家${s.reduced ? "減倉" : "已賣"}</span>` : `<span class="warn2">持倉中</span>`;
    return `<tr class="${s.exit ? "exitrow" : ""}" data-kick="${s.kickoffMs || 9e15}" data-stake="${s.stake}"><td>⏰${esc(koHKT(s.kickoffMs) || "?")}</td><td><b>$${s.stake}</b></td><td>${esc(String(s.name || s.wallet.slice(0, 6)).slice(0, 10))}</td><td>${esc(s.kind)}</td><td>${link}</td><td>${esc(s.outcome)}</td><td>${Math.round(s.entry * 100)}¢${s.nowPrice != null ? `→${Math.round(s.nowPrice * 100)}¢` : ""}</td><td>${u}</td><td>${st}</td></tr>`;
  };
  const pxTs = Math.max(0, ...paper.positions.map((s) => s.nowTs || 0));
  const posTable = paper.positions.length ? `<div class="det-h">📌 目前在押明細（等注${Math.round(paper.stakeFrac * 100)}%·同場≤${Math.round(Number(process.env.EVENT_CAP_FRAC || 0.05) * 100)}%）<span class="muted"> 現價刷新於 ${pxTs ? dHK(pxTs) + " HKT" : "-"}（賽中價變化快, F5 可拉最新）</span>
      <button class="sbtn on" onclick="sortPos('kick',this)">⏰ 最快開賽</button><button class="sbtn" onclick="sortPos('stake',this)">💰 注額最大</button></div>
    <table class="grid det"><thead><tr><th>開賽(HKT)</th><th>紙面注</th><th>地址</th><th>擅長盤</th><th>項目</th><th>方向</th><th>成本→現價</th><th>浮盈</th><th>狀態</th></tr></thead><tbody id="posbody">${paper.positions.slice(0, 25).map(posRow).join("")}</tbody></table>
    <script>function sortPos(m,btn){var tb=document.getElementById('posbody');var rows=Array.prototype.slice.call(tb.rows);rows.sort(function(a,b){return m==='kick'?(+a.dataset.kick-+b.dataset.kick):(+b.dataset.stake-+a.dataset.stake);});rows.forEach(function(r){tb.appendChild(r);});document.querySelectorAll('.sbtn').forEach(function(x){x.classList.remove('on');});btn.classList.add('on');}</script>` : "";
  // 📈 余额曲线(内联SVG): $1000 起, 每笔结算后的余额
  let curveHtml = "";
  if (paper.history.length >= 2) {
    const pts = [1000, ...[...paper.history].reverse().map((h) => h.after)]; // 时间正序
    const W = 560, H = 64, mn = Math.min(...pts), mx = Math.max(...pts), rg = mx - mn || 1;
    const xy = pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - 6 - (v - mn) / rg * (H - 12)).toFixed(1)}`).join(" ");
    const up = pts[pts.length - 1] >= 1000;
    curveHtml = `<div class="det-h">📈 餘額曲線（$1000 起 · 每筆結算後）</div><svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:${H}px"><polyline points="${xy}" fill="none" stroke="${up ? "#3fd07f" : "#ff6b6b"}" stroke-width="2"/><line x1="0" y1="${(H - 6 - (1000 - mn) / rg * (H - 12)).toFixed(1)}" x2="${W}" y2="${(H - 6 - (1000 - mn) / rg * (H - 12)).toFixed(1)}" stroke="#26304a" stroke-dasharray="4 4"/></svg>`;
  }
  // 📊 板块分账(电竞 vs 传统体育并排)
  const vertHtml = paper.verticals.length ? `<div class="det-h">📊 板塊分帳（電競 vs 傳統體育並排 · 樣本外 · 賬戶口徑）</div><table class="grid det"><thead><tr><th>板塊</th><th>已結算</th><th>進行中</th><th>命中</th><th>均ROI</th><th>均CLV</th></tr></thead><tbody>${paper.verticals.map((v) => `<tr><td><b>${esc(v.vertical)}</b></td><td>${v.n}</td><td>${v.open}</td><td>${v.winrate != null ? v.winrate + "%" : "-"}</td><td class="${roiCls(v.roi)}">${v.roi != null ? roiTxt(v.roi, "%") : "-"}</td><td class="${roiCls(v.clv)}">${v.clv != null ? roiTxt(v.clv, "pt") : "-"}</td></tr>`).join("")}</tbody></table>` : "";
  // 盈亏榜(地址×盘类, 亏钱的在前)
  const boardHtml2 = paper.board.length ? `<div class="det-h">🏦 盈虧榜（地址×盤類 · 按ROI排 · 賺的在前）</div><table class="grid det"><thead><tr><th>地址</th><th>盤類</th><th>注</th><th>盈虧$</th><th>ROI</th><th>CLV</th></tr></thead><tbody>${paper.board.map((b) => `<tr><td>${esc((b.name || "").slice(0, 10))}</td><td>${esc(b.kind)}</td><td>${b.n}</td><td class="${roiCls(b.pnl)}"><b>${b.pnl >= 0 ? "+" : ""}$${b.pnl.toFixed(1)}</b></td><td class="${roiCls(b.roi)}">${b.roi != null ? roiTxt(b.roi, "%") : "-"}</td><td class="${roiCls(b.clv)}">${b.clv != null ? roiTxt(b.clv, "pt") : "-"}</td></tr>`).join("")}</tbody></table>` : "";
  // 📜 账户流水(最近15笔)
  const histRow = (h) => {
    const link = h.eventSlug ? `<a href="https://polymarket.com/event/${esc(h.eventSlug)}" target="_blank">${esc((h.title || "").slice(0, 30))}</a>` : esc((h.title || "").slice(0, 30));
    return `<tr><td>${dHK(Math.round((h.when || 0) / 1000))}</td><td>${esc((h.name || "").slice(0, 9))}</td><td>${esc(h.kind)}</td><td>${link}</td><td>${esc(h.outcome)}@${Math.round(h.entry * 100)}¢</td><td>$${h.stake}</td><td class="${roiCls(h.pnl)}"><b>${h.pnl >= 0 ? "+" : ""}$${h.pnl}</b>${h.settledBy === "exit" ? " <span class='warn2'>跟賣</span>" : ""}</td><td>$${h.after}</td></tr>`;
  };
  const histHtml = paper.history.length ? `<div class="det-h">📜 賬戶流水（最近 ${Math.min(15, paper.history.length)} 筆 · 共 ${paper.history.length} 筆）</div><table class="grid det"><thead><tr><th>結算時間</th><th>地址</th><th>盤類</th><th>項目</th><th>方向@成本</th><th>注</th><th>盈虧</th><th>餘額</th></tr></thead><tbody>${paper.history.slice(0, 15).map(histRow).join("")}</tbody></table>` : "";
  const retiredHtml = (paper.retired.length || paper.mmList.length) ? `<div class="det-h">🚫 停跟名單（單向閘門 · 永不回補）</div><div style="font-size:13px">${paper.retired.map((r) => `<span class="str-pill tent" title="雙負閘門: n≥${Number(process.env.RETIRE_MIN_N || 10)} 且 ROI<0 且 CLV不為正">🚫 ${esc((r.name || "").slice(0, 10))} · ${esc(r.kind)} <span class="muted">${r.n}注 ${r.roi}%</span></span>`).join("")}${paper.mmList.map((m) => `<span class="str-pill tent" title="做市預過濾: 被捕捉注中對沖占比≥${Math.round(Number(process.env.MM_HEDGE_RATIO || 0.6) * 100)}% = 梯子/做市型, 方向腿只是殘渣">🤖 ${esc((m.name || "").slice(0, 10))} <span class="muted">${m.hedged}/${m.n}對沖</span></span>`).join("")}</div>` : "";
  const paperHtml = `<div class="card">
    <div class="pc-head"><span class="badge ${paperCls}">🎲</span><b>本金 $1000 → 現值 $${paper.bankroll.toLocaleString()}</b><span class="${roiCls(paper.roi)}" style="font-size:18px">${roiTxt(paper.roi, "%")}</span><span class="muted">等注${Math.round(paper.stakeFrac * 100)}% · 按你能成交價 · 對照¼Kelly: $${paper.kellyAlt.bankroll.toLocaleString()}(${roiTxt(paper.kellyAlt.roi, "%")})</span></div>
    <div style="margin:6px 0">${paper.n ? `已結算 <b>${paper.n}</b> 注 · 勝率 <b>${paper.winrate}%</b> · 最大回撤 <b class="neg">-${paper.maxDD}%</b>` : "⏳ 尚無已結算（等亮燈信號的賽事結算）"} · 進行中 <b>${paper.openN}</b> 注 · 在押 ~<b>$${paper.openExposure.toLocaleString()}</b> · 浮盈 <b class="${roiCls(paper.unrealTotal)}">${paper.unrealTotal >= 0 ? "+" : ""}$${paper.unrealTotal.toLocaleString()}</b>${paper.blocked ? ` · <span class="neg">⛔${paper.blocked}跟不進</span>` : ""}${paper.hedgedN ? ` · <span class="neg">⚖️${paper.hedgedN}對沖對消(已剔除)</span>` : ""}${paper.voidN ? ` · <span class="muted">🕳️${paper.voidN}作廢(取消/延期)</span>` : ""}${paper.xconfN ? ` · <span class="warn2">🤝${paper.xconfN}分歧棄權(候選對賭)</span>` : ""}</div>
    ${curveHtml}${vertHtml}${boardHtml2}${posTable}${histHtml}${retiredHtml}
    <div class="banner">✅ <b>前向 · 樣本外</b>：只跟凍結擅長盤之後、真·未來出現的亮燈信號，按你能成交的價下注、真賽果結算 —— 這是「跟不跟得賺」的誠實答案（不是回放，需攢幾週）。仍：非投注建議，未證明 edge。</div></div>`;
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
    + "table.grid tr.strong td{background:#12261b}table.grid tr.exitrow td{background:#3a1616}"
    + ".str-row{font-size:13px;margin:4px 0 2px}.str-pill{display:inline-block;background:#12261b;border:1px solid #1f4a30;border-radius:6px;padding:1px 7px;margin:2px 4px 2px 0;font-size:12.5px}.str-pill.tent{background:#2a2410;border-color:#5a4520}.str-pill b{color:var(--pos)}"
    + ".sbtn{background:#1b2540;border:1px solid var(--line);color:var(--tx);border-radius:6px;padding:2px 10px;margin-left:8px;font-size:12px;cursor:pointer}.sbtn.on{background:#28406e;border-color:var(--accent)}"
    + ".foot{color:var(--mut);font-size:12px;margin-top:26px;border-top:1px solid var(--line);padding-top:12px}";
  // 🎮 电竞影子账户区域
  const esp = esportsAccount();
  const espCls = esp.n ? (esp.roi > 0 ? "ok" : esp.roi < 0 ? "bad" : "wait") : "wait";
  const espBoard = esp.board.length ? `<table class="grid det"><thead><tr><th>電競專家</th><th>結算</th><th>進行</th><th>命中</th><th>ROI</th><th>CLV均/中位</th></tr></thead><tbody>${esp.board.map((b) => `<tr><td><b>${esc(b.name)}</b></td><td>${b.n}</td><td>${b.open}</td><td>${b.winrate != null ? b.winrate + "%" : "-"}</td><td class="${roiCls(b.roi)}">${b.roi != null ? roiTxt(b.roi, "%") : "-"}</td><td>${b.clv != null ? `<span class="${roiCls(b.clv)}">${roiTxt(b.clv, "")}</span>/<span class="${roiCls(b.clvMed)}">${b.clvMed}</span>pt` : "-"}</td></tr>`).join("")}</tbody></table>` : "";
  // 🎮 电竞影子账户: 余额曲线 + 历史流水(可回溯)
  let espCurve = "";
  if (esp.history.length >= 2) {
    const pts = [esp.start, ...[...esp.history].reverse().map((h) => h.after)];
    const W = 560, H = 60, mn = Math.min(...pts), mx = Math.max(...pts), rg = mx - mn || 1;
    const xy = pts.map((v, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - 6 - (v - mn) / rg * (H - 12)).toFixed(1)}`).join(" ");
    const base = (H - 6 - (esp.start - mn) / rg * (H - 12)).toFixed(1);
    espCurve = `<div class="det-h">📈 餘額曲線（$${esp.start} 起 · 每筆結算後）</div><svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:${H}px"><polyline points="${xy}" fill="none" stroke="${pts[pts.length - 1] >= esp.start ? "#3fd07f" : "#ff6b6b"}" stroke-width="2"/><line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="#26304a" stroke-dasharray="4 4"/></svg>`;
  }
  const espHist = esp.history.length ? `<div class="det-h">📜 賬戶流水（最近 ${Math.min(20, esp.history.length)} 筆 · 共 ${esp.history.length} 筆 · 可回溯）</div><table class="grid det"><thead><tr><th>結算(HKT)</th><th>專家</th><th>項目</th><th>方向@成本</th><th>注</th><th>盈虧</th><th>餘額</th></tr></thead><tbody>${esp.history.slice(0, 20).map((h) => `<tr><td>${dHK(Math.round((h.when || 0) / 1000))}</td><td>${esc(h.name)}</td><td>${h.eventSlug ? `<a href="https://polymarket.com/event/${esc(h.eventSlug)}" target="_blank">${esc((h.title || "").slice(0, 30))}</a>` : esc((h.title || "").slice(0, 30))}</td><td>${esc(h.outcome)}@${Math.round(h.entry * 100)}¢</td><td>$${h.stake}</td><td class="${roiCls(h.pnl)}"><b>${h.pnl >= 0 ? "+" : ""}$${h.pnl}</b></td><td>$${h.after}</td></tr>`).join("")}</tbody></table>` : "";
  const espPos = esp.positions.length ? `<div class="det-h">📌 進行中（⏰最快開賽在前）</div><table class="grid det"><thead><tr><th>開賽</th><th>注</th><th>專家</th><th>項目</th><th>方向</th><th>成本→現價</th><th>浮盈</th></tr></thead><tbody>${esp.positions.slice(0, 15).map((s) => `<tr><td>⏰${esc(koHKT(s.kickoffMs) || "?")}</td><td><b>$${s.stake}</b></td><td>${esc(s.name)}</td><td>${s.eventSlug ? `<a href="https://polymarket.com/event/${esc(s.eventSlug)}" target="_blank">${esc((s.title || "").slice(0, 30))}</a>` : esc((s.title || "").slice(0, 30))}</td><td>${esc(s.outcome)}</td><td>${Math.round(s.entry * 100)}¢${s.nowPrice != null ? `→${Math.round(s.nowPrice * 100)}¢` : ""}</td><td>${s.unreal != null ? `<span class="${roiCls(s.unreal)}">${s.unreal >= 0 ? "+" : ""}$${Math.abs(s.unreal) < 1 ? s.unreal.toFixed(1) : Math.round(s.unreal)}</span>` : "-"}</td></tr>`).join("")}</tbody></table>` : "";
  const espHtml = `<div class="card"><div class="pc-head"><span class="badge ${espCls}">🎮</span><b>本金 $${esp.start} → 現值 $${esp.bankroll.toLocaleString()}</b><span class="${roiCls(esp.roi)}" style="font-size:18px">${roiTxt(esp.roi, "%")}</span><span class="muted">等注2% · 4位電競原生方向專家 · 只跟賽前直向</span></div>
    <div style="margin:6px 0">${esp.n ? `已結算 <b>${esp.n}</b> 注 · 勝率 <b>${esp.winrate}%</b> · 均CLV <b class="${roiCls(esp.clvMean)}">${esp.clvMean != null ? roiTxt(esp.clvMean, "pt") : "-"}</b>（中位 ${esp.clvMed != null ? esp.clvMed + "pt" : "-"}）· 回撤 <b class="neg">-${esp.maxDD}%</b>` : "⏳ 尚無已結算（等這4位出賽前直向注 + 賽事結算）"} · 進行中 <b>${esp.openN}</b> 注 · 在押 ~$${esp.openExposure}</div>
    ${espBoard}${espPos}${espCurve}${espHist}
    <div class="banner">🎮 <b>獨立實驗</b>：$500 只跟 4 個「電競原生方向專家」(joblessfinalbo/0xE16D/SineNooneEI/GeorgeRe) 的<b>賽前直向</b>注(赛中单自動跳過)。用中位CLV抗離群。與 $1000 主賬戶完全隔離,測「電競是否比傳統體育更低效」。仍：非投注建議,未證明 edge。</div></div>`;
  const html = `<!doctype html><html lang="zh-HK"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Polaris 記分卡儀表盤</title><style>${css}</style></head><body><div class="wrap">
    <h1>📇 聰明錢記分卡 · 儀表盤</h1>
    <div class="meta">生成於 ${now} HKT · 資料隨雷達運行更新（重跑「打开仪表盘.bat」刷新）</div>
    <div class="banner">⚠️ 判據：<b>盈利第一</b> —— 以樣本外 ROI 為準,CLV 僅樣本不足時防運氣。需樣本夠 + 跨行情仍成立。目前多為世界盃順風窗口,未證明 edge。</div>
    ${ovHtml}
    <h2>🏅 只跟擅長盤 · 樣本外前向驗證器（凍結後才算 · 真·出樣本）</h2>${strHtml}
    <h2>🏅 高信心跟單組合（地址 × 他擅長的盤）</h2><div class="card">${comboHtml}</div>
    <h2>🎲 $1000 前向紙面賬戶（只跟擅長盤亮燈 · 真·未來樣本）</h2>${paperHtml}
    <h2>🎮 $500 電競影子賬戶（4位電競原生方向專家 · 獨立實驗）</h2>${espHtml}
    <h2>✅ 候選可跟（附「賺從哪來」拆解＋近期出手明細）</h2>${candHtml}
    <h2>📋 其餘足夠樣本（參考）</h2>${othHtml}
    <div class="meta">另有 ${smallN} 個地址樣本 < ${MIN_N}（噪聲，已隱藏）</div>
    <h2>🎯 全體育板塊戰績</h2>${boardHtml}
    <h2>📒 我的下注台賬</h2>${ledHtml}
    <div class="foot">Polaris Whale Radar · 跟隨者視角（按你能成交的價算 ROI）· CLV = 近開賽價 − 入場價<br>看穿一個地址：押熱門才賺=順風車；冷門/五五盤也賺且 CLV 穩定正=真本事。</div>
  </div></body></html>`;
  fs.writeFileSync(DASH_FILE, html);
  return { file: DASH_FILE, cands: cands.length, others: others.length, smallN, html };
}
// 实时现价覆盖(serve模式): F5 时若上次覆盖超 LIVE_REFRESH_S 秒, 现场拉未结算仓的实时价 —— 只进内存渲染, 不写文件(不与雷达抢锁)
const _liveOverlay = { ts: 0, px: new Map() };
async function refreshLiveOverlay() {
  const LIVE_S = Number(process.env.LIVE_REFRESH_S || 180);
  if (Date.now() - _liveOverlay.ts < LIVE_S * 1000) return;
  _liveOverlay.ts = Date.now();
  try {
    const t = loadStrengthTrack();
    const open = Object.values(t.signals || {}).filter((s) => s.afterFreeze !== false && !s.settled && followable(s) && s.gammaId != null).slice(0, 30);
    for (const s of open) {
      const mk = await getMarketNow(s.gammaId).catch(() => null);
      const p = mk && mk.price[s.outcome];
      if (p > 0 && p < 1) _liveOverlay.px.set(s.gammaId + "|" + s.outcome, { p, ts: Date.now() });
    }
  } catch {}
}
// 把覆盖价套到已加载的信号对象上(仅当比文件里的更新鲜; 内存操作, 永不落盘)
function applyLiveOverlay(strk) {
  for (const s of Object.values((strk || {}).signals || {})) {
    const o = _liveOverlay.px.get(s.gammaId + "|" + s.outcome);
    if (o && (!s.nowTs || o.ts > s.nowTs * 1000)) { s.nowPrice = o.p; s.nowTs = Math.round(o.ts / 1000); }
  }
}
// 本地服务模式: 每次请求(F5)现算最新数据重新渲染 → 浏览器 F5 即刷新, 无需重启/重跑 .bat
function serveDashboard(port) {
  const http = require("http");
  const srv = http.createServer(async (req, res) => {
    const u = (req.url || "/").split("?")[0];
    if (u === "/favicon.ico") { res.writeHead(204); return res.end(); }
    try {
      await refreshLiveOverlay(); // 超3分钟旧就现场拉实时价(首个F5慢几秒, 之后走缓存)
      const { html } = buildDashboard();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    } catch (e) { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); res.end("仪表盘生成出错: " + e.message); }
  });
  srv.on("error", (e) => console.error(`端口 ${port} 起服务失败: ${e.message}（可能已被占用; 换端口: node bot.js --serve 8900）`));
  srv.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`✅ 仪表盘服务已启动: ${url}\n   浏览器里按 F5 即可刷新最新数据（无需重启、无需重跑 .bat）。关掉此窗口=停服务。`);
    try { require("child_process").exec(`cmd /c start "" ${url}`); } catch {} // 自动打开浏览器
  });
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
        try { const { fresh, exits, track } = await trackStrengthSignals(); if (fresh.length) { const a = fmtStrengthAlert(fresh); if (a) await send(a); console.log(`  → 🏅擅长盘亮灯: 新捕捉 ${fresh.length}`); } if (exits && exits.length) { const ea = fmtStrengthExitAlert(exits); if (ea) await send(ea); console.log(`  → ⚠️赢家离场: ${exits.length}`); } await postOrUpdateStrengthPin(track, d); } catch (e) { console.error("擅长盘追踪出错:", e.message); }
        try { const { fresh } = await trackEsportsShadow(); if (fresh.length) console.log(`  → 🎮电竞影子: 新捕捉 ${fresh.length}`); } catch (e) { console.error("电竞影子追踪出错:", e.message); }
        try { const cds = scorecardRows(loadScorecard()).filter((r) => r.candidate).map((r) => r.wallet); await refreshWalletDetail(cds.slice(0, 10)); buildDashboard(); } catch (e) { console.error("仪表盘生成出错:", e.message); } // 顺带刷新候选出手明细 + 本地 dashboard.html
        try { const l = loadLedger(); if ((l.bets || []).some((b) => !b.settled)) { const sn = await settleLedger(l); if (sn) console.log(`  → 台账新结算 ${sn} 注`); } await postOrUpdateLedgerPin(l, d); } catch (e) { console.error("台账置顶出错:", e.message); }
        d.winnerBets = now;
      } catch (e) {
        console.error("赢家最新出手出错:", e.message);
      }
    }
    // $1000 前向纸面账户: 每 PAPER_PUSH_MIN(默4h) 推一次(只读, 用运行中雷达已刷新的 strength_track)
    if ((process.env.PAPER_PUSH_ENABLED || "on") !== "off" && now - (d.paperPush || 0) >= Number(process.env.PAPER_PUSH_MIN || 120) * 60000) {
      try {
        const track = loadStrengthTrack();
        const p = strengthPaper(track);
        if (p.openN > 0 || p.n > 0) { await send(fmtPaperTG(track)); console.log("  → 已推 $1000 前向纸面账户"); }
        d.paperPush = now; // 空也记时间, 免每轮重试
      } catch (e) { console.error("纸面账户推送出错:", e.message); }
    }
    // 🎮 $500 电竞影子账户: 独立推送(默认同 2h)
    if ((process.env.ESPORTS_PUSH_ENABLED || "on") !== "off" && now - (d.esportsPush || 0) >= Number(process.env.ESPORTS_PUSH_MIN || 120) * 60000) {
      try { const a = esportsAccount(); if (a.openN > 0 || a.n > 0) { await send(fmtEsportsTG(a)); console.log("  → 已推 $500 电竞影子账户"); } d.esportsPush = now; } catch (e) { console.error("电竞影子推送出错:", e.message); }
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
    console.log(`\n✅ 候选可跟(样本≥${MIN_N} 且样本外 ROI>0 · 盈利第一 · CLV仅参考): ${cands.length ? "" : "暂无"}`);
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

  if (process.argv.includes("--paper")) {
    // $1000 前向纸面账户(样本外·真赛果结算)。#4 修: 默认【只读】(不写文件, 免和运行中的雷达抢写)
    // --refresh 强制先捕捉/结算(仅雷达没开时用); --push 推一条到 Telegram
    if (process.argv.includes("--refresh")) { try { await trackStrengthSignals(); } catch (e) { console.error("刷新出错(用现有数据):", e.message); } }
    const track = loadStrengthTrack();
    console.log(fmtPaperText(track));
    if (process.argv.includes("--push")) { await send(fmtPaperTG(track)); console.log(`\n✅ 已推 $1000 前向纸面账户 → ${CHANNEL}`); }
    return;
  }

  if (process.argv.includes("--esports")) {
    // 🎮 $500 电竞影子账户(只跟4个电竞原生方向专家)。--refresh 先捕捉/结算; --push 推 Telegram
    if (process.argv.includes("--refresh")) { try { const { fresh } = await trackEsportsShadow(); console.log(`(刷新: 新捕捉 ${fresh.length})`); } catch (e) { console.error("刷新出错:", e.message); } }
    const a = esportsAccount();
    console.log(fmtEsportsTG(a).replace(/<[^>]+>/g, ""));
    if (process.argv.includes("--push")) { await send(fmtEsportsTG(a)); console.log(`\n✅ 已推 $500 电竞影子账户 → ${CHANNEL}`); }
    return;
  }

  if (process.argv.includes("--simulate")) {
    // ⚠️参考用: $1000 Kelly【样本内回放】(候选历史注, 偏乐观)。前向真账户看 --paper
    console.log(fmtSimText(loadScorecard()));
    console.log(`\n（注：这是【样本内回放】仅供参考。真·前向账户 → node bot.js --paper）`);
    return;
  }

  if (process.argv.includes("--strength")) {
    // 擅长盘·前向验证器: 捕捉候选在其擅长盘的新出手 + 检测赢家离场 + 结算 + 样本外战绩。--dry 只看不推
    const { fresh, exits, track } = await trackStrengthSignals();
    console.log(fmtStrengthStatsText(track).replace(/<[^>]+>/g, ""));
    if (exits && exits.length) { console.log(`\n⚠️ 本轮新检测到赢家离场 ${exits.length} 个:`); exits.forEach((s) => console.log(`  🔴 ${(s.name || s.wallet.slice(0, 6))} · ${s.kind} · ${s.reduced ? "减仓" : "基本离场"}${s.exit.pct != null ? `~${s.exit.pct}%` : ""} · 原押${s.outcome}@${Math.round(s.entry * 100)}¢ · ${(s.title || "").slice(0, 38)}`)); }
    if (fresh.length) { console.log(`\n本轮新捕捉 ${fresh.length} 个亮灯信号:`); fresh.forEach((s) => console.log(`  💎 ${(s.name || s.wallet.slice(0, 6))} · ${s.kind} · 押${s.outcome}@${Math.round(s.entry * 100)}¢ · ${(s.title || "").slice(0, 40)}`)); }
    else console.log(`\n(本轮无新亮灯信号)`);
    if (!process.argv.includes("--dry")) {
      if (fresh.length) { const a = fmtStrengthAlert(fresh); if (a) { await send(a); console.log(`✅ 已推 ${fresh.length} 条亮灯`); } }
      if (exits && exits.length) { const ea = fmtStrengthExitAlert(exits); if (ea) { await send(ea); console.log(`✅ 已推 ${exits.length} 条离场警报`); } }
    }
    return;
  }

  if (process.argv.includes("--serve")) {
    // 本地仪表盘服务: 浏览器 F5 即刷新最新数据(每次请求现算, 不联网)。用法: node bot.js --serve [端口]
    const i = process.argv.indexOf("--serve");
    const port = Number(process.argv[i + 1]) || Number(process.env.DASH_PORT || 8899);
    serveDashboard(port);
    return new Promise(() => {}); // 常驻(直到关窗口)
  }

  if (process.argv.includes("--dashboard")) {
    // 生成本地 dashboard.html(浏览器双击打开)。--refresh 顺带刷新候选地址的近期出手明细
    if (process.argv.includes("--refresh")) {
      try {
        const cds = scorecardRows(loadScorecard()).filter((r) => r.candidate).map((r) => r.wallet);
        console.log(`刷新 ${cds.length} 个候选地址的近期出手明细 + 擅长盘亮灯现价…`);
        await refreshWalletDetail(cds.slice(0, 10));
        await trackStrengthSignals(); // 顺带捕捉新亮灯 + 刷新进行中信号的現價
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
    const order = [res.pinnedMsgId, res.previewMsgId, d.ledgerPinId, d.winnerPinId, d.scorecardPinId, d.strengthPinId].filter(Boolean);
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
