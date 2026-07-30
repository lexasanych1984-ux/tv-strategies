// ============================================================================
// КАНОНИЧЕСКИЙ ИСТОЧНИК. Этот файл здесь только хранится, отсюда он не запускается.
//
// Рабочая копия, которая реально исполняется:
//     C:\Users\lexas\.claude\tools\tradingview-mcp\scripts\backfill-history.cjs
// Запускать нужно ОТТУДА: скрипт подтягивает chrome-remote-interface из
// node_modules репозитория MCP по относительному пути ../node_modules.
//
// Зачем дубль: репозиторий tradingview-mcp — чужой upstream
// (github.com/tradesdontlie/tradingview-mcp), скрипты в него не коммитятся и при
// переустановке/обновлении MCP теряются. Копия здесь — страховка.
//
// При правке рабочей копии обновлять и эту, иначе разъедутся.
// ============================================================================
// Докачка истории баров пагинацией (свежий график отдаёт ~300 баров — бэктест
// по ним считается за трое суток и выглядит пустым).
// Использование: node backfill-history.cjs <targetId> [maxLoops] [chunk]
const path = require('path');
const CDP = require(path.join(__dirname, '..', 'node_modules', 'chrome-remote-interface'));

const [, , targetId, maxLoopsArg, chunkArg] = process.argv;
if (!targetId) {
  console.log(JSON.stringify({ ok: false, err: 'usage: backfill-history.cjs <targetId> [maxLoops] [chunk]' }));
  process.exit(1);
}
const maxLoops = parseInt(maxLoopsArg || '40', 10);
const chunk = parseInt(chunkArg || '10000', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(function(){
  try {
    var s = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
    return JSON.stringify({bars: s.bars().size(), more: s.requestMoreDataAvailable()});
  } catch(e) { return JSON.stringify({err: String(e).slice(0,120)}); }
})()`;

const PULL = (n) => `(function(){
  try {
    var s = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
    s.requestMoreData(${n});
    return JSON.stringify({bars: s.bars().size(), more: s.requestMoreDataAvailable()});
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

    let st = await run(PROBE);
    const startBars = st.bars;
    let stall = 0;

    // Данные приезжают асинхронно: и bars, и requestMoreDataAvailable() дают
    // переходные значения сразу после запроса. Поэтому «конец истории» признаём
    // только когда счётчик не растёт несколько проб подряд, а не по первому false.
    for (let i = 0; i < maxLoops; i++) {
      if (st.err) break;
      const prev = st.bars;
      await run(PULL(chunk));
      await sleep(3000);
      st = await run(PROBE);
      if (st.err) break;
      if (st.bars <= prev) {
        stall++;
        await sleep(2000);
        st = await run(PROBE);
        if (st.bars > prev) stall = 0;
        if (stall >= 3) break;
      } else {
        stall = 0;
      }
    }

    console.log(JSON.stringify({ ok: true, startBars, endBars: st.bars, moreAvailable: st.more }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, err: String(e.message || e) }));
  } finally {
    if (client) await client.close();
  }
})();
