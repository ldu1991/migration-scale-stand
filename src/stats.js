const { MIGRATION_ID, EXPECTED_TABLES, EXPECTED_FUNCTIONS, EXPECTED_TRIGGERS } = require('./migrate')

function wilson(successes, total, z = 1.96) {
  if (!total) return { p: null, low: null, high: null }
  const p = successes / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const center = (p + z2 / (2 * total)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator
  return {
    p,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return sorted[low]
  return sorted[low] * (high - index) + sorted[high] * (index - low)
}

function median(values) {
  const sorted = values.filter((value) => value != null && !Number.isNaN(value)).slice().sort((a, b) => a - b)
  return percentile(sorted, 0.5)
}

function p95(values) {
  const sorted = values.filter((value) => value != null && !Number.isNaN(value)).slice().sort((a, b) => a - b)
  return percentile(sorted, 0.95)
}

function ols(points) {
  const n = points.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (const point of points) {
    sx += point.x
    sy += point.y
    sxx += point.x * point.x
    sxy += point.x * point.y
  }
  const denominator = n * sxx - sx * sx
  if (denominator === 0) return null
  const b = (n * sxy - sx * sy) / denominator
  const a = (sy - b * sx) / n
  const meanY = sy / n
  let ssRes = 0
  let ssTot = 0
  for (const point of points) {
    const fitted = a + b * point.x
    ssRes += (point.y - fitted) ** 2
    ssTot += (point.y - meanY) ** 2
  }
  return {
    a,
    b,
    r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
    n,
    tz: a + b,
    tp: b,
  }
}

function solve3(matrix, vector) {
  const rows = matrix.map((row, index) => [...row, vector[index]])
  for (let col = 0; col < 3; col += 1) {
    let pivot = col
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row
    }
    const current = rows[col]
    rows[col] = rows[pivot]
    rows[pivot] = current
    const divisor = rows[col][col]
    if (Math.abs(divisor) < 1e-12) return null
    for (let column = col; column < 4; column += 1) rows[col][column] /= divisor
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue
      const factor = rows[row][col]
      for (let column = col; column < 4; column += 1) rows[row][column] -= factor * rows[col][column]
    }
  }
  return [rows[0][3], rows[1][3], rows[2][3]]
}

function quadratic(points) {
  if (points.length < 3) return null
  let n = 0
  let sx = 0
  let sx2 = 0
  let sx3 = 0
  let sx4 = 0
  let sy = 0
  let sxy = 0
  let sx2y = 0
  for (const point of points) {
    const x2 = point.x * point.x
    n += 1
    sx += point.x
    sx2 += x2
    sx3 += x2 * point.x
    sx4 += x2 * x2
    sy += point.y
    sxy += point.x * point.y
    sx2y += x2 * point.y
  }
  const solved = solve3(
    [
      [n, sx, sx2],
      [sx, sx2, sx3],
      [sx2, sx3, sx4],
    ],
    [sy, sxy, sx2y],
  )
  if (!solved) return null
  return { a: solved[0], b: solved[1], c: solved[2] }
}

function bootstrap(points, times, random, pick) {
  const samples = []
  for (let sample = 0; sample < times; sample += 1) {
    const drawn = []
    for (let index = 0; index < points.length; index += 1) {
      drawn.push(points[Math.floor(random() * points.length)])
    }
    const value = pick(drawn)
    if (value != null && !Number.isNaN(value)) samples.push(value)
  }
  samples.sort((left, right) => left - right)
  return {
    samples: samples.length,
    low: percentile(samples, 0.025),
    high: percentile(samples, 0.975),
  }
}

function sameList(actual, expected) {
  if (actual.length !== expected.length) return false
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return false
  }
  return true
}

function schemaOk(run) {
  return Boolean(run.schemaOk)
}

function isCorrect(run) {
  if (!run || run.barrierFailed || run.hung) return false
  if (!Array.isArray(run.workers) || run.workers.length !== run.n) return false
  if (run.workers.some((worker) => !worker.ok)) return false
  const applied = run.workers.filter((worker) => worker.outcome === 'applied').length
  const skipped = run.workers.filter((worker) => worker.outcome === 'skipped').length
  if (applied !== 1 || skipped !== run.n - 1) return false
  if (!Array.isArray(run.registryIds) || run.registryIds.length !== 1 || run.registryIds[0] !== MIGRATION_ID) return false
  if (!schemaOk(run)) return false
  return true
}

function judgeSchema(snapshot) {
  const tables = snapshot.tables.slice().sort()
  const functions = snapshot.functions.slice().sort()
  return sameList(tables, EXPECTED_TABLES)
    && sameList(functions, EXPECTED_FUNCTIONS)
    && snapshot.triggerCount === EXPECTED_TRIGGERS
}

function slopeAgainstLatency(byLatency, times, random) {
  if (byLatency.size < 2) return null
  const samples = []
  for (let sample = 0; sample < times; sample += 1) {
    const resampled = []
    for (const [latencyMs, group] of byLatency) {
      const drawn = []
      for (let index = 0; index < group.length; index += 1) {
        drawn.push(group[Math.floor(random() * group.length)])
      }
      const fit = ols(drawn
        .filter((run) => !run.hung && run.seriesMs != null)
        .map((run) => ({ x: run.n, y: run.seriesMs })))
      if (fit) resampled.push({ x: Number(latencyMs), y: fit.b })
    }
    const line = ols(resampled)
    if (line) samples.push(line.b)
  }
  samples.sort((left, right) => left - right)
  return {
    samples: samples.length,
    low: percentile(samples, 0.025),
    high: percentile(samples, 0.975),
  }
}

function groupKey(run) {
  return [run.series, run.path, run.lock, run.n, run.latencyMs].join('|')
}

function fitGroup(runs, times, random) {
  const completed = runs.filter((run) => !run.hung && !run.barrierFailed && run.seriesMs != null)
  const points = completed.map((run) => ({ x: run.n, y: run.seriesMs }))
  const linear = ols(points)
  const curve = quadratic(points)
  if (!linear) return { linear: null, quadratic: null, slopeInterval: null, quadraticInterval: null }
  const slopeInterval = bootstrap(points, times, random, (sample) => {
    const fit = ols(sample)
    return fit ? fit.b : null
  })
  const quadraticInterval = bootstrap(points, times, random, (sample) => {
    const fit = quadratic(sample)
    return fit ? fit.c : null
  })
  return { linear, quadratic: curve, slopeInterval, quadraticInterval }
}

function summarize(runs, options = {}) {
  const times = options.bootstrap || 10000
  const random = options.random || Math.random
  const usable = runs.filter((run) => !run.barrierFailed)
  const cells = new Map()
  for (const run of usable) {
    const key = groupKey(run)
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(run)
  }

  const cellRows = [...cells.entries()].map(([key, group]) => {
    const sample = group[0]
    const completed = group.filter((run) => !run.hung && run.seriesMs != null)
    const correct = group.filter((run) => run.correct).length
    const sqlstates = {}
    for (const run of group) {
      for (const code of run.sqlstates || []) sqlstates[code] = (sqlstates[code] || 0) + 1
    }
    return {
      key,
      series: sample.series,
      path: sample.path,
      lock: sample.lock,
      n: sample.n,
      latencyMs: sample.latencyMs,
      runs: group.length,
      correct,
      hung: group.filter((run) => run.hung).length,
      wilson: wilson(correct, group.length),
      seriesMedianMs: median(completed.map((run) => run.seriesMs)),
      seriesP95Ms: p95(completed.map((run) => run.seriesMs)),
      schemaMedianMs: median(group.flatMap((run) => run.workers.filter((worker) => worker.outcome === 'applied').map((worker) => worker.schemaMs))),
      holdMedianMs: median(group.flatMap((run) => run.workers.filter((worker) => worker.outcome === 'skipped').map((worker) => worker.holdToCommitEndMs))),
      waitMedianMs: median(group.flatMap((run) => run.workers.filter((worker) => worker.outcome === 'skipped').map((worker) => worker.waitMs))),
      sqlstates,
    }
  })

  const table3 = []
  const ns = [...new Set(usable.filter((run) => run.series === 'main' || run.series === 'control').map((run) => run.n))].sort((a, b) => a - b)
  for (const n of ns) {
    const columns = [
      ['directLock', (run) => run.series === 'main' && run.path === 'direct' && run.lock === 'xact' && run.n === n],
      ['sessionLock', (run) => run.series === 'main' && run.path === 'session' && run.lock === 'xact' && run.n === n],
      ['transactionLock', (run) => run.series === 'main' && run.path === 'transaction' && run.lock === 'xact' && run.n === n],
      ['transactionNone', (run) => run.series === 'control' && run.path === 'transaction' && run.lock === 'none' && run.n === n],
    ]
    const row = { n }
    for (const [name, match] of columns) {
      const group = usable.filter(match)
      const correct = group.filter((run) => run.correct).length
      row[name] = { correct, total: group.length, wilson: wilson(correct, group.length) }
    }
    table3.push(row)
  }

  const table4 = cellRows
    .filter((row) => row.series === 'main' && row.path === 'transaction' && row.lock === 'xact' && [2, 8, 32, 64].includes(row.n))
    .map((row) => ({
      n: row.n,
      latencyMs: row.latencyMs,
      medianMs: row.seriesMedianMs,
      p95Ms: row.seriesP95Ms,
      runs: row.runs,
      hung: row.hung,
    }))

  const modelGroups = new Map()
  for (const run of usable.filter((item) => item.series === 'main' && item.lock === 'xact')) {
    const key = `${run.path}|${run.latencyMs}`
    if (!modelGroups.has(key)) modelGroups.set(key, [])
    modelGroups.get(key).push(run)
  }
  const table5 = []
  for (const [key, group] of modelGroups) {
    const fit = fitGroup(group, times, random)
    const sample = group[0]
    const ratio = fit.linear && fit.linear.tz ? fit.linear.tp / fit.linear.tz : null
    table5.push({
      key,
      path: sample.path,
      latencyMs: sample.latencyMs,
      runs: group.length,
      tzMs: fit.linear ? fit.linear.tz : null,
      tpMs: fit.linear ? fit.linear.tp : null,
      interceptMs: fit.linear ? fit.linear.a : null,
      r2: fit.linear ? fit.linear.r2 : null,
      slopeInterval: fit.slopeInterval,
      quadraticC: fit.quadratic ? fit.quadratic.c : null,
      quadraticInterval: fit.quadraticInterval,
      quadraticContainsZero: fit.quadraticInterval
        ? fit.quadraticInterval.low <= 0 && fit.quadraticInterval.high >= 0
        : null,
      tpOverTz: ratio,
      measuredSchemaMedianMs: median(group.flatMap((run) => run.workers.filter((worker) => worker.outcome === 'applied').map((worker) => worker.schemaMs))),
      measuredHoldMedianMs: median(group.flatMap((run) => run.workers.filter((worker) => worker.outcome === 'skipped').map((worker) => worker.holdToCommitEndMs))),
    })
  }

  const latencySlope = []
  const paths = [...new Set(table5.map((row) => row.path))]
  for (const path of paths) {
    const rows = table5.filter((row) => row.path === path && row.tpMs != null)
    const points = rows.map((row) => ({ x: row.latencyMs, y: row.tpMs }))
    const fit = ols(points)
    const byLatency = new Map()
    for (const run of usable.filter((item) => item.series === 'main' && item.lock === 'xact' && item.path === path)) {
      if (!byLatency.has(run.latencyMs)) byLatency.set(run.latencyMs, [])
      byLatency.get(run.latencyMs).push(run)
    }
    const interval = slopeAgainstLatency(byLatency, times, random)
    latencySlope.push({
      path,
      b0: fit ? fit.a : null,
      k: fit ? fit.b : null,
      r2: fit ? fit.r2 : null,
      kInterval: interval,
    })
  }

  const referenceRuns = usable.filter((run) => run.series === 'reference')
  const referenceSessions = { applied: 0, skipped: 0, errors: {} }
  for (const run of referenceRuns) {
    for (const worker of run.workers) {
      if (worker.outcome === 'applied') referenceSessions.applied += 1
      else if (worker.outcome === 'skipped') referenceSessions.skipped += 1
      else {
        const code = worker.code || 'unknown'
        referenceSessions.errors[code] = (referenceSessions.errors[code] || 0) + 1
      }
    }
  }

  const skipTrips = usable
    .filter((run) => run.series === 'main')
    .flatMap((run) => run.workers.filter((worker) => worker.outcome === 'skipped').map((worker) => worker.roundTrips))
  const tripCounts = {}
  for (const trips of skipTrips) tripCounts[trips] = (tripCounts[trips] || 0) + 1

  return {
    runs: runs.length,
    standFailures: runs.filter((run) => run.barrierFailed).length,
    cells: cellRows,
    table3,
    table4,
    table5,
    latencySlope,
    reference: {
      runs: referenceRuns.length,
      correct: referenceRuns.filter((run) => run.correct).length,
      schemaOk: referenceRuns.filter((run) => run.schemaOk).length,
      sessions: referenceSessions,
      seriesMedianMs: median(referenceRuns.filter((run) => !run.hung).map((run) => run.seriesMs)),
    },
    skipRoundTrips: tripCounts,
  }
}

module.exports = {
  wilson,
  percentile,
  median,
  p95,
  ols,
  quadratic,
  bootstrap,
  isCorrect,
  judgeSchema,
  summarize,
}
