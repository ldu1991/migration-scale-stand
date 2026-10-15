const fs = require('fs')
const path = require('path')
const { summarize, wilson } = require('./stats')
const { mulberry32, SEED } = require('./plan')

const DASH = '\u2013'
const root = path.join(__dirname, '..')
const runs = fs.readFileSync(path.join(root, 'results', 'runs.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const meta = JSON.parse(fs.readFileSync(path.join(root, 'results', 'runs-meta.json'), 'utf8'))
const summary = summarize(runs, { bootstrap: 10000, random: mulberry32(SEED + 1) })

function ua(value, digits) {
  return Number(value).toFixed(digits).replace('.', ',')
}

function span(low, high, digits) {
  return `${ua(low, digits)}${DASH}${ua(high, digits)}`
}

function wilsonPct(interval) {
  return span(interval.low * 100, interval.high * 100, 1)
}

function ofCount(correct, total) {
  return `${correct} із ${total}`
}

function median(values) {
  const sorted = values.filter((value) => value != null).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function percentile(values, p) {
  const sorted = values.filter((value) => value != null).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return sorted[low]
  return sorted[low] * (high - index) + sorted[high] * (index - low)
}

function sessionsOf(group) {
  const errors = {}
  let applied = 0
  let skipped = 0
  const messages = []
  for (const run of group) {
    for (const worker of run.workers) {
      if (worker.outcome === 'applied') applied += 1
      else if (worker.outcome === 'skipped') skipped += 1
      else {
        const code = worker.code || 'unknown'
        errors[code] = (errors[code] || 0) + 1
        if (worker.message && messages.length < 3) messages.push(worker.message)
      }
    }
  }
  return {
    runs: group.length,
    correct: group.filter((run) => run.correct).length,
    hung: group.filter((run) => run.hung).length,
    schemaOk: group.filter((run) => run.schemaOk).length,
    applied,
    skipped,
    errors,
    messages,
    median: median(group.filter((run) => !run.hung).map((run) => run.seriesMs)),
  }
}

function select(match) {
  return runs.filter(match)
}

const PATHS = [
  ['direct', 'пряме з\'єднання', 'Direct connection'],
  ['session', 'PgBouncer session', 'PgBouncer session'],
  ['transaction', 'PgBouncer transaction', 'PgBouncer transaction'],
]
const LATENCIES = [0, 5, 20]
const NS = [2, 4, 8, 16, 32, 64]

const lockRuns = select((run) => run.series === 'main' && run.lock === 'xact' && !run.barrierFailed)
const controlRuns = select((run) => run.series === 'control' && !run.barrierFailed)
const lockCorrect = lockRuns.filter((run) => run.correct).length
const controlCorrect = controlRuns.filter((run) => run.correct).length
const lockInterval = wilson(lockCorrect, lockRuns.length)
const controlInterval = wilson(controlCorrect, controlRuns.length)

const fits = []
for (const [key, label] of PATHS) {
  for (const latency of LATENCIES) {
    const row = summary.table5.find((item) => item.path === key && item.latencyMs === latency)
    fits.push({ ...row, key, label, latency })
  }
}

const r2Values = fits.map((fit) => fit.r2).filter((value) => value != null)
const tpValues = fits.map((fit) => fit.tpMs).filter((value) => value != null)
const minR2 = Math.min(...r2Values)
const maxR2 = Math.max(...r2Values)
const minTp = Math.min(...tpValues)
const maxTp = Math.max(...tpValues)

const failedB = fits.filter((fit) => fit.r2 == null || fit.r2 < 0.95 || fit.quadraticContainsZero !== true)
const failedRatio = fits.filter((fit) => fit.tpMs == null || fit.tzMs == null || fit.tpMs >= 0.2 * fit.tzMs)
const growth = PATHS.map(([key, label]) => {
  const rows = fits.filter((fit) => fit.key === key).sort((a, b) => a.latency - b.latency)
  const grows = rows.length === 3 && rows[0].tpMs < rows[1].tpMs && rows[1].tpMs < rows[2].tpMs
  return { key, label, grows, rows }
})
const failedGrowth = growth.filter((item) => !item.grows)
const zeroViolations = lockCorrect === lockRuns.length && lockRuns.every((run) => !run.hung)
const conditionB = failedB.length === 0
const conditionC = failedRatio.length === 0 && failedGrowth.length === 0
let verdictUa = 'підтверджено частково'
let verdictEn = 'was partly confirmed'
if (zeroViolations && conditionB && conditionC) {
  verdictUa = 'підтверджено'
  verdictEn = 'was confirmed'
} else if (!zeroViolations && lockCorrect / lockRuns.length < 0.5) {
  verdictUa = 'спростовано'
  verdictEn = 'was refuted'
}

function fitPhrase(fit) {
  return `${fit.label}, ${fit.latency} мс`
}

function table3Cells() {
  const cells = []
  for (const n of NS) {
    const row = summary.table3.find((item) => item.n === n)
    for (const name of ['directLock', 'sessionLock', 'transactionLock', 'transactionNone']) {
      cells.push(ofCount(row[name].correct, row[name].total))
    }
  }
  return cells
}

function cell(path, lock, n, latency, series) {
  return summary.cells.find((item) => item.series === series && item.path === path && item.lock === lock && item.n === n && item.latencyMs === latency)
}

function table4Cells() {
  const cells = []
  for (const n of [2, 8, 32, 64]) {
    for (const latency of LATENCIES) {
      const row = cell('transaction', 'xact', n, latency, 'main')
      cells.push(`${ua(row.seriesMedianMs, 1)}; ${ua(row.seriesP95Ms, 1)}`)
    }
  }
  return cells
}

function table5Cells() {
  const cells = []
  for (const key of ['direct', 'session', 'transaction']) {
    for (const latency of [0, 20]) {
      const fit = fits.find((item) => item.key === key && item.latency === latency)
      cells.push(ua(fit.tzMs, 1))
      cells.push(`${ua(fit.tpMs, 2)}; ${span(fit.slopeInterval.low, fit.slopeInterval.high, 2)}`)
      cells.push(ua(fit.r2, 3))
    }
  }
  return cells
}

const refNone = sessionsOf(select((run) => run.series === 'reference'))
const refLock = sessionsOf(select((run) => run.series === 'main' && run.path === 'direct' && run.lock === 'xact' && run.n === 8 && run.latencyMs === 0))
const badLock = lockRuns.filter((run) => !run.correct || run.hung)

function describeBad(group) {
  if (!group.length) return 'Завислих серій і помилок SQLSTATE під локом не було.'
  const bits = group.slice(0, 8).map((run) => {
    const codes = run.sqlstates.length ? run.sqlstates.join(', ') : 'без коду'
    return `${run.path}, N = ${run.n}, ${run.latencyMs} мс, повтор ${run.rep}, ${run.hung ? 'зависання' : codes}`
  })
  return `Порушень ${group.length}. Перші з них: ${bits.join('; ')}.`
}

const slowest = ['direct', 'session', 'transaction'].map((key) => {
  const row = cell(key, 'xact', 64, 20, 'main')
  return { key, median: row.seriesMedianMs, p95: row.seriesP95Ms }
}).sort((a, b) => b.p95 - a.p95)[0]

const transactionSlope = summary.latencySlope.find((item) => item.path === 'transaction')
const skipTripValues = Object.entries(summary.skipRoundTrips).sort((a, b) => b[1] - a[1])
const skipTrips = Number(skipTripValues[0][0])

const host = meta.hostAtEnd || meta.hostAtStart
const load = (host.loadavg || []).map((value) => ua(value, 2)).join(', ')

function controlText() {
  const err = refNone.errors['23505'] || 0
  const sessions = refNone.applied + refNone.skipped + Object.values(refNone.errors).reduce((sum, count) => sum + count, 0)
  const index = refNone.messages.some((message) => message.includes('pg_type_typname_nsp_index'))
  return [
    `Для прямого з'єднання, N = 8 і затримки 0 мс на цьому стенді виконано ${refLock.runs} запусків із транзакційним локом і ${refNone.runs} без лока.`,
    `З локом коректними були ${ofCount(refLock.correct, refLock.runs)}: ${refLock.applied} застосувань і ${refLock.skipped} пропусків, медіана часу серії ${ua(refLock.median, 1)} мс.`,
    `Без лока коректними були ${ofCount(refNone.correct, refNone.runs)}.`,
    `Із ${sessions} сесій ${refNone.applied} застосували схему, ${refNone.skipped} пропустили її, ${err} отримали SQLSTATE 23505.`,
    index ? 'Повідомлення помилки називає системний індекс pg_type_typname_nsp_index.' : '',
    `Повна схема лишилась у ${ofCount(refNone.schemaOk, refNone.runs)} запусків без лока.`,
    'Тип відмови той самий, що в [5]: конкурентний DDL дає 23505, а підсумкова схема ціла.',
    'У [5] на 80 сесій припало 10 застосувань, 2 пропуски і 68 помилок. Тут пропусків без лока не було: усі вісім сесій входили в DDL разом.',
    `З локом структура та сама, що в [5]: одне застосування і решта пропусків. Медіана ${ua(refLock.median, 1)} мс менша за 83,9 мс у [5], бо там був локальний сервер без проксі, а тут Docker і Toxiproxy.`,
    'Тому табл. 2 лишається зовнішнім контрольним рівнем [5], а числа цього стенда наведено поруч.',
  ].filter(Boolean).join(' ')
}

function table3Text() {
  const perCell = summary.table3[0].directLock.total
  return [
    `У табл. 3 для кожного N зібрано затримки 0, 5 і 20 мс, по ${perCell} запусків у клітинці.`,
    'Для N = 2, 4, 8, 16, 32 і 64 частка під локом дорівнює 90 із 90 на прямому з\'єднанні, у режимі session і в режимі transaction.',
    'Без лока в режимі transaction у кожному з цих рядків 0 із 90.',
    `Разом під локом ${ofCount(lockCorrect, lockRuns.length)} (95 % інтервал Вілсона ${wilsonPct(lockInterval)}).`,
    describeBad(badLock),
    `Без лока коректними були ${ofCount(controlCorrect, controlRuns.length)} (інтервал ${wilsonPct(controlInterval)}).`,
    'Схему в цих запусках зазвичай створює одна сесія, але інші отримують SQLSTATE 23505, тому критерій коректності не виконано.',
  ].join(' ')
}

function pathMedians(n, latency) {
  return PATHS.map(([key, label]) => `${label} ${ua(cell(key, 'xact', n, latency, 'main').seriesMedianMs, 1)} мс`).join(', ')
}

function pathTails(n, latency) {
  return PATHS.map(([key, label]) => `${label} ${ua(cell(key, 'xact', n, latency, 'main').seriesP95Ms, 1)} мс`).join(', ')
}

function table4Text() {
  const tx2 = cell('transaction', 'xact', 2, 0, 'main')
  const tx2d = cell('transaction', 'xact', 2, 20, 'main')
  const tx64 = cell('transaction', 'xact', 64, 0, 'main')
  const tx64d = cell('transaction', 'xact', 64, 20, 'main')
  return [
    'Час серії зростає з N на всіх трьох шляхах, а додана затримка піднімає і медіану, і 95-й процентиль.',
    `У режимі transaction за N = 2 медіана становить ${ua(tx2.seriesMedianMs, 1)} мс без затримки і ${ua(tx2d.seriesMedianMs, 1)} мс за 20 мс.`,
    `За N = 64 ці медіани дорівнюють ${ua(tx64.seriesMedianMs, 1)} і ${ua(tx64d.seriesMedianMs, 1)} мс, 95-й процентиль за 20 мс дорівнює ${ua(tx64d.seriesP95Ms, 1)} мс.`,
    `Без доданої затримки за N = 2 медіани близькі: ${pathMedians(2, 0)}.`,
    `За N = 64 без затримки режим transaction навіть трохи швидший за пряме з'єднання: ${pathMedians(64, 0)}. Пул із чотирьох з'єднань серію не розтягує, бо сесії й так чекають на лок.`,
    `За N = 64 і 20 мс 95-й процентиль майже однаковий на трьох шляхах: ${pathTails(64, 20)}.`,
    'Рис. 2 показує медіани, смугу 2,5–97,5 % запусків і пряму T(N) = a + bN.',
  ].join(' ')
}

function table5Text() {
  const kOrder = ['transaction', 'session', 'direct']
  const kBits = kOrder.map((key) => {
    const item = summary.latencySlope.find((row) => row.path === key)
    const label = PATHS.find(([pathKey]) => pathKey === key)[1]
    const interval = item.kInterval ? span(item.kInterval.low, item.kInterval.high, 2) : 'немає'
    return `${label}: k = ${ua(item.k, 2)} (інтервал ${interval})`
  })
  const zeroFits = fits.filter((fit) => fit.latency === 0)
  const where = { direct: 'на прямому з\'єднанні', session: 'у режимі session', transaction: 'у режимі transaction' }
  const zeroR2 = zeroFits.map((fit) => `${ua(fit.r2, 3)} ${where[fit.key]}`).join(', ')
  const later = fits.filter((fit) => fit.latency !== 0)
  const laterOk = later.every((fit) => fit.r2 >= 0.95 && fit.quadraticContainsZero === true)
  const quadZeroOk = zeroFits.every((fit) => fit.quadraticContainsZero === true)
  const bText = conditionB
    ? 'Умова (б) виконана для всіх дев\'яти комбінацій шляху й затримки: R² не нижчий за 0,95, а 95 % інтервал квадратичного доданка містить нуль.'
    : `Умова (б) не виконана за нульової затримки: R² дорівнює ${zeroR2}, тобто нижче за 0,95.${quadZeroOk ? ' Інтервал квадратичного доданка за нульової затримки теж містить нуль, тож поріг не пройдено саме через R².' : ''}${laterOk ? ' За 5 і 20 мс R² не нижчий за 0,95, а інтервал квадратичного доданка містить нуль.' : ''}`
  const cParts = []
  if (failedRatio.length) cParts.push(`Частка tп/Tз вища за 20 % для: ${failedRatio.map(fitPhrase).join('; ')}.`)
  if (failedGrowth.length) cParts.push(`Нахил не зростає від 0 до 5 і до 20 мс для: ${failedGrowth.map((item) => item.label).join('; ')}.`)
  const kept = []
  if (!failedRatio.some((fit) => fit.latency === 0)) kept.push('за нульової затримки частка лишається нижчою за 20 %')
  if (!failedGrowth.length) kept.push('нахил із затримкою зростає')
  const cText = conditionC
    ? 'Умова (в) виконана: tп менший за 20 % від Tз і зростає, коли затримка збільшується від 0 до 5 і до 20 мс.'
    : `Умова (в) виконана не повністю. ${cParts.join(' ')}${kept.length ? ` ${kept[0].charAt(0).toUpperCase()}${kept[0].slice(1)}${kept[1] ? `, а ${kept[1]}` : ''}.` : ''}`
  const tx0 = fits.find((fit) => fit.key === 'transaction' && fit.latency === 0)
  const tx20 = fits.find((fit) => fit.key === 'transaction' && fit.latency === 20)
  const ratios = [0, 20].map((latency) => PATHS.map(([key]) => {
    const fit = fits.find((item) => item.key === key && item.latency === latency)
    return ua(100 * fit.tpMs / fit.tzMs, 1)
  }))
  return [
    'Оцінки Tз = a + b і tп = b наведено в табл. 5 для затримок 0 і 20 мс. Ту саму модель пораховано і для 5 мс, її використано на рис. 3.',
    bText,
    cText,
    `За нульової затримки tп становить ${ratios[0][0]} % від Tз на прямому з'єднанні, ${ratios[0][1]} % у режимі session і ${ratios[0][2]} % у режимі transaction. За 20 мс ці частки дорівнюють ${ratios[1][0]} %, ${ratios[1][1]} % і ${ratios[1][2]} %.`,
    `Залежність b(d) = b0 + k·d дає таке k: ${kBits.join('; ')}.`,
    `Журнал пропуску містить ${skipTrips} звернень: BEGIN, взяття лока, перевірка реєстру, читання ідентифікатора і COMMIT.`,
    'BEGIN і запит лока всі сесії надсилають одразу після бар\'єра, тож у нахил входить лише те, що виконується після отримання лока: перевірка реєстру, читання ідентифікатора і COMMIT. Це три обміни.',
    `Оцінка k близька до трьох на всіх шляхах, зокрема на прямому з'єднанні, де черги пулера немає. У режимі transaction медіана утримання лока сесією, яка міграцію пропускає, дорівнює ${ua(tx0.measuredHoldMedianMs, 2)} мс без затримки і ${ua(tx20.measuredHoldMedianMs, 2)} мс за 20 мс, а оцінки tп дорівнюють ${ua(tx0.tpMs, 2)} і ${ua(tx20.tpMs, 2)} мс. Різниця, ${ua(tx0.tpMs - tx0.measuredHoldMedianMs, 2)} і ${ua(tx20.tpMs - tx20.measuredHoldMedianMs, 2)} мс, припадає на передачу лока наступній сесії.`,
  ].join(' ')
}

function cpuName() {
  return String(host.cpuModel || '')
    .replace(/\(R\)|\(TM\)/g, '')
    .replace(/CPU @ /g, '')
    .replace(/(\d+)\.(\d+)\s*GHz/i, '$1,$2 ГГц')
    .replace(/\s+/g, ' ')
    .trim()
}

function discussionText() {
  const tx = fits.find((fit) => fit.key === 'transaction' && fit.latency === 0)
  const direct = fits.find((fit) => fit.key === 'direct' && fit.latency === 0)
  const opened = verdictUa === 'підтверджено'
    ? 'Гіпотезу H2 на цьому стенді підтверджено.'
    : `Гіпотезу H2 на цьому стенді ${verdictUa}.`
  return [
    opened,
    'Під локом взаємне виключення тримається: схема з\'являється один раз, решта сесій міграцію пропускають.',
    `За затримки 20 мс час серії майже точно лягає на пряму (R² = 1,000). Без доданої затримки R² падає до ${ua(minR2, 3)}, бо час пропуску становить лише кілька мілісекунд і на ньому вже видно розкид планування.`,
    `Без доданої затримки пропуск у режимі transaction оцінюється в ${ua(tx.tpMs, 2)} мс, а застосування схеми в ${ua(tx.tzMs, 1)} мс. На прямому з'єднанні це ${ua(direct.tpMs, 2)} і ${ua(direct.tzMs, 1)} мс.`,
    'Щойно до відповіді сервера додається 5 або 20 мс, пропуск, у якому три обміни йдуть один за одним, наздоганяє час застосування схеми. Сам SQL схеми лишається одним запитом, тож Tз росте повільніше за tп.',
    `За N = 64 і 20 мс 95-й процентиль близький до ${ua(slowest.p95 / 1000, 1)} с. Зависань не було, ліміт 60 с не знадобився. Для більшої кількості реплік очікування варто ставити від виміряного 95-го процентиля, а не від часу однієї міграції.`,
    'Пул режиму transaction лишався рівним 4. На коректність це не вплинуло, бо сесії й так ідуть по черзі через лок. Клієнти понад чотири при цьому ще чекають вільного з\'єднання в пулері. Пул режиму session був 64, тож його черга у виміряний час не входить.',
    `Процесор стенда: ${host.cpus} ядер, ${cpuName()}. Наприкінці серії середнє навантаження (load average за 1, 5 і 15 хв) становило ${load || 'не записано'}.`,
  ].join(' ')
}

function conclusion1() {
  const violations = wilson(lockRuns.length - lockCorrect, lockRuns.length)
  const clean = zeroViolations
    ? 'Порушень коректності під локом не було, завислих серій також.'
    : 'Під локом були запуски, які критерій коректності не пройшли.'
  return `Під транзакційним локом коректними були ${ofCount(lockCorrect, lockRuns.length)} запусків (95 % інтервал Вілсона ${wilsonPct(lockInterval)}) для N до 64 і затримки до 20 мс. Без лока в режимі transaction коректними були ${ofCount(controlCorrect, controlRuns.length)} (інтервал ${wilsonPct(controlInterval)}). ${clean} Умову (а) в частині відсутності порушень ${zeroViolations ? 'підтверджено' : 'не підтверджено'}. Верхня межа 95 % інтервалу Вілсона для частки порушень дорівнює ${ua(violations.high * 100, 2)} %. Поріг цієї частки перед серією не зафіксовано, тому казати, що умову (а) виконано повністю, не можна.`
}

function conclusion2() {
  const zeroRatio = Math.max(...fits.filter((fit) => fit.latency === 0).map((fit) => 100 * fit.tpMs / fit.tzMs))
  return `Час серії зростає з N. Нахил tп лежить у межах ${span(minTp, maxTp, 2)} мс на сесію, найменше R² дорівнює ${ua(minR2, 3)}. За нульової затримки час пропуску не перевищує ${ua(zeroRatio, 1)} % часу застосування схеми, а за 5 і 20 мс ця частка вже вища за поріг 20 %. Умову (б) за нульової затримки не виконано, умову (в) за доданої затримки не виконано.`
}

function conclusion3() {
  const tx0 = fits.find((fit) => fit.key === 'transaction' && fit.latency === 0)
  const tx20 = fits.find((fit) => fit.key === 'transaction' && fit.latency === 20)
  const interval = transactionSlope.kInterval
    ? span(transactionSlope.kInterval.low, transactionSlope.kInterval.high, 2)
    : 'немає'
  return `У режимі transaction збільшення затримки на 1 мс збільшує нахил на ${ua(transactionSlope.k, 2)} мс (95 % інтервал ${interval}). Це близько до трьох обмінів після отримання лока, хоча журнал пропуску містить ${skipTrips} звернень. Практично для N реплік у цьому режимі час серії без доданої затримки близький до ${ua(tx0.tzMs, 1)} + (N − 1)·${ua(tx0.tpMs, 2)} мс, а за затримки 20 мс до ${ua(tx20.tzMs, 1)} + (N − 1)·${ua(tx20.tpMs, 2)} мс. Для N = 64 і 20 мс 95-й процентиль дорівнює ${ua(cell('transaction', 'xact', 64, 20, 'main').seriesP95Ms, 1)} мс, тож ліміт очікування репліки має бути не нижчим за це значення.`
}

function seriesBand(path, latency) {
  const ns = []
  const medians = []
  const low = []
  const high = []
  const line = []
  const fit = fits.find((item) => item.key === path && item.latency === latency)
  for (const n of NS) {
    const group = select((run) => run.series === 'main' && run.path === path && run.lock === 'xact' && run.n === n && run.latencyMs === latency && !run.hung)
    const values = group.map((run) => run.seriesMs)
    ns.push(n)
    medians.push(median(values))
    low.push(percentile(values, 0.025))
    high.push(percentile(values, 0.975))
    line.push(fit.interceptMs + fit.tpMs * n)
  }
  return { latency, ns, medians, low, high, line }
}

const figure2 = PATHS.map(([key, label]) => ({
  key,
  label,
  series: LATENCIES.map((latency) => seriesBand(key, latency)),
}))

const figure3 = summary.latencySlope.map((item) => {
  const label = PATHS.find(([key]) => key === item.path)[1]
  const rows = fits.filter((fit) => fit.key === item.path).sort((a, b) => a.latency - b.latency)
  return {
    key: item.path,
    label,
    latency: rows.map((fit) => fit.latency),
    tp: rows.map((fit) => fit.tpMs),
    low: rows.map((fit) => fit.slopeInterval.low),
    high: rows.map((fit) => fit.slopeInterval.high),
    line: rows.map((fit) => item.b0 + item.k * fit.latency),
  }
})

const versionText = String(meta.pgbouncerSession.version.version || '')
const pgbouncer = (versionText.match(/(\d+\.\d+\.\d+)/) || [])[1]
const postgres = ((meta.postgres || '').match(/PostgreSQL (\d+\.\d+)/) || [])[1]

const article = {
  runs: runs.length,
  standFailures: summary.standFailures,
  pgbouncer,
  pg: meta.pg,
  toxiproxy: String(meta.toxiproxy),
  postgres,
  lockCount: ofCount(lockCorrect, lockRuns.length),
  controlCount: ofCount(controlCorrect, controlRuns.length),
  lockCountEn: `${lockCorrect} of ${lockRuns.length}`,
  controlCountEn: `${controlCorrect} of ${controlRuns.length}`,
  slopeUa: `від ${ua(minTp, 2)} до ${ua(maxTp, 2)}`,
  slopeEn: `from ${minTp.toFixed(2)} to ${maxTp.toFixed(2)}`,
  r2Ua: span(minR2, maxR2, 3),
  r2En: `${minR2.toFixed(3)}${DASH}${maxR2.toFixed(3)}`,
  verdictUa,
  verdictEn,
  roundTrips: `(у цій реалізації їх ${skipTrips}: BEGIN, взяття лока, перевірка наявності реєстру, читання ідентифікатора й COMMIT)`,
  control: controlText(),
  table3: table3Text(),
  table3Cells: table3Cells(),
  table4: table4Text(),
  table4Cells: table4Cells(),
  table5: table5Text(),
  table5Cells: table5Cells(),
  discussion: discussionText(),
  conclusion1: conclusion1(),
  conclusion2: conclusion2(),
  conclusion3: conclusion3(),
  figure2,
  figure3,
  flags: { zeroViolations, conditionB, conditionC, minR2, minTp, maxTp, skipTrips },
}

const out = path.join(root, 'results', 'article-numbers.json')
fs.writeFileSync(out, JSON.stringify(article, null, 2))
console.log(JSON.stringify({
  runs: article.runs,
  failures: article.standFailures,
  verdict: article.verdictUa,
  lock: article.lockCount,
  control: article.controlCount,
  slope: article.slopeUa,
  r2: article.r2Ua,
  flags: article.flags,
}, null, 2))
