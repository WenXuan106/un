const express = require('express')
const QRCode = require('qrcode')
const pino = require('pino')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

const PORT = process.env.PORT || 3000
const AUTH_FOLDER = './auth_session'

const logger = pino({ level: 'warn' })

// Holds the latest QR code (as a data URL) so it can be viewed in a browser.
// null once you're logged in and connected.
let latestQrDataUrl = null
let connectionStatus = 'starting'

const app = express()

// Health check endpoint — this is what UptimeRobot pings every few minutes
// to keep the free Render web service from spinning down.
app.get('/health', (req, res) => {
  res.json({ status: connectionStatus })
})

// Visit this in a browser to scan the QR code when (re)pairing is needed.
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send('<h1>Already connected — no QR code needed.</h1>')
  }
  if (!latestQrDataUrl) {
    return res.send('<h1>No QR code yet. Refresh in a few seconds.</h1>')
  }
  res.send(`
    <html>
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif;">
        <div style="text-align:center;">
          <h2>Scan with WhatsApp</h2>
          <img src="${latestQrDataUrl}" width="300" height="300" />
        </div>
      </body>
    </html>
  `)
})

app.get('/', (req, res) => {
  res.send(`Status: ${connectionStatus}. Visit /qr to scan if needed.`)
})

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`)
})

async function startWhatsApp () {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      connectionStatus = 'awaiting_scan'
      latestQrDataUrl = await QRCode.toDataURL(qr)
      console.log('New QR code generated — visit /qr to scan it')
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

      if (shouldReconnect) {
        startWhatsApp()
      } else {
        console.log('Logged out — delete the auth_session folder and restart to re-pair.')
      }
    }
  })

  return sock
}

startWhatsApp().catch(err => {
  console.error('Fatal error starting WhatsApp connection:', err)
  process.exit(1)
})
