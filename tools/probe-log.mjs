/**
 * Offline harness for the session-log surgery: decodes a real session artifact,
 * validates it with the Host's own released-format validator, then deletes each
 * visible message in turn and re-validates the rewritten log.
 *
 * Usage: node tools/probe-log.mjs <session.v4.jsonl.zstd> [--apply <seq>]
 */

import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decodeSessionLog, describeMessages, removeMessage, encodeSessionLog } from '../session-log.js'

const BASE = 'E:/蓝色大肥鱼正在工作/.asar-src/node_modules/@deepseek-ai'
const validator = await import(pathToFileURL(`${BASE}/dsh-session-format-v3-to-v4/lib/index.js`).href)
const sessionLib = await import(pathToFileURL(`${BASE}/dsh-session/lib/index.js`).href)
const KNOWN = sessionLib.KNOWN_SESSION_EVENT_TYPES

const args = process.argv.slice(2)
const logPath = args[0]
if (!logPath) {
	console.error('usage: node tools/probe-log.mjs <log> [--apply <seq>]')
	process.exit(2)
}

/** Validate one decoded artifact with the Host validator; returns the refusal text. */
function validate(header, events) {
	const logical = { ...header }
	delete logical.type
	try {
		validator.restoreReleasedV4Artifact({ header: logical, inheritedEventCount: 0, events }, KNOWN)
		return null
	} catch (error) {
		return error.message
	}
}

const buffer = await fs.readFile(logPath)
const decoded = decodeSessionLog(buffer)
console.log(`file: ${logPath}`)
console.log(`compressed=${decoded.compressed} frames=${decoded.frameCount} events=${decoded.events.length}`)
console.log(`header: ${decoded.headerText.slice(0, 200)}`)
console.log(`original validates: ${validate(decoded.header, decoded.events) ?? 'OK'}`)

// Round-trip: encode without changes, decode again, validate.
const roundTrip = decodeSessionLog(encodeSessionLog(decoded.headerText, decoded.events))
console.log(`round-trip events=${roundTrip.events.length} validates: ${validate(roundTrip.header, roundTrip.events) ?? 'OK'}`)

const messages = describeMessages(decoded.events)
console.log(`\nmessages (${messages.length}):`)
for (const message of messages) {
	console.log(`  #${message.seq} ${message.role.padEnd(9)} ${message.source.padEnd(22)} tools=${message.toolCalls} ${JSON.stringify(message.preview.slice(0, 60))}`)
}

const applyIndex = args.indexOf('--apply')
if (applyIndex !== -1) {
	const seq = Number(args[applyIndex + 1])
	const fresh = decodeSessionLog(buffer)
	const result = removeMessage(fresh.events, seq)
	if (!result.ok) {
		console.log(`\napply #${seq} refused: ${result.error}`)
		process.exit(1)
	}
	const refusal = validate(fresh.header, result.events)
	console.log(`\napply #${seq}: dropped=[${result.dropped.join(',')}] note=${result.note.join('|') || '-'} events=${result.events.length} validates: ${refusal ?? 'OK'}`)
	if (refusal === null) {
		const out = `${logPath}.rewritten`
		await fs.writeFile(out, encodeSessionLog(fresh.headerText, result.events))
		console.log(`wrote ${out}`)
	}
	process.exit(refusal === null ? 0 : 1)
}

console.log('\nper-message deletion dry run:')
let failures = 0
for (const message of messages) {
	const fresh = decodeSessionLog(buffer)
	const result = removeMessage(fresh.events, message.seq)
	if (!result.ok) {
		console.log(`  #${message.seq} ${message.role}: refused ${result.error}`)
		failures += 1
		continue
	}
	const refusal = validate(fresh.header, result.events)
	if (refusal !== null) {
		failures += 1
		console.log(`  #${message.seq} ${message.role}: INVALID — ${refusal}`)
	} else {
		console.log(`  #${message.seq} ${message.role}: ok (dropped ${result.dropped.length}, ${result.events.length} left)`)
	}
}
console.log(`\nfailures: ${failures}`)
