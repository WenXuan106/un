const express = require('express')
const multer = require('multer')
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
const MAX_MESSAGES_PER_CHAT = 100
const MAX_CACHED_MEDIA_ITEMS = 60
const MAX_RAW_MSG_CACHE = 200

const ACCESS_TOKEN = process.env.ACCESS_TOKEN
const logger = pino({ level: 'warn' })
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } })

let latestQrDataUrl = null
let connectionStatus = 'starting'
let sock = null

const chats = new Map() // jid -> { jid, name, avatarUrl, isGroup, participants, messages: [] }
const seenMessageIds = new Set()
const mediaCache = new Map()      // id -> { buffer, mimetype }
const rawMsgCache = new Map()     // id -> full WAMessage (needed for reply/forward)
const presenceSubscribed = new Set()
const sseClients = new Set()

function evictOldest (map, max) {
  if (map.size >= max) map.delete(map.keys().next().value)
}

function getOrCreateChat (jid, name) {
  if (!chats.has(jid)) {
    chats.set(jid, {
      jid, name: name || jid, avatarUrl: null,
      isGroup: jid.endsWith('@g.us'), participants: [], messages: []
    })
  } else if (name) {
    chats.get(jid).name = name
  }
  return chats.get(jid)
}

async function ensureAvatar (chat) {
  if (chat.avatarUrl !== null) return
  try { chat.avatarUrl = await sock.profilePictureUrl(chat.jid, 'preview') }
  catch { chat.avatarUrl = '' }
}

async function ensureGroupInfo (chat) {
  if (!chat.isGroup || chat.participants.length) return
  try {
    const meta = await sock.groupMetadata(chat.jid)
    chat.name = meta.subject || chat.name
    chat.participants = meta.participants.map(p => ({ id: p.id, admin: !!p.admin }))
  } catch (err) { console.error('groupMetadata failed:', err) }
}

function broadcast (event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) res.write(payload)
}

function findMessage (jid, id) {
  const chat = chats.get(jid)
  return chat ? chat.messages.find(m => m.id === id) : null
}

// --- Turning an incoming Baileys message into our stored shape ---
async function buildMessageEntry (msg) {
  const id = msg.key.id
  const fromMe = !!msg.key.fromMe
  const timestamp = (msg.messageTimestamp || Date.now() / 1000) * 1000
  const m = msg.message || {}
  const sender = msg.key.participant || msg.key.remoteJid

  let type = 'text', text = '', extra = {}

  if (m.conversation) text = m.conversation
  else if (m.extendedTextMessage) {
    text = m.extendedTextMessage.text
    if (m.extendedTextMessage.contextInfo?.quotedMessage) {
      extra.quotedText = m.extendedTextMessage.contextInfo.quotedMessage.conversation ||
        m.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text || '[quoted media]'
    }
  } else if (m.imageMessage) { type = 'image'; text = m.imageMessage.caption || '' }
  else if (m.videoMessage) {
    type = m.videoMessage.gifPlayback ? 'gif' : 'video'
    text = m.videoMessage.caption || ''
  } else if (m.audioMessage) { type = 'audio'; extra.ptt = !!m.audioMessage.ptt }
  else if (m.stickerMessage) { type = 'sticker' }
  else if (m.locationMessage) {
    type = 'location'
    extra.lat = m.locationMessage.degreesLatitude
    extra.lon = m.locationMessage.degreesLongitude
  } else if (m.contactMessage) {
    type = 'contact'
    extra.displayName = m.contactMessage.displayName
  } else { text = '[Unsupported message]' }

  if (['image', 'video', 'gif', 'audio', 'sticker'].includes(type)) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
      const mimetype =
        m.imageMessage?.mimetype || m.videoMessage?.mimetype ||
        m.audioMessage?.mimetype || m.stickerMessage?.mimetype || 'application/octet-stream'
      evictOldest(mediaCache, MAX_CACHED_MEDIA_ITEMS)
      mediaCache.set(id, { buffer, mimetype })
    } catch (err) {
      console.error('Media download failed:', err)
      type = 'text'; text = '[Media unavailable]'
    }
  }

  evictOldest(rawMsgCache, MAX_RAW_MSG_CACHE)
  rawMsgCache.set(id, msg)

  return { id, fromMe, sender, type, text, timestamp, status: fromMe ? 'sent' : null, starred: false, reactions: {}, ...extra }
}

async function recordMessage (jid, chatName, msg) {
  if (seenMessageIds.has(msg.key.id)) return null
  seenMessageIds.add(msg.key.id)

  const chat = getOrCreateChat(jid, chatName)
  const entry = await buildMessageEntry(msg)
  chat.messages.push(entry)
  chat.messages.sort((a, b) => a.timestamp - b.timestamp)
  if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT)

  await ensureAvatar(chat)
  if (chat.isGroup) await ensureGroupInfo(chat)
  broadcast('message', { jid, message: entry, chatName: chat.name })
  return entry
}

const STATUS_MAP = { 0: 'error', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' }

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

function requireToken (req, res, next) {
  const token = req.query.token || req.headers['x-access-token']
  if (!ACCESS_TOKEN) return res.status(500).json({ error: 'ACCESS_TOKEN not set' })
  if (token !== ACCESS_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

app.get('/health', (req, res) => res.json({ status: connectionStatus }))

app.get('/qr', requireToken, (req, res) => {
  if (connectionStatus === 'connected') return res.send('<h1>Already connected.</h1>')
  if (!latestQrDataUrl) return res.send('<h1>No QR code yet.</h1>')
  res.send(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
    <img src="${latestQrDataUrl}" width="300" height="300" /></body></html>`)
})

app.get('/api/chats', requireToken, (req, res) => {
  res.json([...chats.values()].map(c => ({
    jid: c.jid, name: c.name, avatarUrl: c.avatarUrl, isGroup: c.isGroup,
    participants: c.participants, lastMessage: c.messages[c.messages.length - 1] || null
  })).sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0)))
})

app.get('/api/chats/:jid/messages', requireToken, async (req, res) => {
  const jid = req.params.jid
  if (sock && !presenceSubscribed.has(jid)) {
    presenceSubscribed.add(jid)
    sock.presenceSubscribe(jid).catch(() => {})
  }
  res.json(chats.get(jid)?.messages || [])
})

app.get('/api/starred', requireToken, (req, res) => {
  const starred = []
  for (const chat of chats.values()) {
    for (const m of chat.messages) if (m.starred) starred.push({ jid: chat.jid, chatName: chat.name, message: m })
  }
  res.json(starred)
})

app.get('/api/search', requireToken, (req, res) => {
  const q = (req.query.q || '').toLowerCase()
  if (!q) return res.json([])
  const results = []
  for (const chat of chats.values()) {
    for (const m of chat.messages) {
      if (m.text && m.text.toLowerCase().includes(q)) {
        results.push({ jid: chat.jid, chatName: chat.name, message: m })
      }
    }
  }
  res.json(results.slice(0, 100))
})

app.get('/api/media/:id', requireToken, (req, res) => {
  const item = mediaCache.get(req.params.id)
  if (!item) return res.status(404).send('Media not cached')
  res.set('Content-Type', item.mimetype)
  res.send(item.buffer)
})

function assertConnected (res) {
  if (!sock || connectionStatus !== 'connected') { res.status(400).json({ error: 'Not connected' }); return false }
  return true
}

app.post('/api/chats/:jid/send', requireToken, async (req, res) => {
  const { text, quotedId } = req.body
  const jid = req.params.jid
  if (!text || !assertConnected(res)) return
  try {
    const opts = { text }
    if (quotedId && rawMsgCache.has(quotedId)) opts.quoted = { key: rawMsgCache.get(quotedId).key, message: rawMsgCache.get(quotedId).message }
    const result = await sock.sendMessage(jid, opts)
    await recordMessage(jid, chats.get(jid)?.name, {
      key: result.key, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000)
    })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Send failed' }) }
})

app.post('/api/chats/:jid/edit', requireToken, async (req, res) => {
  const { messageId, text } = req.body
  const jid = req.params.jid
  const raw = rawMsgCache.get(messageId)
  if (!raw || !assertConnected(res)) return res.status(400).json({ error: 'Message not found or not connected' })
  try {
    await sock.sendMessage(jid, { text, edit: raw.key })
    const entry = findMessage(jid, messageId)
    if (entry) { entry.text = text; entry.edited = true }
    broadcast('edit', { jid, messageId, text })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Edit failed' }) }
})

app.post('/api/chats/:jid/delete', requireToken, async (req, res) => {
  const { messageId } = req.body
  const jid = req.params.jid
  const raw = rawMsgCache.get(messageId)
  if (!raw || !assertConnected(res)) return res.status(400).json({ error: 'Message not found or not connected' })
  try {
    await sock.sendMessage(jid, { delete: raw.key })
    const entry = findMessage(jid, messageId)
    if (entry) { entry.deleted = true; entry.text = ''; }
    broadcast('delete', { jid, messageId })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Delete failed' }) }
})

app.post('/api/chats/:jid/react', requireToken, async (req, res) => {
  const { messageId, emoji } = req.body // emoji: '' to remove
  const jid = req.params.jid
  const raw = rawMsgCache.get(messageId)
  if (!raw || !assertConnected(res)) return res.status(400).json({ error: 'Message not found or not connected' })
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key: raw.key } })
    const entry = findMessage(jid, messageId)
    if (entry) entry.reactions['me'] = emoji
    broadcast('reaction', { jid, messageId, emoji, from: 'me' })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'React failed' }) }
})

app.post('/api/chats/:jid/forward', requireToken, async (req, res) => {
  const { messageId, toJid } = req.body
  const raw = rawMsgCache.get(messageId)
  if (!raw || !assertConnected(res)) return res.status(400).json({ error: 'Message not found or not connected' })
  try {
    await sock.sendMessage(toJid, { forward: raw, force: true })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Forward failed' }) }
})

app.post('/api/chats/:jid/messages/:id/star', requireToken, (req, res) => {
  const entry = findMessage(req.params.jid, req.params.id)
  if (!entry) return res.status(404).json({ error: 'Not found' })
  entry.starred = !entry.starred
  res.json({ ok: true, starred: entry.starred })
})

app.post('/api/chats/:jid/location', requireToken, async (req, res) => {
  const { lat, lon } = req.body
  const jid = req.params.jid
  if (!assertConnected(res)) return
  try {
    const result = await sock.sendMessage(jid, { location: { degreesLatitude: lat, degreesLongitude: lon } })
    await recordMessage(jid, chats.get(jid)?.name, {
      key: result.key,
      message: { locationMessage: { degreesLatitude: lat, degreesLongitude: lon } },
      messageTimestamp: Math.floor(Date.now() / 1000)
    })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to send location' }) }
})

app.post('/api/chats/:jid/contact', requireToken, async (req, res) => {
  const { name, phone } = req.body
  const jid = req.params.jid
  if (!assertConnected(res)) return
  const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL:${phone}\nEND:VCARD`
  try {
    const result = await sock.sendMessage(jid, { contacts: { displayName: name, contacts: [{ vcard }] } })
    await recordMessage(jid, chats.get(jid)?.name, {
      key: result.key,
      message: { contactMessage: { displayName: name } },
      messageTimestamp: Math.floor(Date.now() / 1000)
    })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to send contact' }) }
})

app.post('/api/chats/:jid/send-media', requireToken, upload.single('file'), async (req, res) => {
  const jid = req.params.jid
  const kind = req.body.kind // 'sticker' | 'gif' | 'voice' | 'image' | 'video'
  if (!req.file || !assertConnected(res)) return
  try {
    let payload
    if (kind === 'sticker') payload = { sticker: req.file.buffer }
    else if (kind === 'gif') payload = { video: req.file.buffer, gifPlayback: true, mimetype: req.file.mimetype }
    else if (kind === 'voice') payload = { audio: req.file.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }
    else if (kind === 'image') payload = { image: req.file.buffer, caption: req.body.caption || '' }
    else if (kind === 'video') payload = { video: req.file.buffer, caption: req.body.caption || '' }
    else return res.status(400).json({ error: 'Unknown kind' })

    const result = await sock.sendMessage(jid, payload)
    const messageMap = {
      sticker: { stickerMessage: {} }, gif: { videoMessage: { gifPlayback: true } },
      voice: { audioMessage: { ptt: true } }, image: { imageMessage: {} }, video: { videoMessage: {} }
    }
    await recordMessage(jid, chats.get(jid)?.name, {
      key: result.key, message: messageMap[kind], messageTimestamp: Math.floor(Date.now() / 1000)
    })
    // Cache the buffer we just sent so it renders immediately for the sender too
    evictOldest(mediaCache, MAX_CACHED_MEDIA_ITEMS)
    mediaCache.set(result.key.id, { buffer: req.file.buffer, mimetype: req.file.mimetype })
    res.json({ ok: true })
  } catch (err) { console.error(err); res.status(500).json({ error: 'Send failed' }) }
})

app.post('/api/chats/:jid/typing', requireToken, async (req, res) => {
  if (!sock) return res.status(400).json({ error: 'Not connected' })
  try { await sock.sendPresenceUpdate('composing', req.params.jid); res.json({ ok: true }) }
  catch { res.status(500).json({ error: 'Failed' }) }
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

  sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false, syncFullHistory: true })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      connectionStatus = 'awaiting_scan'
      latestQrDataUrl = await QRCode.toDataURL(qr)
    }
    if (connection === 'open') { connectionStatus = 'connected'; latestQrDataUrl = null }
    if (connection === 'close') {
      connectionStatus = 'disconnected'
      const statusCode = lastDisconnect?.error?.output?.statusCode
      if (statusCode !== DisconnectReason.loggedOut) startWhatsApp()
      else console.log('Logged out — delete auth_session and restart to re-pair.')
    }
  })

  sock.ev.on('messaging-history.set', async ({ chats: historyChats, messages }) => {
    for (const c of historyChats) getOrCreateChat(c.id, c.name)
    const sorted = [...messages].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0))
    for (const msg of sorted) {
      const jid = msg.key.remoteJid
      if (!jid || jid === 'status@broadcast') continue
      await recordMessage(jid, msg.pushName, msg)
    }
  })

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) if (chats.has(c.id) && c.name) chats.get(c.id).name = c.name
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      if (!jid || jid === 'status@broadcast') continue

      // Reactions and deletes/edits can arrive as their own protocol-ish messages
      // depending on Baileys version — handle the common shapes here.
      if (msg.message?.reactionMessage) {
        const r = msg.message.reactionMessage
        const entry = findMessage(jid, r.key.id)
        if (entry) {
          entry.reactions[msg.key.participant || jid] = r.text
          broadcast('reaction', { jid, messageId: r.key.id, emoji: r.text, from: 'them' })
        }
        continue
      }
      if (msg.message?.protocolMessage?.type === 0) { // REVOKE
        const targetId = msg.message.protocolMessage.key?.id
        const entry = findMessage(jid, targetId)
        if (entry) { entry.deleted = true; entry.text = ''; broadcast('delete', { jid, messageId: targetId }) }
        continue
      }

      await recordMessage(jid, msg.pushName, msg)
    }
  })

  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      const entry = findMessage(key.remoteJid, key.id)
      if (entry && update.status !== undefined) {
        entry.status = STATUS_MAP[update.status] || entry.status
        broadcast('status', { jid: key.remoteJid, messageId: key.id, status: entry.status })
      }
    }
  })

  sock.ev.on('presence.update', ({ id, presences }) => {
    const presence = presences[id]
    if (presence) broadcast('presence', { jid: id, state: presence.lastKnownPresence })
  })

  return sock
}

startWhatsApp().catch(err => { console.error('Fatal error:', err); process.exit(1) })
