import { createApp } from './app.js'

const port = Number(process.env.PORT || 4310)
const host = process.env.HOST || '127.0.0.1'
const app = createApp({ host })

app.listen(port, host, () => {
  console.log(`Warrior Base listening on http://${host}:${port}`)
})
