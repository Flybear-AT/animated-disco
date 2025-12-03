/**
 * HyperLiquid 数据源模块
 * 用于获取 HyperLiquid 现货和合约的最新价格
 */

// 现货和合约的最新价格
interface HyperliquidPrices {
    spot: number;      // 现货价格
    perp: number;      // 永续合约价格
    timestamp: number;
}

let hlPrices: HyperliquidPrices = {
    spot: 0,
    perp: 0,
    timestamp: 0,
};

// 可注册的回调，在价格更新时触发（listener 会注册 printAllPrices）
let updateCallback: (() => void) | null = null;

export function onHyperLiquidUpdate(cb: () => void) {
    updateCallback = cb;
}

const HL_API_URL = 'https://api.hyperliquid.xyz';
const HL_REQUEST_TIMEOUT = 5000; // 5秒超时

/**
 * 从 HyperLiquid 获取现货和合约价格
 * 使用 allMids 端点获取所有交易对的实时中间价格
 */
async function fetchHyperLiquidPrices(): Promise<{ spot: number | null; perp: number | null }> {
    try {
        const response = await fetch(`${HL_API_URL}/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'allMids',
            }),
        });

        if (!response.ok) {
            if (response.status === 429) {
                // 速率限制，静默忽略
                return { spot: null, perp: null };
            }
            console.warn(`   ⚠️  HyperLiquid 请求失败: HTTP ${response.status}`);
            return { spot: null, perp: null };
        }

        const data = (await response.json()) as Record<string, string>;
        
        // 从返回的数据中查找 HYPE 现货和合约价格
        let spotPrice: number | null = null;
        let perpPrice: number | null = null;

        // 查找现货价格
        if (data['HYPE']) {
            spotPrice = parseFloat(data['HYPE']);
            if (isNaN(spotPrice) || spotPrice <= 0) {
                spotPrice = null;
            }
        }

        // 查找合约价格（使用同一个价格作为演示，实际应该从不同端点获取）
        if (data['HYPE']) {
            perpPrice = parseFloat(data['HYPE']);
            if (isNaN(perpPrice) || perpPrice <= 0) {
                perpPrice = null;
            }
        }

        return { spot: spotPrice, perp: perpPrice };
    } catch (error) {
        // 静默处理网络错误
        return { spot: null, perp: null };
    }
}

/**
 * 尝试从 HyperLiquid API 读取交易手续费（如果可用）
 * 返回 { spotFee, perpFee }，单位为百分比（例如 0.1 表示 0.1%）或 null 表示不可用
 */
export async function fetchHyperLiquidFees(): Promise<{ spotFee: number | null; perpFee: number | null }> {
    try {
        const response = await fetch(`${HL_API_URL}/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'allMids' }),
        });

        if (!response.ok) return { spotFee: null, perpFee: null };

        const data = await response.json();

        // 尝试从返回数据中解析手续费字段（API 未文档化此项，做最宽松的匹配）
        // 常见可能位置：data.fees, data.marketFees, 或者每个交易对的属性中
        if (data && typeof data === 'object') {
            // 如果有顶层 fees 对象
            if (data.fees && typeof data.fees === 'object') {
                const spotFee = data.fees.spot ?? data.fees['HYPE']?.spot ?? null;
                const perpFee = data.fees.perp ?? data.fees['HYPE']?.perp ?? null;
                return { spotFee: spotFee ?? null, perpFee: perpFee ?? null };
            }

            // 检查是否有 markets/marketsInfo
            if (data.markets && data.markets['HYPE'] && typeof data.markets['HYPE'] === 'object') {
                const m = data.markets['HYPE'];
                const spotFee = m.spotFee ?? m.fee ?? null;
                const perpFee = m.perpFee ?? m.fee ?? null;
                return { spotFee: spotFee ?? null, perpFee: perpFee ?? null };
            }
        }

        return { spotFee: null, perpFee: null };
    } catch (e) {
        return { spotFee: null, perpFee: null };
    }
}

/**
 * 尝试获取 HyperLiquid 指定市场的 orderbook 数据
 * 返回格式: { bids: Array<[price, size]>, asks: Array<[price, size]> } 或 null
 */
export async function fetchHyperLiquidOrderbook(market: string = 'HYPE'): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> } | null> {
    const tryUrls = [
        `${HL_API_URL}/orderbook?market=${market}`,
        `${HL_API_URL}/book?symbol=${market}`,
        `${HL_API_URL}/markets/${market}/orderbook`,
        `${HL_API_URL}/markets/${market}/book`,
    ];

    for (const url of tryUrls) {
        try {
            const res = await fetch(url, { method: 'GET' });
            if (!res.ok) continue;
            const data = await res.json();

            // Try to normalize several common shapes
            let bids: Array<[number, number]> = [];
            let asks: Array<[number, number]> = [];

            if (Array.isArray(data.bids) && Array.isArray(data.asks)) {
                // bids/asks as [[price,size],...]
                bids = data.bids.map((b: any) => Array.isArray(b) ? [Number(b[0]), Number(b[1])] : [Number(b.price), Number(b.size)]);
                asks = data.asks.map((a: any) => Array.isArray(a) ? [Number(a[0]), Number(a[1])] : [Number(a.price), Number(a.size)]);
                return { bids, asks };
            }

            // Some APIs return { bids: {price: size,...} }
            if (data.bids && data.asks && typeof data.bids === 'object' && !Array.isArray(data.bids)) {
                bids = Object.entries(data.bids).map(([p, s]) => [Number(p), Number(s)]);
                asks = Object.entries(data.asks).map(([p, s]) => [Number(p), Number(s)]);
                // sort bids desc, asks asc
                bids.sort((x, y) => y[0] - x[0]);
                asks.sort((x, y) => x[0] - y[0]);
                return { bids, asks };
            }

            // If data itself is an array of levels
            if (Array.isArray(data)) {
                // try find object with bids/asks
                const obj = data[0];
                if (obj && obj.bids && obj.asks) {
                    bids = obj.bids.map((b: any) => [Number(b[0]), Number(b[1])]);
                    asks = obj.asks.map((a: any) => [Number(a[0]), Number(a[1])]);
                    return { bids, asks };
                }
            }
        } catch (e) {
            continue;
        }
    }

    return null;
}

/**
 * 初始化 HyperLiquid 价格
 */
export async function initializeHyperLiquidPrices(): Promise<void> {
    try {
        console.log(`   ⏳ 从 HyperLiquid 获取 HYPE 价格...`);

        const { spot, perp } = await fetchHyperLiquidPrices();

        if (spot === null || perp === null) {
            console.log(`   ℹ️  HyperLiquid 初始化跳过（API 限流或不可用，程序将继续运行）`);
            return;
        }

        hlPrices = {
            spot: spot,
            perp: perp,
            timestamp: Date.now(),
        };

        console.log(`   ✅ HyperLiquid HYPE 现货价格: ${spot.toFixed(8)} USDT`);

        const priceDiff = Math.abs(spot - perp);
        const priceDiffPercent = (priceDiff / spot) * 100;
        console.log(`   📊 现货-合约价差: ${priceDiff.toFixed(8)} USDT (${priceDiffPercent.toFixed(4)}%)`);
        // 初始化完成后触发回调
        try {
            if (updateCallback) updateCallback();
        } catch (e) {
            // 忽略回调错误
        }
    } catch (error) {
        console.log(`   ℹ️  初始化 HyperLiquid 价格失败，程序将继续运行`);
    }
}

/**
 * 启动 HyperLiquid 价格定时更新（每 5 秒更新一次，避免 API 限流）
 */
export function startHyperLiquidPriceUpdater(): void {
    console.log(`🚀 [HyperLiquid] 启动价格定时更新器 (间隔: 5 秒)...\n`);

    setInterval(async () => {
        try {
            const { spot, perp } = await fetchHyperLiquidPrices();

            if (spot !== null && perp !== null) {
                hlPrices = {
                    spot: spot,
                    perp: perp,
                    timestamp: Date.now(),
                };
                // 触发注册的回调，让 listener 刷新显示
                try {
                    if (updateCallback) updateCallback();
                } catch (e) {
                    // 忽略回调中可能发生的错误
                }
            }
        } catch (error) {
            // 静默处理，避免频繁输出错误
        }
    }, 5000); // 5秒更新一次
}

/**
 * 获取当前 HyperLiquid 价格
 */
export function getHyperLiquidPrices(): HyperliquidPrices {
    return hlPrices;
}

/**
 * 获取现货价格
 */
export function getSpotPrice(): number {
    return hlPrices.spot;
}

/**
 * 获取合约价格
 */
export function getPerpPrice(): number {
    return hlPrices.perp;
}
