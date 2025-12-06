// ═══════════════════════════════════════════════════════════
// 🤖 JERCAT PROFIT MAXIMIZER - SERVEUR NODE.JS 24/7
// Version: 2.0 - Web Service pour Render
// ═══════════════════════════════════════════════════════════

const express = require('express');
const { ethers } = require('ethers');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ═══════════════════════════════════════════════════════════
// 🔐 CONFIGURATION
// ═══════════════════════════════════════════════════════════

const CONFIG = {
    // Wallet (CONFIGURE VIA RENDER ENVIRONMENT VARIABLES)
    PRIVATE_KEY: process.env.PRIVATE_KEY || '',
    
    // Blockchain BSC
    BSC_RPC: 'https://bsc-dataseed.binance.org',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    JERCAT_WALLET: '0x7C08b7E9862bd3826c0de1741a2d26770C39903d',
    JERCAT_FEE_BNB: '0.001',
    PANCAKE_ROUTER: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    
    // Tokens
    TOKEN_ADDRESSES: {
        'BTCUSDT': '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
        'ETHUSDT': '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        'BNBUSDT': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
    },
    
    // Trading
    CRYPTO: process.env.CRYPTO || 'BTCUSDT',
    CAPITAL: parseFloat(process.env.TRADING_CAPITAL) || 100,
    TRADE_PERCENT: parseFloat(process.env.TRADE_PERCENT) || 15,
    TAKE_PROFIT_PCT: parseFloat(process.env.TAKE_PROFIT_PCT) || 5,
    STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT) || 2,
    MIN_SCORE: parseInt(process.env.MIN_SCORE) || 60,
    TRAILING_START: parseFloat(process.env.TRAILING_START) || 2,
    TRAILING_DELTA: parseFloat(process.env.TRAILING_DELTA) || 1.5,
    TRADING_MODE: process.env.TRADING_MODE || 'aggressive'
};

// ═══════════════════════════════════════════════════════════
// 📊 STATE GLOBAL
// ═══════════════════════════════════════════════════════════

let state = {
    provider: null,
    wallet: null,
    account: null,
    currentPrice: 0,
    priceHistory: [],
    volumeHistory: [],
    tradingCapital: CONFIG.CAPITAL,
    initialCapital: CONFIG.CAPITAL,
    botRunning: false,
    isTrading: false,
    currentPosition: null,
    lastBuyPrice: 0,
    positionAmount: 0,
    positionTokens: null,
    entryFees: 0,
    highestPrice: 0,
    trailingActive: false,
    indicators: {},
    signals: {},
    lastMacdHist: 0,
    trades: [],
    portfolio: { profit: 0, wins: 0, losses: 0 },
    consecutiveWins: 0,
    consecutiveLosses: 0,
    selectedCrypto: CONFIG.CRYPTO,
    tradingMode: CONFIG.TRADING_MODE,
    approvedTokens: {},
    usdtBalance: 0,
    logs: [],
    maxLogs: 100
};

function log(msg, type = 'info') {
    const timestamp = new Date().toISOString();
    const time = new Date().toLocaleTimeString('fr-FR');
    const logEntry = { timestamp, time, msg, type };
    
    state.logs.unshift(logEntry);
    if (state.logs.length > state.maxLogs) {
        state.logs = state.logs.slice(0, state.maxLogs);
    }
    
    const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️';
    console.log(`[${time}] ${icon} ${msg}`);
}

// ═══════════════════════════════════════════════════════════
// 🔧 WALLET
// ═══════════════════════════════════════════════════════════

async function initWallet() {
    log('🔑 Initialisation du wallet...', 'info');
    
    if (!CONFIG.PRIVATE_KEY) {
        log('❌ PRIVATE_KEY manquante!', 'error');
        return false;
    }
    
    try {
        state.provider = new ethers.providers.JsonRpcProvider(CONFIG.BSC_RPC);
        const key = CONFIG.PRIVATE_KEY.startsWith('0x') ? CONFIG.PRIVATE_KEY : '0x' + CONFIG.PRIVATE_KEY;
        state.wallet = new ethers.Wallet(key, state.provider);
        state.account = state.wallet.address;
        
        const network = await state.provider.getNetwork();
        log(`✅ Wallet: ${state.account.slice(0, 10)}...`, 'success');
        log(`✅ Network: BSC (${network.chainId})`, 'success');
        
        await updateBalance();
        return true;
    } catch (error) {
        log(`❌ Erreur wallet: ${error.message}`, 'error');
        return false;
    }
}

async function updateBalance() {
    if (!state.wallet) return;
    try {
        const USDT_ABI = ['function balanceOf(address account) view returns (uint256)'];
        const usdtContract = new ethers.Contract(CONFIG.USDT, USDT_ABI, state.provider);
        const balance = await usdtContract.balanceOf(state.account);
        state.usdtBalance = parseFloat(ethers.utils.formatUnits(balance, 18));
        log(`💰 Balance USDT: ${state.usdtBalance.toFixed(2)} USDT`, 'info');
        return state.usdtBalance;
    } catch (error) {
        log(`❌ Erreur balance: ${error.message}`, 'error');
        return 0;
    }
}

// ═══════════════════════════════════════════════════════════
// 📡 WEBSOCKET
// ═══════════════════════════════════════════════════════════

let ws = null;

function initWebSocket() {
    if (ws) try { ws.close(); } catch (e) {}
    
    const symbol = state.selectedCrypto.toLowerCase();
    log(`📡 WebSocket: ${state.selectedCrypto}...`, 'info');
    
    ws = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@ticker`);
    
    ws.on('open', () => log(`✅ WebSocket: ${state.selectedCrypto}`, 'success'));
    
    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            state.currentPrice = parseFloat(parsed.c);
            const volume = parseFloat(parsed.v);
            
            state.priceHistory.push(state.currentPrice);
            state.volumeHistory.push(volume);
            
            if (state.priceHistory.length > 200) state.priceHistory.shift();
            if (state.volumeHistory.length > 50) state.volumeHistory.shift();
            
            if (state.priceHistory.length >= 50) updateIndicators();
            
            if (state.currentPosition && state.trailingActive) {
                if (state.currentPrice > state.highestPrice) {
                    state.highestPrice = state.currentPrice;
                }
            }
        } catch (error) {
            log(`❌ Erreur WS: ${error.message}`, 'error');
        }
    });
    
    ws.on('error', (error) => log(`❌ WS error: ${error.message}`, 'error'));
    ws.on('close', () => {
        log('🔴 WS fermé, reconnexion 5s...', 'warning');
        setTimeout(initWebSocket, 5000);
    });
}

// ═══════════════════════════════════════════════════════════
// 📊 INDICATEURS
// ═══════════════════════════════════════════════════════════

function calculateEMA(prices, period) {
    if (prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = (prices[i] - ema) * k + ema;
    }
    return ema;
}

function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

function calculateMACD(prices) {
    if (prices.length < 26) return { macd: 0, hist: 0 };
    const ema12 = calculateEMA(prices, 12);
    const ema26 = calculateEMA(prices, 26);
    const macd = ema12 - ema26;
    const macdLine = [];
    for (let i = 26; i <= prices.length; i++) {
        const slice = prices.slice(0, i);
        macdLine.push(calculateEMA(slice, 12) - calculateEMA(slice, 26));
    }
    const signal = calculateEMA(macdLine, 9);
    return { macd, hist: macd - signal };
}

function updateIndicators() {
    if (state.priceHistory.length < 50) return;
    
    state.indicators.ema9 = calculateEMA(state.priceHistory, 9);
    state.indicators.ema21 = calculateEMA(state.priceHistory, 21);
    state.indicators.rsi = calculateRSI(state.priceHistory, 14);
    
    const macd = calculateMACD(state.priceHistory);
    state.lastMacdHist = state.indicators.macdHist || 0;
    state.indicators.macd = macd.macd;
    state.indicators.macdHist = macd.hist;
    
    if (state.volumeHistory.length >= 20) {
        state.indicators.volumeAvg = state.volumeHistory.slice(-20).reduce((a, b) => a + b, 0) / 20;
    }
    state.indicators.volume = state.volumeHistory[state.volumeHistory.length - 1] || 0;
    
    updateSignals();
}

function updateSignals() {
    const { ema9, ema21, rsi, macdHist, volume, volumeAvg } = state.indicators;
    
    const allSignals = {
        trend: ema9 > ema21,
        rsi: rsi >= 20 && rsi <= 50,
        macd: macdHist > 0 && state.lastMacdHist <= 0,
        volume: volume > volumeAvg * 1.2
    };
    
    let activeSignals = {};
    if (state.tradingMode === 'aggressive') {
        activeSignals = {
            trend: allSignals.trend,
            rsi: allSignals.rsi,
            volume: allSignals.volume
        };
    } else {
        activeSignals = allSignals;
    }
    
    state.signals = activeSignals;
}

// ═══════════════════════════════════════════════════════════
// 🎯 TRADING
// ═══════════════════════════════════════════════════════════

function getTradeSignal() {
    if (!state.currentPosition) {
        const signals = Object.values(state.signals);
        const score = Math.round((signals.filter(s => s).length / signals.length) * 100);
        
        if (score >= CONFIG.MIN_SCORE) {
            const reasons = [];
            if (state.signals.trend) reasons.push('EMA↑');
            if (state.signals.rsi) reasons.push(`RSI:${state.indicators.rsi.toFixed(0)}`);
            return { signal: 'BUY', score, reason: reasons.join('|') };
        }
        return { signal: null, score: 0 };
    } else {
        const profitPct = ((state.currentPrice - state.lastBuyPrice) / state.lastBuyPrice) * 100;
        
        if (profitPct <= -CONFIG.STOP_LOSS_PCT) {
            return { signal: 'SELL', score: 100, reason: `SL ${profitPct.toFixed(2)}%` };
        }
        
        if (!state.trailingActive && profitPct >= CONFIG.TRAILING_START) {
            state.trailingActive = true;
            state.highestPrice = state.currentPrice;
            log(`📈 Trailing activé à +${profitPct.toFixed(2)}%`, 'success');
        }
        
        if (state.trailingActive) {
            const dropFromHigh = ((state.highestPrice - state.currentPrice) / state.highestPrice) * 100;
            if (dropFromHigh >= CONFIG.TRAILING_DELTA) {
                return { signal: 'SELL', score: 100, reason: `Trailing -${dropFromHigh.toFixed(2)}%` };
            }
        }
        
        if (profitPct >= CONFIG.TAKE_PROFIT_PCT) {
            return { signal: 'SELL', score: 100, reason: `TP +${profitPct.toFixed(2)}%` };
        }
        
        return { signal: null, score: 0 };
    }
}

async function executeTrade(tradeType, score, reason) {
    if (state.isTrading) return;
    state.isTrading = true;
    
    log(`${tradeType === 'BUY' ? '🟢' : '🔴'} ${tradeType} - ${reason}`, tradeType === 'BUY' ? 'success' : 'warning');
    
    let basePercent = CONFIG.TRADE_PERCENT;
    if (state.consecutiveWins >= 2) basePercent = Math.min(basePercent * 1.3, 30);
    if (state.consecutiveLosses >= 2) basePercent = Math.max(basePercent * 0.7, 5);
    if (score >= 80) basePercent = Math.min(basePercent * 1.2, 35);
    
    const tradeAmount = (state.tradingCapital * basePercent) / 100;
    log(`💰 Montant: ${tradeAmount.toFixed(2)} USDT (${basePercent.toFixed(1)}%)`, 'info');
    
    let netProfit = 0;
    
    // MODE SIMULATION (si pas de wallet)
    if (!state.wallet) {
        if (tradeType === 'BUY') {
            state.currentPosition = 'BUY';
            state.lastBuyPrice = state.currentPrice;
            state.positionAmount = tradeAmount;
            state.tradingCapital -= tradeAmount;
            state.highestPrice = state.currentPrice;
            state.trailingActive = false;
            log(`📈 POSITION OUVERTE (sim)`, 'success');
        } else {
            const profitPct = ((state.currentPrice - state.lastBuyPrice) / state.lastBuyPrice) * 100;
            netProfit = state.positionAmount * (profitPct / 100);
            state.tradingCapital += state.positionAmount + netProfit;
            state.portfolio.profit += netProfit;
            
            if (netProfit > 0) {
                state.portfolio.wins++;
                state.consecutiveWins++;
                state.consecutiveLosses = 0;
            } else {
                state.portfolio.losses++;
                state.consecutiveLosses++;
                state.consecutiveWins = 0;
            }
            
            log(`📉 POSITION FERMÉE (sim): ${netProfit >= 0 ? '+' : ''}${netProfit.toFixed(2)} USDT`, netProfit >= 0 ? 'success' : 'error');
            state.currentPosition = null;
            state.trailingActive = false;
        }
        
        const newTrade = {
            id: Date.now(),
            time: new Date().toLocaleTimeString('fr-FR'),
            type: tradeType,
            price: state.currentPrice.toFixed(2),
            amount: tradeAmount.toFixed(2),
            profit: netProfit.toFixed(2),
            reason: reason,
            score: score,
            mode: 'simulation'
        };
        
        state.trades.unshift(newTrade);
        state.trades = state.trades.slice(0, 20);
    }
    
    // TODO: MODE RÉEL - Implémenter logique PancakeSwap
    
    state.isTrading = false;
}

// ═══════════════════════════════════════════════════════════
// ⏰ BOT LOOP
// ═══════════════════════════════════════════════════════════

let botInterval = null;

function startBot() {
    if (botInterval) return;
    state.botRunning = true;
    
    log('🚀 BOT DÉMARRÉ', 'success');
    log(`💰 Capital: ${state.tradingCapital} USDT`, 'info');
    
    botInterval = setInterval(() => {
        if (state.priceHistory.length < 50) return;
        
        updateIndicators();
        const signal = getTradeSignal();
        
        if (signal.signal && !state.isTrading) {
            executeTrade(signal.signal, signal.score, signal.reason);
        }
    }, 3000);
}

function stopBot() {
    if (botInterval) {
        clearInterval(botInterval);
        botInterval = null;
        state.botRunning = false;
        log('🛑 BOT ARRÊTÉ', 'warning');
    }
}

// ═══════════════════════════════════════════════════════════
// 🌐 API
// ═══════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.json({
        status: 'alive',
        uptime: process.uptime(),
        bot: {
            running: state.botRunning,
            position: state.currentPosition,
            price: state.currentPrice,
            capital: state.tradingCapital.toFixed(2)
        }
    });
});

app.get('/api/status', (req, res) => {
    const totalTrades = state.portfolio.wins + state.portfolio.losses;
    const winRate = totalTrades > 0 ? ((state.portfolio.wins / totalTrades) * 100).toFixed(0) : 0;
    
    res.json({
        bot: {
            running: state.botRunning,
            mode: state.tradingMode,
            crypto: state.selectedCrypto,
            hasWallet: !!state.wallet
        },
        price: state.currentPrice,
        position: state.currentPosition,
        capital: state.tradingCapital.toFixed(2),
        portfolio: {
            profit: state.portfolio.profit.toFixed(2),
            wins: state.portfolio.wins,
            losses: state.portfolio.losses,
            winRate: winRate
        },
        trades: state.trades.slice(0, 10),
        logs: state.logs.slice(0, 20)
    });
});

app.post('/api/bot/start', (req, res) => {
    startBot();
    res.json({ success: true });
});

app.post('/api/bot/stop', (req, res) => {
    stopBot();
    res.json({ success: true });
});

app.post('/api/config/capital', (req, res) => {
    const { capital } = req.body;
    state.tradingCapital = parseFloat(capital);
    state.initialCapital = parseFloat(capital);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// 🚀 START
// ═══════════════════════════════════════════════════════════

async function start() {
    console.log('\n🤖 JERCAT PROFIT MAXIMIZER - SERVEUR NODE.JS\n');
    
    const walletOk = await initWallet();
    if (!walletOk) {
        log('⚠️ MODE SIMULATION', 'warning');
    }
    
    initWebSocket();
    
    app.listen(PORT, () => {
        log(`✅ Serveur sur port ${PORT}`, 'success');
        log(`📡 Health: /health`, 'info');
        log(`📊 Status: /api/status`, 'info');
        
        if (process.env.AUTO_START === 'true') {
            setTimeout(startBot, 5000);
        }
    });
}

process.on('SIGTERM', () => {
    stopBot();
    process.exit(0);
});

start().catch(error => {
    log(`❌ ERREUR: ${error.message}`, 'error');
    process.exit(1);
});
