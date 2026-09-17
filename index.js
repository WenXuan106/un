const express = require('express')
const QRCode = require('qrcode')
const pino = require('pino')
const path = require('path')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys')

const PORT = process.env.PORT || 3000
const AUTH_FOLDER = './auth_session'

// Memory safety caps — free-tier Render has ~512MB RAM, and full history
// sync + cached media can blow past that fast if left unbounded.
const MAX_MESSAGES_PER_CHAT = 100
const MAX_CACHED_MEDIA_ITEMS = 60

const ACCESS_TOKEN = process.env.ACCESS_TOKEN

const logger = pino({ level: 'warn' })

let latestQrDataUrl = null
let connectionStatus = 'starting'
let sock = null

// In-memory chat store: Map<jid, { jid, name, avatarUrl, messages: [] }>
const chats = new Map()
const seenMessageIds = new Set()

// Media cache: Map<mediaId, { buffer, mimetype }>, insertion-ordered for
// simple oldest-first eviction once MAX_CACHED_MEDIA_ITEMS is hit.
const mediaCache = new Map()

// jids currently subscribed to for presence updates
const presenceSubscribed = new Set()

const sseClients = new Set()

function getOrCreateChat (jid, name) {
  if (!chats.has(jid)) {
    chats.set(jid, { jid, name: name || jid, avatarUrl: null, messages: [] })
  } else if (name) {
    chats.get(jid).name = name
  }
  return chats.get(jid)
}

function cacheMedia (mediaId, buffer, mimetype) {
  if (mediaCache.size >= MAX_CACHED_MEDIA_ITEMS) {
    const oldestKey = mediaCache.keys().next().value
    mediaCache.delete(oldestKey)
  }
  mediaCache.set(mediaId, { buffer, mimetype })
}

// Maps a Baileys message object to our stored shape. Media is downloaded
// and cached; the message itself just references it by id.
async function buildMessageEntry (msg) {
  const id = msg.key.id
  const fromMe = !!msg.key.fromMe
  const timestamp = (msg.messageTimestamp || Date.now() / 1000) * 1000
  const m = msg.message || {}

  let type = 'text'
  let text = ''

  if (m.conversation) {
    text = m.conversation
  } else if (m.extendedTextMessage) {
    text = m.extendedTextMessage.text
  } else if (m.imageMessage) {
    type = 'image'
    text = m.imageMessage.caption || ''
  } else if (m.videoMessage) {
    type = 'video'
    text = m.videoMessage.caption || ''
  } else if (m.audioMessage) {
    type = 'audio'
    text = ''
  } else {
    text = '[Unsupported message]'
  }

  if (type !== 'text') {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      )
      const mimetype =
        m.imageMessage?.mimetype || m.videoMessage?.mimetype || m.audioMessage?.mimetype || 'application/octet-stream'
      cacheMedia(id, buffer, mimetype)
    } catch (err) {
      console.error('Media download failed:', err)
      type = 'text'
      text = '[Media unavailable]'
    }
  }

  return { id, fromMe, type, text, timestamp, status: fromMe ? 'sent' : null }
}

function broadcast (event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) res.write(payload)
}

async function recordMessage (jid, chatName, msg) {
  if (seenMessageIds.has(msg.key.id)) return null
  seenMessageIds.add(msg.key.id)

  const chat = getOrCreateChat(jid, chatName)
  const entry = await buildMessageEntry(msg)
  chat.messages.push(entry)
  chat.messages.sort((a, b) => a.timestamp - b.timestamp)
  if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
    chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT)
  }

  await ensureAvatar(chat)
  broadcast('message', { jid, message: entry, chatName: chat.name, avatarUrl: chat.avatarUrl })
  return entry
}

async function ensureAvatar (chat) {
  if (chat.avatarUrl !== null) return // already fetched (or confirmed none)
  try {
    chat.avatarUrl = await sock.profilePictureUrl(chat.jid, 'preview')
  } catch {
    chat.avatarUrl = '' // mark as "checked, none available" so we don't retry every time
  }
}

const STATUS_MAP = { 0: 'error', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' }

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

function requireToken (req, res, next) {
  const token = req.query.token || req.headers['x-access-token']
  if (!ACCESS_TOKEN) return res.status(500).json({ error: 'Server misconfigured: ACCESS_TOKEN not set' })
  if (token !== ACCESS_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

app.get('/health', (req, res) => res.json({ status: connectionStatus }))

app.get('/qr', requireToken, (req, res) => {
  if (connectionStatus === 'connected') return res.send('<h1>Already connected.</h1>')
  if (!latestQrDataUrl) return res.send('<h1>No QR code yet. Refresh shortly.</h1>')
  res.send(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif;">
    <div style="text-align:center;"><h2>Scan with WhatsApp</h2><img src="${latestQrDataUrl}" width="300" height="300" /></div>
  </body></html>`)
})

app.get('/api/chats', requireToken, (req, res) => {
  const list = [...chats.values()]
    .map(c => ({
      jid: c.jid,
      name: c.name,
      avatarUrl: c.avatarUrl,
      lastMessage: c.messages[c.messages.length - 1] || null
    }))
    .sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0))
  res.json(list)
})

app.get('/api/chats/:jid/messages', requireToken, async (req, res) => {
  const jid = req.params.jid
  const chat = chats.get(jid)

  // Subscribe to presence updates for this chat the first time it's opened.
  if (sock && !presenceSubscribed.has(jid)) {
    presenceSubscribed.add(jid)
    sock.presenceSubscribe(jid).catch(() => {})
  }

  res.json(chat ? chat.messages : [])
})

app.get('/api/media/:id', requireToken, (req, res) => {
  const item = mediaCache.get(req.params.id)
  if (!item) return res.status(404).send('Media not cached (may have expired)')
  res.set('Content-Type', item.mimetype)
  res.send(item.buffer)
})

app.post('/api/chats/:jid/send', requireToken, async (req, res) => {
  const { text } = req.body
  const jid = req.params.jid
  if (!text || !sock || connectionStatus !== 'connected') {
    return res.status(400).json({ error: 'Not connected, or missing text' })
  }
  try {
    const result = await sock.sendMessage(jid, { text })
    await recordMessage(jid, chats.get(jid)?.name, {
      key: result.key,
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000)
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Send failed:', err)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// Lets the frontend tell WhatsApp "I'm typing" in a given chat.
app.post('/api/chats/:jid/typing', requireToken, async (req, res) => {
  const jid = req.params.jid
  if (!sock) return res.status(400).json({ error: 'Not connected' })
  try {
    await sock.sendPresenceUpdate('composing', jid)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Failed to send typing indicator' })
  }
})

app.get('/api/stream', requireToken, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`))

async function startWhatsApp () {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    syncFullHistory: true // pull existing chat history on first connect
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      connectionStatus = 'awaiting_scan'
      latestQrDataUrl = await QRCode.toDataURL(qr)
      console.log('New QR code — visit /qr?token=YOUR_TOKEN')
    }

    if (connection === 'open') {
      connectionStatus = 'connected'
      latestQrDataUrl = null
      console.log('Connected to WhatsApp')
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected'
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log('Connection closed. Reconnecting:', shouldReconnect)
      if (shouldReconnect) startWhatsApp()
      else console.log('Logged out — delete auth_session and restart to re-pair.')
    }
  })

  // Fired once on initial connect with a batch of historical chats/messages.
  sock.ev.on('messaging-history.set', async ({ chats: historyChats, messages }) => {
    for (const c of historyChats) {
      getOrCreateChat(c.id, c.name)
    }
    // Process oldest-first so trimming keeps the most recent N per chat.
    const sorted = [...messages].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0))
    for (const msg of sorted) {
      const jid = msg.key.remoteJid
      if (!jid || jid === 'status@broadcast') continue
      await recordMessage(jid, msg.pushName, msg)
    }
    console.log(`History sync: loaded ${historyChats.length} chats`)
  })

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      if (chats.has(c.id) && c.name) chats.get(c.id).name = c.name
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      if (!jid || jid === 'status@broadcast') continue
      await recordMessage(jid, msg.pushName, msg)
    }
  })

  // Delivery/read receipt updates for messages we sent.
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      const chat = chats.get(key.remoteJid)
      if (!chat) continue
      const entry = chat.messages.find(m => m.id === key.id)
      if (entry && update.status !== undefined) {
        entry.status = STATUS_MAP[update.status] || entry.status
        broadcast('status', { jid: key.remoteJid, messageId: key.id, status: entry.status })
      }
    }
  })

  // Typing / online presence from the other side.
  sock.ev.on('presence.update', ({ id, presences }) => {
    const presence = presences[id]
    if (!presence) return
    broadcast('presence', { jid: id, state: presence.lastKnownPresence })
  })

  return sock
}

startWhatsApp().catch(err => {
  console.error('Fatal error starting WhatsApp connection:', err)
  process.exit(1)
})
