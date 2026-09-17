// Test fixture only: emulates the documented native app-server notifications.
import { createInterface } from 'node:readline'
const send = packet => process.stdout.write(JSON.stringify(packet) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: {} })
  if (message.method === 'thread/start') {
    if (message.params.sandbox !== 'danger-full-access') process.exit(9)
    send({ id: message.id, result: { thread: { id: 'test-thread' } } })
  }
  if (message.method === 'turn/start') {
    if (message.params.input[1].type !== 'localImage') process.exit(10)
    send({ id: message.id, result: { turn: { id: 'test-turn' } } })
    if (process.env.TEST_MODE === 'wait') return
    const item = { id: 'image-1', type: 'imageGeneration', status: 'completed', result: process.env.TEST_PNG }
    if (process.env.TEST_MODE === 'fail') item.failure = { type: 'usageLimitExceeded' }
    if (process.env.TEST_MODE === 'empty') item.result = ''
    // Codex CLI 0.154.0 omits threadId from these notifications.
    send({ method: 'item/completed', params: { item } })
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  }
})
