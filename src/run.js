const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { Client } = require('pg')
const { createBarrier } = require('./barrier')
const { setLatency } = require('./latency')
const { MIGRATION_ID, LOCK_KEY, EXPECTED_TABLES, EXPECTED_FUNCTIONS } = require('./migrate')
const {
  SEED,
  PATHS,
  TIMEOUT_MS,
  BARRIER_TIMEOUT_MS,
  shuffle,
  buildPlan,
  filterPlan,
  cellKey,
  SMOKE_PLAN,
} = require('./plan')
const { isCorrect, judgeSchema, summarize } = require('./stats')

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1]
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function numberList(name) {
  const value = argValue(name, '')
  if (!value) return null
  return value.split(',').map((item) => Number(item))
}

function stringList(name) {
  const value = argValue(name, '')
  return value ? value.split(',') : null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function outputPath(value) {
  return path.isAbsolute(value) ? value : path.join(__dirname, '..', value)
}

function sibling(file, suffix) {
  return file.replace(/\.jsonl$/, suffix)
}

function poolSize(kind) {
  if (kind === 'session') return Number(process.env.SESSION_POOL_SIZE || 64)
  if (kind === 'transaction') return Number(process.env.TRANSACTION_POOL_SIZE || 4)
  return null
}

function connectionUrl(kind) {
  const urls = {
    direct: process.env.DIRECT_URL,
    session: process.env.SESSION_URL,
    transaction: process.env.TRANSACTION_URL,
  }
  const url = urls[kind]
  if (!url) throw new Error(`Немає адреси для шляху ${kind}`)
  return url
}

function hostInfo() {
  const cpus = os.cpus()
  return {
    cpus: cpus.length,
    cpuModel: cpus[0] ? cpus[0].model : null,
    loadavg: os.loadavg(),
    totalMemMb: Math.round(os.totalmem() / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
  }
}

async function connectAdmin() {
  const client = new Client({
    connectionString: process.env.ADMIN_URL,
    application_name: 'exp-admin',
    connectionTimeoutMillis: 10000,
  })
  client.on('error', () => {})
  await client.connect()
  return client
}

async function waitForDatabase() {
  const deadline = Date.now() + 90000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const client = await connectAdmin()
      await client.query('SELECT 1')
      await client.end()
      for (const kind of PATHS) {
        const probe = new Client({ connectionString: connectionUrl(kind), connectionTimeoutMillis: 10000 })
        probe.on('error', () => {})
        await probe.connect()
        await probe.query('SELECT 1')
        await probe.end()
      }
      await setLatency(0)
      return
    } catch (error) {
      lastError = error
      console.error(`стенд ще не готовий: ${error.message}`)
      await sleep(1000)
    }
  }
  throw lastError || new Error('Стенд не відповів за 90 секунд')
}

async function clearBackends(admin) {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()`,
  )
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const left = await admin.query(
      `SELECT count(*)::int AS n
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()`,
    )
    if (left.rows[0].n === 0) return
    await sleep(100)
  }
}

async function resetDatabase(admin) {
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await clearBackends(admin)
      await admin.query('DROP SCHEMA IF EXISTS public CASCADE')
      await admin.query('CREATE SCHEMA public')
      await admin.query('GRANT ALL ON SCHEMA public TO postgres')
      await admin.query('GRANT ALL ON SCHEMA public TO public')
      return
    } catch (error) {
      lastError = error
      await sleep(200)
    }
  }
  throw lastError
}

async function snapshot(admin) {
  const tables = await admin.query(
    `SELECT c.relname AS name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY 1`,
  )
  const triggers = await admin.query(
    `SELECT count(*)::int AS n
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  )
  const functions = await admin.query(
    `SELECT p.proname AS name
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     ORDER BY 1`,
  )
  const names = tables.rows.map((row) => row.name)
  let registryIds = []
  if (names.includes('schema_migrations')) {
    const ids = await admin.query('SELECT id FROM schema_migrations ORDER BY id')
    registryIds = ids.rows.map((row) => row.id)
  }
  return {
    tables: names,
    triggerCount: triggers.rows[0].n,
    functions: functions.rows.map((row) => row.name),
    registryIds,
  }
}

function startWorker(env) {
  const child = spawn(process.execPath, [path.join(__dirname, 'worker.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let output = ''
  let timer
  const done = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = output.trim().split('\n').filter(Boolean).at(-1)
      if (!line) {
        resolve({
          ok: false,
          worker: Number(env.WORKER_INDEX),
          hung: true,
          outcome: null,
          code: 'HUNG',
          message: 'сесія не завершилась за 60 с',
        })
        return
      }
      try {
        resolve({ hung: false, ...JSON.parse(line) })
      } catch (error) {
        resolve({
          ok: false,
          worker: Number(env.WORKER_INDEX),
          hung: false,
          outcome: null,
          code: 'BAD_OUTPUT',
          message: error.message,
        })
      }
    })
  })
  return {
    done,
    arm(ms) {
      if (child.exitCode != null) return
      timer = setTimeout(() => child.kill(), ms)
    },
    stop() {
      clearTimeout(timer)
      child.kill()
    },
  }
}

function seriesMsOf(workers, releaseNs, endNs, hung) {
  if (hung) return Number(endNs - releaseNs) / 1e6
  const finishes = workers
    .map((worker) => worker.finishedAtNs)
    .filter(Boolean)
    .map((value) => BigInt(value))
    .filter((value) => value > releaseNs)
  if (!finishes.length) return null
  const last = finishes.reduce((max, value) => (value > max ? value : max))
  return Number(last - releaseNs) / 1e6
}

async function oneRun(admin, cell) {
  const latencyRead = await setLatency(cell.latencyMs)
  await resetDatabase(admin)
  const barrier = createBarrier(cell.n)
  const port = await barrier.listen()
  const handles = Array.from({ length: cell.n }, (_, worker) => startWorker({
    DATABASE_URL: connectionUrl(cell.path),
    LOCK: cell.lock,
    WORKER_INDEX: String(worker),
    BARRIER_PORT: String(port),
  }))
  let releaseNs = null
  let barrierFailed = false
  try {
    await Promise.race([
      barrier.allReady,
      sleep(BARRIER_TIMEOUT_MS).then(() => {
        throw new Error(`Бар'єр не зібрався за ${BARRIER_TIMEOUT_MS / 1000} с`)
      }),
    ])
    releaseNs = barrier.release()
    for (const handle of handles) handle.arm(TIMEOUT_MS)
  } catch (error) {
    barrierFailed = true
    console.error(error.message)
    for (const handle of handles) handle.stop()
  }
  const workers = await Promise.all(handles.map((handle) => handle.done))
  const endNs = process.hrtime.bigint()
  barrier.close()
  await sleep(200)
  const state = await snapshot(admin)
  await clearBackends(admin)
  const hung = workers.some((worker) => worker.hung)
  const run = {
    ...cell,
    seed: SEED,
    poolSize: poolSize(cell.path),
    migrationId: MIGRATION_ID,
    lockKey: LOCK_KEY,
    latencyReadMs: latencyRead[cell.path],
    barrierFailed,
    hung,
    seriesMs: releaseNs == null ? null : seriesMsOf(workers, releaseNs, endNs, hung),
    tables: state.tables,
    triggerCount: state.triggerCount,
    functions: state.functions,
    registryIds: state.registryIds,
    schemaOk: judgeSchema(state),
    sqlstates: workers.filter((worker) => worker.code && worker.code !== 'HUNG').map((worker) => worker.code),
    workers,
  }
  run.correct = isCorrect(run)
  return run
}

async function pgbouncerInfo(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 })
  client.on('error', () => {})
  await client.connect()
  try {
    const version = await client.query('SHOW VERSION')
    const config = await client.query('SHOW CONFIG')
    const wanted = ['pool_mode', 'default_pool_size', 'server_reset_query', 'server_reset_query_always', 'max_client_conn']
    const settings = {}
    for (const row of config.rows) {
      if (wanted.includes(row.key)) settings[row.key] = row.value
    }
    return { version: version.rows[0], settings }
  } finally {
    await client.end().catch(() => {})
  }
}

async function versions(admin) {
  const version = await admin.query(`SELECT version() AS version, current_setting('max_connections') AS max_connections`)
  const sessionAdmin = process.env.SESSION_URL.replace(/\/experiment$/, '/pgbouncer')
  const transactionAdmin = process.env.TRANSACTION_URL.replace(/\/experiment$/, '/pgbouncer')
  const read = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      return `не прочитано: ${error.message}`
    }
  }
  return {
    postgres: version.rows[0].version,
    maxConnections: version.rows[0].max_connections,
    node: process.version,
    pg: require('pg/package.json').version,
    pgbouncerSession: await read(() => pgbouncerInfo(sessionAdmin)),
    pgbouncerTransaction: await read(() => pgbouncerInfo(transactionAdmin)),
    toxiproxy: await read(async () => {
      const response = await fetch(`${process.env.TOXIPROXY_API}/version`)
      const body = await response.json()
      return body.version || body
    }),
    lockKey: LOCK_KEY,
    migrationId: MIGRATION_ID,
    expectedTables: EXPECTED_TABLES,
    expectedFunctions: EXPECTED_FUNCTIONS,
    sessionPoolSize: poolSize('session'),
    transactionPoolSize: poolSize('transaction'),
    timeoutMs: TIMEOUT_MS,
    seed: SEED,
    hostAtStart: hostInfo(),
    when: new Date().toISOString(),
  }
}

function loadCompleted(file) {
  if (!fs.existsSync(file)) return new Set()
  const done = new Set()
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      done.add(cellKey(JSON.parse(line)))
    } catch (error) {
      console.error(`пропущено пошкоджений рядок: ${error.message}`)
    }
  }
  return done
}

async function main() {
  if (hasFlag('--help')) {
    console.log('node src/run.js --reps 30 [--resume] [--smoke] [--paths direct,session,transaction] [--locks xact,none] [--ns 2,4,8,16,32,64] [--latencies 0,5,20] [--series main,control,reference] [--out results/runs.jsonl]')
    return
  }

  const smoke = hasFlag('--smoke')
  const reps = Number(argValue('--reps', '30'))
  const file = outputPath(argValue('--out', smoke ? 'results/smoke.jsonl' : 'results/runs.jsonl'))
  const filters = {
    series: stringList('--series'),
    paths: stringList('--paths'),
    locks: stringList('--locks'),
    ns: numberList('--ns'),
    latencies: numberList('--latencies'),
  }
  let cells = smoke ? SMOKE_PLAN.slice() : filterPlan(buildPlan(reps), filters)
  if (!smoke) cells = shuffle(cells, SEED)
  const resume = hasFlag('--resume')
  const completed = resume ? loadCompleted(file) : new Set()
  if (!resume) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
  } else if (completed.size) {
    cells = cells.filter((cell) => !completed.has(cellKey(cell)))
  }

  await waitForDatabase()
  let admin = await connectAdmin()
  const meta = await versions(admin)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(sibling(file, '-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)

  const runs = resume && fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    : []

  try {
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index]
      try {
        await admin.query('SELECT 1')
      } catch {
        admin = await connectAdmin()
      }
      const run = await oneRun(admin, cell)
      runs.push(run)
      fs.appendFileSync(file, `${JSON.stringify(run)}\n`)
      const applied = run.workers.filter((worker) => worker.outcome === 'applied').length
      const skipped = run.workers.filter((worker) => worker.outcome === 'skipped').length
      console.log(
        `${index + 1}/${cells.length} ${cell.series} ${cell.path} ${cell.lock} N=${cell.n} `
        + `d=${cell.latencyMs} #${cell.rep}: ${run.correct ? 'коректно' : 'ні'}, `
        + `застосовано ${applied}, пропущено ${skipped}, зависло ${run.hung ? 'так' : 'ні'}, `
        + `час ${run.seriesMs == null ? 'немає' : run.seriesMs.toFixed(1)} мс, `
        + `помилки ${run.sqlstates.join(',') || 'немає'}`,
      )
    }
  } finally {
    await admin.end().catch(() => {})
  }

  meta.hostAtEnd = hostInfo()
  meta.finishedAt = new Date().toISOString()
  const summary = summarize(runs, { bootstrap: Number(process.env.BOOTSTRAP || 10000) })
  fs.writeFileSync(sibling(file, '-meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  fs.writeFileSync(sibling(file, '-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`запусків ${summary.runs}, збоїв стенда ${summary.standFailures}`)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
