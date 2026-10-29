import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'

// Read-only check; optional public API proxy lets local UI use an existing work.
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5173'
const workId = process.env.TEST_WORK_ID
if (!workId) throw new Error('TEST_WORK_ID is required')
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
const page = await browser.newPage()
try {
  if (process.env.TEST_PUBLIC_API_ORIGIN) {
    await page.route(`${base}/api/**`, async route => {
      assert.equal(route.request().method(), 'GET', 'Layout checks must not write data')
      const url = new URL(route.request().url())
      const response = await page.request.get(new URL(url.pathname + url.search, process.env.TEST_PUBLIC_API_ORIGIN).href)
      await route.fulfill({ response })
    })
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`${base}/works/${encodeURIComponent(workId)}`)
    const image = page.locator('.work-cover-large.work-cover-custom img')
    await expect(image).toBeVisible()
    await image.evaluate(img => img.decode())
    const dimensions = await image.evaluate(img => {
      const box = img.getBoundingClientRect()
      return { originalRatio: img.naturalWidth / img.naturalHeight, shownRatio: box.width / box.height, height: box.height, frameHeight: img.parentElement.getBoundingClientRect().height }
    })
    assert.ok(Math.abs(dimensions.originalRatio - dimensions.shownRatio) < .002, 'Screenshot must retain its original ratio')
    assert.ok(Math.abs(dimensions.height - dimensions.frameHeight) < 1, 'Detail frame must not crop the screenshot')
    const back = await page.locator('.back-link').boundingBox()
    const kicker = await page.locator('.page-heading > .section-kicker').boundingBox()
    const title = await page.locator('.page-heading h1').boundingBox()
    assert.ok(kicker.y >= back.y + back.height + 10, 'Back link must occupy a separate row')
    assert.ok(title.y >= kicker.y + kicker.height, 'Title must appear below the lesson label')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow')
    if (process.env.TEST_SCREENSHOT_PREFIX) await page.screenshot({ path: `${process.env.TEST_SCREENSHOT_PREFIX}-${width}.png`, fullPage: true })
    console.log(JSON.stringify({ width, ...dimensions, headerRows: 'separate' }))
  }
  await page.goto(base)
  const thumbnail = page.locator(`.card-cover-link[href="/works/${workId}"] .work-cover-custom img`)
  await expect(thumbnail).toBeVisible()
  assert.equal(await thumbnail.evaluate(img => getComputedStyle(img).objectFit), 'contain')
  await thumbnail.hover()
  assert.equal(await thumbnail.evaluate(img => getComputedStyle(img).transform), 'none')
  console.log('Layout checks passed: full-ratio detail screenshot, uncropped thumbnail, separate header rows, desktop and mobile.')
} finally {
  await browser.close()
}
