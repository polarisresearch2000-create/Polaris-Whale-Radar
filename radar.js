// 核心扫描逻辑（被 index.js 命令行 和 bot.js Telegram 共用）
// 从 Polymarket 拉取加密市场大额成交，给钱包标注真实战绩，挑出「聪明钱方向性下注」信号。

const CONFIG = {
  MIN_NOTIONAL_USDC: 1000,    // 多大金额(USDC)才算「巨鲸」(服务端直接过滤)
  WHALE_TRADES_TO_PULL: 1000, // 默认拉多少笔「大额」成交
  CRYPTO_EVENT_PAGES: 6,      // 抓多少页加密市场建立过滤名单 (每页100)
  EXCLUDE_HFT: true,          // 排除「Up or Down」超短线刷单市场(纯赌博噪音)
  MAX_WALLETS_TO_SCORE: 60,   // 最多给多少笔(按金额)查钱包战绩
  SIGNAL_MIN_PNL: 5000,       // 钱包全期盈亏超过此值才算「聪明钱」
  TOP_N: 15,                  // 完整榜单展示前 N 笔
  WALLET_CONCURRENCY: 6,      // 同时查询多少个钱包
  SCORE_TTL_MS: 60 * 60 * 1000, // 钱包战绩缓存时长(战绩变化慢，1小时足够)
};

const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const PNL = "https://user-pnl-api.polymarket.com";

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

// ---------------- 数据拉取 ----------------
async function getCryptoConditionIds() {
  const ids = new Set();
  for (let page = 0; page < CONFIG.CRYPTO_EVENT_PAGES; page++) {
    let events;
    try {
      events = await getJSON(
        `${GAMMA}/events?tag_slug=crypto&closed=false&limit=100&offset=${page * 100}`
      );
    } catch {
      break;
    }
    if (!Array.isArray(events) || events.length === 0) break;
    for (const ev of events) for (const m of ev.markets || []) if (m.conditionId) ids.add(m.conditionId.toLowerCase());
  }
  return ids;
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

  const [cryptoIds, trades] = await Promise.all([getCryptoConditionIds(), getWhaleTrades(pull)]);

  const cryptoWhales = trades
    .map((t) => ({ ...t, notional: (t.size || 0) * (t.price || 0) }))
    .filter((t) => {
      const isCrypto = cryptoIds.size
        ? cryptoIds.has((t.conditionId || "").toLowerCase())
        : CRYPTO_WORDS.test(t.title || "");
      if (!isCrypto) return false;
      if (CONFIG.EXCLUDE_HFT && HFT_RE.test(t.title || "")) return false;
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
      marketCount: cryptoIds.size,
      tradeCount: trades.length,
      cryptoWhaleCount: cryptoWhales.length,
    },
  };
}

module.exports = { scan, fmtUSD, CONFIG, isDirectional };
