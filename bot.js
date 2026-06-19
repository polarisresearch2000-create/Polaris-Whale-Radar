// Telegram 推送机器人：定时扫描 → 去重 → 把 ⭐聪明钱信号 推到频道。
//
// 运行方式：
//   node bot.js --test   只发一条连通性测试消息
//   node bot.js --once    扫描一次并推送(不循环)，适合测试
//   node bot.js           持续运行，每 POLL_MINUTES 分钟扫描一次

const fs = require("fs");
const path = require("path");
const { scan, scanWatchlist, marketSentiment, analyzeTopTraders, getMatchEvents, getWcResults, matchPrediction, cryptoPrediction, getMarketResolution, fmtUSD } = require("./radar");

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
const VERSION = "V3.8"; // 版本号(每次迭代升级时更新; 同步 CHANGELOG.md 与启动脚本横幅)
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
async function trackResults() {
  const res = loadResults();
  let wc, pmEvents;
  try {
    [wc, pmEvents] = await Promise.all([getWcResults(), getMatchEvents(20)]);
  } catch (e) {
    console.error("赛果追踪取数出错:", e.message);
    return;
  }
  // 1) 捕捉预测: 只在【赛前 state=pre】捕捉, 杜绝赛中追涨的前视偏差(回测教训)
  for (const m of wc) {
    if (m.completed || m.state !== "pre") continue;
    const ex = res.predictions[m.id];
    if (ex && ex.sides) continue;
    const pred = await matchPrediction(m, pmEvents).catch(() => null);
    if (pred && pred.sides) {
      res.predictions[m.id] = {
        match: `${m.home} vs ${m.away}`, home: m.home, away: m.away,
        whaleSide: pred.whaleSide, consensusPct: pred.consensusPct, bigBettor: pred.bigBettor,
        sides: pred.sides, state: m.state, capturedAt: new Date().toISOString(),
      };
    }
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
    res.settled.push({
      espnId: m.id, match: p.match, home: p.home, away: p.away, actual: m.actual,
      score: `${m.homeScore}-${m.awayScore}`, whaleSide: p.whaleSide, bigBettor: p.bigBettor,
      strat, settledAt: new Date().toISOString(),
    });
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
  const lines = ["📌 <b>策略戰績 Track Record</b>（持續更新）", ""];
  let any = false;
  for (const { key, label } of STRATS) {
    const s = res.strategies[key];
    if (!s || !s.bets) {
      lines.push(`${label}: 暫無`);
      continue;
    }
    any = true;
    const roi = roiPct(s);
    lines.push(`${label}: ${s.bets}場 命中${Math.round((s.wins / s.bets) * 100)}% · ROI <b>${roi >= 0 ? "+" : ""}${roi}%</b>`);
  }
  lines.push("", any ? "⚠️ 樣本越多越可信" : "⏳ 等待首批賽果結算");
  lines.push(`更新 ${hkNow().toISOString().slice(5, 16).replace("T", " ")} HKT`);
  lines.push(`🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`);
  return lines.join("\n");
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
  }
  const best = bestStrategy(res);
  if (best) lines.push("", `📊 目前最佳策略: ${best.label} ${best.bets}場 ROI ${best.roi >= 0 ? "+" : ""}${best.roi}%`);
  lines.push("", `🔭 Polaris Research · Polymarket ${LABEL} 聰明錢雷達`);
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
  }
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
};
const tTeam = (s) => TEAMS[String(s).trim().toLowerCase()] || String(s).trim();
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
    "📊 <b>巨鯨持倉分析（精華版）</b>",
    `（大戶下注的多空分布 · 錢往哪押）`,
    "",
  ];
  for (const m of top) {
    cn.push(`🔥 <a href="${url(m)}">${esc(translateTitle(m.title))}</a>  <i>(共 ${m.wallets} 人 · ${fmtUSD(m.total)})</i>`);
    m.breakdown.slice(0, 3).forEach((b, i) => {
      const ocz = ocZh(b.outcome) ? `（${ocZh(b.outcome)}）` : "";
      cn.push(`   ${i === 0 ? "🟩" : "🔻"} ${esc(String(b.outcome))}${ocz}  ${fmtUSD(b.usd)} · ${b.wallets}人 · ${b.pct}%`);
    });
    if (m.topWhale) {
      const bb = m.topWhale;
      const ocz = ocZh(bb.outcome) ? `（${ocZh(bb.outcome)}）` : "";
      const pnl = bb.allTimePnl;
      const badge =
        pnl == null ? ""
        : pnl >= 50000 ? ` · 💎贏家 歷史盈利 ${fmtUSD(pnl)}`
        : pnl <= -50000 ? ` · ⚠️輸家 歷史虧損 ${fmtUSD(Math.abs(pnl))}`
        : pnl > 0 ? ` · 🟢 歷史小賺 ${fmtUSD(pnl)}`
        : ` · 🔴 歷史小虧 ${fmtUSD(Math.abs(pnl))}`;
      cn.push(`   🐋 最大單大戶 押 ${esc(String(bb.outcome))}${ocz} · ${fmtUSD(bb.usd)}${badge}`);
      cn.push(`      <code>${esc(bb.wallet)}</code>`);
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
  const text = fmtTrackRecord(res);
  if (res.pinnedMsgId && (await editMsg(res.pinnedMsgId, text))) return;
  const id = await sendReturn(text);
  if (id) {
    res.pinnedMsgId = id;
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

module.exports = { translateTitle, titleBlock, fmtPositioning, fmtProfiles, fmtResultSummary, evalStrategies, fmtTrackRecord, fmtDailyPreview };
