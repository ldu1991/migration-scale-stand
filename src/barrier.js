const net = require('net')

function createBarrier(expected) {
  const readySockets = []
  let markReady
  const allReady = new Promise((resolve) => {
    markReady = resolve
  })

  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (!buffer.includes('ready') || socket.readySeen) return
      socket.readySeen = true
      readySockets.push(socket)
      if (readySockets.length === expected) markReady()
    })
  })

  server.on('error', () => {})

  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      })
    },
    allReady,
    release() {
      const released = process.hrtime.bigint()
      for (const socket of readySockets) socket.end('go')
      return released
    },
    close() {
      server.close()
    },
  }
}

function waitForRelease(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('connect', () => socket.write('ready'))
    socket.on('data', () => resolve())
    socket.on('end', () => resolve())
    socket.on('error', reject)
  })
}

module.exports = { createBarrier, waitForRelease }
