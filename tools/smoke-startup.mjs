/**
 * Start-up smoke test: a Session moved to the trash must be gone after the
 * plugin's start-up pass, and its registry rows must be gone with it.
 *
 * Usage: node tools/smoke-startup.mjs <home>
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.argv[2]
if (home === undefined) {
	console.error('usage: node tools/smoke-startup.mjs <home>')
	process.exit(2)
}
process.env.DSH_HOME = path.resolve(home)

const handlers = new Map()
const ctx = {
	logger: { warn: (...args) => console.warn('[warn]', ...args) },
	webServer: {
		register: (route) => {
			handlers.set(route.path, route.handler)
			return () => {}
		}
	},
	effect: (fn) => fn(),
	sessions: { store: new Map(), get: () => undefined, list: () => [], emitDisposed: () => {} },
	sessionPersistence: { list: async () => [], open: async () => { throw new Error('smoke: no handles') } },
	workspaceRegistry: { unarchiveSession: async () => {} },
	get: () => undefined
}

const plugin = await import(pathToFileURL('E:/蓝色大肥鱼正在工作/dsh-session-delete/index.js').href)
plugin.apply(ctx)

let failures = 0
function check(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`)
		return
	}
	failures += 1
	console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

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

const debug = await invoke('/api/session-delete/debug', 'GET')
const target = debug.payload.onDisk[0]
check('debug lists on-disk sessions', typeof target === 'string', debug.payload)

const trashed = await invoke('/api/session-delete/trash', 'POST', { sessionId: target })
check('trash accepted', trashed.status === 200 && trashed.payload.ok === true, trashed.payload)

const trashDir = path.join(process.env.DSH_HOME, 'session-trash', target)
check('trash directory exists before the start-up pass', await exists(trashDir))
check('trash scrubbed the registry row', !(await registryHas(target)))

// The start-up pass runs two seconds after apply(); wait for it to land.
await new Promise((resolve) => setTimeout(resolve, 2600))

check('trash was emptied on start-up', !(await exists(trashDir)))
check('registry row stayed gone', !(await registryHas(target)))

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

async function registryHas(sessionId) {
	const file = path.join(process.env.DSH_HOME, 'storages', 'workspace.json')
	try {
		return (await fs.readFile(file, 'utf8')).includes(sessionId)
	} catch {
		return false
	}
}
