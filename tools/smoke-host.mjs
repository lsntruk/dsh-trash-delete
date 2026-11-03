/**
 * Smoke test for the Host half against a throwaway DSH_HOME copy.
 *
 * Runs the real route handlers with a stub context, then checks the effects on
 * disk. The `sessionPersistence` stub reuses the Host's own validator, so the
 * "Verified" path in the message route is exercised for real.
 *
 * Usage: node tools/smoke-host.mjs <home>
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.argv[2]
if (home === undefined) {
	console.error('usage: node tools/smoke-host.mjs <home>')
	process.exit(2)
}
process.env.DSH_HOME = path.resolve(home)

const ASAR = 'E:/蓝色大肥鱼正在工作/.asar-src/node_modules/@deepseek-ai'
const validator = await import(pathToFileURL(`${ASAR}/dsh-session-format-v3-to-v4/lib/index.js`).href)
const sessionLib = await import(pathToFileURL(`${ASAR}/dsh-session/lib/index.js`).href)
const logLib = await import(pathToFileURL('E:/蓝色大肥鱼正在工作/dsh-session-delete/session-log.js').href)

const handlers = new Map()
const ctx = {
	logger: { warn: (...args) => console.warn('[warn]', ...args) },
	webServer: {
		register: (route) => {
			handlers.set(route.path, route.handler)
			return () => {}
		}
	},
	effect: (fn) => {
		const cleanup = fn()
		return cleanup
	},
	sessions: {
		store: new Map(),
		get: (id) => ctx.sessions.store.get(id),
		list: () => [],
		emitDisposed: () => {}
	},
	sessionPersistence: {
		list: async () => [],
		open: async (id, access) => {
			if (access !== 'read') throw new Error('smoke: write handles are not stubbed')
			const file = await findLog(id)
			if (file === undefined) throw new Error('smoke: no log')
			const decoded = logLib.decodeSessionLog(await fs.readFile(file))
			const header = { ...decoded.header }
			delete header.type
			validator.restoreReleasedV4Artifact({ header, inheritedEventCount: 0, events: decoded.events }, sessionLib.KNOWN_SESSION_EVENT_TYPES)
			return { read: async () => ({ events: decoded.events }), close: async () => {} }
		}
	},
	workspaceRegistry: { unarchiveSession: async () => {} },
	get: () => undefined
}

const plugin = await import(pathToFileURL('E:/蓝色大肥鱼正在工作/dsh-session-delete/index.js').href)
plugin.apply(ctx)

async function findLog(sessionId) {
	const root = path.join(process.env.DSH_HOME, 'sessions')
	for (const slug of await fs.readdir(root).catch(() => [])) {
		const dir = path.join(root, slug, sessionId)
		for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
			const candidate = path.join(dir, name)
			try {
				await fs.stat(candidate)
				return candidate
			} catch {
				// keep looking
			}
		}
	}
	return undefined
}

let failures = 0
function check(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`)
		return
	}
	failures += 1
	console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// Patch the request factory so handlers that subscribe to data/end get a body.
function request2(method, text) {
	const listeners = new Map()
	const req = {
		method,
		headers: { host: '127.0.0.1:10205', 'content-type': 'application/json' },
		on: (event, cb) => {
			listeners.set(event, cb)
			return req
		},
		destroy: () => {}
	}
	setTimeout(() => {
		if (text !== '') listeners.get('data')?.(Buffer.from(text))
		listeners.get('end')?.()
	}, 0)
	const res = {
		status: 0,
		body: '',
		writeHead: (status) => {
			res.status = status
		},
		end: (payload) => {
			res.body = payload
			res.done?.()
		}
	}
	return { req, res }
}

async function invoke(routePath, method, body) {
	const handler = handlers.get(routePath)
	const { req, res } = request2(method, method === 'GET' ? '' : JSON.stringify(body ?? {}))
	const finished = new Promise((resolve) => {
		res.done = resolve
	})
	await handler(req, res)
	await finished
	return { status: res.status, payload: res.body === '' ? null : JSON.parse(res.body) }
}

const DEBUG = '/api/session-delete/debug'
const SWEEP = '/api/session-delete/sweep'
const TRASH = '/api/session-delete/trash'
const TRASH_LIST = '/api/session-delete/trash-list'
const RESTORE = '/api/session-delete/restore'
const RESTORE_ALL = '/api/session-delete/restore-all'
const TRASH_PURGE = '/api/session-delete/trash-purge'
const MESSAGES = '/api/session-delete/messages'
const MESSAGE_DELETE = '/api/session-delete/message-delete'
const MESSAGE_UNDO = '/api/session-delete/message-undo'
const ORPHANS = '/api/session-delete/orphans'
const DELETE = '/api/session-delete/delete'

console.log('routes registered:', handlers.size)

// --- pick a session that has messages -------------------------------------
const debug = await invoke(DEBUG, 'GET')
check('debug lists on-disk sessions', Array.isArray(debug.payload.onDisk) && debug.payload.onDisk.length > 0, debug.payload)

// The first session may be a bare header (a fixture), so walk until one has
// an answer worth deleting.
let target = undefined
let before = undefined
for (const candidate of debug.payload.onDisk) {
	const probe = await invoke(MESSAGES, 'POST', { sessionId: candidate })
	if (Array.isArray(probe.payload.messages) && probe.payload.messages.length > 0) {
		target = candidate
		before = probe
		break
	}
}
check('some on-disk session has messages', target !== undefined, debug.payload.onDisk)
console.log('target session:', target)

check('messages route answers', before !== undefined && before.status === 200, before?.payload)
if (target === undefined) {
	console.log('\nno session with messages — cannot continue')
	process.exit(1)
}
const first = before.payload.messages[0]
check('there is a message to delete', first !== undefined, before.payload.messages.slice(0, 2))

// --- delete one message, then check the log still validates ---------------
const removed = await invoke(MESSAGE_DELETE, 'POST', { sessionId: target, seq: first.seq })
check('message-delete accepted', removed.status === 200 && removed.payload.verified === true, removed.payload)
const afterRemove = await invoke(MESSAGES, 'POST', { sessionId: target })
check('one message left the list', afterRemove.payload.messages.length === before.payload.messages.length - 1, {
	before: before.payload.messages.length,
	after: afterRemove.payload.messages.length
})
check('dropped records were reported', removed.payload.dropped.includes(first.seq), removed.payload.dropped)

const undo = await invoke(MESSAGE_UNDO, 'POST', { sessionId: target })
check('undo restored the log', undo.status === 200 && undo.payload.verified === true, undo.payload)
const afterUndo = await invoke(MESSAGES, 'POST', { sessionId: target })
check('message came back', afterUndo.payload.messages.length === before.payload.messages.length, {
	expected: before.payload.messages.length,
	actual: afterUndo.payload.messages.length
})

// --- the UI addresses messages by id, not by seq --------------------------
check('messages carry an id', typeof first.id === 'string' && first.id.length > 0, first)
const byId = await invoke(MESSAGE_DELETE, 'POST', { sessionId: target, messageId: first.id })
check('message-delete accepts a message id', byId.status === 200 && byId.payload.verified === true, byId.payload)
check('the id resolved to the same seq', byId.payload.seq === first.seq, { seq: byId.payload.seq, expected: first.seq })

const unknown = await invoke(MESSAGE_DELETE, 'POST', { sessionId: target, messageId: 'not-a-message' })
check('an unknown message id is refused', unknown.status === 404 && unknown.payload.error === 'no-message', unknown.payload)

await invoke(MESSAGE_UNDO, 'POST', { sessionId: target })

// --- trash, list, restore -------------------------------------------------
const trashed = await invoke(TRASH, 'POST', { sessionId: target })
check('trash accepted', trashed.status === 200 && trashed.payload.ok === true, trashed.payload)
check('log directory left sessions/', (await findLog(target)) === undefined)
check('trash directory exists', await exists(path.join(process.env.DSH_HOME, 'session-trash', target)))

const listed = await invoke(TRASH_LIST, 'POST', {})
check('trash-list shows it', listed.payload.entries.some((entry) => entry.sessionId === target), listed.payload)

const restored = await invoke(RESTORE, 'POST', { sessionId: target })
check('restore accepted', restored.status === 200 && restored.payload.ok === true, restored.payload)
check('log is back on disk', (await findLog(target)) !== undefined)

// --- erase ----------------------------------------------------------------
const erased = await invoke(DELETE, 'POST', { sessionId: target })
check('delete accepted', erased.status === 200 && erased.payload.ok === true, erased.payload)
check('log is gone', (await findLog(target)) === undefined)
const after = await invoke(DEBUG, 'GET')
check('catalog no longer lists it', !after.payload.onDisk.includes(target), after.payload.onDisk)

// --- residue sweep --------------------------------------------------------
const swept = await invoke(SWEEP, 'POST', {})
check('sweep answered', swept.status === 200 && swept.payload.ok === true, swept.payload)
check('sweep dropped the erased id from the registry', !(await registryNames(target)), await registryNames(target))
const orphans = await invoke(ORPHANS, 'POST', {})
check('orphans answered', orphans.status === 200 && orphans.payload.ok === true, orphans.payload.indexes)

// --- restore everything, then empty the trash ------------------------------
// These two run last, on a spare Session, because emptying the trash is the one
// operation that leaves nothing to check afterwards.
const spare = after.payload.onDisk.find((id) => id !== target)
if (spare === undefined) {
	check('a spare Session exists for the trash-wide routes', false, after.payload.onDisk)
} else {
	await invoke(TRASH, 'POST', { sessionId: spare })
	const restoreAll = await invoke(RESTORE_ALL, 'POST', {})
	check('restore-all accepted', restoreAll.status === 200 && restoreAll.payload.ok === true, restoreAll.payload)
	check('restore-all restored the spare log', (await findLog(spare)) !== undefined)
	check('restore-all emptied the trash', (await invoke(TRASH_LIST, 'POST', {})).payload.entries.length === 0)

	await invoke(TRASH, 'POST', { sessionId: spare })
	const purged = await invoke(TRASH_PURGE, 'POST', {})
	check('trash-purge accepted', purged.status === 200 && purged.payload.ok === true, purged.payload)
	check('trash-purge deleted the directory', !(await exists(path.join(process.env.DSH_HOME, 'session-trash', spare))))
	check('trash-purge did not restore', (await findLog(spare)) === undefined)
}

await new Promise((resolve) => setTimeout(resolve, 50))
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

async function exists(target2) {
	try {
		await fs.stat(target2)
		return true
	} catch {
		return false
	}
}

async function registryNames(sessionId) {
	const file = path.join(process.env.DSH_HOME, 'storages', 'workspace.json')
	try {
		const text = await fs.readFile(file, 'utf8')
		return text.includes(sessionId)
	} catch {
		return false
	}
}
