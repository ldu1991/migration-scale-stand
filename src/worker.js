const { Client } = require('pg')
const { waitForRelease } = require('./barrier')
const { applyMigration } = require('./migrate')

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: `exp-${process.env.WORKER_INDEX}`,
    connectionTimeoutMillis: 30000,
  })
  client.on('error', () => {})

  try {
    await client.connect()
    await waitForRelease(Number(process.env.BARRIER_PORT))
    const outcome = await applyMigration(client, { lock: process.env.LOCK === 'xact' })
    process.stdout.write(`${JSON.stringify({
      ok: true,
      worker: Number(process.env.WORKER_INDEX),
      hung: false,
      ...outcome,
    })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      worker: Number(process.env.WORKER_INDEX),
      hung: false,
      outcome: null,
      statements: error.statements || [],
      roundTrips: (error.statements || []).length,
      finishedAtNs: error.finishedAtNs || process.hrtime.bigint().toString(),
      code: error.code || null,
      message: String(error.message || error).split('\n')[0],
    })}\n`)
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(1)
})
