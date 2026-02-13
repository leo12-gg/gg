const http = require("http")
const fs = require("fs")
const path = require("path")
const WebSocket = require("ws")

const port = process.env.PORT ? Number(process.env.PORT) : 3000
const publicDir = path.join(__dirname, "public")

const server = http.createServer((req, res) => {
  if (req.url === "/config.json") {
    const iceServers = [{ urls: "stun:stun.l.google.com:19302" }]
    if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
      iceServers.push({
        urls: process.env.TURN_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_PASSWORD
      })
    }
    const forwardedProto = req.headers["x-forwarded-proto"]
    const proto = forwardedProto ? String(forwardedProto).split(",")[0] : "http"
    const host = req.headers.host || `localhost:${port}`
    const serverOrigin = `${proto}://${host}`
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || null
    const body = JSON.stringify({ iceServers, publicBaseUrl, serverOrigin })
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    })
    res.end(body)
    return
  }
  const urlPath = req.url === "/" ? "/index.html" : req.url
  const filePath = path.join(publicDir, decodeURIComponent(urlPath))
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end("Not found")
      return
    }
    const ext = path.extname(filePath).toLowerCase()
    const contentType =
      ext === ".html"
        ? "text/html"
        : ext === ".css"
          ? "text/css"
          : ext === ".js"
            ? "application/javascript"
            : "application/octet-stream"
    res.writeHead(200, { "Content-Type": contentType })
    res.end(data)
  })
})

const wss = new WebSocket.Server({ server })
const rooms = new Map()
const clients = new Map()
const history = new Map()

const makeId = () =>
  Math.random().toString(36).slice(2, 8) +
  Math.random().toString(36).slice(2, 6)

const send = (ws, payload) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

const broadcast = (roomId, payload, exceptId) => {
  const room = rooms.get(roomId)
  if (!room) return
  room.forEach((id) => {
    if (id === exceptId) return
    const client = clients.get(id)
    if (client) send(client, payload)
  })
}

const removeFromRoom = (ws) => {
  if (!ws.roomId) return
  const room = rooms.get(ws.roomId)
  if (room) {
    room.delete(ws.clientId)
    if (room.size === 0) rooms.delete(ws.roomId)
  }
  broadcast(ws.roomId, { type: "peerLeft", id: ws.clientId }, ws.clientId)
  ws.roomId = null
}

wss.on("connection", (ws) => {
  ws.clientId = makeId()
  ws.displayName = `Guest-${ws.clientId.slice(0, 4)}`
  ws.voiceState = {
    inVoice: false,
    muted: false,
    deafened: false,
    speaking: false
  }
  clients.set(ws.clientId, ws)

  ws.on("message", (data) => {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!message || typeof message.type !== "string") return

    if (message.type === "joinRoom") {
      if (typeof message.roomId !== "string") return
      if (typeof message.name === "string" && message.name.trim()) {
        ws.displayName = message.name.trim().slice(0, 24)
      }
      if (ws.roomId && ws.roomId !== message.roomId) removeFromRoom(ws)
      ws.roomId = message.roomId
      if (!rooms.has(message.roomId)) rooms.set(message.roomId, new Set())
      rooms.get(message.roomId).add(ws.clientId)
      if (!history.has(message.roomId)) history.set(message.roomId, [])

      const peers = Array.from(rooms.get(message.roomId))
        .filter((id) => id !== ws.clientId)
        .map((id) => {
          const peer = clients.get(id)
          return {
            id,
            name: peer ? peer.displayName : "User",
            voiceState: peer ? peer.voiceState : null
          }
        })
      send(ws, {
        type: "joined",
        clientId: ws.clientId,
        peers,
        history: history.get(message.roomId)
      })
      broadcast(
        message.roomId,
        {
          type: "peerJoined",
          peer: { id: ws.clientId, name: ws.displayName }
        },
        ws.clientId
      )
      return
    }

    if (message.type === "leaveRoom") {
      ws.voiceState = {
        inVoice: false,
        muted: false,
        deafened: false,
        speaking: false
      }
      removeFromRoom(ws)
      return
    }

    if (message.type === "chat") {
      if (!ws.roomId || typeof message.text !== "string") return
      const text = message.text.trim()
      if (!text) return
      const msg = {
        type: "chat",
        msgId: makeId() + Date.now(),
        id: ws.clientId,
        name: ws.displayName,
        text,
        ts: Date.now()
      }
      const list = history.get(ws.roomId) || []
      list.push({ ...msg, reactions: {} })
      if (list.length > 50) list.shift()
      history.set(ws.roomId, list)
      broadcast(ws.roomId, msg)
      return
    }

    if (message.type === "typing") {
      if (!ws.roomId) return
      broadcast(
        ws.roomId,
        { type: "typing", id: ws.clientId, name: ws.displayName },
        ws.clientId
      )
      return
    }

    if (message.type === "rename") {
      if (typeof message.name !== "string") return
      const nextName = message.name.trim().slice(0, 24)
      if (!nextName) return
      ws.displayName = nextName
      if (ws.roomId) {
        broadcast(
          ws.roomId,
          { type: "peerRenamed", id: ws.clientId, name: ws.displayName },
          ws.clientId
        )
      }
      return
    }

    if (message.type === "signal") {
      if (!ws.roomId || typeof message.targetId !== "string") return
      const target = clients.get(message.targetId)
      if (!target) return
      send(target, {
        type: "signal",
        fromId: ws.clientId,
        signal: message.signal
      })
      return
    }

    if (message.type === "voiceState") {
      if (!ws.roomId) return
      const inVoice =
        typeof message.inVoice === "boolean" ? message.inVoice : true
      ws.voiceState = {
        inVoice,
        muted: Boolean(message.muted),
        deafened: Boolean(message.deafened),
        speaking: Boolean(message.speaking)
      }
      broadcast(
        ws.roomId,
        {
          type: "voiceState",
          id: ws.clientId,
          inVoice,
          muted: Boolean(message.muted),
          deafened: Boolean(message.deafened),
          speaking: Boolean(message.speaking)
        },
        ws.clientId
      )
    }

    if (message.type === "presence") {
      if (!ws.roomId) return
      const status =
        typeof message.status === "string" ? message.status.slice(0, 12) : "online"
      ws.presence = status
      broadcast(
        ws.roomId,
        { type: "presence", id: ws.clientId, status },
        ws.clientId
      )
      return
    }

    if (message.type === "react") {
      if (!ws.roomId) return
      const msgId = message.msgId
      const emoji = typeof message.emoji === "string" ? message.emoji : null
      if (!msgId || !emoji) return
      const list = history.get(ws.roomId) || []
      const target = list.find((m) => m.msgId === msgId)
      if (!target) return
      if (!target.reactions) target.reactions = {}
      if (!target.reactions[emoji]) target.reactions[emoji] = new Set()
      const set = target.reactions[emoji]
      if (set.has(ws.clientId)) set.delete(ws.clientId)
      else set.add(ws.clientId)
      broadcast(
        ws.roomId,
        {
          type: "reaction",
          msgId,
          emoji,
          count: set.size
        },
        null
      )
      return
    }
  })

  ws.on("close", () => {
    removeFromRoom(ws)
    clients.delete(ws.clientId)
  })
})

server.listen(port, () => {
  process.stdout.write(`Server running on http://localhost:${port}\n`)
})
