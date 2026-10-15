const PROXIES = ['direct', 'session', 'transaction']

function apiBase() {
  const base = process.env.TOXIPROXY_API
  if (!base) throw new Error('Не задано TOXIPROXY_API')
  return base.replace(/\/$/, '')
}

async function readToxics(name) {
  const response = await fetch(`${apiBase()}/proxies/${name}/toxics`)
  if (!response.ok) {
    throw new Error(`Toxiproxy ${name}: ${response.status} ${await response.text()}`)
  }
  return response.json()
}

async function setLatency(ms) {
  for (const name of PROXIES) {
    const toxics = await readToxics(name)
    const exists = toxics.some((toxic) => toxic.name === 'latency_down')
    if (ms <= 0) {
      if (!exists) continue
      const response = await fetch(`${apiBase()}/proxies/${name}/toxics/latency_down`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) {
        throw new Error(`Не вдалося зняти затримку ${name}: ${response.status} ${await response.text()}`)
      }
      continue
    }
    const url = exists
      ? `${apiBase()}/proxies/${name}/toxics/latency_down`
      : `${apiBase()}/proxies/${name}/toxics`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'latency_down',
        type: 'latency',
        stream: 'downstream',
        toxicity: 1,
        attributes: { latency: ms, jitter: 0 },
      }),
    })
    if (!response.ok) {
      throw new Error(`Не вдалося поставити затримку ${name}: ${response.status} ${await response.text()}`)
    }
  }
  const actual = {}
  for (const name of PROXIES) {
    const toxics = await readToxics(name)
    const toxic = toxics.find((item) => item.name === 'latency_down')
    actual[name] = toxic ? Number(toxic.attributes.latency) : 0
    if (actual[name] !== ms) {
      throw new Error(`Затримка ${name} дорівнює ${actual[name]}, очікувалось ${ms}`)
    }
  }
  return actual
}

module.exports = { setLatency }
