const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ==================== CONFIGURATION BOT ====================
let botConfig = {
  isRunning: false,
  mode: 'AGGRESSIVE',
  capital: 0,
  positionSizePercent: 2,
  takeProfitPercent: 1.5,
  trailingStartPercent: 0.8,
  trailingDeltaPercent: 0.3,
  stopLossPercent: 1,
  minScorePercent: 60
};

// ==================== ÉTAT DU BOT ====================
let botState = {
  currentPrice: 0,
  position: null, // { type: 'LONG'|'SHORT', entry: price, size: amount, trailing: { highest/lowest, active } }
  trades: [],
  stats: {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    winRate: 0,
    roi: 0
  },
  signals: {
    ema: { value: '--', signal: 'NEUTRAL' },
    rsi: { value: '--', signal: 'NEUTRAL' },
    macd: { value: '--', signal: 'NEUTRAL' },
    bb: { value: '--', signal: 'NEUTRAL' },
    volume: { value: '--', signal: 'NEUTRAL' },
    atr: { value: '--', signal: 'NEUTRAL' }
  },
  score: 0
};

// ==================== DONNÉES HISTORIQUES ====================
let priceHistory = [];
const MAX_HISTORY = 200;

// ==================== WEBSOCKET BINANCE ====================
let binanceWs = null;

function connectBinance() {
  if (binanceWs) {
    binanceWs.close();
  }

  binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');

  binanceWs.on('open', () => {
    console.log('🟢 WebSocket Binance connecté');
  });

  binanceWs.on('message', (data) => {
    const trade = JSON.parse(data);
    const price = parseFloat(trade.p);
    
    botState.currentPrice = price;
    priceHistory.push({
      price: price,
      time: Date.now(),
      volume: parseFloat(trade.q)
    });

    if (priceHistory.length > MAX_HISTORY) {
      priceHistory.shift();
    }

    if (botConfig.isRunning) {
      updateIndicators();
      checkTradingSignals();
      checkPosition();
    }
  });

  binanceWs.on('error', (error) => {
    console.error('❌ Erreur WebSocket:', error.message);
  });

  binanceWs.on('close', () => {
    console.log('🔴 WebSocket fermé - Reconnexion dans 5s...');
    setTimeout(connectBinance, 5000);
  });
}

// ==================== INDICATEURS TECHNIQUES ====================
function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(prices) {
  if (prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macd = ema12 - ema26;
  
  const macdLine = [];
  for (let i = 26; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    macdLine.push(e12 - e26);
  }
  
  const signal = calculateEMA(macdLine, 9);
  const histogram = macd - signal;
  
  return { macd, signal, histogram };
}

function calculateBollingerBands(prices, period = 20) {
  if (prices.length < period) return null;
  
  const slice = prices.slice(-period);
  const avg = slice.reduce((a, b) => a + b) / period;
  const variance = slice.reduce((sum, price) => sum + Math.pow(price - avg, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: avg + (stdDev * 2),
    middle: avg,
    lower: avg - (stdDev * 2)
  };
}

function calculateATR(prices, period = 14) {
  if (prices.length < period + 1) return 0;
  
  let sum = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const high = prices[i] * 1.01;
    const low = prices[i] * 0.99;
    const prev = i > 0 ? prices[i - 1] : prices[i];
    const tr = Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
    sum += tr;
  }
  
  return sum / period;
}

function updateIndicators() {
  if (priceHistory.length < 50) return;

  const prices = priceHistory.map(p => p.price);
  const currentPrice = prices[prices.length - 1];

  // EMA
  const ema20 = calculateEMA(prices, 20);
  const ema50 = calculateEMA(prices, 50);
  if (ema20 && ema50) {
    botState.signals.ema.value = ema20.toFixed(2);
    botState.signals.ema.signal = ema20 > ema50 ? 'BUY' : 'SELL';
  }

  // RSI
  const rsi = calculateRSI(prices);
  if (rsi) {
    botState.signals.rsi.value = rsi.toFixed(2);
    if (rsi < 30) botState.signals.rsi.signal = 'BUY';
    else if (rsi > 70) botState.signals.rsi.signal = 'SELL';
    else botState.signals.rsi.signal = 'NEUTRAL';
  }

  // MACD
  const macd = calculateMACD(prices);
  botState.signals.macd.value = macd.histogram.toFixed(4);
  botState.signals.macd.signal = macd.histogram > 0 ? 'BUY' : 'SELL';

  // Bollinger Bands
  const bb = calculateBollingerBands(prices);
  if (bb) {
    botState.signals.bb.value = `${bb.lower.toFixed(0)}-${bb.upper.toFixed(0)}`;
    if (currentPrice < bb.lower) botState.signals.bb.signal = 'BUY';
    else if (currentPrice > bb.upper) botState.signals.bb.signal = 'SELL';
    else botState.signals.bb.signal = 'NEUTRAL';
  }

  // Volume
  const volumes = priceHistory.slice(-20).map(p => p.volume);
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const currentVolume = priceHistory[priceHistory.length - 1].volume;
  botState.signals.volume.value = (currentVolume / avgVolume).toFixed(2);
  botState.signals.volume.signal = currentVolume > avgVolume * 1.5 ? 'BUY' : 'NEUTRAL';

  // ATR
  const atr = calculateATR(prices);
  const atrPercent = (atr / currentPrice) * 100;
  botState.signals.atr.value = atrPercent.toFixed(2) + '%';
  botState.signals.atr.signal = atrPercent > 0.5 && atrPercent < 5 ? 'BUY' : 'NEUTRAL';

  // Score global
  calculateScore();
}

function calculateScore() {
  const signals = botState.signals;
  let buyScore = 0;
  let sellScore = 0;
  let totalSignals = 0;

  const activeSignals = botConfig.mode === 'AGGRESSIVE' ? ['ema', 'rsi', 'volume'] :
                        botConfig.mode === 'BALANCED' ? ['ema', 'rsi', 'macd', 'volume'] :
                        ['ema', 'rsi', 'macd', 'bb', 'volume', 'atr'];

  activeSignals.forEach(key => {
    if (signals[key].signal === 'BUY') buyScore++;
    else if (signals[key].signal === 'SELL') sellScore++;
    totalSignals++;
  });

  botState.score = Math.round((Math.max(buyScore, sellScore) / totalSignals) * 100);
}

// ==================== LOGIQUE DE TRADING ====================
function checkTradingSignals() {
  if (botState.position) return; // Déjà en position

  if (botState.score >= botConfig.minScorePercent) {
    const buySignals = Object.values(botState.signals).filter(s => s.signal === 'BUY').length;
    const sellSignals = Object.values(botState.signals).filter(s => s.signal === 'SELL').length;

    if (buySignals > sellSignals) {
      openPosition('LONG');
    } else if (sellSignals > buySignals) {
      openPosition('SHORT');
    }
  }
}

function openPosition(type) {
  const entryPrice = botState.currentPrice;
  const positionSize = (botConfig.capital * botConfig.positionSizePercent / 100) / entryPrice;

  botState.position = {
    type: type,
    entry: entryPrice,
    size: positionSize,
    openTime: Date.now(),
    trailing: {
      active: false,
      highest: type === 'LONG' ? entryPrice : null,
      lowest: type === 'SHORT' ? entryPrice : null
    }
  };

  logTrade(`🟢 ${type} ouvert @ $${entryPrice.toFixed(2)} | Taille: ${positionSize.toFixed(6)} BTC`);
}

function checkPosition() {
  if (!botState.position) return;

  const pos = botState.position;
  const currentPrice = botState.currentPrice;
  const entryPrice = pos.entry;
  
  let profitPercent;
  if (pos.type === 'LONG') {
    profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    
    // Trailing stop
    if (!pos.trailing.active && profitPercent >= botConfig.trailingStartPercent) {
      pos.trailing.active = true;
      pos.trailing.highest = currentPrice;
      logTrade(`📈 Trailing stop activé @ $${currentPrice.toFixed(2)}`);
    }
    
    if (pos.trailing.active) {
      if (currentPrice > pos.trailing.highest) {
        pos.trailing.highest = currentPrice;
      }
      const trailingDrop = ((pos.trailing.highest - currentPrice) / pos.trailing.highest) * 100;
      if (trailingDrop >= botConfig.trailingDeltaPercent) {
        closePosition('TRAILING_STOP');
        return;
      }
    }
    
    // Take profit & Stop loss
    if (profitPercent >= botConfig.takeProfitPercent) {
      closePosition('TAKE_PROFIT');
    } else if (profitPercent <= -botConfig.stopLossPercent) {
      closePosition('STOP_LOSS');
    }
    
  } else { // SHORT
    profitPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
    
    if (!pos.trailing.active && profitPercent >= botConfig.trailingStartPercent) {
      pos.trailing.active = true;
      pos.trailing.lowest = currentPrice;
      logTrade(`📈 Trailing stop activé @ $${currentPrice.toFixed(2)}`);
    }
    
    if (pos.trailing.active) {
      if (currentPrice < pos.trailing.lowest) {
        pos.trailing.lowest = currentPrice;
      }
      const trailingRise = ((currentPrice - pos.trailing.lowest) / pos.trailing.lowest) * 100;
      if (trailingRise >= botConfig.trailingDeltaPercent) {
        closePosition('TRAILING_STOP');
        return;
      }
    }
    
    if (profitPercent >= botConfig.takeProfitPercent) {
      closePosition('TAKE_PROFIT');
    } else if (profitPercent <= -botConfig.stopLossPercent) {
      closePosition('STOP_LOSS');
    }
  }
}

function closePosition(reason) {
  if (!botState.position) return;

  const pos = botState.position;
  const exitPrice = botState.currentPrice;
  const profitUSDT = pos.type === 'LONG' 
    ? (exitPrice - pos.entry) * pos.size
    : (pos.entry - exitPrice) * pos.size;

  const trade = {
    id: Date.now(),
    type: pos.type,
    entry: pos.entry,
    exit: exitPrice,
    size: pos.size,
    profit: profitUSDT,
    reason: reason,
    duration: Date.now() - pos.openTime,
    time: new Date().toLocaleTimeString()
  };

  botState.trades.unshift(trade);
  if (botState.trades.length > 50) botState.trades.pop();

  // Stats
  botState.stats.totalTrades++;
  botState.stats.totalProfit += profitUSDT;
  if (profitUSDT > 0) botState.stats.wins++;
  else botState.stats.losses++;
  botState.stats.winRate = (botState.stats.wins / botState.stats.totalTrades) * 100;
  botState.stats.roi = (botState.stats.totalProfit / botConfig.capital) * 100;

  logTrade(`🔴 ${pos.type} fermé @ $${exitPrice.toFixed(2)} | Profit: ${profitUSDT > 0 ? '✅' : '❌'} $${profitUSDT.toFixed(2)}`);
  botState.position = null;
}

function logTrade(message) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${message}`);
}

// ==================== API ROUTES ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/status', (req, res) => {
  res.json({
    config: botConfig,
    state: botState,
    priceHistory: priceHistory.slice(-100)
  });
});

app.post('/api/start', (req, res) => {
  const { capital } = req.body;
  
  if (!capital || capital <= 0) {
    return res.status(400).json({ error: 'Capital invalide' });
  }

  botConfig.capital = capital;
  botConfig.isRunning = true;
  
  logTrade('🚀 Bot démarré');
  res.json({ success: true, message: 'Bot démarré' });
});

app.post('/api/stop', (req, res) => {
  botConfig.isRunning = false;
  
  if (botState.position) {
    closePosition('MANUAL_STOP');
  }
  
  logTrade('⏹️ Bot arrêté');
  res.json({ success: true, message: 'Bot arrêté' });
});

app.post('/api/config', (req, res) => {
  const { mode, positionSize, takeProfit, trailingStart, trailingDelta, stopLoss, minScore } = req.body;
  
  if (mode) botConfig.mode = mode;
  if (positionSize) botConfig.positionSizePercent = positionSize;
  if (takeProfit) botConfig.takeProfitPercent = takeProfit;
  if (trailingStart) botConfig.trailingStartPercent = trailingStart;
  if (trailingDelta) botConfig.trailingDeltaPercent = trailingDelta;
  if (stopLoss) botConfig.stopLossPercent = stopLoss;
  if (minScore) botConfig.minScorePercent = minScore;
  
  res.json({ success: true, config: botConfig });
});

app.post('/api/reset', (req, res) => {
  botState.trades = [];
  botState.stats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    winRate: 0,
    roi: 0
  };
  
  res.json({ success: true, message: 'Statistiques réinitialisées' });
});

// ==================== DÉMARRAGE ====================
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🤖 JERCAT PROFIT MAXIMIZER initialisé`);
  connectBinance();
});

// Gestion propre de l'arrêt
process.on('SIGTERM', () => {
  console.log('⏹️ Arrêt du serveur...');
  if (binanceWs) binanceWs.close();
  process.exit(0);
});
