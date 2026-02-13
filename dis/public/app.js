const wsUrl =
  (location.protocol === "https:" ? "wss://" : "ws://") + location.host
const ws = new WebSocket(wsUrl)
let ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }]
let PUBLIC_BASE_URL = null
fetch("/config.json")
  .then((r) => r.json())
  .then((cfg) => {
    if (Array.isArray(cfg.iceServers)) ICE_SERVERS = cfg.iceServers
    PUBLIC_BASE_URL = cfg.publicBaseUrl || cfg.serverOrigin || location.origin
  })
  .catch(() => {})

const servers = ["gg", "dev", "music"]
let rooms = ["general", "gaming", "music", "random"]
const state = {
  clientId: null,
  roomId: "general",
  serverId: "gg",
  displayName: "",
  peers: new Map(),
  voiceEnabled: false,
  muted: false,
  deafened: false,
  localStream: null,
  peerConnections: new Map(),
  typingUsers: new Map(),
  voiceChannel: null
}

const nameInput = document.getElementById("nameInput")
const saveName = document.getElementById("saveName")
const roomTitle = document.getElementById("roomTitle")
const roomStatus = document.getElementById("roomStatus")
const inviteBtn = document.getElementById("inviteBtn")
const presenceSelect = document.getElementById("presenceSelect")
const messageInput = document.getElementById("messageInput")
const sendBtn = document.getElementById("sendBtn")
const messages = document.getElementById("messages")
const typing = document.getElementById("typing")
const memberList = document.getElementById("memberList")
const voiceList = document.getElementById("voiceList")
const joinVoice = document.getElementById("joinVoice")
const leaveVoice = document.getElementById("leaveVoice")
const muteBtn = document.getElementById("muteBtn")
const roomsList = document.getElementById("roomsList")
const newRoomName = document.getElementById("newRoomName")
const addRoomBtn = document.getElementById("addRoomBtn")

const defaultName = `Guest-${Math.random().toString(36).slice(2, 6)}`
state.displayName = defaultName
nameInput.value = defaultName
const urlParams = new URLSearchParams(location.search)
const roomParam = urlParams.get("room")
const voiceParam = urlParams.get("voice")
const channelParam = urlParams.get("channel")
const serverParam = urlParams.get("server")
if (roomParam && ["general", "gaming", "music", "random"].includes(roomParam)) {
  state.roomId = roomParam
}
if (serverParam && servers.includes(serverParam)) {
  state.serverId = serverParam
}

const updateStatus = (text) => {
  roomStatus.textContent = text
}

const setRoomTitle = (roomId) => {
  roomTitle.textContent = `${state.serverId} • # ${roomId}`
  messageInput.placeholder = `Message #${roomId}`
}

const formatTime = (timestamp) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

const getInitials = (name) => {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "U"
  const first = parts[0][0] || ""
  const second = parts.length > 1 ? parts[1][0] || "" : ""
  return (first + second).toUpperCase()
}

const getAvatarColor = (seed) => {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 70% 55%)`
}

const makeInviteLink = () => {
  const base = PUBLIC_BASE_URL || location.origin
  const params = new URLSearchParams()
  params.set("room", state.roomId)
  params.set("server", state.serverId)
  if (state.voiceEnabled) {
    params.set("voice", "1")
    if (state.voiceChannel) params.set("channel", state.voiceChannel)
  }
  return `${base}/?${params.toString()}`
}

const renderRooms = () => {
  roomsList.innerHTML = ""
  rooms.forEach((r, i) => {
    const btn = document.createElement("button")
    btn.className = "room-button" + (r === state.roomId ? " active" : "")
    btn.dataset.room = r
    btn.textContent = `# ${r}`
    btn.addEventListener("click", () => joinRoom(r))
    roomsList.appendChild(btn)
  })
}

const addMessage = ({ name, text, ts }) => {
  const wrapper = document.createElement("div")
  wrapper.className = "message"
  const header = document.createElement("div")
  header.className = "message-header"
  header.textContent = `${name} • ${formatTime(ts)}`
  const body = document.createElement("div")
  body.className = "message-body"
  body.textContent = text
  const reactions = document.createElement("div")
  reactions.className = "reaction-bar"
  const add = document.createElement("div")
  add.className = "reaction add"
  add.textContent = "➕"
  const emojis = ["👍", "❤️", "😂", "🔥", "🎮", "🎵"]
  emojis.forEach((emo) => {
    const el = document.createElement("div")
    el.className = "reaction"
    el.textContent = `${emo} 0`
    el.dataset.emoji = emo
    el.addEventListener("click", () => {})
    reactions.appendChild(el)
  })
  reactions.appendChild(add)
  wrapper.appendChild(header)
  wrapper.appendChild(body)
  wrapper.appendChild(reactions)
  messages.appendChild(wrapper)
  messages.scrollTop = messages.scrollHeight
}

const messageIndex = new Map()
const createMessageElement = (msg) => {
  const wrapper = document.createElement("div")
  wrapper.className = "message"
  wrapper.dataset.msgId = msg.msgId || ""
  const header = document.createElement("div")
  header.className = "message-header"
  header.textContent = `${msg.name} • ${formatTime(msg.ts)}`
  const body = document.createElement("div")
  body.className = "message-body"
  body.textContent = msg.text
  const reactions = document.createElement("div")
  reactions.className = "reaction-bar"
  const emojis = ["👍", "❤️", "😂", "🔥", "🎮", "🎵"]
  emojis.forEach((emo) => {
    const el = document.createElement("div")
    el.className = "reaction"
    el.dataset.emoji = emo
    el.textContent = `${emo} ${0}`
    el.addEventListener("click", () => {
      if (msg.msgId) {
        sendPayload({ type: "react", msgId: msg.msgId, emoji: emo })
      }
    })
    reactions.appendChild(el)
  })
  wrapper.appendChild(header)
  wrapper.appendChild(body)
  wrapper.appendChild(reactions)
  return wrapper
}

const updateReactionCount = (msgId, emoji, count) => {
  const el = messages.querySelector(`.message[data-msg-id="${msgId}"]`)
  const wrapper =
    el || messages.querySelector(`.message[data-msgid="${msgId}"]`) || null
  const target = wrapper
    ? Array.from(wrapper.querySelectorAll(".reaction")).find(
        (r) => r.dataset.emoji === emoji
      )
    : null
  if (target) {
    target.textContent = `${emoji} ${count}`
  }
}

const renderMembers = () => {
  memberList.innerHTML = ""
  const selfItem = buildMemberItem(state.clientId, state.displayName, {
    muted: state.muted,
    deafened: state.deafened,
    speaking: false,
    inVoice: state.voiceEnabled
  })
  if (selfItem) memberList.appendChild(selfItem)
  state.peers.forEach((peer, id) => {
    const item = buildMemberItem(id, peer.name, peer.voiceState || {})
    if (item) memberList.appendChild(item)
  })
  renderVoiceList()
}

const buildMemberItem = (id, name, voiceState) => {
  if (!id) return null
  const item = document.createElement("div")
  item.className = "member"
  const left = document.createElement("div")
  left.className = "member-left"
  const avatar = document.createElement("div")
  avatar.className = "member-avatar"
  avatar.style.background = getAvatarColor(id + name)
  avatar.textContent = getInitials(name || "User")
  if (voiceState && voiceState.speaking) {
    avatar.classList.add("speaking")
  } else {
    avatar.classList.remove("speaking")
  }
  const info = document.createElement("div")
  info.className = "member-info"
  const title = document.createElement("div")
  title.className = "member-name"
  title.textContent = name
  const status = document.createElement("div")
  status.className = "member-status"
  const parts = []
  if (voiceState.inVoice) parts.push("Voice")
  if (voiceState.muted) parts.push("Muted")
  if (voiceState.deafened) parts.push("Deafened")
  if (voiceState.speaking) parts.push("Speaking")
  status.textContent = parts.length ? parts.join(" • ") : "Online"
  left.appendChild(avatar)
  info.appendChild(title)
  info.appendChild(status)
  left.appendChild(info)
  item.appendChild(left)
  const badge = document.createElement("div")
  badge.textContent =
    id === state.clientId ? "You" : voiceState.inVoice ? "Live" : "Online"
  item.appendChild(badge)
  return item
}

const clearTyping = (id) => {
  const entry = state.typingUsers.get(id)
  if (entry) clearTimeout(entry.timeout)
  state.typingUsers.delete(id)
  updateTypingIndicator()
}

const updateTypingIndicator = () => {
  const names = Array.from(state.typingUsers.values()).map((entry) => entry.name)
  typing.textContent =
    names.length === 0
      ? ""
      : names.length === 1
        ? `${names[0]} is typing...`
        : `${names.slice(0, 2).join(", ")} are typing...`
}

const setActiveRoomButton = (roomId) => {
  document.querySelectorAll(".room-button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.room === roomId)
  })
}

const sendPayload = (payload) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

const joinRoom = (roomId) => {
  if (state.roomId === roomId && state.clientId) return
  state.roomId = roomId
  setRoomTitle(roomId)
  setActiveRoomButton(roomId)
  messages.innerHTML = ""
  typing.textContent = ""
  state.peers.clear()
  state.typingUsers.forEach((entry) => clearTimeout(entry.timeout))
  state.typingUsers.clear()
  updateTypingIndicator()
  disableVoice()
  const composite = `${state.serverId}/${roomId}`
  sendPayload({ type: "joinRoom", roomId: composite, name: state.displayName })
}

const connectToPeer = (peerId) => {
  if (state.peerConnections.has(peerId)) return state.peerConnections.get(peerId)
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  })
  state.peerConnections.set(peerId, pc)

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendPayload({
        type: "signal",
        targetId: peerId,
        signal: { type: "candidate", candidate: event.candidate }
      })
    }
  }

  pc.ontrack = (event) => {
    const existing = document.getElementById(`audio-${peerId}`)
    if (existing) return
    const audio = document.createElement("audio")
    audio.id = `audio-${peerId}`
    audio.autoplay = true
    audio.srcObject = event.streams[0]
    document.body.appendChild(audio)
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, state.localStream)
    })
  }

  return pc
}

const createOffer = async (peerId) => {
  const pc = connectToPeer(peerId)
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  sendPayload({
    type: "signal",
    targetId: peerId,
    signal: pc.localDescription
  })
}

const handleSignal = async (fromId, signal) => {
  const pc = connectToPeer(fromId)
  if (signal.type === "offer") {
    await pc.setRemoteDescription(signal)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    sendPayload({
      type: "signal",
      targetId: fromId,
      signal: pc.localDescription
    })
  } else if (signal.type === "answer") {
    await pc.setRemoteDescription(signal)
  } else if (signal.type === "candidate") {
    if (signal.candidate) {
      try {
        await pc.addIceCandidate(signal.candidate)
      } catch {}
    }
  }
}

const renderVoiceList = () => {
  voiceList.innerHTML = ""
  const entries = []
  if (state.voiceEnabled) {
    entries.push({
      id: state.clientId,
      name: state.displayName,
      voiceState: { inVoice: true, muted: state.muted, deafened: state.deafened }
    })
  }
  state.peers.forEach((peer, id) => {
    if (peer.voiceState && peer.voiceState.inVoice) {
      entries.push({ id, name: peer.name, voiceState: peer.voiceState })
    }
  })
  entries.forEach((entry) => {
    const item = document.createElement("div")
    item.className = "voice-item"
    const left = document.createElement("div")
    left.className = "member-left"
    const avatar = document.createElement("div")
    avatar.className = "member-avatar"
    avatar.style.background = getAvatarColor(entry.id + entry.name)
    avatar.textContent = getInitials(entry.name || "User")
    const info = document.createElement("div")
    info.className = "member-info"
    const title = document.createElement("div")
    title.className = "member-name"
    title.textContent = entry.name
    const status = document.createElement("div")
    status.className = "member-status"
    const parts = ["Voice"]
    if (entry.voiceState.muted) parts.push("Muted")
    if (entry.voiceState.deafened) parts.push("Deafened")
    status.textContent = parts.join(" • ")
    left.appendChild(avatar)
    info.appendChild(title)
    info.appendChild(status)
    left.appendChild(info)
    item.appendChild(left)
    const badge = document.createElement("div")
    badge.className = "voice-badge"
    badge.textContent = entry.id === state.clientId ? "You" : "Live"
    item.appendChild(badge)
    voiceList.appendChild(item)
  })
}

const enableVoice = async (channel) => {
  if (state.voiceEnabled) return
  state.voiceChannel = channel
  state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  state.voiceEnabled = true
  state.muted = false
  state.deafened = false
  joinVoice.disabled = true
  leaveVoice.disabled = false
  muteBtn.disabled = false
  deafenBtn.disabled = false
  sendPayload({
    type: "voiceState",
    inVoice: true,
    muted: state.muted,
    deafened: state.deafened,
    speaking: true
  })
  renderMembers()
  state.peers.forEach((_, id) => {
    if (state.clientId && state.clientId < id) {
      createOffer(id)
    } else {
      connectToPeer(id)
    }
  })
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const src = ctx.createMediaStreamSource(state.localStream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    let last = 0
    const tick = () => {
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (let i = 0; i < data.length; i += 1) sum += data[i]
      const level = sum / data.length
      const speaking = level > 20 && !state.muted && !state.deafened
      if (speaking !== last) {
        last = speaking
        sendPayload({
          type: "voiceState",
          inVoice: true,
          muted: state.muted,
          deafened: state.deafened,
          speaking
        })
        renderMembers()
      }
      if (state.voiceEnabled) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  } catch {}
}

const disableVoice = () => {
  if (!state.voiceEnabled) return
  state.voiceEnabled = false
  state.muted = false
  state.deafened = false
  state.voiceChannel = null
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop())
  }
  state.localStream = null
  state.peerConnections.forEach((pc, id) => {
    pc.close()
    state.peerConnections.delete(id)
    const audio = document.getElementById(`audio-${id}`)
    if (audio) audio.remove()
  })
  joinVoice.disabled = false
  leaveVoice.disabled = true
  muteBtn.disabled = true
  deafenBtn.disabled = true
  sendPayload({
    type: "voiceState",
    inVoice: false,
    muted: false,
    deafened: false,
    speaking: false
  })
  renderMembers()
}

const toggleMute = () => {
  if (!state.localStream) return
  state.muted = !state.muted
  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = !state.muted
  })
  sendPayload({
    type: "voiceState",
    inVoice: state.voiceEnabled,
    muted: state.muted,
    deafened: state.deafened,
    speaking: !state.muted
  })
  renderMembers()
}

const toggleDeafen = () => {
  state.deafened = !state.deafened
  document.querySelectorAll("audio").forEach((audio) => {
    if (audio.id.startsWith("audio-")) {
      audio.muted = state.deafened
    }
  })
  sendPayload({
    type: "voiceState",
    inVoice: state.voiceEnabled,
    muted: state.muted,
    deafened: state.deafened,
    speaking: !state.muted
  })
  renderMembers()
}

ws.addEventListener("open", () => {
  updateStatus("Connected")
  joinRoom(state.roomId)
  if (voiceParam === "1" || voiceParam === "true") {
    const channel = channelParam || "lounge"
    enableVoice(channel)
  }
  renderRooms()
})

ws.addEventListener("close", () => {
  updateStatus("Disconnected")
})

ws.addEventListener("message", async (event) => {
  const message = JSON.parse(event.data)
  if (message.type === "joined") {
    state.clientId = message.clientId
    state.peers.clear()
    message.peers.forEach((peer) => {
      state.peers.set(peer.id, { name: peer.name, voiceState: peer.voiceState })
    })
    messages.innerHTML = ""
    const arr = Array.isArray(message.history) ? message.history : []
    arr.forEach((msg) => {
      const el = createMessageElement(msg)
      messages.appendChild(el)
      el.scrollIntoView({ block: "end" })
    })
    renderMembers()
    return
  }
  if (message.type === "peerJoined") {
    state.peers.set(message.peer.id, { name: message.peer.name })
    if (state.voiceEnabled) {
      if (state.clientId && state.clientId < message.peer.id) {
        await createOffer(message.peer.id)
      } else {
        connectToPeer(message.peer.id)
      }
    }
    renderMembers()
    return
  }
  if (message.type === "peerRenamed") {
    const peer = state.peers.get(message.id)
    if (peer) peer.name = message.name
    renderMembers()
    return
  }
  if (message.type === "peerLeft") {
    state.peers.delete(message.id)
    const pc = state.peerConnections.get(message.id)
    if (pc) pc.close()
    state.peerConnections.delete(message.id)
    const audio = document.getElementById(`audio-${message.id}`)
    if (audio) audio.remove()
    clearTyping(message.id)
    renderMembers()
    return
  }
  if (message.type === "chat") {
    const el = createMessageElement(message)
    messages.appendChild(el)
    el.scrollIntoView({ block: "end" })
    return
  }
  if (message.type === "typing") {
    if (!state.typingUsers.has(message.id)) {
      state.typingUsers.set(message.id, { name: message.name })
    }
    const entry = state.typingUsers.get(message.id)
    if (entry && entry.timeout) clearTimeout(entry.timeout)
    entry.timeout = setTimeout(() => clearTyping(message.id), 1500)
    updateTypingIndicator()
    return
  }
  if (message.type === "signal") {
    await handleSignal(message.fromId, message.signal)
    return
  }
  if (message.type === "voiceState") {
    const peer = state.peers.get(message.id)
    if (peer) {
      peer.voiceState = {
        inVoice: message.inVoice,
        muted: message.muted,
        deafened: message.deafened,
        speaking: message.speaking
      }
      renderMembers()
    }
  }
  if (message.type === "reaction") {
    updateReactionCount(message.msgId, message.emoji, message.count)
    return
  }
  if (message.type === "presence") {
    const peer = state.peers.get(message.id)
    if (peer) {
      peer.presence = message.status
      renderMembers()
    }
    return
  }
})

document.querySelectorAll(".room-button").forEach((btn) => {
  btn.addEventListener("click", () => joinRoom(btn.dataset.room))
})

document.querySelectorAll(".voice-button").forEach((btn) => {
  btn.addEventListener("click", () => enableVoice(btn.dataset.voice))
})

sendBtn.addEventListener("click", () => {
  const text = messageInput.value.trim()
  if (!text) return
  sendPayload({ type: "chat", text })
  messageInput.value = ""
})

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    sendBtn.click()
  } else {
    sendPayload({ type: "typing" })
  }
})

saveName.addEventListener("click", () => {
  const newName = nameInput.value.trim()
  if (!newName) return
  state.displayName = newName.slice(0, 24)
  sendPayload({ type: "rename", name: state.displayName })
  renderMembers()
})

presenceSelect.addEventListener("change", () => {
  const status = presenceSelect.value
  sendPayload({ type: "presence", status })
})

joinVoice.addEventListener("click", () => enableVoice("lounge"))
leaveVoice.addEventListener("click", () => disableVoice())
muteBtn.addEventListener("click", () => toggleMute())
deafenBtn.addEventListener("click", () => toggleDeafen())
addRoomBtn.addEventListener("click", () => {
  const name = newRoomName.value.trim().toLowerCase().replace(/\s+/g, "-")
  if (!name) return
  if (!rooms.includes(name)) {
    rooms.push(name)
    renderRooms()
  }
  newRoomName.value = ""
})

document.querySelectorAll(".guild").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".guild").forEach((b) => b.classList.remove("active"))
    btn.classList.add("active")
    state.serverId = btn.dataset.server
    renderRooms()
    joinRoom("general")
  })
})
inviteBtn.addEventListener("click", async () => {
  const link = makeInviteLink()
  let ok = false
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(link)
      ok = true
    } catch {}
  }
  if (!ok) {
    window.prompt("Share this link", link)
    ok = true
  }
  if (ok) {
    const prev = roomStatus.textContent
    roomStatus.textContent = "Invite copied"
    setTimeout(() => (roomStatus.textContent = prev), 2000)
  }
})

window.addEventListener("beforeunload", () => {
  disableVoice()
  sendPayload({ type: "leaveRoom" })
})
