const SEED = 20261015
const PATHS = ['direct', 'session', 'transaction']
const NS = [2, 4, 8, 16, 32, 64]
const LATENCIES = [0, 5, 20]
const TIMEOUT_MS = 60000
const BARRIER_TIMEOUT_MS = 45000

function mulberry32(seed) {
  let state = seed >>> 0
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(items, seed) {
  const copy = items.slice()
  const random = mulberry32(seed)
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const item = copy[index]
    copy[index] = copy[swap]
    copy[swap] = item
  }
  return copy
}

function buildPlan(reps) {
  const cells = []
  for (const path of PATHS) {
    for (const n of NS) {
      for (const latencyMs of LATENCIES) {
        for (let rep = 1; rep <= reps; rep += 1) {
          cells.push({ series: 'main', path, lock: 'xact', n, latencyMs, rep })
        }
      }
    }
  }
  for (const n of NS) {
    for (const latencyMs of LATENCIES) {
      for (let rep = 1; rep <= reps; rep += 1) {
        cells.push({ series: 'control', path: 'transaction', lock: 'none', n, latencyMs, rep })
      }
    }
  }
  for (let rep = 1; rep <= reps; rep += 1) {
    cells.push({ series: 'reference', path: 'direct', lock: 'none', n: 8, latencyMs: 0, rep })
  }
  return cells
}

function filterPlan(cells, options) {
  return cells.filter((cell) => {
    if (options.series && !options.series.includes(cell.series)) return false
    if (options.paths && !options.paths.includes(cell.path)) return false
    if (options.locks && !options.locks.includes(cell.lock)) return false
    if (options.ns && !options.ns.includes(cell.n)) return false
    if (options.latencies && !options.latencies.includes(cell.latencyMs)) return false
    return true
  })
}

function cellKey(cell) {
  return [cell.series, cell.path, cell.lock, cell.n, cell.latencyMs, cell.rep].join('|')
}

const SMOKE_PLAN = [
  { series: 'main', path: 'direct', lock: 'xact', n: 2, latencyMs: 0, rep: 1 },
  { series: 'main', path: 'direct', lock: 'xact', n: 2, latencyMs: 5, rep: 1 },
  { series: 'main', path: 'session', lock: 'xact', n: 2, latencyMs: 0, rep: 1 },
  { series: 'main', path: 'transaction', lock: 'xact', n: 2, latencyMs: 0, rep: 1 },
  { series: 'main', path: 'transaction', lock: 'xact', n: 8, latencyMs: 0, rep: 1 },
  { series: 'control', path: 'transaction', lock: 'none', n: 2, latencyMs: 0, rep: 1 },
  { series: 'reference', path: 'direct', lock: 'none', n: 8, latencyMs: 0, rep: 1 },
]

module.exports = {
  SEED,
  PATHS,
  NS,
  LATENCIES,
  TIMEOUT_MS,
  BARRIER_TIMEOUT_MS,
  mulberry32,
  shuffle,
  buildPlan,
  filterPlan,
  cellKey,
  SMOKE_PLAN,
}
