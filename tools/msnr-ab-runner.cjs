// ============================================================================
// КАНОНИЧЕСКИЙ ИСТОЧНИК. Этот файл здесь только хранится, отсюда он не запускается.
//
// Рабочая копия, которая реально исполняется:
//     C:\Users\lexas\.claude\tools\tradingview-mcp\scripts\msnr-ab-runner.cjs
// Запускать нужно ОТТУДА: скрипт подтягивает chrome-remote-interface из
// node_modules репозитория MCP по относительному пути ../node_modules.
//
// Зачем дубль: репозиторий tradingview-mcp — чужой upstream
// (github.com/tradesdontlie/tradingview-mcp), скрипты в него не коммитятся и при
// переустановке/обновлении MCP теряются. Копия здесь — страховка.
//
// При правке рабочей копии обновлять и эту, иначе разъедутся.
// ============================================================================
// Прогон набора конфигов MSNR по ОДНОМУ символу: докачка истории один раз,
// затем переключение вариантов инпутами с ожиданием стабилизации отчёта.
//
// Защита от снятия недосчитанных цифр (двойной кэш TV): вариант считается снятым,
// только когда (бары, сделки, net, маркер таблицы) не меняются 3 пробы подряд
// И маркер конфига в таблице соответствует заданному варианту.
//
// Использование:
//   node msnr-ab-runner.cjs <targetId> <entityId> <expectSymbol> <commission> <variantsJson>
// variantsJson: [{"name":"base","inputs":{"in_25":"half_tp",...}}, ...]
const path = require('path');
const CDP = require(path.join(__dirname, '..', 'node_modules', 'chrome-remote-interface'));

const [, , targetId, entityId, expectSymbol, commissionArg, variantsArg] = process.argv;
if (!targetId || !entityId || !variantsArg) {
  console.log(JSON.stringify({ ok: false, err: 'usage: msnr-ab-runner.cjs <targetId> <entityId> <expectSymbol> <commission> <variantsJson>' }));
  process.exit(1);
}
const variants = JSON.parse(variantsArg);
const commission = commissionArg ? parseFloat(commissionArg) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SET_INPUTS = (id, obj) => `(function(){
  try {
    var chart = window.TradingViewApi.activeChart();
    var st = chart.getStudyById(${JSON.stringify(id)});
    if (!st) return JSON.stringify({err:'study not found'});
    var cur = st.getInputValues();
    var ov = ${JSON.stringify(obj)};
    var done = {};
    for (var i = 0; i < cur.length; i++) {
      if (Object.prototype.hasOwnProperty.call(ov, cur[i].id)) { cur[i].value = ov[cur[i].id]; done[cur[i].id] = ov[cur[i].id]; }
    }
    st.setInputValues(cur);
    return JSON.stringify({ok:true, set:done});
  } catch(e) { return JSON.stringify({err:String(e).slice(0,160)}); }
})()`;

const PULL = `(function(){
  try {
    var s = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
    s.requestMoreData(10000);
    return JSON.stringify({bars: s.bars().size()});
  } catch(e) { return JSON.stringify({err:String(e).slice(0,120)}); }
})()`;

const PROBE = (id) => `(function(){
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var m = cw.model(), s = m.mainSeries();
    var ds = m.dataSources().find(function(x){
      try { return typeof x.reportData === 'function' && x.id && x.id() === ${JSON.stringify(id)}; } catch(e){ return false; }
    });
    if (!ds) return JSON.stringify({err:'strategy not found'});
    var rd = ds.reportData(); if (rd && typeof rd.value === 'function') rd = rd.value();
    var p = rd && rd.performance;
    var orders = ds.ordersData(); if (orders && typeof orders.value === 'function') orders = orders.value();
    orders = orders || [];
    var L = 0, S = 0;
    for (var i = 0; i < orders.length; i++) { var o = orders[i]; if (o && o.e) { if (o.id === 'MSNR L') L++; else if (o.id === 'MSNR S') S++; } }
    var pick = function(o){ return o ? {
      trades: (o.numberOfWiningTrades||0)+(o.numberOfLosingTrades||0),
      win: o.numberOfWiningTrades||0, loss: o.numberOfLosingTrades||0,
      net: o.netProfit, netPct: o.netProfitPercent, pf: o.profitFactor,
      gp: o.grossProfit, gl: o.grossLoss, largestWin: o.largestWinTrade, largestLoss: o.largestLosTrade,
      commission: o.commissionPaid
    } : null; };
    // таблица Pine (маркер конфига + счётчики воронки)
    var rows = [];
    try {
      var g = ds._graphics, pc = g && g._primitivesCollection;
      var outer = pc && pc.dwgtablecells;
      var inner = outer && outer.get('tableCells');
      // у таблиц inner УЖЕ коллекция (в отличие от линий/боксов, где нужен .get(false))
      var coll = null;
      if (inner) {
        if (inner._primitivesDataById) coll = inner;
        else if (typeof inner.get === 'function') { try { coll = inner.get(false); } catch(e) {} }
      }
      if (coll && coll._primitivesDataById) {
        var cells = [];
        coll._primitivesDataById.forEach(function(v){ cells.push(v); });
        cells.sort(function(a,b){ return (a.row||0)-(b.row||0); });
        for (var c = 0; c < cells.length; c++) if (cells[c].t) rows.push(cells[c].t);
      }
    } catch(e) {}
    return JSON.stringify({
      symbol: s.symbolInfo() ? s.symbolInfo().full_name : null,
      bars: s.bars().size(), more: s.requestMoreDataAvailable(),
      all: p ? pick(p.all) : null, long: p ? pick(p.long) : null, short: p ? pick(p.short) : null,
      ddPct: p ? p.maxStrategyDrawDownPercent : null,
      entriesL: L, entriesS: S, rows: rows
    });
  } catch(e) { return JSON.stringify({err:String(e).slice(0,160)}); }
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

    // --- комиссия. ВНИМАНИЕ: id свойства стратегии зависит от числа юзерских инпутов
    // и съезжает при каждой правке кода. Задаётся через env, по умолчанию карта v1.2:
    // COMM_ID   — commission_value (свойство стратегии), v1.2 = in_35
    // COSTPCT_ID — costPctSide (инпут фильтра издержек),  v1.2 = in_23
    const COMM_ID = process.env.COMM_ID || 'in_35';
    const COSTPCT_ID = process.env.COSTPCT_ID || 'in_23';
    if (commission !== null && !isNaN(commission)) {
      const obj = {};
      obj[COMM_ID] = commission;
      obj[COSTPCT_ID] = commission;
      const res = await run(SET_INPUTS(entityId, obj));
      if (res.err) throw new Error('set commission: ' + res.err);
      const applied = Object.keys(res.set || {});
      if (applied.length !== 2) throw new Error('commission ids not applied: ' + JSON.stringify(res.set));
      await sleep(1500);
    }

    // --- докачка истории (один раз на символ)
    let st = await run(PROBE(entityId));
    if (st.err) throw new Error(st.err);
    let stall = 0;
    for (let i = 0; i < 40; i++) {
      const prev = st.bars;
      await run(PULL);
      await sleep(3000);
      st = await run(PROBE(entityId));
      if (st.bars <= prev) {
        stall++;
        await sleep(2000);
        st = await run(PROBE(entityId));
        if (st.bars > prev) stall = 0;
        if (stall >= 3) break;
      } else stall = 0;
    }
    const bars = st.bars;
    const symbol = st.symbol;

    const out = [];
    for (const v of variants) {
      const sres = await run(SET_INPUTS(entityId, v.inputs));
      if (sres.err) throw new Error('set inputs: ' + sres.err);
      await sleep(2500);

      let prevSig = null, stableFor = 0, settled = false, cur = null;
      for (let i = 0; i < 40; i++) {
        cur = await run(PROBE(entityId));
        const marker = (cur.rows && cur.rows[0]) || '';
        const markerOk = !v.expectMarker || marker.indexOf(v.expectMarker) !== -1;
        const sig = JSON.stringify([cur.bars, cur.all && cur.all.trades, cur.all && cur.all.net, cur.entriesL, cur.entriesS, marker]);
        if (sig === prevSig && markerOk) {
          stableFor++;
          if (stableFor >= 3) { settled = true; break; }
        } else stableFor = 0;
        prevSig = sig;
        await sleep(2500);
      }
      const marker = (cur.rows && cur.rows[0]) || '';
      out.push({
        variant: v.name, settled,
        markerOk: v.expectMarker ? marker.indexOf(v.expectMarker) !== -1 : null,
        marker,
        rows: cur.rows, all: cur.all, long: cur.long, short: cur.short,
        ddPct: cur.ddPct, entriesL: cur.entriesL, entriesS: cur.entriesS
      });
    }

    console.log(JSON.stringify({
      ok: true, symbol, expectSymbol: expectSymbol || null,
      symbolOk: expectSymbol ? symbol === expectSymbol : null,
      bars, commission, results: out
    }, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, err: String(e.message || e) }));
  } finally {
    if (client) await client.close();
  }
})();
