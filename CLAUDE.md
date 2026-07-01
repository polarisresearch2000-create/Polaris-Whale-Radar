# CLAUDE.md — Polaris Whale Radar 驾驭文档

> 这份是项目操作手册。任何 AI 对话或维护者读完这页即可接手、运行、续做本项目。
> 当前版本 **V6.4**。详细迭代见 [CHANGELOG.md](CHANGELOG.md)。

## 1. 这是什么

Polymarket「聪明钱」雷达 → 自动推送到 Telegram 频道。**只读公开 API，从不下单。零依赖**（仅用 Node 自带 `fetch`，Node ≥20）。
用户：香港、非程序员、靠 AI 开发，目标是**侧收入**。

定位是**「卖铲子」的内容产品**（养受众 → 变现），**不是交易策略**。回测已证明：用散户可得的免费数据，Polymarket 上**没有可交易的 edge**（赛前价值法 = 市场有效；直播滞后法 = ESPN 比 Polymarket 还慢）。所以方向是产品/受众，不是自己下注。

两个频道：
- **加密** `@polarisresearch2000`（bot token = `TELEGRAM_BOT_TOKEN`）
- **世界杯** `@polarisresearch2000_PE`（bot token = `SPORTS_BOT_TOKEN`，PROFILE=SPORTS）

## 2. 硬性边界（务必遵守）

- **只读**：绝不下真实订单。
- **`.bat` 文件内容必须纯 ASCII**：cmd 用 GBK 读 UTF-8，中文(连 `rem`/`echo` 里的)会乱码并**破坏后面的 `set` 行**。中文只放进 Node 程序输出，不放 .bat。改完用字节检查（>127 的字节数应为 0）。
- **同一频道不要云端 + 本地同时跑**：各自独立去重 → 会重复推送。
- **`D:\PM-NO2`（Polaris 量化项目）对本项目只读**：永不修改它。
- 所有新代码都在 `D:\STM` 下。

## 3. 文件结构

| 文件 | 作用 |
|---|---|
| `radar.js` | 核心：拉数据 + 扫描/持仓/观察名单/赛果预判逻辑（加密与体育共用） |
| `bot.js` | Telegram bot：消息格式化、轮询循环、定时摘要、赛果追踪、CLI |
| `index.js` | 命令行报告（给自己看，中文） |
| `启动世界杯雷达.bat` | 世界杯本地启动（PROFILE=SPORTS + 门槛 + 关信号/风格榜） |
| `启动本地雷达.bat` | 加密本地启动 |
| `.github/workflows/worldcup.yml` | 世界杯云端（**长任务版**: 一次连续跑~5h、每小时一轮 --once 并回写状态; cron 每小时尝试重启+并发锁接力。**需仓库密钥 `SPORTS_BOT_TOKEN`**） |
| `.github/workflows/radar.yml` | 加密云端（schedule 已注释=暂停；保留手动触发） |
| `.env` | 机密 token（**gitignored，不上传**） |
| `data/` | 状态文件（见 §7），云端工作流会 commit 回写 |
| `backtest-whales.js` | 历史回测工具（`node backtest-whales.js fifa-world-cup`） |
| `CHANGELOG.md` | 版本日志 |

GitHub 仓库：`https://github.com/polarisresearch2000-create/Polaris-Whale-Radar`（公开）。

## 4. 怎么运行

**本地**：双击桌面快捷方式，或：
```
node bot.js            # 持续轮询(每 POLL_MINUTES 分；设了 POLL_SECONDS 则按秒)
node bot.js --once     # 扫描一次(测试用)
node bot.js --test     # 发一条连通性测试到频道
node bot.js --results  # 打印赛果追踪/策略 ROI
node index.js          # 命令行信号报告
```
> bot 走哪个频道由环境变量 `PROFILE` 决定：`PROFILE=SPORTS` → 世界杯；空 → 加密(默认)。启动脚本里已设好。

**运行模式(2026-07-01起)：本地运行，云端已停。** 双击 `启动世界杯雷达.bat`(PROFILE=SPORTS，推送去 `.env` 的 `SPORTS_CHANNEL`=私聊 DM `7903017148`)，窗口开着=运行。`worldcup.yml` 的 `on:` 触发器已注释停用(去掉 schedule 停 cron + 去掉 workflow_dispatch 断 PAT 自重启)。要恢复云端见该文件顶部注释。**本地/云端勿同跑同一 DM**(会重复)。

**云端(已停用)**：GitHub Actions。世界杯 = `worldcup.yml`。**GitHub 免费 cron 极不可靠**(实测 */5 与 30 分钟都只 4-12h 才跑一次)，故改**长任务版**：一次运行连续 ~5h、`while` 循环每小时 `node bot.js --once` 并 commit/push 回写状态；cron 每小时尝试重启，并发锁(group=worldcup)保证同时只一个、自然接力 → 近乎不间断、每小时推一次。公开仓库 Actions 免费无限。要真·零空窗(无重启缝)需长任务自重启(PAT)或换常驻托管(Railway/Render)。
启用步骤：GitHub 仓库 → Settings → Secrets and variables → Actions → New secret，名 `SPORTS_BOT_TOKEN`、值见 `.env`；然后 Actions 页 Run workflow。**启用云端后关掉本地世界杯窗口**（避免重复）。

## 5. 频道里会推什么

| 内容 | 触发 | 加密 | 世界杯 |
|---|---|---|---|
| 📊 巨鲸持仓分析（体育=整场三方合并/加密=二元 + 💎最赚大户/⚠️输家反指） | 每 `POSITIONING_MIN` 分钟 | ✅(二元) | ✅(15分·整场三方) |
| ☀️ 今日赛前预判（含⚽大小球O/U聪明钱偏向） | 每天 HKT `PREVIEW_HOUR` 点 | ✅ | ✅(大小球仅世界杯) |
| 🏁 赛果总结 + 策略 ROI | 完赛/市场结算后 | ✅(UMA结算) | ✅(ESPN) |
| 📌 置顶①策略战绩(自动更新) | 有新结算时 + 每≥30分钟刷新 | ✅ | ✅ |
| 📅 置顶②即将开赛预判(自动更新) | 每≥30分钟刷新(只列 state=pre) | ✅ | ✅(世界杯) |
| 🏁 置顶③今日赛果(自动更新) | 有新结算时 + 每≥30分钟刷新(按最近比赛日HKT分组) | ❌ | ✅(世界杯) |
| 🎯 近期聪明钱·全体育（世界杯以外 MLB/网球…💎赢家vs🐋最大注 + 大小球/让球） | 每 `SHARP_MIN` 分(默6h) | ❌ | ✅(仅体育) |
| 🎯 全体育战绩（MLB/网球 前向 ROI，按市场解析结算，胜负/大小球/让球×跟💎/跟大户） | 有新结算时(随 sharps digest) | ❌ | ✅(仅体育) |
| 💎 赢家最新出手（名单里盈利大户近期方向性注 · 全体育全盘口 · 按时间倒序 · tx去重） | 每 `WINNER_MIN` 分(默90) | ❌ | ✅(仅体育) |
| 🐋/👑 逐条实时信号 | 每轮 | ✅ | ❌(已关，整合进持仓分析) |
| 🏆 全站顶级赢家风格榜 | 每天 | ✅ | ❌(跑题，已关) |

## 6. 关键环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `PROFILE` | (空) | `SPORTS`=用 `SPORTS_BOT_TOKEN`/`SPORTS_CHANNEL`；空=用 `TELEGRAM_*` |
| `POLY_TAG` | crypto | Polymarket 标签：`crypto` / `fifa-world-cup`（radar 在 require 时读，**须由启动脚本 `set` 成真环境变量**） |
| `VERTICAL_LABEL` | Crypto | 消息落款里的赛道名 |
| `POLL_SECONDS` | (空) | 设了就按秒轮询(本地快速)；同时把 whale 拉取量降到 500 省流量 |
| `MIN_NOTIONAL` | 1000 | 大额信号门槛(USDC)。世界杯=5000 |
| `SIGNAL_MIN_PNL` | 5000 | 算「聪明钱」的全期盈亏门槛。世界杯=20000 |
| `WATCHLIST_MIN_PNL` / `WATCHLIST_MIN_NOTIONAL` | 30000 / 100 | 观察名单收录/动作门槛。世界杯=50000 / 500 |
| `POSITIONING_MIN_NOTIONAL` | 500 | 持仓快照独立(低)门槛 |
| `POSITIONING_MIN` | 120 | 持仓快照间隔(分)。世界杯=15 |
| `PREVIEW_HOUR` | 9 | 每日预判推送时刻(HKT) |
| `SIGNALS_ENABLED` | on | 逐条信号开关；世界杯=off |
| `PROFILES_ENABLED` | on | 全站赢家风格榜；世界杯=off |
| `DIGESTS` | on | 持仓/风格摘要总开关 |
| `SHARP_ENABLED` / `SHARP_SPORTS` / `SHARP_MIN` / `SHARP_WINDOW_H` / `SHARP_TOP` / `SHARP_TRACK_TOP` | on / `mlb,tennis` / 360 / 504 / 8 / 15 | 全体育聪明钱digest：开关 / 扫哪些tag / 间隔(分) / 只看未来N小时开赛 / 显示几场 / 前向追踪锁定几场。`--sharps [--dry]` 手动快照; `--sharps-results` 前向战绩; `--quote <slug> [额]` 成本报价 |
| `WINNER_BETS_ENABLED` / `WINNER_MIN` / `WINNER_MIN_PNL` / `WINNER_MIN_BET` / `WINNER_HOURS` / `WINNER_SPORTS` | on / 90 / 100000 / 2000 / 24 / (=SHARP_SPORTS+WC) | 💎赢家最新出手feed：开关 / 间隔(分) / 上名单的PnL门槛 / 单注金额门槛 / 只看近N小时 / 扫哪些tag建名单。名单缓存 `data/winners_sports.json`(12h)。`node bot.js --winner-bets [--dry]` 手动 |

机密(在 `.env`)：`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHANNEL`(加密)、`SPORTS_BOT_TOKEN`/`SPORTS_CHANNEL`(世界杯)。

## 7. 数据 / 状态文件（`data/`）

- `seen_<tag>.json` — 逐条信号去重
- `watchlist_<tag>.json` — 加密活跃常胜钱包缓存(6h)
- `digest_<tag>.json` — 持仓/风格摘要上次推送时间戳
- `results_<tag>.json` — 赛果追踪：`predictions`(赛前锁定, 含 `eventSlug`+`totals`大小球+`spread`让球{favTeam,dogTeam,side(cover/not),pct,coverPrice,notPrice,winnerSide,winnerPnl}+`proWinner`胜负盘最赚+`clv`收盘线价值+`clvCaptured`) / `settled`(含 `ou`/`spread`结果) / `strategies`(胜负盘) / `ouStrategies`+`ouSettled`(大小球) / `spreadStrategies`+`spreadSettled`(让球 followWinner/followBig/highConsensus + cover/not分段) / `pinnedMsgId` / `trackUpdatedAt`

- `results_multisport.json` — 全体育(MLB/网球…)前向追踪：`predictions[eventSlug]`(赛前锁定, 每类 {id(gamma市场id), outcomes, prices, backedIdx, winnerIdx, settled}) / `strategies`(ml/ou/spread × followBig/followWinner 各 bets/wins/profit) / `settled`(逐项)。**按 Polymarket 市场解析结算**(`getMarketResolution`, 免 ESPN 队名匹配), 只锁"有开赛时间且未开赛"的真赛前场。

**重置追踪记录**：删对应 `results_<tag>.json` / `results_multisport.json`（干净起跑；现无已结算数据时无损失）。

## 8. 数据源

- `gamma-api.polymarket.com` — 市场/事件（`tag_slug=`、`markets/{id}` 读结算 outcomePrices）
- `data-api.polymarket.com` — `/trades`（`filterType=CASH&filterAmount=` 服务端按金额过滤；`market=` 按市场拉）、`/positions`、`/value`、`/activity`
- `clob.polymarket.com/book` — 实时买卖盘
- `user-pnl-api.polymarket.com/user-pnl` — 钱包全期盈亏(最后一点=总盈亏)；`lb-api.polymarket.com/profit` — 盈利榜
- `site.api.espn.com/.../soccer/fifa.world/scoreboard` — 免费：比分、状态、开赛时间(`date`)、DraftKings 赔率

## 9. 多策略 ROI 追踪 & 回测（诚实纪律）

赛前(state=pre)锁定每场预判(无前视偏差)，完赛/结算后按**下注价算 ROI**(非胜率)，并行测 4 策略：跟巨鲸多数方 / 跟最大单大户 / 高共识>85%才跟 / 反向 fade。`node bot.js --results` 查看。
**大小球前向追踪(V5.4)**：同一套纪律用到 O/U 2.5 —— 赛前锁定大户偏向+入场价+盈利大户押哪边(`getTotalsSignal`)，赛后用 ESPN 总进球判 Over/Under(≥3=大球)，并行测 3 假设：**跟💎盈利大户 / 跟大户(资金多数方) / 仅强共识≥75%才跟**，外加大球/小球分段。置顶战绩底部 + `--results` 显示。目的是**实测大小球到底有没有含金量**(押≠赢)，不是已证明的 edge。
**让球前向追踪(V6.0)**：同一套用到 spread -1.5(`getSpreadSignal`取成交量最高的-1.5盘)。依据=分析11个赢家按盘口类型,让球是第三大类(14%钱、单笔更大)。赛后按"让球方净胜球>1.5"判 cover/受让,测同3策略 + cover/not分段。至此跟踪覆盖赢家~80%的钱(胜负+大小球+让球)。
**当前样本太小，不足以证明任何 edge** —— 让 forward 跑、攒到几十场再说。**绝不拿小样本的漂亮数字对外宣传。**

**CLV 收盘线价值(V5.6，V6.1扩)**：`getClosingPrices` 临近开赛(≤90分钟)抓一次价，存 `prediction.clv`(含 `ml`胜负/`ou`大小球/`spread`让球 三条)，算 `近开赛价 − 入场价`。**正 CLV = 买在好价位 = 有 edge 最快的领先指标(不必等赛果)**。置顶+`--results` 显示三线均CLV+赢线率。
**多体育 O/U/让球(V6.1)**：`multiSportSentiment` 里非世界杯(MLB/网球)每场除胜负盘外，用 `sideSignal(mk)` 从该场已有 markets 找**主 O/U 盘 + 主让球盘**(成交量最高)算大户偏向+💎赢家，显示在「🎯 近期聪明钱·全体育」里。子盘太薄(<门槛)自动省略。窗口默认放宽到21天(MLB 有量的对局多在2~3周内)。
**多体育前向 ROI 追踪(V6.3)**：`trackMultiSport` 锁定赛前信号(存 gamma 市场 id + backed/winner outcome + 入场价) → 开赛后用 `getMarketResolution(id)` 拿赢家 outcome → 按下注价算 ROI(胜负/大小球/让球 × 跟💎/跟大户)。**用 Polymarket 解析结算, 不接 ESPN**(uniform、免球队/球员名匹配)。`--sharps-results` 查看; digest 有新结算自动推「🎯 全体育战绩」。⚠️只锁"有开赛时间且未开赛"的场杜绝 look-ahead。

## 9.5 个人自用转型 & ROI 路线（V5.6 起）

项目从「卖铲子内容产品」转为**个人自用工具**。⚠️ 立项结论仍是「散户数据无可交易 edge」，转去下注=推翻地基，故纪律更严。**Kelly 不创造 ROI，只放大已有 edge；顺序必须是先证明 edge、再控成本、最后才 Kelly**：
1. **✅ CLV 追踪(V5.6 已建)** — 最快判断有没有 edge。
2. **✅ 成本感知 ROI(V6.2 已建)** — `getExecQuote`/`quoteMatch` 用 `clob/book` 算真实点差/深度/VWAP 滑点，`node bot.js --quote <slug> [额]` 报"能成交的价"+点差/流动性闸门。(TODO:自动挂到 preview)
3. **❌ 个人下注台账** — 记真实每注，跟踪已实现 ROI vs 预测。
4. **❌ 分数 Kelly(¼~½)** — 仅在 1-3 成立后，按实测 edge/方差定仓，叠单注上限+流动性上限。GIGO。
> 自用解锁：可显示裸地址/订单簿/点差(不再为"干净独家"美化)。**非投资/博彩建议；任何投入当可全亏的风险资金。**

## 10. 版本约定（每次迭代必做）

升级 = 改代码 + 在**三处**同步版本号：`bot.js` 的 `const VERSION` + 两个 `.bat` 横幅 + `CHANGELOG.md` 加一条。

## 11. 信号质量规则（资金信号红线，持续沉淀）

> 这是「什么能发/不能发」的判断依据。✅=已实现，⚠️=部分，❌=待做(TODO)。改代码涉及信号时务必对照。

| 规则 | 现状 | 说明 / 代码位置 |
|---|---|---|
| **什么算聪明钱** | ✅ | all-time PnL ≥ $50k 记 💎(`getWalletScore` 交叉 user-pnl-api)。⚠️注意:高 PnL 也可能是**做市机器人**，未区分(见下) |
| **聪明钱 vs 做市机器人** | ⚠️ | V4.5 上了**本场对冲过滤**:押注分散在多个互斥结果(集中度 `DIR_MIN`<80%)的钱包不当 💎/🐋(`marketSentiment` 用 `byOutcome` 算，零额外 API)。仍未做:全局 MM 识别(需拉钱包交易史看频率/breadth)、同一市场 Yes+No 对冲(三方只取 Yes 侧漏此型) |
| **同一钱包多地址聚类** | ❌ | 一个人用多地址会虚增"人数/共识"。TODO:按出入金关联或行为指纹聚类 |
| **赛前才算"提前聪明钱"** | ✅ | 赛果追踪(`capturePredictions`)只在 `state==="pre"` 捕捉；持仓分析(`marketSentiment`)按 `event.startTime` 过滤,**`now>=开赛`整场跳过**(V4.4 修复)。 |
| **不碰的体育市场** | ✅/更新 | **持仓digest**(`marketSentiment`)仍只统计主胜/平/客胜(SPORTS_NOISE 排除衍生)。但 O/U大小球 与 spread让球 现在有**专用信号+前向追踪**(getTotalsSignal/getSpreadSignal, V5.3/V6.0) —— 因数据证明赢家把80%的钱押在 胜负+大小球+让球。仍不碰:准确比分/球员props/半场/网球分盘(=散户) |
| **流动性下限** | ✅引擎 | V6.2 `getExecQuote`/`quoteMatch` 用 clob/book 算**能成交价+吃单深度**;`node bot.js --quote <slug> [额]` 报深度不足⚠️。TODO:把闸门自动挂到 preview(现为按需查) |
| **价差(spread)上限** | ✅引擎 | V6.2 `quoteMatch` 用 clob/book 买卖一档算真实点差 + VWAP 滑点;点差>`SPREAD_MAX_CENTS`(默5¢) 标⚠️點差過大。TODO:自动挂到 preview |
| **金额门槛** | ✅ | `MIN_NOTIONAL` 等(世界杯=$5000)；持仓快照独立低门槛 `POSITIONING_MIN_NOTIONAL=$500` |

## 12. 代码审查清单（资金信号专项 · 每次改信号逻辑必查）

改动 `radar.js`/`bot.js` 的信号/持仓/赛果逻辑后，逐条对照(也是 `/code-review` 与 code-review 插件应聚焦的点)：

1. **重复推送** — 逐条信号靠 `seen_<tag>.json`(key=钱包+市场+时间戳+结果)；摘要靠 `digest_<tag>.json` 时间戳节流；**云端+本地勿同跑同频道**。
2. **时间戳单位** — 成交 `t.timestamp`=秒；`kickoffMs`=毫秒；`leadMin=(kickoffMs - betTs*1000)/60000`。混用秒/毫秒会算错领先量。
3. **BUY/SELL 方向** — 统计只取 `t.side==="BUY"`；Yes/No 看 `t.outcome`。别把卖出当买入、别把押 No 当押 Yes。
4. **价格单位** — `usd = size(股) × price(0~1 概率)`；`entryPrice = usd/shares`。别把概率当美元、别漏乘。
5. **offset/limit 漏数据** — `/trades?limit=500`；极活跃盘 >500 笔合格成交会被截断而少算。事件分页 `2×100`。
6. **maker/taker** — ✅已核实(2026-06-20):同一笔成交在 data-api `/trades` 只返回一行，`takerOnly=true` 与默认结果**完全一致**(245=245，按 tx+钱包+size+ts 全唯一)，**无重复计数**。
7. **赛后交易误判** — ✅已修(V4.4):持仓分析按 `event.startTime`(备用 `market.gameStartTime`)过滤,`now>=开赛`整场跳过,in-play 不再当"提前布局聪明钱"。改信号逻辑时勿回退此过滤。

## 13. 战略现状 & 下一步

- 功能已**基本完整，建议冻结**（避免复杂度蔓延）。
- 真正瓶颈是**非功能**两件：① 加 `SPORTS_BOT_TOKEN` 密钥 → 世界杯 24h 云端(数据不漏)；② 发 Threads 引流（二维码在 `D:\STM\promo\worldcup-channel-qr.png`，文案见对话/记忆）。
- 变现路径：免费频道养受众 → 返佣/affiliate（零门槛）→ 免费/VIP 订阅，收 USDC。定位「数据分析」非「投注建议」(香港合规)。
- token 正式公开推广前建议 `@BotFather` `/revoke` 重置(曾在聊天出现过)。
