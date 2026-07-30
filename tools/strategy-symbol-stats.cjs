// ============================================================================
// КАНОНИЧЕСКИЙ ИСТОЧНИК. Этот файл здесь только хранится, отсюда он не запускается.
//
// Рабочая копия, которая реально исполняется:
//     C:\Users\lexas\.claude\tools\tradingview-mcp\scripts\strategy-symbol-stats.cjs
// Запускать нужно ОТТУДА: скрипт подтягивает chrome-remote-interface из
// node_modules репозитория MCP по относительному пути ../node_modules.
//
// Зачем дубль: репозиторий tradingview-mcp — чужой upstream
// (github.com/tradesdontlie/tradingview-mcp), скрипты в него не коммитятся и при
// переустановке/обновлении MCP теряются. Копия здесь — страховка.
//
// При правке рабочей копии обновлять и эту, иначе разъедутся.
// ============================================================================
// Докачка истории + снятие отчёта стратегии с разбивкой long/short.
// Ждёт СТАБИЛИЗАЦИИ отчёта: TV пересчитывает асинхронно, и снятый сразу после
// докачки снимок бывает промежуточным (см. расхождение 30.07.2026).
// Использование: node strategy-symbol-stats.cjs <targetId> <entityId> [expectSymbol]
const path = require('path');
const CDP = require(path.join(__dirname, '..', 'node_modules', 'chrome-remote-interface'));

const [, , targetId, entityId, expectSymbol] = process.argv;
if (!targetId || !entityId) {
  console.log(JSON.stringify({ ok: false, err: 'usage: strategy-symbol-stats.cjs <targetId> <entityId> [expectSymbol]' }));
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const JS = (entity) => `(function(){
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var m = cw.model(), s = m.mainSeries();
    var ds = m.dataSources().find(function(x){
      try { return typeof x.reportData === 'function' && x.id && x.id() === '${entity}'; } catch(e){ return false; }
    });
    if (!ds) return JSON.stringify({err:'strategy not found'});
    var rd = ds.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value();
    var p = rd && rd.performance;
    var orders = ds.ordersData(); if (orders && typeof orders.value === 'function') orders = orders.value();
    orders = orders || [];
    var L = 0, S = 0;
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (o && o.e) { if (o.id === 'MSNR L') L++; else if (o.id === 'MSNR S') S++; }
    }
    var pick = function(o){ return o ? {
      trades: (o.numberOfWiningTrades||0)+(o.numberOfLosingTrades||0),
      win: o.numberOfWiningTrades||0, loss: o.numberOfLosingTrades||0,
      net: o.netProfit, pf: o.profitFactor, gross_profit: o.grossProfit
    } : null; };
    var inp = ds.properties().childs().inputs.state();
    return JSON.stringify({
      symbol: s.symbolInfo() ? s.symbolInfo().full_name : null,
      bars: s.bars().size(),
      more: s.requestMoreDataAvailable(),
      commission: inp.in_29,
      all: p ? pick(p.all) : null,
      long: p ? pick(p.long) : null,
      short: p ? pick(p.short) : null,
      entriesL: L, entriesS: S
    });
  } catch(e) { return JSON.stringify({err: String(e).slice(0,140)}); }
})()`;

const PULL = `(function(){
  try {
    var s = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
    s.requestMoreData(10000);
    return JSON.stringify({bars: s.bars().size()});
  } catch(e) { return JSON.stringify({err: String(e).slice(0,120)}); }
})()`;

(async () => {
  let client;
  try {
    client = await CDP({ target: targetId, port: 9222 });
    const { Runtime } = client;
    const run = async (expr) => {
      const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
      return JSON.parse(r.result.value);
    };

    // --- докачка
    let st = await run(JS(entityId));
    if (st.err) throw new Error(st.err);
    let stall = 0;
    for (let i = 0; i < 40; i++) {
      const prev = st.bars;
      await run(PULL);
      await sleep(3000);
      st = await run(JS(entityId));
      if (st.bars <= prev) {
        stall++;
        await sleep(2000);
        st = await run(JS(entityId));
        if (st.bars > prev) stall = 0;
        if (stall >= 3) break;
      } else stall = 0;
    }

    // --- ждём, пока отчёт перестанет меняться
    let stableFor = 0, prevSig = null, settled = false;
    for (let i = 0; i < 30; i++) {
      st = await run(JS(entityId));
      const sig = JSON.stringify([st.bars, st.all && st.all.trades, st.all && st.all.net, st.entriesL, st.entriesS]);
      if (sig === prevSig) {
        stableFor++;
        if (stableFor >= 3) { settled = true; break; }
      } else stableFor = 0;
      prevSig = sig;
      await sleep(2500);
    }

    const symbolOk = expectSymbol ? st.symbol === expectSymbol : null;
    console.log(JSON.stringify({ ok: true, settled, symbolOk, expectSymbol: expectSymbol || null, ...st }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, err: String(e.message || e) }));
  } finally {
    if (client) await client.close();
  }
})();
