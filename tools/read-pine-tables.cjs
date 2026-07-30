// ============================================================================
// КАНОНИЧЕСКИЙ ИСТОЧНИК. Этот файл здесь только хранится, отсюда он не запускается.
//
// Рабочая копия, которая реально исполняется:
//     C:\Users\lexas\.claude\tools\tradingview-mcp\scripts\read-pine-tables.cjs
// Запускать нужно ОТТУДА: скрипт подтягивает chrome-remote-interface из
// node_modules репозитория MCP по относительному пути ../node_modules.
//
// Зачем дубль: репозиторий tradingview-mcp — чужой upstream
// (github.com/tradesdontlie/tradingview-mcp), скрипты в него не коммитятся и при
// переустановке/обновлении MCP теряются. Копия здесь — страховка.
//
// При правке рабочей копии обновлять и эту, иначе разъедутся.
// ============================================================================
// Докачка истории + чтение таблиц Pine всех студий с ожиданием стабилизации.
// Использование: node read-pine-tables.cjs <targetId> [expectTicker]
const path = require('path');
const CDP = require(path.join(__dirname, '..', 'node_modules', 'chrome-remote-interface'));

const [, , targetId, expectTicker] = process.argv;
if (!targetId) {
  console.log(JSON.stringify({ ok: false, err: 'usage: read-pine-tables.cjs <targetId> [expectTicker]' }));
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PULL = `(function(){
  try {
    var s = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
    s.requestMoreData(10000);
    return JSON.stringify({bars: s.bars().size()});
  } catch(e) { return JSON.stringify({err:String(e).slice(0,120)}); }
})()`;

const PROBE = `(function(){
  try {
    var cw = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var m = cw.model(), s = m.mainSeries();
    var out = [];
    var sources = m.dataSources();
    for (var si = 0; si < sources.length; si++) {
      var ds = sources[si];
      if (!ds.metaInfo) continue;
      var name = '';
      try { var mi = ds.metaInfo(); name = mi.description || mi.shortDescription || ''; } catch(e) { continue; }
      if (!name || name.indexOf('MSNR') === -1) continue;
      var rows = [];
      try {
        var pc = ds._graphics && ds._graphics._primitivesCollection;
        var outer = pc && pc.dwgtablecells;
        var inner = outer && outer.get('tableCells');
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
      var st = null;
      try { var stt = ds.status(); st = stt && stt.type; } catch(e) {}
      out.push({name: name, status: st, rows: rows});
    }
    return JSON.stringify({
      symbol: s.symbolInfo() ? s.symbolInfo().full_name : null,
      ticker: s.symbolInfo() ? s.symbolInfo().name : null,
      bars: s.bars().size(), studies: out
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

    let st = await run(PROBE);
    if (st.err) throw new Error(st.err);
    let stall = 0;
    for (let i = 0; i < 40; i++) {
      const prev = st.bars;
      await run(PULL);
      await sleep(3000);
      st = await run(PROBE);
      if (st.bars <= prev) {
        stall++;
        await sleep(2000);
        st = await run(PROBE);
        if (st.bars > prev) stall = 0;
        if (stall >= 3) break;
      } else stall = 0;
    }

    // стабилизация: таблицы не меняются 3 пробы подряд и тикер в маркере верный
    let prevSig = null, stable = 0, settled = false;
    for (let i = 0; i < 40; i++) {
      st = await run(PROBE);
      const sig = JSON.stringify(st.studies.map(s => s.rows));
      const allHaveRows = st.studies.length > 0 && st.studies.every(s => s.rows.length > 0);
      const tickOk = !expectTicker || st.studies.every(s => !s.rows[0] || s.rows[0].indexOf(expectTicker) !== -1);
      if (sig === prevSig && allHaveRows && tickOk) {
        stable++;
        if (stable >= 3) { settled = true; break; }
      } else stable = 0;
      prevSig = sig;
      await sleep(2500);
    }

    console.log(JSON.stringify({ ok: true, settled, symbol: st.symbol, ticker: st.ticker, bars: st.bars, studies: st.studies }, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, err: String(e.message || e) }));
  } finally {
    if (client) await client.close();
  }
})();
