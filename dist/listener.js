"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const viem_1 = require("viem");
const accounts_1 = require("viem/accounts");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Import ABI JSON files
const v3_abi_json_1 = __importDefault(require("./v3_abi.json"));
const v4_abi_json_1 = __importDefault(require("./v4_abi.json"));
const v4_pool_abi_json_1 = __importDefault(require("./v4_pool_abi.json"));
// Import HyperLiquid 数据源
const hyperliquid_1 = require("./hyperliquid");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// --- CONFIGURATION START ---
// 配置（优先从环境变量读取）
const HYPER_EVM_CHAIN_ID = parseInt(process.env.HYPER_EVM_CHAIN_ID ?? '11155111', 10);
const WS_URL = process.env.WS_URL ?? 'ws://your-hyperevm-node.com/ws';
const HTTP_URL = process.env.HTTP_URL ?? 'https://your-hyperevm-node.com';
// 私钥（生产环境请确保通过安全方式注入）
const PRIVATE_KEY = (process.env.PRIVATE_KEY ?? '0x...');
// 合约地址
const HYPE_USDT_V3_POOL = (process.env.HYPE_USDT_V3_POOL ?? '0x...');
const HYPE_USDT_V4_POOL = (process.env.HYPE_USDT_V4_POOL ?? '0x...');
const USDT_ADDRESS = (process.env.USDT_ADDRESS ?? '0x...');
const HYPE_ADDRESS = (process.env.HYPE_ADDRESS ?? '0x...');
// USDT 小数位
const USDT_DECIMALS = 6;
// 池手续费（单位：%）
// V3 是固定的，V4 需要动态读取
const V3_FEE = 0.25; // Uniswap V3 HYPE-USDT 池手续费 0.25%
let V4_FEE = 0.01; // V4 初始默认值，会通过 fee() 函数动态更新
// 套利检测阈值：价格差异大于此值时触发套利计算
const ARBITRAGE_THRESHOLD_PERCENT = 0.5; // 0.5%
// 模拟交易额
const SIMULATED_TRADE_AMOUNT_USDT = 100; // 100 USDT
// --- CONFIGURATION END ---
// 客户端初始化
const publicClient = (0, viem_1.createPublicClient)({
    chain: { id: HYPER_EVM_CHAIN_ID, name: 'HyperEVM', network: 'hyperevm', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [HTTP_URL], webSocket: [WS_URL] }, public: { http: [HTTP_URL], webSocket: [WS_URL] } } },
    transport: (0, viem_1.webSocket)(WS_URL),
});
const account = (0, accounts_1.privateKeyToAccount)(PRIVATE_KEY);
const walletClient = (0, viem_1.createWalletClient)({
    chain: { id: HYPER_EVM_CHAIN_ID, name: 'HyperEVM', network: 'hyperevm', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [HTTP_URL], webSocket: [WS_URL] }, public: { http: [HTTP_URL], webSocket: [WS_URL] } } },
    transport: (0, viem_1.http)(HTTP_URL),
    account,
});
// 去重缓存：防止同一个事件被处理多次
const processedLogsCache = new Map();
const DEDUP_TIMEOUT_MS = 5000; // 5秒内的重复日志被视为同一事件
/**
 * 检查日志是否已被处理过（去重逻辑）
 */
function isDuplicateLog(blockNumber, transactionHash, logIndex) {
    const key = `${blockNumber}-${transactionHash}-${logIndex}`;
    if (processedLogsCache.has(key)) {
        return true; // 已处理过
    }
    // 标记为已处理，并在 DEDUP_TIMEOUT_MS 后清除
    processedLogsCache.set(key, true);
    setTimeout(() => {
        processedLogsCache.delete(key);
    }, DEDUP_TIMEOUT_MS);
    return false; // 首次处理
}
let v3CurrentPrice = null;
let v4CurrentPrice = null;
/**
 * 统一打印所有四个价格，从高到低排序
 */
async function printAllPrices() {
    const prices = [];
    if (v3CurrentPrice) {
        prices.push({ source: 'V3 池', price: v3CurrentPrice.actualPrice });
    }
    if (v4CurrentPrice) {
        prices.push({ source: 'V4 池', price: v4CurrentPrice.actualPrice });
    }
    const hlPrices = (0, hyperliquid_1.getHyperLiquidPrices)();
    if (hlPrices.spot > 0) {
        prices.push({ source: '现货价格', price: hlPrices.spot });
    }
    if (hlPrices.perp > 0) {
        prices.push({ source: '合约价格', price: hlPrices.perp });
    }
    // 从高到低排序
    prices.sort((a, b) => b.price - a.price);
    if (prices.length > 0) {
        const first = prices[0];
        const last = prices[prices.length - 1];
        console.log(`\n💰 ===== 价格汇总（从高到低）=====`);
        prices.forEach((p, idx) => {
            if (idx === 0) {
                console.log(`${idx + 1}. ${p.source}: ${p.price.toFixed(8)} USDT/HYPE`);
            }
            else {
                const diffPercent = ((first.price - p.price) / first.price) * 100;
                console.log(`${idx + 1}. ${p.source}: ${p.price.toFixed(8)} USDT/HYPE (与第一名差: ${diffPercent.toFixed(4)}%)`);
            }
        });
        // 如果第一名和最后一名价差超过阈值，则保存记录到按日 CSV 文件
        const firstLastDiffPercent = ((first.price - last.price) / first.price) * 100;
        const PRICE_DIFF_SAVE_THRESHOLD_PERCENT = 0.1; // 千分之一 = 0.1%
        if (firstLastDiffPercent > PRICE_DIFF_SAVE_THRESHOLD_PERCENT) {
            try {
                const dataDir = path_1.default.resolve(process.cwd(), 'data');
                if (!fs_1.default.existsSync(dataDir))
                    fs_1.default.mkdirSync(dataDir, { recursive: true });
                const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
                const outPath = path_1.default.join(dataDir, `price_alerts-${day}.csv`);
                // CSV header
                const header = 'timestamp,v3_price,v4_price,spot_price,perp_price,first_source,first_price,last_source,last_price,firstLastDiffPercent,spot_capacity_usdt,perp_capacity_usdt\n';
                if (!fs_1.default.existsSync(outPath)) {
                    fs_1.default.writeFileSync(outPath, header, { flag: 'w' });
                }
                // prepare individual prices (if missing, write empty)
                const v3 = prices.find(p => p.source === 'V3 池')?.price ?? '';
                const v4 = prices.find(p => p.source === 'V4 池')?.price ?? '';
                const spot = prices.find(p => p.source === '现货价格')?.price ?? '';
                const perp = prices.find(p => p.source === '合约价格')?.price ?? '';
                // 先尝试从 HyperLiquid 获取 orderbook 并估算容量
                let spotCapacityUSDT = '';
                let perpCapacityUSDT = '';
                try {
                    const obSpot = await (0, hyperliquid_1.fetchHyperLiquidOrderbook)('HYPE');
                    const obPerp = await (0, hyperliquid_1.fetchHyperLiquidOrderbook)('HYPE-PERP');
                    function computeCapacityFromOrderbook(ob, buyPrice, sellPrice) {
                        if (!ob)
                            return { buyAtLow: 0, sellAtHigh: 0 };
                        // ob.bids: [[price,size],[...]] bids sorted desc; ob.asks sorted asc
                        let buyAtLow = 0; // USDT available to buy HYPE at <= buyPrice (consume asks)
                        let sellAtHigh = 0; // USDT available to sell HYPE at >= sellPrice (consume bids)
                        if (Array.isArray(ob.asks)) {
                            for (const [p, s] of ob.asks) {
                                if (p <= buyPrice) {
                                    buyAtLow += p * s;
                                }
                                else
                                    break;
                            }
                        }
                        if (Array.isArray(ob.bids)) {
                            for (const [p, s] of ob.bids) {
                                if (p >= sellPrice) {
                                    sellAtHigh += p * s;
                                }
                                else
                                    break;
                            }
                        }
                        return { buyAtLow, sellAtHigh };
                    }
                    const lowPrice = Number(last.price);
                    const highPrice = Number(first.price);
                    const spotCaps = computeCapacityFromOrderbook(obSpot, lowPrice, highPrice);
                    const perpCaps = computeCapacityFromOrderbook(obPerp, lowPrice, highPrice);
                    // 取卖出（对我们卖出 HYPE 到 HL）能接受的 USDT: sellAtHigh
                    spotCapacityUSDT = spotCaps.sellAtHigh.toFixed(2);
                    perpCapacityUSDT = perpCaps.sellAtHigh.toFixed(2);
                    console.log(`   ℹ️ HyperLiquid 容量估算 (USDT): 现货卖出侧=${spotCapacityUSDT}, 合约卖出侧=${perpCapacityUSDT}`);
                }
                catch (e) {
                    // 忽略 orderbook 错误
                }
                const line = `${new Date().toISOString()},${v3},${v4},${spot},${perp},${first.source},${first.price},${last.source},${last.price},${firstLastDiffPercent.toFixed(6)},${spotCapacityUSDT},${perpCapacityUSDT}\n`;
                fs_1.default.appendFileSync(outPath, line, { encoding: 'utf8' });
                console.log(`   💾 已保存价格差记录到 ${outPath}`);
                // 估算池内容量（仅在保存记录时打印） — 同时考虑手续费影响
                (async () => {
                    try {
                        const lowSource = prices[prices.length - 1].source;
                        const highSource = prices[0].source;
                        const lowPool = lowSource === 'V3 池' || lowSource === 'V4 池'
                            ? lowSource === 'V3 池' ? HYPE_USDT_V3_POOL : HYPE_USDT_V4_POOL
                            : HYPE_USDT_V3_POOL;
                        const highPool = highSource === 'V3 池' || highSource === 'V4 池'
                            ? highSource === 'V3 池' ? HYPE_USDT_V3_POOL : HYPE_USDT_V4_POOL
                            : HYPE_USDT_V4_POOL;
                        const lowAbi = lowSource === 'V3 池' ? v3_abi_json_1.default : v4_abi_json_1.default;
                        const highAbi = highSource === 'V3 池' ? v3_abi_json_1.default : v4_abi_json_1.default;
                        const lowCap = await estimateCapacityFromRecentSwaps(lowPool, lowAbi, Number(prices[prices.length - 1].price), 0.5, 2000);
                        const highCap = await estimateCapacityFromRecentSwaps(highPool, highAbi, Number(prices[0].price), 0.5, 2000);
                        // 读取 HyperLiquid 手续费（如果可用），并设置默认值（万5 = 0.05%）
                        const hlFees = await (0, hyperliquid_1.fetchHyperLiquidFees)();
                        const DEFAULT_HL_FEE = 0.05; // 万5
                        // 根据来源决定买卖双方手续费
                        function feeForSource(source, isBuySide) {
                            if (source === 'V3 池')
                                return V3_FEE;
                            if (source === 'V4 池')
                                return V4_FEE;
                            if (source === '现货价格')
                                return (hlFees.spotFee !== null ? Number(hlFees.spotFee) : DEFAULT_HL_FEE);
                            if (source === '合约价格')
                                return (hlFees.perpFee !== null ? Number(hlFees.perpFee) : DEFAULT_HL_FEE);
                            return DEFAULT_HL_FEE;
                        }
                        const cheapFee = feeForSource(lowSource, true);
                        const expensiveFee = feeForSource(highSource, false);
                        const lowPrice = Number(prices[prices.length - 1].price);
                        const highPrice = Number(prices[0].price);
                        // 每单位 USDT 的净收益倍率 M = (1 - f_buy)*(1 - f_sell)*(high/low) - 1
                        const m = (1 - cheapFee / 100) * (1 - expensiveFee / 100) * (highPrice / lowPrice) - 1;
                        let estimatedCapacity = 0;
                        if (m <= 0) {
                            estimatedCapacity = 0;
                            console.log(`   ⚠️ 手续费和价差导致无套利空间 (m=${(m * 100).toFixed(4)}%)，估算容量为 0`);
                        }
                        else {
                            estimatedCapacity = Math.min(lowCap, highCap);
                            // 如果我们也有 HL orderbook 的卖出侧容量，尝试纳入限制
                            const spotCapNum = spotCapacityUSDT ? Number(spotCapacityUSDT) : Infinity;
                            const perpCapNum = perpCapacityUSDT ? Number(perpCapacityUSDT) : Infinity;
                            // 如果高端是现货或合约，限制在对应的 HL 容量
                            if (highSource === '现货价格')
                                estimatedCapacity = Math.min(estimatedCapacity, spotCapNum);
                            if (highSource === '合约价格')
                                estimatedCapacity = Math.min(estimatedCapacity, perpCapNum);
                        }
                        console.log(`   ⚖️ 估算容量（考虑手续费）: ${estimatedCapacity.toFixed(2)} USDT (m=${(m * 100).toFixed(4)}%)`);
                    }
                    catch (e) {
                        // 忽略估算错误
                    }
                })();
            }
            catch (e) {
                console.warn('   ⚠️ 保存价格记录失败:', e instanceof Error ? e.message : e);
            }
        }
        console.log(`================================\n`);
    }
}
/**
 * 基于最近 Swap 日志的保守容量估计（USDT）
 * 容量定义：在低价买入并在高价卖出不会亏损的 USDT 数量（近似）
 * 方法：统计在价格区间（currentPrice ± thresholdPercent）内的历史 USDT 成交量，取低池与高池的最小值并乘以 safetyFactor
 */
async function estimateCapacityFromRecentSwaps(poolAddress, poolAbi, currentPrice, thresholdPercent = 0.5, lookbackBlocks = 2000) {
    try {
        const swapEventAbi = poolAbi.find((item) => item.name === 'Swap' && item.type === 'event');
        if (!swapEventAbi)
            return 0;
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > BigInt(lookbackBlocks) ? currentBlock - BigInt(lookbackBlocks) : 0n;
        const logs = await publicClient.getLogs({ address: poolAddress, event: swapEventAbi, fromBlock, toBlock: currentBlock });
        if (!logs || logs.length === 0)
            return 0;
        let summedUsdt = 0;
        for (const l of logs) {
            const sqrtPriceX96 = BigInt(l.args?.sqrtPriceX96 || 0);
            const priceAtLog = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 6);
            const pct = Math.abs((priceAtLog - currentPrice) / currentPrice) * 100;
            if (pct <= thresholdPercent) {
                const amount1 = Number(l.args?.amount1 || 0);
                summedUsdt += Math.abs(amount1) / (10 ** USDT_DECIMALS);
            }
        }
        const safetyFactor = 0.5; // 保守因子
        return summedUsdt * safetyFactor;
    }
    catch (e) {
        return 0;
    }
}
/**
 * 从 V4 池合约读取动态手续费
 * 手续费在链上以 uint24 存储，表示万分比 (1 = 0.01 bps, 10000 = 1%)
 */
async function fetchV4PoolFee() {
    try {
        const feeRaw = await publicClient.readContract({
            address: HYPE_USDT_V4_POOL,
            abi: v4_pool_abi_json_1.default,
            functionName: 'fee',
            args: [],
        });
        // 将 uint24 转换为百分比
        // fee 返回值的单位是 bps (basis points)
        // 10000 bps = 1%, 所以 fee/10000 = percentage
        const feePercent = feeRaw / 10000;
        console.log(`   ✅ V4 池动态手续费读取成功: ${feePercent}% (原始值: ${feeRaw} bps)`);
        return feePercent;
    }
    catch (error) {
        console.warn(`   ⚠️  无法读取 V4 池手续费，使用默认值:`, error instanceof Error ? error.message : error);
        return V4_FEE; // 返回默认值
    }
}
/**
 * 将 sqrtPriceX96 转换为实际价格
 * 公式: (sqrtPriceX96 / 2^96)^2 * 10^(token0Decimals - token1Decimals)
 */
function sqrtPriceX96ToPrice(sqrtPriceX96, token0Decimals, token1Decimals) {
    // 计算 sqrtPrice: sqrtPriceX96 / 2^96
    const sqrtPrice = Number(sqrtPriceX96) / (2 ** 96);
    // 平方得到价格
    let price = sqrtPrice * sqrtPrice;
    // 调整小数位差异
    const decimalsDiff = token0Decimals - token1Decimals;
    price = price * (10 ** decimalsDiff);
    return price;
}
/**
 * 计算套利机会
 * 假设在便宜池买入，在贵池卖出
 * 需要扣掉两边的手续费
 */
function calculateArbitrageOpportunity(cheaPrice, expensivePrice, cheapFee, // 手续费百分比
expensiveFee, // 手续费百分比
tradeAmount // USDT 金额
) {
    // 在便宜池买入：支付 USDT 获得 HYPE
    // 付出 USDT（含手续费）
    const usdtPaidCheap = tradeAmount;
    const usdtFeeCheap = (tradeAmount * cheapFee) / 100;
    const usdtAfterFeeCheap = tradeAmount - usdtFeeCheap;
    // 获得的 HYPE 数量
    const hypeBought = usdtAfterFeeCheap / cheaPrice;
    // 在贵池卖出：用 HYPE 换 USDT
    // 获得 USDT（扣除手续费）
    const usdtReceivedBeforeFee = hypeBought * expensivePrice;
    const usdtFeeExpensive = (usdtReceivedBeforeFee * expensiveFee) / 100;
    const usdtReceivedAfterFee = usdtReceivedBeforeFee - usdtFeeExpensive;
    // 计算收益
    const profit = usdtReceivedAfterFee - tradeAmount;
    const profitPercent = (profit / tradeAmount) * 100;
    const details = `
      💰 套利细节分析 (买100 USDT):
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      📍 便宜池 (买入):
         - 价格: ${cheaPrice.toFixed(8)} USDT/HYPE
         - 手续费: ${cheapFee}%
         - 支付: ${tradeAmount.toFixed(2)} USDT
         - 手续费: ${usdtFeeCheap.toFixed(4)} USDT
         - 实际支付: ${usdtAfterFeeCheap.toFixed(4)} USDT
         - 获得: ${hypeBought.toFixed(10)} HYPE
      
      📍 贵池 (卖出):
         - 价格: ${expensivePrice.toFixed(8)} USDT/HYPE
         - 手续费: ${expensiveFee}%
         - 卖出: ${hypeBought.toFixed(10)} HYPE
         - 获得: ${usdtReceivedBeforeFee.toFixed(4)} USDT
         - 手续费: ${usdtFeeExpensive.toFixed(4)} USDT
         - 实际收入: ${usdtReceivedAfterFee.toFixed(4)} USDT
      
      💵 净收益: ${profit.toFixed(4)} USDT (${profitPercent.toFixed(4)}%)
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
    return {
        canProfit: profit > 0,
        profit: profit,
        profitPercent: profitPercent,
        details: details,
    };
}
/**
 * 计算价格差异百分比
 */
function calculatePriceDifference(price1, price2) {
    if (price1 === 0)
        return 0;
    const diff = price2 > price1 ? price2 - price1 : price1 - price2;
    const percentage = (diff / price1) * 100;
    return Math.round(percentage * 10000) / 10000; // 保留 4 位小数
}
/**
 * 从最近的历史块中读取最新的 Swap 事件来初始化价格
 */
async function initializePoolPrice(poolAddress, poolName) {
    try {
        console.log(`   ⏳ 初始化 ${poolName} 价格...`);
        // 读取最近的 1000 个块中的 Swap 事件（扩大搜索范围）
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock > 1000n ? currentBlock - 1000n : 0n;
        // 使用正确的 ABI 对象
        const abi = poolName === 'V3' ? v3_abi_json_1.default : v4_abi_json_1.default;
        // 找到 Swap 事件的 ABI 定义
        const swapEventAbi = abi.find((item) => item.name === 'Swap' && item.type === 'event');
        if (!swapEventAbi) {
            console.warn(`   ⚠️  未找到 ${poolName} 的 Swap 事件 ABI`);
            return null;
        }
        const logs = await publicClient.getLogs({
            address: poolAddress,
            event: swapEventAbi,
            fromBlock: fromBlock,
            toBlock: currentBlock,
        });
        if (logs.length === 0) {
            console.warn(`   ⚠️  未找到 ${poolName} 的最近 Swap 事件`);
            return null;
        }
        // 获取最后一个 Swap 事件
        const lastLog = logs[logs.length - 1];
        const sqrtPriceX96 = BigInt(lastLog.args?.sqrtPriceX96 || 0);
        const tick = Number(lastLog.args?.tick || 0);
        // 计算实际价格
        const actualPrice = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 6);
        // 计算交易金额和方向
        const amount0 = Number(lastLog.args?.amount0 || 0);
        const amount1 = Number(lastLog.args?.amount1 || 0);
        const direction = amount0 > 0 ? '卖出 HYPE 买入 USDT' : '买入 HYPE 卖出 USDT';
        const hypeAmount = Math.abs(amount0) / (10 ** 18);
        const usdtAmount = Math.abs(amount1) / (10 ** 6);
        const poolPrice = {
            sqrtPriceX96: sqrtPriceX96,
            actualPrice: actualPrice,
            tick: tick,
            timestamp: Date.now(),
        };
        console.log(`   ✅ ${poolName} 初始价格: ${actualPrice.toFixed(8)} USDT/HYPE`);
        console.log(`      📍 区块: ${lastLog.blockNumber}`);
        console.log(`      💱 方向: ${direction}`);
        console.log(`      📊 金额: ${hypeAmount.toFixed(6)} HYPE ↔ ${usdtAmount.toFixed(4)} USDT`);
        return poolPrice;
    }
    catch (error) {
        console.warn(`   ⚠️  无法初始化 ${poolName} 价格:`, error instanceof Error ? error.message : error);
        return null;
    }
}
/**
 * 启动 V3 池监听器
 */
function startV3Listener() {
    console.log(`🚀 [V3 池] 正在连接 HyperEVM WebSocket 并监听 Swap 事件...`);
    publicClient.watchContractEvent({
        address: HYPE_USDT_V3_POOL,
        abi: v3_abi_json_1.default,
        eventName: 'Swap',
        onLogs: (logs) => {
            for (const log of logs) {
                if (isDuplicateLog(log.blockNumber, log.transactionHash, log.logIndex)) {
                    continue;
                }
                // 提取 Swap 事件参数
                const args = log.args || {};
                const sqrtPriceX96 = BigInt(args.sqrtPriceX96 || 0);
                // 计算实际价格
                // V3 pool: sqrtPriceX96 = sqrt(token1/token0) * 2^96
                // token0 = HYPE (18 decimals), token1 = USDT (6 decimals)
                // 价格 = token1 / token0 = USDT / HYPE
                const actualPrice = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 6);
                // 保存价格信息
                v3CurrentPrice = {
                    sqrtPriceX96: sqrtPriceX96,
                    actualPrice: actualPrice,
                    tick: Number(args.tick || 0),
                    timestamp: Date.now(),
                };
                // 计算交易方向和金额
                const v3Amount0 = Number(args.amount0 || 0);
                const v3Amount1 = Number(args.amount1 || 0);
                const v3Direction = v3Amount0 > 0 ? '卖出 HYPE 买入 USDT' : '买入 HYPE 卖出 USDT';
                const v3HypeAmount = Math.abs(v3Amount0) / (10 ** 18);
                const v3UsdtAmount = Math.abs(v3Amount1) / (10 ** 6);
                console.log(`\n📊 [V3 池] ${v3Direction} | HYPE: ${v3HypeAmount.toFixed(4)} | USDT: ${v3UsdtAmount.toFixed(2)}`);
                // 定时打印所有四个价格
                printAllPrices();
            }
        },
        onError: (error) => {
            console.error('[V3 监听] WebSocket 错误:', error);
        },
    });
}
/**
 * 启动 V4 池监听器
 */
function startV4Listener() {
    console.log(`🚀 [V4 池] 正在连接 HyperEVM WebSocket 并监听 Swap 事件...`);
    publicClient.watchContractEvent({
        address: HYPE_USDT_V4_POOL,
        abi: v4_abi_json_1.default,
        eventName: 'Swap',
        onLogs: (logs) => {
            for (const log of logs) {
                if (isDuplicateLog(log.blockNumber, log.transactionHash, log.logIndex)) {
                    continue;
                }
                // 提取 Swap 事件参数
                const args = log.args || {};
                const sqrtPriceX96 = BigInt(args.sqrtPriceX96 || 0);
                // 计算实际价格
                // V4 pool: sqrtPriceX96 = sqrt(token1/token0) * 2^96
                // token0 = HYPE (18 decimals), token1 = USDT (6 decimals)
                // 价格 = token1 / token0 = USDT / HYPE
                const actualPrice = sqrtPriceX96ToPrice(sqrtPriceX96, 18, 6);
                // 保存价格信息
                v4CurrentPrice = {
                    sqrtPriceX96: sqrtPriceX96,
                    actualPrice: actualPrice,
                    tick: Number(args.tick || 0),
                    timestamp: Date.now(),
                };
                // 计算交易方向和金额
                const v4Amount0 = Number(args.amount0 || 0);
                const v4Amount1 = Number(args.amount1 || 0);
                const v4Direction = v4Amount0 > 0 ? '卖出 HYPE 买入 USDT' : '买入 HYPE 卖出 USDT';
                const v4HypeAmount = Math.abs(v4Amount0) / (10 ** 18);
                const v4UsdtAmount = Math.abs(v4Amount1) / (10 ** 6);
                console.log(`\n📊 [V4 池] ${v4Direction} | HYPE: ${v4HypeAmount.toFixed(4)} | USDT: ${v4UsdtAmount.toFixed(2)}`);
                // 定时打印所有四个价格
                printAllPrices();
            }
        },
        onError: (error) => {
            console.error('[V4 监听] WebSocket 错误:', error);
        },
    });
}
/**
 * 启动监听器（同时启动 V3 和 V4）
 */
async function startListener() {
    console.log(`\n=== 启动双池 Swap 事件监听器 ===\n`);
    console.log(`📍 V3 池: ${HYPE_USDT_V3_POOL}`);
    console.log(`📍 V4 池: ${HYPE_USDT_V4_POOL}`);
    console.log(`💼 监听代币: USDT ↔ HYPE\n`);
    // 初始化两个池的价格
    console.log(`📊 正在初始化池价格和配置...\n`);
    v3CurrentPrice = await initializePoolPrice(HYPE_USDT_V3_POOL, 'V3');
    v4CurrentPrice = await initializePoolPrice(HYPE_USDT_V4_POOL, 'V4');
    // 读取 V4 动态手续费
    console.log(`\n📊 正在读取池手续费...\n`);
    V4_FEE = await fetchV4PoolFee();
    console.log(`   ✅ V3 池手续费: ${V3_FEE}%`);
    // 如果初始化成功，显示价格对比
    if (v3CurrentPrice && v4CurrentPrice) {
        const priceDiff = calculatePriceDifference(v3CurrentPrice.actualPrice, v4CurrentPrice.actualPrice);
        const priceRatio = (v4CurrentPrice.actualPrice / v3CurrentPrice.actualPrice * 100 - 100).toFixed(2);
        console.log(`\n💥 ===== 初始价格对比 =====`);
        console.log(`   V3 价格: ${v3CurrentPrice.actualPrice.toFixed(8)} USDT/HYPE`);
        console.log(`   V4 价格: ${v4CurrentPrice.actualPrice.toFixed(8)} USDT/HYPE`);
        console.log(`   价格差异: ${priceDiff.toFixed(4)}%`);
        console.log(`   V4 相比 V3: ${priceRatio}%`);
        // 检测初始套利机会
        if (priceDiff >= ARBITRAGE_THRESHOLD_PERCENT) {
            console.log(`\n🤖 ===== 检测到初始套利机会 (差异 ≥ ${ARBITRAGE_THRESHOLD_PERCENT}%) =====`);
            // 如果 V4 更贵，在 V3 买，V4 卖
            if (v4CurrentPrice.actualPrice > v3CurrentPrice.actualPrice) {
                const arb = calculateArbitrageOpportunity(v3CurrentPrice.actualPrice, v4CurrentPrice.actualPrice, V3_FEE, V4_FEE, SIMULATED_TRADE_AMOUNT_USDT);
                console.log(arb.details);
                if (arb.canProfit) {
                    console.log(`✅ 可盈利！预计收益: ${arb.profit.toFixed(4)} USDT\n`);
                }
                else {
                    console.log(`❌ 不可盈利。预计亏损: ${Math.abs(arb.profit).toFixed(4)} USDT\n`);
                }
            }
            else {
                const arb = calculateArbitrageOpportunity(v4CurrentPrice.actualPrice, v3CurrentPrice.actualPrice, V4_FEE, V3_FEE, SIMULATED_TRADE_AMOUNT_USDT);
                console.log(arb.details);
                if (arb.canProfit) {
                    console.log(`✅ 可盈利！预计收益: ${arb.profit.toFixed(4)} USDT\n`);
                }
                else {
                    console.log(`❌ 不可盈利。预计亏损: ${Math.abs(arb.profit).toFixed(4)} USDT\n`);
                }
            }
        }
        console.log(`================================\n`);
    }
    // 初始化 HyperLiquid 价格
    console.log(`📊 正在初始化 HyperLiquid 价格...\n`);
    await (0, hyperliquid_1.initializeHyperLiquidPrices)();
    // 同步尝试读取 HyperLiquid 手续费信息（如果可用）
    try {
        const fees = await (0, hyperliquid_1.fetchHyperLiquidFees)();
        if (fees.spotFee !== null || fees.perpFee !== null) {
            console.log(`   ℹ️ HyperLiquid 手续费: 现货=${fees.spotFee ?? 'n/a'}%, 合约=${fees.perpFee ?? 'n/a'}%`);
        }
        else {
            console.log(`   ℹ️ 无法从 HyperLiquid 获取手续费信息（API 不提供或格式不同）`);
        }
    }
    catch (e) {
        console.log(`   ℹ️ 读取 HyperLiquid 手续费失败`);
    }
    startV3Listener();
    startV4Listener();
    (0, hyperliquid_1.startHyperLiquidPriceUpdater)();
    // 注册 HyperLiquid 更新回调，确保 HL 价格变动也触发统一打印
    try {
        (0, hyperliquid_1.onHyperLiquidUpdate)(printAllPrices);
    }
    catch (e) {
        // 忽略注册错误
    }
    console.log(`✅ 所有监听器已启动，等待事件...\n`);
}
// 自动启动监听器
startListener();
console.log("⏳ 监听中... 等待链上交易...\n");
//# sourceMappingURL=listener.js.map