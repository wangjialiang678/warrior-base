import { createApp, recheckPendingWork } from '../server/app.js'

// Run as the service user with the production environment; specify both IDs.
const [workId, versionId] = process.argv.slice(2)
if (!workId || !versionId || process.argv.length !== 4) throw new Error('Usage: node scripts/recheck-work.mjs <work-id> <expected-version-id>')
const app = createApp()
try {
  console.log(JSON.stringify(await recheckPendingWork(app, workId, versionId)))
} finally {
  app.locals.config.moderator.close?.()
  app.locals.db.close()
}
