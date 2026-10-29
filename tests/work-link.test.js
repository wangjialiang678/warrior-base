import test from 'node:test'
import assert from 'node:assert/strict'
import { localWorkLinkError, workLinkError } from '../src/work-link.js'

test('local and LAN links give an immediate, actionable message', () => {
  for (const url of ['127.0.0.1:5500', 'http://127.0.0.1:5173/', 'https://localhost:3000', 'localhost:5173/submit', 'http://demo.localhost', 'https://computer.local', 'http://192.168.1.5:8000', 'https://10.0.0.1', 'https://172.16.0.1', 'https://169.254.1.2', 'https://0.0.0.0', 'http://[::1]:3000/', '::1', 'http://[fd00::1]', 'http://2130706433', 'http://0x7f000001', 'file:///Users/test/index.html', 'C:\\site\\index.html']) {
    assert.match(localWorkLinkError(url), /本地或局域网/, url)
    assert.match(workLinkError(url), /分享给好友/, url)
  }
})

test('valid WorkBuddy share links pass, including localhost text in a path', () => {
  for (const url of ['https://workbuddy.link/p/example', 'https://www.workbuddy.link/example?x=1#section', ' https://workbuddy.link/p/localhost-demo ']) assert.equal(workLinkError(url), '')
})

test('incomplete, unsafe and lookalike links never pass the early gate', () => {
  for (const url of ['', 'some words', 'workbuddy.link/p/example', 'http://workbuddy.link/p/example', 'https://workbuddy.link.evil.example/p/x', 'https://example.com/?url=https://workbuddy.link', 'https://user:pass@workbuddy.link/p/x', 'https://workbuddy.link:8443/p/x', 'javascript:alert(1)', 'https://8.8.8.8', 'https://workbuddy.link/' + 'a'.repeat(2050)]) assert.ok(workLinkError(url), url)
  assert.equal(localWorkLinkError('htt'), '')
  assert.equal(localWorkLinkError('https://workbuddy.link/p/localhost'), '')
})
