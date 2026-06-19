// 巨鲸预判回测(诚实版): 仅"主胜负/晋级"盘 + 仅"赛前"持仓, 复盘巨鲸方向胜率与 ROI。
// 关键修正: (1)排除衍生/花絮盘(避免同场相关盘灌水) (2)只用开赛前成交(去前视偏差)
//   node backtest-whales.js              # 世界杯
//   node backtest-whales.js soccer       # 足球(更大样本)
// 只读公开 API, 不下单。

const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const tag = process.argv[2] || "fifa-world-cup";
const MIN_BUY = 500; // 单笔≥此金额算大户买入
const MIN_PRE_USD = 1500; // 赛前大户买入合计≥此值才纳入
const MAX_MARKETS = 400;
// 排除衍生/花絮盘, 只留"谁赢/平/晋级/冠军"主盘
const DERIV = /o\/u|over\/under|spread|exact|corner|half-?time|both teams|to score|score first|first (goal|team|half)|player prop|announcer|hat ?trick|to play|penalt|booking|\bcards?\b|leading at|\bassist|clean sheet|tournament|golden|how many|number of/i;

async function getJSON(u, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 20000);
      const r = await fetch(u, { headers: { Accept: "application/json" }, signal: c.signal });
      clearTimeout(t);
      if (!r.ok) throw 0;
      return await r.json();
    } catch {
      if (i === tries - 1) return null;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
}
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}
const safe = (s) => {
  try { return JSON.parse(s || "[]"); } catch { return []; }
};
const fmtUSD = (n) => "$" + Math.round(n).toLocaleString("en-US");

async function closedMarkets() {
  const out = [];
  for (let p = 0; p < 4; p++) {
    const ev = await getJSON(`${GAMMA}/events?tag_slug=${tag}&closed=true&limit=100&offset=${p * 100}&order=endDate&ascending=false`);
    if (!Array.isArray(ev) || !ev.length) break;
    for (const e of ev) {
      const kickoffMs = e.startTime ? Date.parse(e.startTime) : null;
      if (!kickoffMs) continue; // 没开赛时间(多为花絮/非对阵), 跳过
      for (const m of e.markets || []) {
        if (!m.conditionId || /up or down/i.test(m.question || "") || DERIV.test(m.question || "")) continue;
        out.push({ cid: m.conditionId, q: m.question, outcomes: safe(m.outcomes), prices: safe(m.outcomePrices), kickoffMs });
      }
    }
    if (ev.length < 100) break;
  }
  return out;
}
const resolution = (m) => {
  const wi = m.prices.findIndex((p) => Number(p) >= 0.99);
  return wi >= 0 ? m.outcomes[wi] : null;
};

async function fetchBuys(cid) {
  const tr = await getJSON(`${DATA}/trades?market=${cid}&filterType=CASH&filterAmount=${MIN_BUY}&limit=500`);
  return Array.isArray(tr)
    ? tr.filter((t) => t.side === "BUY").map((t) => ({ o: t.outcome, usd: (t.size || 0) * (t.price || 0), sh: t.size || 0, ts: t.timestamp, w: t.proxyWallet }))
    : [];
}
function positionFrom(buys) {
  const side = {};
  const wallet = new Map();
  for (const b of buys) {
    if (!side[b.o]) side[b.o] = { usd: 0, sh: 0 };
    side[b.o].usd += b.usd; side[b.o].sh += b.sh;
    if (!wallet.has(b.w)) wallet.set(b.w, { usd: 0, bySide: new Map(), shBySide: new Map() });
    const w = wallet.get(b.w);
    w.usd += b.usd; w.bySide.set(b.o, (w.bySide.get(b.o) || 0) + b.usd); w.shBySide.set(b.o, (w.shBySide.get(b.o) || 0) + b.sh);
  }
  const total = Object.values(side).reduce((s, v) => s + v.usd, 0);
  if (total <= 0) return null;
  const whaleSide = Object.keys(side).reduce((a, b) => (side[b].usd > side[a].usd ? b : a));
  let big = null;
  for (const [w, wr] of wallet) {
    if (!big || wr.usd > big.usd) {
      const s = [...wr.bySide.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const sh = wr.shBySide.get(s) || 0;
      big = { side: s, usd: wr.usd, vwap: sh > 0 ? wr.bySide.get(s) / sh : null };
    }
  }
  const vwap = (s) => (side[s] && side[s].sh > 0 ? side[s].usd / side[s].sh : null);
  return { whaleSide, consensusPct: side[whaleSide].usd / total, total, side, big, vwap };
}

const acc = () => ({ bets: 0, wins: 0, profit: 0 });
const add = (s, win, price) => {
  if (price == null || !(price > 0 && price < 1)) return;
  s.bets++;
  if (win) s.wins++;
  s.profit += win ? (1 - price) / price : -1;
};
const inBand = (p) => p != null && p >= 0.3 && p <= 0.8;

(async () => {
  console.log(`回测标签: ${tag} — 抓已结算"主胜负盘"...`);
  const markets = (await closedMarkets()).filter((m) => m.outcomes.length >= 2 && resolution(m)).slice(0, MAX_MARKETS);
  console.log(`主盘(可定胜负+有开赛时间): ${markets.length} — 拉历史成交(并发)...`);
  const rows = await mapLimit(markets, 6, async (m) => ({ m, buys: await fetchBuys(m.cid) }));

  const mk = () => ({ all: acc(), comp: acc() });
  const S = { followWhale: mk(), followBig: mk(), highConsensus: mk(), fadeFav: mk() };
  const contrastFull = acc(); // 对照: 用"全程持仓"跟巨鲸(有前视偏差)
  const addB = (o, win, price) => {
    add(o.all, win, price);
    if (inBand(price)) add(o.comp, win, price);
  };
  const examples = [];
  let used = 0;
  for (const { m, buys } of rows) {
    const actual = resolution(m);
    if (!actual) continue;
    // 对照: 全程持仓
    const Pf = positionFrom(buys);
    if (Pf && Pf.total >= MIN_PRE_USD) add(contrastFull, Pf.whaleSide === actual, Pf.vwap(Pf.whaleSide));
    // 诚实: 仅赛前持仓
    const pre = buys.filter((b) => b.ts * 1000 < m.kickoffMs);
    const P = positionFrom(pre);
    if (!P || P.total < MIN_PRE_USD) continue;
    used++;
    addB(S.followWhale, P.whaleSide === actual, P.vwap(P.whaleSide));
    if (P.big?.side) addB(S.followBig, P.big.side === actual, P.big.vwap);
    if (P.consensusPct >= 0.85) addB(S.highConsensus, P.whaleSide === actual, P.vwap(P.whaleSide));
    const others = Object.keys(P.side).filter((o) => o !== P.whaleSide);
    const fadeSide = others.sort((a, b) => P.side[b].usd - P.side[a].usd)[0];
    if (fadeSide) addB(S.fadeFav, fadeSide === actual, P.vwap(fadeSide));
    const wp = P.vwap(P.whaleSide);
    if (examples.length < 12 && inBand(wp))
      examples.push({ q: m.q, whale: P.whaleSide, actual, win: P.whaleSide === actual, p: wp, cons: P.consensusPct });
  }

  const wr = (s) => (s.bets ? Math.round((s.wins / s.bets) * 100) : 0);
  const roi = (s) => (s.bets ? Math.round((s.profit / s.bets) * 100) : 0);
  const line = (s) => `${s.bets}场 命中${wr(s)}% ROI ${roi(s) >= 0 ? "+" : ""}${roi(s)}%`;
  console.log(`\n========== 巨鲸预判回测(诚实版): ${tag} ==========`);
  console.log(`样本: ${used} 个"主胜负盘 + 赛前大户≥${fmtUSD(MIN_PRE_USD)}"的已结算市场`);
  console.log(`竞争盘 = 赛前巨鲸入场价 0.30~0.80 (真有悬念)\n`);
  for (const [k, label] of [
    ["followWhale", "🐋 跟巨鲸多数方"],
    ["followBig", "👑 跟最大单大户"],
    ["highConsensus", "🔒 高共识>85%才跟"],
    ["fadeFav", "🔄 反向 fade 大众"],
  ]) {
    console.log(`${label}`);
    console.log(`   全部:   ${line(S[k].all)}`);
    console.log(`   竞争盘: ${line(S[k].comp)}`);
  }
  console.log(`\n⚠️ 对照(全程持仓含赛中, 有前视偏差) 跟巨鲸: ${line(contrastFull)}`);
  console.log(`   ↑ 若这个比"赛前版"高很多, 说明很多"准"是赛中追涨, 不是真预测`);
  console.log("\n竞争盘样例(赛前跟巨鲸):");
  examples.forEach((e) => console.log(`  ${e.win ? "✅" : "❌"} ${e.q.slice(0, 44)} | 押${e.whale}@${e.p.toFixed(2)} (共识${Math.round(e.cons * 100)}%) → ${e.actual}`));
})();
