import { readFileSync } from 'node:fs'
import { decodeSessionLog } from '../session-log.js'

const raw = readFileSync(process.argv[2])
const decoded = decodeSessionLog(raw)
const user = decoded.events.find((event) => event.type === 'user/message')
const assistant = decoded.events.find((event) => event.type === 'assistant/message')
console.log('USER', JSON.stringify(user, null, 1).slice(0, 1400))
if (assistant !== undefined) {
	const clone = structuredClone(assistant)
	for (const block of clone.data?.message?.content ?? []) {
		if (typeof block.text === 'string') block.text = `<${block.text.length} chars>`
	}
	console.log('ASSISTANT', JSON.stringify(clone, null, 1).slice(0, 1200))
}
