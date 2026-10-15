const fs = require('fs')
const path = require('path')

const LOCK_KEY = 480719
const MIGRATION_ID = 'schema'
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'schema', 'migration.sql'), 'utf8')

const EXPECTED_TABLES = [
  'collection_dictionaries',
  'collection_meta',
  'collection_revisions',
  'collections',
  'dictionaries',
  'media',
  'options',
  'schema_migrations',
  'users',
]
const EXPECTED_FUNCTIONS = ['cms_prevent_hierarchy_cycle', 'cms_set_updated_at']
const EXPECTED_TRIGGERS = 6

function msSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e6
}

async function applyMigration(client, { lock }) {
  const statements = []
  let committed = false
  const started = process.hrtime.bigint()
  try {
    statements.push('BEGIN')
    const beginAt = process.hrtime.bigint()
    await client.query('BEGIN')
    const beginMs = msSince(beginAt)

    let waitMs = null
    let lockReturnedAt = null
    if (lock) {
      statements.push('pg_advisory_xact_lock')
      const row = await client.query(
        `WITH t0 AS MATERIALIZED (SELECT clock_timestamp() AS t),
              taken AS MATERIALIZED (SELECT pg_advisory_xact_lock($1::bigint) FROM t0),
              t1 AS MATERIALIZED (SELECT clock_timestamp() AS t FROM taken)
         SELECT extract(epoch FROM (t1.t - t0.t)) * 1000 AS wait_ms
         FROM t0, t1`,
        [LOCK_KEY],
      )
      waitMs = Number(row.rows[0].wait_ms)
      lockReturnedAt = process.hrtime.bigint()
    }

    statements.push('registry_exists')
    const exists = await client.query(`SELECT to_regclass('public.schema_migrations') AS rel`)
    let already = false
    if (exists.rows[0].rel) {
      statements.push('registry_read')
      const seen = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [MIGRATION_ID])
      already = seen.rowCount > 0
    }

    let schemaMs = null
    if (!already) {
      statements.push('schema_sql')
      const schemaAt = process.hrtime.bigint()
      await client.query(SCHEMA_SQL)
      schemaMs = msSince(schemaAt)
      statements.push('registry_insert')
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [MIGRATION_ID])
    }

    statements.push('COMMIT')
    const commitAt = process.hrtime.bigint()
    await client.query('COMMIT')
    committed = true
    const afterCommit = process.hrtime.bigint()

    return {
      outcome: already ? 'skipped' : 'applied',
      statements,
      roundTrips: statements.length,
      beginMs,
      waitMs,
      schemaMs,
      commitMs: Number(afterCommit - commitAt) / 1e6,
      holdToCommitEndMs: lockReturnedAt == null ? null : Number(afterCommit - lockReturnedAt) / 1e6,
      clientMs: msSince(started),
      finishedAtNs: afterCommit.toString(),
    }
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {})
    error.statements = statements
    error.finishedAtNs = process.hrtime.bigint().toString()
    throw error
  }
}

module.exports = {
  LOCK_KEY,
  MIGRATION_ID,
  SCHEMA_SQL,
  EXPECTED_TABLES,
  EXPECTED_FUNCTIONS,
  EXPECTED_TRIGGERS,
  applyMigration,
}
