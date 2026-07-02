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
const { scan, scanWatchlist, marketSentiment, analyzeTopTraders, getMatchEvents, getWcResults, matchPrediction, getTotalsSignal, getSpreadSignal, getClosingPrices, multiSportSentiment, winnerRecentBets, quoteMatch, cryptoPrediction, getMarketResolution, getMarketNow, findBetMarket, fmtUSD } = require("./radar");

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
const VERSION = "V7.1"; // 版本号(每次迭代升级时更新; 同步 CHANGELOG.md 与启动脚本横幅)
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
    lines.push(`   巨鯨押 ${esc(sideLabel(s.whaleSide, s.home, s.away))} ${fw?.win ? "✅" : "❌"}`);
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
function fmtMultiSport(games) {
  if (!games || !games.length) return null;
  const url = (g) => (g.eventSlug ? `https://polymarket.com/event/${g.eventSlug}` : "https://polymarket.com");
  const cn = ["🎯 <b>近期聰明錢 · 全體育</b>", "（世界盃以外 · 近期 · 💎贏家在押誰 + 大小球/讓球）", ""];
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
    if (g.ou) { const t = g.ou; const ex = t.winnerSide ? ` · 💎贏家偏${t.winnerSide === "Over" ? "大" : "小"}${t.winnerSide === t.side ? "✓" : "⚠️分歧"}` : ""; cn.push(`   ⚽ 大小球: 大戶偏 ${t.side === "Over" ? "大" : "小"} ${t.pct}%（O/U ${esc(t.line)}）${ex}`); }
    if (g.spread) { const s = g.spread; const disp = s.side === "cover" ? `${esc(s.favTeam)} -${esc(s.line)}` : `${esc(s.dogTeam)} +${esc(s.line)}`; const ex = s.winnerSide ? ` · 💎贏家${s.winnerSide === s.side ? "同向✓" : "分歧⚠️"}` : ""; cn.push(`   ⚖️ 讓球: 大戶偏 ${disp} ${s.pct}%${ex}`); }
    cn.push("");
  }
  cn.push("⚠️ 數據分析 · 非投注建議");
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
// 赢家最新出手: 名单里盈利大户近期方向性下注; 按体育分类分组, 组内按时间倒序; 给"参与更多投注"
function fmtWinnerBets(bets) {
  if (!bets || !bets.length) return null;
  const ago = (ts) => { const m = Math.round(Date.now() / 1000 / 60 - ts / 60); return m < 60 ? `${m}分前` : `${Math.round(m / 60)}h前`; };
  const ORDER = ["⚽ 世界盃", "⚾ 棒球(MLB)", "🎾 網球", "🏀 籃球", "🏒 冰球", "🏈 美式足球", "⚽ 其他足球", "🏟 其他"];
  const groups = new Map();
  for (const b of bets) { const s = sportOf(b); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(b); }
  const cn = ["💎 <b>贏家最新出手</b>（盈利大戶近期剛下的方向性注 · 按體育分類）", ""];
  const perSport = Number(process.env.WINNER_PER_SPORT || 6); // 每个体育最多列几笔(最新), 避免世界杯挤掉其它
  for (const sport of ORDER) {
    const all = groups.get(sport);
    if (!all || !all.length) continue;
    const arr = all.slice(0, perSport);
    cn.push(`━━ <b>${sport}</b>（${all.length > arr.length ? `顯示${arr.length}/${all.length}` : all.length}）━━`);
    for (const b of arr) {
      const url = b.eventSlug ? `https://polymarket.com/event/${b.eventSlug}` : "https://polymarket.com";
      const ko = koHKT(b.kickoffMs);
      cn.push(`💎 <a href="${url}">${esc(translateTitle(b.title || ""))}</a>${ko ? ` · ⏰ ${ko}` : ""}`);
      const consensus = b.count > 1 ? ` · 💎×${b.count}同押` : "";
      cn.push(`   買 <b>${esc(String(b.outcome))}</b> @${Math.round(b.price * 100)}¢ · ${cUSD(b.maxUsd || b.usd)} · 下注${ago(b.ts)}（最賺贏家 ${cUSD(b.profit)}）${consensus}`);
    }
    cn.push("");
  }
  cn.push("⚠️ 數據分析 · 非投注建議 · 未證明 edge（更多信號≠更多勝率）");
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
      const s = S[key];
      if (!s || !s.bets) continue;
      parts.push(`${name} ${s.bets}場 命中${Math.round((s.wins / s.bets) * 100)}% ROI ${Math.round((s.profit / s.bets) * 100) >= 0 ? "+" : ""}${Math.round((s.profit / s.bets) * 100)}%`);
    }
    if (parts.length) { any = true; out.push(`<b>${lbl[kind]}</b>: ${parts.join(" · ")}`); }
  }
  if (!any) return null;
  out.push("", "⚠️ 未證明 edge · 前向攢樣本中");
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
  // 2) 结算已解析的市场(开赛后)
  let newN = 0;
  for (const slug in ms.predictions) {
    const p = ms.predictions[slug];
    if (p.kickoffMs && Date.now() < p.kickoffMs) continue;
    for (const kind of ["ml", "ou", "spread"]) {
      const s = p[kind];
      if (!s || s.settled || s.id == null) continue;
      const winnerName = await getMarketResolution(s.id).catch(() => null);
      if (!winnerName) continue; // 还没解析
      const evalOne = (idx) => {
        if (idx == null || !s.outcomes || !s.prices) return null;
        const price = Number(s.prices[idx]);
        if (!(price > 0 && price < 1)) return null;
        const win = s.outcomes[idx] === winnerName;
        return { win, profit: win ? (1 - price) / price : -1 };
      };
      const strat = { followBig: evalOne(s.backedIdx), followWinner: evalOne(s.winnerIdx) };
      const S = (ms.strategies[kind] = ms.strategies[kind] || {});
      for (const key in strat) { const r = strat[key]; if (!r) continue; const st = (S[key] = S[key] || { bets: 0, wins: 0, profit: 0 }); st.bets++; if (r.win) st.wins++; st.profit += r.profit; }
      s.settled = true;
      ms.settled.push({ eventSlug: slug, sport: p.sport, kind, winner: winnerName, backed: s.outcomes[s.backedIdx], bigWin: strat.followBig ? strat.followBig.win : null, settledAt: new Date().toISOString() });
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
    rows.push({ wallet, name: W.name, pnl: W.pnl || 0, n, wins, wr: n ? Math.round((wins / n) * 100) : null, roi, clv, open });
  }
  return rows.sort((a, b) => (b.roi ?? -999) - (a.roi ?? -999) || b.n - a.n);
}
function fmtScorecard(sc) {
  const all = scorecardRows(sc);
  const settled = all.filter((r) => r.n >= 1);
  const cn = ["📇 <b>每錢包前向記分卡</b>（跟隨者視角 · 按你能成交的價算）", "（找出真正值得跟的地址：ROI+CLV 持續為正才是真赢家）", ""];
  if (!settled.length) {
    cn.push(`⏳ 還沒有已結算的跟隨樣本（已鎖定 ${all.reduce((s, r) => s + r.open, 0)} 筆未結算，賽後逐步結算）`);
  } else {
    for (const r of settled.slice(0, 15)) {
      cn.push(`${r.roi >= 0 ? "🟢" : "🔴"} <code>${esc(r.wallet.slice(0, 6))}…</code>${r.name ? " " + esc(String(r.name).slice(0, 10)) : ""}（歷史$${Math.round(r.pnl / 1e5) / 10}M）`);
      cn.push(`   ${r.n}場 命中${r.wr}% · ROI ${r.roi >= 0 ? "+" : ""}${r.roi}% · 均CLV ${r.clv != null ? (r.clv >= 0 ? "+" : "") + r.clv + "pt" : "-"}${r.open ? ` · 未結算${r.open}` : ""}`);
    }
  }
  cn.push("", "⚠️ 樣本少別信 · 只有 ROI 與 CLV 都持續為正的地址才值得專門跟 · 未證明 edge");
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
        const text = fmtMultiSport((games || []).slice(0, Number(process.env.SHARP_TOP || 8)));
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
    const rows = scorecardRows(sc);
    console.log(`每钱包前向记分卡（跟随者视角 · 按能成交价算 · 已锁定 ${rows.reduce((s, r) => s + r.open, 0)} 未结算 / ${rows.reduce((s, r) => s + r.n, 0)} 已结算）`);
    if (!rows.length) { console.log("(还没有任何跟随样本; 让它跑几天)"); return; }
    for (const r of rows) {
      const perf = r.n ? `${r.n}结算 命中${r.wr}% ROI ${r.roi >= 0 ? "+" : ""}${r.roi}% 均CLV ${r.clv != null ? (r.clv >= 0 ? "+" : "") + r.clv + "pt" : "-"}` : "尚无结算";
      console.log(`  ${r.wallet.slice(0, 8)}… ${(r.name || "").slice(0, 12).padEnd(12)} 历史$${Math.round(r.pnl / 1e6 * 10) / 10}M | ${perf} | 未结算${r.open}`);
    }
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
    const text = fmtMultiSport(games);
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
