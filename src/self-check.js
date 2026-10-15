const fs = require('fs')
const path = require('path')
const { mulberry32, shuffle, buildPlan, cellKey, SEED } = require('./plan')
const { wilson, ols, quadratic, isCorrect, summarize } = require('./stats')
const { MIGRATION_ID, EXPECTED_TABLES, EXPECTED_FUNCTIONS, EXPECTED_TRIGGERS } = require('./migrate')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema', 'migration.sql'), 'utf8')
assert(!/miraicms/i.test(schema), 'у скрипті лишилась стара назва реєстру')
assert(schema.includes('schema_migrations'), 'немає таблиці реєстру')
assert((schema.match(/CREATE TABLE /g) || []).length === 9, 'очікується 9 таблиць')
assert((schema.match(/CREATE TRIGGER /g) || []).length === EXPECTED_TRIGGERS, 'очікується 6 тригерів')
assert((schema.match(/CREATE OR REPLACE FUNCTION /g) || []).length === EXPECTED_FUNCTIONS.length, 'очікується 2 функції')

const empty = wilson(0, 30)
assert(empty.high > 0.11 && empty.high < 0.12, 'верхня межа Вілсона для 0/30')
const full = wilson(30, 30)
assert(full.high === 1 && full.low > 0.88 && full.low < 0.9, 'інтервал Вілсона для 30/30')

const line = [2, 4, 8, 16, 32, 64].map((n) => ({ x: n, y: 10 + 3 * n }))
const fit = ols(line)
assert(Math.abs(fit.b - 3) < 1e-9, 'нахил прямої')
assert(Math.abs(fit.tz - 13) < 1e-9, 'Tз = a + b')
assert(fit.r2 === 1, 'R2 прямої')
const curve = quadratic(line)
assert(curve && Math.abs(curve.c) < 1e-8, 'квадратичний доданок прямої')
const parabola = [1, 2, 3, 4, 5].map((x) => ({ x, y: x * x }))
const curved = quadratic(parabola)
assert(curved && Math.abs(curved.c - 1) < 1e-8, 'квадратичний доданок параболи')

const plan = buildPlan(30)
assert(plan.length === 2190, `план має 2190 запусків, отримано ${plan.length}`)
const shuffled = shuffle(plan, SEED)
assert(shuffle(plan, SEED).map(cellKey).join() === shuffled.map(cellKey).join(), 'перемішування нестабільне')
assert(shuffled.map(cellKey).sort().join() === plan.map(cellKey).sort().join(), 'перемішування губить клітинки')

function worker(outcome) {
  return {
    ok: true,
    outcome,
    schemaMs: outcome === 'applied' ? 56 : null,
    holdToCommitEndMs: outcome === 'skipped' ? 4 : 60,
    waitMs: outcome === 'skipped' ? 3 : 0,
    roundTrips: outcome === 'skipped' ? 5 : 7,
  }
}

const good = {
  n: 4,
  barrierFailed: false,
  hung: false,
  registryIds: [MIGRATION_ID],
  schemaOk: true,
  workers: [worker('applied'), worker('skipped'), worker('skipped'), worker('skipped')],
}
assert(isCorrect(good), 'коректний запуск')
assert(!isCorrect({ ...good, hung: true }), 'зависання некоректне')
assert(!isCorrect({ ...good, workers: [worker('applied'), worker('applied'), worker('skipped'), worker('skipped')] }), 'два застосування некоректні')

const synthetic = []
for (const n of [2, 4, 8, 16, 32, 64]) {
  for (let rep = 1; rep <= 10; rep += 1) {
    synthetic.push({
      series: 'main',
      path: 'direct',
      lock: 'xact',
      n,
      latencyMs: 0,
      rep,
      barrierFailed: false,
      hung: false,
      correct: true,
      seriesMs: 40 + 5 * n,
      sqlstates: [],
      workers: [worker('applied'), ...Array.from({ length: n - 1 }, () => worker('skipped'))],
    })
  }
}
const summary = summarize(synthetic, { bootstrap: 200, random: mulberry32(SEED) })
const row = summary.table5.find((item) => item.path === 'direct' && item.latencyMs === 0)
assert(row && Math.abs(row.tpMs - 5) < 1e-6, 'оцінка tп')
assert(row.r2 === 1, 'R2 синтетики')
assert(row.slopeInterval.low <= 5 && row.slopeInterval.high >= 5, 'bootstrap-інтервал нахилу')
assert(row.quadraticContainsZero === true, 'квадратичний інтервал має містити нуль')
assert(summary.table3.find((item) => item.n === 8).directLock.correct === 10, 'табл. 3')

console.log('self-check ok')
