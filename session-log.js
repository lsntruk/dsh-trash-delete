/**
 * dsh-trash-delete — session log surgery.
 *
 * A Harness Session is an append-only event log:
 *
 *   <DSH_HOME>/sessions/<project-slug>/<sessionId>/session.v4.jsonl.zstd
 *
 * Frame 0 of the file is the plain-text `{"type":"session",...}` header row;
 * every later frame holds a batch of `{"type":"…","seq":N,…}` event rows. The
 * events are contiguous from seq 0 and are never rewritten by the Harness
 * itself, so removing one message means: decode every frame, drop the rows that
 * belong to it, renumber the survivors, rewrite every sequence reference, and
 * publish the result as a fresh set of independently decodable checksummed
 * frames.
 *
 * The frame scanner below mirrors the Host decoder (structured frame/block
 * header walk, not a magic-byte search) so a frame that merely *contains* the
 * Zstandard magic inside its payload is never mistaken for a frame boundary.
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Little-endian `0xFD2FB528`, the first four bytes of every Zstandard frame. */
const ZSTD_MAGIC = 4247762216

/** Frames the Host writes carry a content checksum; ours must too. */
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Event types that carry conversation content on the visible surface. */
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** Bytes of decompressed JSONL grouped into one frame when re-encoding. */
const FRAME_TARGET_BYTES = 64 * 1024

/**
 * Locate every complete Zstandard frame in a buffer, walking each frame's
 * descriptor and block headers exactly as the Host decoder does.
 * @param buffer - complete bytes of one session artifact.
 * @returns frame ranges in file order.
 * @throws {Error} when the bytes are not a sequence of complete valid frames.
 */
export function scanZstdFrames(buffer) {
	if (buffer.length === 0) return []
	const frames = []
	let offset = 0
	while (offset < buffer.length) {
		const start = offset
		if (buffer.length - offset < 5) throw new Error(`truncated Zstandard frame header at byte ${offset}`)
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
		offset += 4
		const descriptor = buffer.readUInt8(offset)
		offset += 1
		if ((descriptor & 24) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
		const contentSizeFlag = descriptor >>> 6
		const singleSegment = (descriptor & 32) !== 0
		const checksum = (descriptor & 4) !== 0
		const dictionaryFlag = descriptor & 3
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
		if (buffer.length - offset < remainingHeaderBytes) throw new Error(`truncated Zstandard frame header at byte ${offset}`)
		offset += remainingHeaderBytes
		for (;;) {
			if (buffer.length - offset < 3) throw new Error(`truncated Zstandard block header at byte ${offset}`)
			const blockHeader = buffer.readUIntLE(offset, 3)
			offset += 3
			const lastBlock = (blockHeader & 1) !== 0
			const blockType = (blockHeader >>> 1) & 3
			const blockSize = blockHeader >>> 3
			if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
			const payloadBytes = blockType === 1 ? 1 : blockSize
			if (buffer.length - offset < payloadBytes) throw new Error(`truncated Zstandard block payload at byte ${offset}`)
			offset += payloadBytes
			if (lastBlock) break
		}
		if (checksum) {
			if (buffer.length - offset < 4) throw new Error(`truncated Zstandard checksum at byte ${offset}`)
			offset += 4
		}
		frames.push({ start, end: offset })
	}
	return frames
}

/**
 * Decode one session artifact into its header row and event rows.
 * @param buffer - raw bytes of `session.v4.jsonl.zstd` (or plain `.jsonl`).
 * @returns the decoded artifact.
 */
export function decodeSessionLog(buffer) {
	const compressed = buffer.length > 0 && buffer.readUInt32LE(0) === ZSTD_MAGIC
	let text
	let frameCount = 0
	if (compressed) {
		const frames = scanZstdFrames(buffer)
		frameCount = frames.length
		const parts = []
		for (const frame of frames) parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
		text = Buffer.concat(parts).toString('utf8')
	} else {
		text = buffer.toString('utf8')
	}
	const lines = text.split('\n')
	const headerText = lines.shift() ?? ''
	const header = headerText.trim() === '' ? null : JSON.parse(headerText)
	const events = []
	for (const line of lines) {
		if (line.trim() === '') continue
		events.push(JSON.parse(line))
	}
	return { header, headerText, events, compressed, frameCount }
}

/**
 * Encode a header row plus event rows back into one artifact: one frame for the
 * header, then frames holding whole lines up to {@link FRAME_TARGET_BYTES}.
 * @param headerText - the header row without its newline terminator.
 * @param events - event rows in seq order.
 * @returns the encoded artifact.
 */
export function encodeSessionLog(headerText, events) {
	const frames = [zstdCompressSync(Buffer.from(`${headerText}\n`, 'utf8'), CHECKSUM_OPTIONS)]
	let pending = []
	let pendingBytes = 0
	const flush = () => {
		if (pendingBytes === 0) return
		frames.push(zstdCompressSync(Buffer.from(pending.join(''), 'utf8'), CHECKSUM_OPTIONS))
		pending = []
		pendingBytes = 0
	}
	for (const event of events) {
		const line = `${JSON.stringify(event)}\n`
		pending.push(line)
		pendingBytes += Buffer.byteLength(line)
		if (pendingBytes >= FRAME_TARGET_BYTES) flush()
	}
	flush()
	return Buffer.concat(frames)
}

/** Whether an event is a conversation message the user can see and delete. */
export function isDeletableMessage(event) {
	if (event === null || typeof event !== 'object') return false
	if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
	return event.surfaceOp === 'append'
}

/** First non-empty text block of a message payload, trimmed for a preview. */
function previewOf(message) {
	const content = Array.isArray(message?.content) ? message.content : []
	for (const block of content) {
		if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
			const text = block.text.trim().replace(/\s+/g, ' ')
			return text.length > 160 ? `${text.slice(0, 160)}…` : text
		}
	}
	const tools = content.filter((block) => block?.type === 'tool-call').map((block) => String(block.name ?? 'tool'))
	if (tools.length > 0) {
		const names = [...new Set(tools)].join(' · ')
		return `⏺ ${names.length > 120 ? `${names.slice(0, 120)}…` : names}`
	}
	for (const block of content) {
		if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
			const text = block.text.trim().replace(/\s+/g, ' ')
			return `…${text.length > 120 ? text.slice(0, 120) : text}`
		}
	}
	return ''
}

/**
 * Client-visible id of one message event: a user message keeps its id on the
 * event data, an assistant message keeps it inside its wrapped `message`.
 * @param event - a `user/message` or `assistant/message` event.
 * @returns the id, or '' when the log has none.
 */
export function messageIdOf(event) {
	if (typeof event?.data?.message?.id === 'string') return event.data.message.id
	if (typeof event?.data?.id === 'string') return event.data.id
	return ''
}

/**
 * Seq of the message event carrying one client-visible id.
 * @param events - decoded event rows.
 * @param messageId - id reported by the chat view.
 * @returns the seq, or -1 when no event carries that id.
 */
export function seqOfMessageId(events, messageId) {
	if (typeof messageId !== 'string' || messageId === '') return -1
	for (const event of events) {
		if (!isDeletableMessage(event)) continue
		if (messageIdOf(event) === messageId) return event.seq
	}
	return -1
}

/**
 * Describe every deletable message in one log, for the picker dialog.
 * @param events - decoded event rows.
 * @returns one entry per visible user/assistant message.
 */
export function describeMessages(events) {
	const messages = []
	for (const event of events) {
		if (!isDeletableMessage(event)) continue
		// A user message carries its content directly; an assistant message wraps the
		// model output in `message`.
		const payload = event.type === 'user/message' ? event.data : event.data?.message
		const blocks = Array.isArray(payload?.content) ? payload.content : []
		const toolCalls = blocks.filter((block) => block?.type === 'tool-call').map((block) => String(block.id ?? '')).filter((id) => id !== '')
		messages.push({
			seq: event.seq,
			// The chat view keys one answered turn by the id of its final assistant
			// message, so the per-message action reports that id, not a seq.
			id: messageIdOf(event),
			role: event.type === 'user/message' ? 'user' : 'assistant',
			source: typeof event.data?.source?.kind === 'string' ? event.data.source.kind : '',
			preview: previewOf(payload),
			time: typeof event.time === 'number' ? event.time : 0,
			toolCalls: toolCalls.length
		})
	}
	return messages
}

/** Tool-call id an event refers to, for `tool/call` and `tool/result`. */
function callIdOf(event) {
	if (event.type === 'tool/call') return typeof event.data?.callId === 'string' ? event.data.callId : ''
	if (event.type === 'tool/result') {
		const id = event.data?.message?.toolCallId
		return typeof id === 'string' ? id : ''
	}
	return ''
}

/** Every sequence number an event points at through a structural relationship. */
function structuralRefs(event) {
	const refs = []
	const op = event.surfaceOp
	if (op !== null && typeof op === 'object') {
		if (Number.isInteger(op.startSeq)) refs.push(op.startSeq)
		if (Number.isInteger(op.endSeq)) refs.push(op.endSeq)
	}
	if (Array.isArray(event.sourceEventSeqs)) for (const seq of event.sourceEventSeqs) if (Number.isInteger(seq)) refs.push(seq)
	const range = event.data?.shadowedRange
	if (range !== null && typeof range === 'object') {
		if (Number.isInteger(range.start)) refs.push(range.start)
		if (Number.isInteger(range.end)) refs.push(range.end)
	}
	if (Array.isArray(event.data?.shadowedSeqs)) for (const seq of event.data.shadowedSeqs) if (Number.isInteger(seq)) refs.push(seq)
	return refs
}

/**
 * Plan the removal of one message: the message row itself, the tool-call rows
 * it advertised, and every row that structurally points into that set (a
 * surface replacement or compaction window that would otherwise dangle).
 *
 * Turn, step and request rows are never removed, so turn/step numbering and
 * the tool lifecycle of every surviving turn keep their original shape.
 * @param events - decoded event rows.
 * @param targetSeq - seq of the message to remove.
 * @returns the removal plan.
 */
export function planMessageRemoval(events, targetSeq) {
	const target = events[targetSeq]
	if (!isDeletableMessage(target)) {
		return { ok: false, error: 'not-a-message', message: 'that event is not a deletable user or assistant message' }
	}

	const removed = new Set([target.seq])
	const note = []

	// A tool advertisement that disappears must take its call/result pair with it,
	// otherwise the enclosing step ends with an unresolved tool call.
	if (target.type === 'assistant/message') {
		const blocks = Array.isArray(target.data?.message?.content) ? target.data.message.content : []
		const ids = new Set(blocks.filter((block) => block?.type === 'tool-call').map((block) => String(block.id ?? '')).filter((id) => id !== ''))
		for (const event of events) {
			if (removed.has(event.seq)) continue
			const id = callIdOf(event)
			if (id !== '' && ids.has(id)) {
				removed.add(event.seq)
				note.push(`tool ${id}`)
			}
		}
	}

	// Anything that *structurally* references a removed row would fail the Host's
	// surface/compaction fold, so it goes too. This cascades until stable.
	for (let changed = true; changed;) {
		changed = false
		for (const event of events) {
			if (removed.has(event.seq)) continue
			if (structuralRefs(event).some((seq) => removed.has(seq))) {
				removed.add(event.seq)
				changed = true
			}
		}
	}

	// Compaction windows are validated as a whole: a surviving summary without its
	// start (or end) is refused, so an interrupted window is dropped entirely.
	const windows = new Map()
	for (const event of events) {
		const id = event.data?.compactionId
		if (typeof id !== 'string') continue
		if (event.type !== 'compaction/start' && event.type !== 'compaction/summary' && event.type !== 'compaction/end') continue
		const entry = windows.get(id) ?? { start: null, end: null, rows: [] }
		if (event.type === 'compaction/start') entry.start = event.seq
		if (event.type === 'compaction/end') entry.end = event.seq
		entry.rows.push(event.seq)
		windows.set(id, entry)
	}
	for (const entry of windows.values()) {
		const touched = entry.rows.some((seq) => removed.has(seq))
		if (!touched) continue
		const broken = (entry.start !== null && removed.has(entry.start)) || (entry.end !== null && removed.has(entry.end))
		if (!broken) continue
		for (const seq of entry.rows) removed.add(seq)
	}

	return { ok: true, removed, note }
}

/**
 * Rewrite one decoded log without a planned set of rows, renumbering the
 * survivors densely and remapping every sequence reference, including the
 * `session/title` citations that must keep pointing at human user messages.
 * @param events - decoded event rows.
 * @param removed - seqs to drop.
 * @returns the rewritten rows and the dropped rows' seqs.
 */
export function applyRemoval(events, removed) {
	const dropped = []
	const kept = []
	for (const event of events) {
		if (removed.has(event.seq)) dropped.push(event.seq)
		else kept.push(event)
	}

	// Titles cite earlier human user messages. A citation that points at a removed
	// row is dropped; a title left citing nothing is only legal for a user title.
	// A delivery watermark that named the removed row moves to the nearest
	// surviving earlier row, and is dropped outright when there is none.
	const earliestKept = kept.find((event) => !removed.has(event.seq))?.seq
	const surviving = []
	for (const event of kept) {
		const watermark = event.data?.throughSeq
		if (Number.isInteger(watermark) && removed.has(watermark) && (earliestKept === undefined || watermark <= earliestKept)) continue
		if (event.type === 'session/title' || event.type === 'session/title-llm-request') {
			const refs = Array.isArray(event.data?.messageSeqs) ? event.data.messageSeqs : []
			const keptRefs = refs.filter((seq) => !removed.has(seq))
			if (keptRefs.length !== refs.length) {
				const sourceKind = event.data?.source?.kind
				if (event.type === 'session/title-llm-request') continue
				if (keptRefs.length === 0 && sourceKind !== 'user') continue
				event.data.messageSeqs = keptRefs
			}
			if (event.type === 'session/title-llm-request') {
				const refsNow = Array.isArray(event.data?.messageSeqs) ? event.data.messageSeqs : []
				if (refsNow.length === 0) continue
			}
		}
		surviving.push(event)
	}

	const oldToNew = new Map()
	for (const [index, event] of surviving.entries()) oldToNew.set(event.seq, index)
	const map = (seq) => (oldToNew.has(seq) ? oldToNew.get(seq) : undefined)
	/**
	 * Clamp a delivery watermark onto the nearest surviving earlier event: a
	 * `throughSeq` must stay a valid count, so it is moved down rather than
	 * dropped when the row it named is the one being removed.
	 */
	const mapOrPrevious = (seq) => {
		for (let probe = seq; probe >= 0; probe -= 1) {
			const mapped = oldToNew.get(probe)
			if (mapped !== undefined) return mapped
		}
		return undefined
	}

	for (const [index, event] of surviving.entries()) {
		event.seq = index
		const op = event.surfaceOp
		if (op !== null && typeof op === 'object') {
			const startSeq = map(op.startSeq)
			const endSeq = map(op.endSeq)
			if (startSeq === undefined || endSeq === undefined) {
				// Cannot happen after the cascade; keep the payload valid rather than
				// leaving a dangling range the Host would refuse.
				event.surfaceOp = 'append'
			} else {
				op.startSeq = startSeq
				op.endSeq = endSeq
			}
		}
		if (Array.isArray(event.sourceEventSeqs)) {
			event.sourceEventSeqs = event.sourceEventSeqs.map(map).filter((seq) => seq !== undefined)
		}
		const data = event.data
		if (data !== null && typeof data === 'object') {
			const range = data.shadowedRange
			if (range !== null && typeof range === 'object') {
				const start = map(range.start)
				const end = map(range.end)
				if (start !== undefined && end !== undefined) {
					range.start = start
					range.end = end
				}
			}
			if (Array.isArray(data.shadowedSeqs)) data.shadowedSeqs = data.shadowedSeqs.map(map).filter((seq) => seq !== undefined)
			if (Array.isArray(data.messageSeqs)) data.messageSeqs = data.messageSeqs.map(map).filter((seq) => seq !== undefined)
			for (const key of ['headerSeq', 'sourceEventSeq']) {
				if (!Number.isInteger(data[key])) continue
				const mapped = map(data[key])
				if (mapped === undefined) delete data[key]
				else data[key] = mapped
			}
			if (Number.isInteger(data.throughSeq)) {
				const mapped = mapOrPrevious(data.throughSeq)
				if (mapped === undefined) delete data.throughSeq
				else data.throughSeq = mapped
			}
		}
	}

	return { events: surviving, dropped }
}

/**
 * Remove one message from one decoded log in a single call.
 * @param events - decoded event rows.
 * @param targetSeq - seq of the message to remove.
 * @returns the rewritten rows, or a refusal.
 */
export function removeMessage(events, targetSeq) {
	const plan = planMessageRemoval(events, targetSeq)
	if (!plan.ok) return plan
	const result = applyRemoval(events, plan.removed)
	return { ok: true, events: result.events, dropped: result.dropped, note: plan.note }
}
