/**
 * dsh-trash-delete — Host half.
 *
 * The Harness exposes no `delete` on `sessionPersistence`, `sessions`,
 * `sessionController`, or `workspaceRegistry`: a Session can only be archived.
 * Erasing one therefore has to touch the durable layout directly:
 *
 *   <DSH_HOME>/sessions/<project-slug>/<sessionId>/   event log directory
 *   <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
 *
 * Three operations live here:
 *
 *   • erase      — remove the directory and every derived index record, prune
 *                  leftovers on demand and again at start-up;
 *   • trash      — move the directory to `<DSH_HOME>/session-trash/`, where the
 *                  next Harness start deletes it, and restore it on request;
 *   • message    — rewrite `session.v4.jsonl.zstd` without one message, verify
 *                  the result through the Host's own reader, keep a backup.
 *
 * The browser half archives the Session through the public `uiWorkspace`
 * service first (which stops its activity and clears it from the sidebar), then
 * asks this half to act. Every route is deliberately narrow: POST only, JSON
 * body only, same-origin only, one `session-[A-Za-z0-9._-]+` id, and it never
 * accepts a caller-supplied path.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodeSessionLog, describeMessages, encodeSessionLog, removeMessage, seqOfMessageId } from './session-log.js'

/** Hard dependency: the browser carrier that owns the route table, plus the
 * registry whose archive set must drop a deleted session. `agents` is there so
 * a rewritten log can be reopened through `agents.resume`. */
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'agents']

/** Exact route the browser half POSTs to. */
const ROUTE_PATH = '/api/session-delete/delete'

/** Route that prunes archive records whose session files are already gone. */
const SWEEP_PATH = '/api/session-delete/sweep'

/** Route that moves one Session into the trash instead of erasing it. */
const TRASH_PATH = '/api/session-delete/trash'

/** Route that lists the Sessions currently in the trash. */
const TRASH_LIST_PATH = '/api/session-delete/trash-list'

/** Route that moves one trashed Session back into place. */
const RESTORE_PATH = '/api/session-delete/restore'

/** Route that moves every trashed Session back into place. */
const RESTORE_ALL_PATH = '/api/session-delete/restore-all'

/** Route that deletes everything in the trash right now. */
const TRASH_PURGE_PATH = '/api/session-delete/trash-purge'

/** Route that lists one Session's deletable messages. */
const MESSAGES_PATH = '/api/session-delete/messages'

/** Route that removes one message from a Session log. */
const MESSAGE_DELETE_PATH = '/api/session-delete/message-delete'

/** Route that restores the log saved before the newest message removal. */
const MESSAGE_UNDO_PATH = '/api/session-delete/message-undo'

/** Route that prunes every derived index record left by a deleted Session. */
const ORPHANS_PATH = '/api/session-delete/orphans'

/** Session ids are opaque brands, but every stored one is a safe single segment. */
const SESSION_ID = /^session-[A-Za-z0-9._-]{1,120}$/

/** Read-only diagnostic route: which Sessions the Host still knows about. */
const DEBUG_PATH = '/api/session-delete/debug'

/** Route the browser half reports its own behaviour to, for on-disk diagnosis. */
const REPORT_PATH = '/api/session-delete/report'

/** Route that only evicts a Session left in the live store (diagnostic repair). */
const EVICT_PATH = '/api/session-delete/evict'

/** Largest JSON body the route accepts; the only fields are ids and one seq. */
const MAX_BODY_BYTES = 8 * 1024

/** Retry delays for a path another process still holds open. */
const RETRY_DELAYS_MS = [80, 160, 240, 400, 600, 900]

/** Folder that holds trashed Sessions until the next start deletes them. */
const TRASH_DIR = 'session-trash'

/** Folder that holds pre-removal log copies, so one removal can be undone. */
const BACKUP_DIR = 'session-msg-backups'

/** How many pre-removal logs are kept per Session. */
const BACKUP_KEEP = 20

/** Log file names a Session directory may hold, newest format first. */
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v4.jsonl']

/** Resolve the Harness home directory the same way the process did. */
function resolveDshHome() {
	const configured = process.env.DSH_HOME
	if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
	return path.join(os.homedir(), '.dsh')
}

/** Lower-cased host name of a Host header or URL, without port or brackets. */
function hostNameOf(value) {
	if (typeof value !== 'string') return ''
	const trimmed = value.trim().toLowerCase()
	if (trimmed === '') return ''
	if (trimmed.startsWith('[')) {
		const end = trimmed.indexOf(']')
		return end === -1 ? trimmed : trimmed.slice(1, end)
	}
	const colon = trimmed.indexOf(':')
	return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body)
	})
	res.end(body)
}

/**
 * Refuse anything that is not a same-origin JSON POST.
 *
 * A cross-site `fetch` with a `application/json` body cannot be sent without a
 * CORS preflight this route never answers, and the `Origin`/`Host` comparison
 * rejects a same-site-but-not-same-origin caller as well.
 * @param ctx - plugin context, for the refusal log.
 * @param req - incoming request.
 * @param res - response to answer a refusal on.
 * @returns whether the request was already refused.
 */
function refuseForeignCaller(ctx, req, res) {
	if (req.method !== 'POST') {
		sendJson(res, 405, { ok: false, error: 'method-not-allowed', message: 'POST only' })
		return true
	}
	const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
	if (!contentType.startsWith('application/json')) {
		sendJson(res, 415, { ok: false, error: 'unsupported-media-type', message: 'content-type must be application/json' })
		return true
	}
	const origin = req.headers.origin
	if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
		let originHost = ''
		try {
			originHost = hostNameOf(new URL(origin).host)
		} catch {
			originHost = ''
		}
		const requestHost = hostNameOf(req.headers.host)
		if (originHost === '' || requestHost === '' || originHost !== requestHost) {
			ctx.logger?.warn?.(`session-delete: refused origin ${origin} for host ${String(req.headers.host)}`)
			sendJson(res, 403, { ok: false, error: 'forbidden', message: 'cross-origin request' })
			return true
		}
	}
	return false
}

/** Read the whole request body, refusing one that is too large. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error('body-too-large'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}

/**
 * Read one JSON body into an object, refusing a malformed or oversized one.
 * @param req - incoming request.
 * @returns the parsed object, or a refusal description.
 */
async function readJsonBody(req) {
	let raw
	try {
		raw = await readBody(req)
	} catch (error) {
		const tooLarge = error instanceof Error && error.message === 'body-too-large'
		return { ok: false, status: tooLarge ? 413 : 400, error: tooLarge ? 'body-too-large' : 'invalid-body' }
	}
	try {
		const parsed = JSON.parse(raw === '' ? '{}' : raw)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, status: 400, error: 'invalid-body' }
		return { ok: true, value: parsed }
	} catch {
		return { ok: false, status: 400, error: 'invalid-body' }
	}
}

/**
 * Remove one file or directory tree, retrying while a flush still holds it.
 * @param target - absolute path to erase.
 * @returns `{ ok }` plus the failing code and message when it could not be removed.
 */
async function removePath(target) {
	let lastCode = 'error'
	let lastMessage = 'unknown failure'
	for (const [attempt, waitMs] of RETRY_DELAYS_MS.entries()) {
		try {
			await fs.rm(target, { recursive: true, force: true, maxRetries: 0 })
			return { ok: true }
		} catch (error) {
			const code = typeof error?.code === 'string' ? error.code : 'error'
			lastCode = code
			lastMessage = error instanceof Error ? error.message : String(error)
			if (code === 'ENOENT') return { ok: true }
			const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
			if (!retryable || attempt === RETRY_DELAYS_MS.length - 1) break
			await delay(waitMs)
		}
	}
	return { ok: false, code: lastCode, message: lastMessage }
}

/** Whether a path exists and is a directory. */
async function isDirectory(target) {
	try {
		return (await fs.stat(target)).isDirectory()
	} catch {
		return false
	}
}

/** Whether a path exists at all. */
async function exists(target) {
	try {
		await fs.stat(target)
		return true
	} catch {
		return false
	}
}

/**
 * Every `sessions/<project-slug>/<sessionId>` directory that exists on disk.
 * @param home - Harness home directory.
 * @param sessionId - session id.
 * @returns absolute directory paths, in slug order.
 */
async function sessionDirs(home, sessionId) {
	const sessionsRoot = path.join(home, 'sessions')
	let entries = []
	try {
		entries = await fs.readdir(sessionsRoot, { withFileTypes: true })
	} catch {
		return []
	}
	const dirs = []
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const target = path.join(sessionsRoot, entry.name, sessionId)
		if (await isDirectory(target)) dirs.push({ slug: entry.name, dir: target })
	}
	return dirs
}

/**
 * Erase every durable trace of one Session.
 * @param sessionId - already validated session id.
 * @returns the Harness home used, every removed path, and every failure.
 */
async function eraseSession(sessionId) {
	const home = resolveDshHome()
	const removed = []
	const errors = []

	// 1. The event-log directory, under whichever project slug owns it.
	for (const { dir } of await sessionDirs(home, sessionId)) {
		const result = await removePath(dir)
		if (result.ok) removed.push(dir)
		else errors.push({ path: dir, code: result.code, message: result.message })
	}

	// 2. The projection cache the sidebar reads titles from.
	const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
	if (await exists(cacheFile)) {
		const result = await removePath(cacheFile)
		if (result.ok) removed.push(cacheFile)
		else errors.push({ path: cacheFile, code: result.code, message: result.message })
	}

	return { home, removed, errors }
}

/**
 * Whether any project slug still stores this session's event log.
 * @param home - Harness home directory.
 * @param sessionId - session id.
 * @returns true when at least one `sessions/<slug>/<id>` directory exists.
 */
async function hasStoredSession(home, sessionId) {
	return (await sessionDirs(home, sessionId)).length > 0
}

/**
 * Drop one id from the registry-global archive set. An id that is not archived
 * resolves without writing, and a session that no longer exists is still
 * accepted, so this is safe to call unconditionally after an erase.
 * @param ctx - plugin context carrying the registry.
 * @param sessionId - session id.
 * @returns whether the call resolved.
 */
async function unarchiveQuietly(ctx, sessionId) {
	try {
		await ctx.workspaceRegistry.unarchiveSession(sessionId)
		return true
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: unarchive ${sessionId} failed: ${String(error)}`)
		return false
	}
}

/**
 * Drop every JSON record that names one Session id.
 *
 * The durable layout keeps a small number of derived indexes beside the logs:
 * the workspace registry (whose archive, pin and per-workspace lists are plain
 * id arrays) and the projection cache. Neither is authoritative — the catalog is
 * rebuilt from `sessions/` — so a record left pointing at an erased Session is
 * pure residue: the sidebar can render it as an empty dimmed row until a
 * restart. This walks `storages/` and deletes the id wherever it appears as an
 * array element, an object key, or an `id`/`sessionId` property.
 * @param home - Harness home directory.
 * @param sessionId - the erased Session.
 * @returns the rewritten index files and any failures.
 */
async function scrubIndexes(home, sessionId) {
	const root = path.join(home, 'storages')
	const changed = []
	const errors = []
	const walk = async (dir, depth) => {
		if (depth > 4) return
		let entries = []
		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const target = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				await walk(target, depth + 1)
				continue
			}
			if (!entry.name.endsWith('.json')) continue
			let text
			try {
				text = await fs.readFile(target, 'utf8')
			} catch {
				continue
			}
			if (!text.includes(sessionId)) continue
			let parsed
			try {
				parsed = JSON.parse(text)
			} catch {
				continue
			}
			const scrubbed = scrubValue(parsed, sessionId)
			if (!scrubbed.changed) continue
			const temporary = `${target}.tmp-${process.pid}`
			try {
				await fs.writeFile(temporary, `${JSON.stringify(scrubbed.value)}\n`, 'utf8')
				await removePath(target)
				await fs.rename(temporary, target)
				changed.push(target)
			} catch (error) {
				await removePath(temporary)
				errors.push({ path: target, message: error instanceof Error ? error.message : String(error) })
			}
		}
	}
	await walk(root, 0)
	return { changed, errors }
}

/**
 * Recursively drop one id from a decoded JSON index value.
 * @param value - decoded JSON value.
 * @param sessionId - the erased Session.
 * @returns the scrubbed value and whether anything changed.
 */
function scrubValue(value, sessionId) {
	if (Array.isArray(value)) {
		const kept = []
		let changed = false
		for (const item of value) {
			if (item === sessionId) {
				changed = true
				continue
			}
			if (item !== null && typeof item === 'object') {
				if (item.id === sessionId || item.sessionId === sessionId) {
					changed = true
					continue
				}
				const inner = scrubValue(item, sessionId)
				if (inner.changed) changed = true
				kept.push(inner.value)
				continue
			}
			kept.push(item)
		}
		return { value: kept, changed }
	}
	if (value !== null && typeof value === 'object') {
		const out = {}
		let changed = false
		for (const [key, item] of Object.entries(value)) {
			if (key === sessionId) {
				changed = true
				continue
			}
			const inner = scrubValue(item, sessionId)
			if (inner.changed) changed = true
			out[key] = inner.value
		}
		return { value: out, changed }
	}
	return { value, changed: false }
}

/**
 * Delete every derived search/index database that a rebuild replaces.
 *
 * A Session's log is the only authoritative artifact; anything a backend caches
 * beside it in `storages/` is derived and is rebuilt on demand. Removing a whole
 * database is therefore safe after an erase — and is the only way to clear an
 * index the Harness exposes no removal for.
 * @param home - Harness home directory.
 * @returns the removed database paths.
 */
async function removeDerivedDatabases(home) {
	const root = path.join(home, 'storages')
	const removed = []
	const walk = async (dir, depth) => {
		if (depth > 4) return
		let entries = []
		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const target = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				await walk(target, depth + 1)
				continue
			}
			if (!/\.(sqlite|sqlite3|db)(-wal|-shm|-journal)?$/i.test(entry.name)) continue
			const result = await removePath(target)
			if (result.ok) removed.push(target)
		}
	}
	await walk(root, 0)
	return removed
}

/**
 * Every id the workspace registry still names, with the workspace that lists it.
 * @param home - Harness home directory.
 * @returns ids mapped to their workspace id, or an empty map when unreadable.
 */
async function registryIndex(home) {
	const registryFile = path.join(home, 'storages', 'workspace.json')
	let parsed
	try {
		parsed = JSON.parse(await fs.readFile(registryFile, 'utf8'))
	} catch {
		return new Map()
	}
	const found = new Map()
	const note = (value) => {
		if (typeof value !== 'string' || !SESSION_ID.test(value) || found.has(value)) return
		found.set(value, undefined)
	}
	for (const value of parsed?.global?.archivedSessionIds ?? []) note(value)
	for (const value of parsed?.global?.pinnedSessionIds ?? []) note(value)
	for (const [workspaceId, workspace] of Object.entries(parsed?.tables?.workspaces ?? {})) {
		for (const value of workspace?.sessionIds ?? []) {
			if (typeof value !== 'string' || !SESSION_ID.test(value)) continue
			if (!found.has(value)) found.set(value, workspaceId)
		}
	}
	return found
}

/**
 * Put one id back into the workspace that listed it before it was trashed.
 * @param home - Harness home directory.
 * @param sessionId - restored session id.
 * @param workspaceId - workspace the id belonged to, when known.
 * @returns whether the registry file changed.
 */
async function addToWorkspaceIndex(home, sessionId, workspaceId) {
	const registryFile = path.join(home, 'storages', 'workspace.json')
	let parsed
	try {
		parsed = JSON.parse(await fs.readFile(registryFile, 'utf8'))
	} catch {
		return false
	}
	const workspaces = parsed?.tables?.workspaces
	if (workspaces === null || typeof workspaces !== 'object') return false
	const target = typeof workspaceId === 'string' && workspaces[workspaceId] !== undefined ? workspaces[workspaceId] : Object.values(workspaces)[0]
	if (target === null || typeof target !== 'object') return false
	if (!Array.isArray(target.sessionIds)) target.sessionIds = []
	if (target.sessionIds.includes(sessionId)) return false
	target.sessionIds.push(sessionId)
	target.updatedAt = new Date().toISOString()
	const temporary = `${registryFile}.tmp-${process.pid}`
	try {
		await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
		await removePath(registryFile)
		await fs.rename(temporary, registryFile)
		return true
	} catch {
		await removePath(temporary)
		return false
	}
}

/**
 * Prune index records whose session no longer has any stored event log.
 *
 * The workspace registry is the sidebar's source of truth: a Session id left in
 * a workspace's `sessionIds`, in the archive set, or in the pin set renders as
 * an empty dimmed row until a restart rebuilds the registry. A Session that is
 * live in memory or known to persistence is protected even before its log is
 * materialized, so a brand-new conversation is never mistaken for residue.
 * @param ctx - plugin context carrying the registry.
 * @returns the checked and pruned ids.
 */
async function sweepArchived(ctx) {
	const home = resolveDshHome()
	const registryFile = path.join(home, 'storages', 'workspace.json')
	let parsed = null
	try {
		parsed = JSON.parse(await fs.readFile(registryFile, 'utf8'))
	} catch (error) {
		return { ok: false, error: 'registry-unreadable', message: error instanceof Error ? error.message : String(error), unarchived: [] }
	}
	const protectedIds = new Set()
	try {
		for (const session of ctx.sessions?.list?.() ?? []) if (typeof session?.id === 'string') protectedIds.add(session.id)
		for (const record of (await ctx.sessionPersistence?.list?.()) ?? []) {
			const id = record?.header?.id
			if (typeof id === 'string') protectedIds.add(id)
		}
	} catch {
		// A refusal to enumerate is not a licence to prune: fall back to the logs.
	}
	const archived = Array.isArray(parsed?.global?.archivedSessionIds) ? parsed.global.archivedSessionIds : []
	const unarchived = []
	const scrubbed = []
	const indexFiles = []
	for (const id of (await registryIndex(home)).keys()) {
		if (protectedIds.has(id)) continue
		if (await hasStoredSession(home, id)) continue
		if (archived.includes(id) && (await unarchiveQuietly(ctx, id))) unarchived.push(id)
		const result = await scrubIndexes(home, id)
		indexFiles.push(...result.changed)
		scrubbed.push(id)
	}
	const prunedCaches = await pruneOrphanCaches(ctx, home)
	return { ok: true, checked: archived.length, unarchived, scrubbed, indexFiles: [...new Set(indexFiles)], prunedCaches }
}

/**
 * Remove projection caches whose session no longer exists.
 *
 * A cache file is written for a Session the catalog still lists, so erasing the
 * event log first can leave one behind — and a disposal can write a last one
 * after the erase. A cache with no Session and no live entry is orphaned: the
 * session it describes is gone, so this drops it.
 * @param ctx - plugin context carrying the live store.
 * @param home - resolved `<DSH_HOME>`.
 * @returns how many cache files were removed.
 */
async function pruneOrphanCaches(ctx, home) {
	const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
	let names = []
	try {
		names = await fs.readdir(dir)
	} catch {
		return 0
	}
	let removed = 0
	for (const name of names) {
		if (!name.endsWith('.json')) continue
		const id = name.slice(0, -'.json'.length)
		if (!SESSION_ID.test(id)) continue
		if (typeof ctx.sessions?.get === 'function' && ctx.sessions.get(id) !== undefined) continue
		if (await hasStoredSession(home, id)) continue
		const result = await removePath(path.join(dir, name))
		if (result.ok) removed += 1
	}
	return removed
}

/**
 * Answer one sweep request.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleSweep(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	try {
		const result = await sweepArchived(ctx)
		sendJson(res, result.ok ? 200 : 500, result)
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Evict one erased Session from the Host's live store.
 *
 * `session.list` is "persisted ∪ live", so a Session that is still resident
 * keeps being listed even with no files left — that is the row that used to
 * survive until a restart. The store exposes no by-id removal, but its entry
 * map is a plain `Map` field and `emitDisposed` is the same announcement a real
 * disposal makes, so this reproduces `detachEntered` for an id whose files are
 * already gone.
 * @param ctx - plugin context carrying the `sessions` store.
 * @param sessionId - the erased Session.
 * @returns whether a live entry was actually removed.
 */
function evictLive(ctx, sessionId) {
	try {
		const sessions = ctx.sessions
		const store = sessions?.store
		if (store === undefined || store === null) return false
		if (typeof store.get !== 'function' || typeof store.delete !== 'function') return false
		const entry = store.get(sessionId)
		if (entry === undefined) return false
		store.delete(sessionId)
		try {
			sessions.emitDisposed?.(entry)
		} catch (error) {
			ctx.logger?.warn?.(`session-delete: disposal announcement threw: ${String(error)}`)
		}
		return true
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: could not evict the live entry: ${String(error)}`)
		return false
	}
}

/**
 * Append one diagnostic line to `<DSH_HOME>/session-delete.log`.
 * Diagnostics must never fail the action they describe, so a write error is
 * swallowed here and surfaced only through the returned flag.
 * @param fields - flat, already-trimmed values.
 * @returns whether the line reached disk.
 */
async function appendReport(fields) {
	const line = `${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`
	try {
		await fs.appendFile(path.join(resolveDshHome(), 'session-delete.log'), line, 'utf8')
		return true
	} catch {
		return false
	}
}

/**
 * Tell open pages that a Session is gone, through the channel the official
 * controller uses for its own disposals.
 *
 * A Host-side registry write is not pushed to open pages, so a page that still
 * lists the erased Session keeps its row until it reloads. The official
 * `api-session/removed` event is emitted from the session controller's own
 * context; `ctx.emit` here would not reach that listener, so this borrows the
 * controller's context when the service exposes one.
 * @param ctx - plugin context.
 * @param sessionId - the erased Session.
 * @returns whether the event was emitted.
 */
function announceRemoval(ctx, sessionId) {
	try {
		const controller = ctx.get('sessionController')
		const carrier = controller?.ctx ?? controller?.context
		if (carrier === undefined || carrier === null || typeof carrier.emit !== 'function') return false
		carrier.emit('api-session/removed', sessionId)
		return true
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: could not announce removal: ${String(error)}`)
		return false
	}
}

/**
 * Answer one delete request: erase, drop the archive record, drop every derived
 * index record, and evict the live entry.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleDelete(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return

	const body = await readJsonBody(req)
	if (!body.ok) {
		sendJson(res, body.status, { ok: false, error: body.error, message: 'expected {"sessionId":"session-..."}' })
		return
	}
	const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId : ''
	if (!SESSION_ID.test(sessionId)) {
		sendJson(res, 400, { ok: false, error: 'invalid-session', message: 'sessionId must look like session-<id>' })
		return
	}

	try {
		const result = await eraseSession(sessionId)
		const ok = result.errors.length === 0
		// Drop the registry's archive record too. `unarchiveSession` removes the id
		// from the registry-global archive set without an existence check, which is
		// exactly what a session whose files are gone needs: otherwise the sidebar
		// keeps rendering it as an empty, dimmed row until the next restart.
		let unarchived = false
		if (ok) unarchived = await unarchiveQuietly(ctx, sessionId)
		// A Session still resident in the live store is listed by `session.list`
		// even with no files left. Evict the entry (which announces its disposal
		// the way a real one does) so the catalog stops listing it at once instead
		// of at the next app start.
		const stillLive = typeof ctx.sessions?.get === 'function' && ctx.sessions.get(sessionId) !== undefined
		const evicted = ok && stillLive ? evictLive(ctx, sessionId) : false
		const announced = ok && stillLive && !evicted ? announceRemoval(ctx, sessionId) : false
		// Evicting a live entry can make its owner flush one last time, which would
		// recreate the directory this call just removed. Re-check once, briefly.
		let repaired = false
		if (evicted) {
			await delay(120)
			const again = await eraseSession(sessionId)
			repaired = again.removed.length > 0
			if (repaired) {
				for (const leftover of again.removed) result.removed.push(leftover)
				result.errors.push(...again.errors)
			}
		}
		// Residue: archive records, pinned ids, projection caches and any derived
		// database the Host would otherwise keep answering from.
		const scrubbed = ok ? await scrubIndexes(result.home, sessionId) : { changed: [], errors: [] }
		const databases = ok ? await removeDerivedDatabases(result.home) : []
		const prunedCaches = ok ? await pruneOrphanCaches(ctx, result.home) : 0
		await appendReport({
			event: 'host-erase',
			sessionId,
			ok,
			unarchived,
			stillLive,
			evicted,
			announced,
			repaired,
			removed: result.removed.length,
			indexFiles: scrubbed.changed.length,
			databases: databases.length,
			prunedCaches
		})
		sendJson(res, ok ? 200 : 500, {
			ok,
			sessionId,
			home: result.home,
			removed: result.removed,
			errors: result.errors,
			unarchived,
			stillLive,
			evicted,
			announced,
			indexFiles: scrubbed.changed,
			indexErrors: scrubbed.errors,
			databases,
			prunedCaches,
			alreadyGone: result.removed.length === 0 && result.errors.length === 0
		})
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: erase failed: ${String(error)}`)
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

//#region trash
/**
 * Title of one Session, read from the projection cache the sidebar uses.
 * @param home - Harness home directory.
 * @param sessionId - session id.
 * @returns the stored title, or an empty string.
 */
async function titleOf(home, sessionId) {
	const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
	try {
		const parsed = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
		for (const key of ['title', 'displayTitle', 'name', 'summary']) {
			if (typeof parsed?.[key] === 'string' && parsed[key].trim() !== '') return parsed[key]
		}
	} catch {
		// A missing or unreadable cache is normal; the trash entry keeps no title.
	}
	return ''
}

/**
 * Move one Session into `<DSH_HOME>/session-trash/<id>/`.
 *
 * The next Harness start deletes whatever is in there (see {@link purgeTrash}),
 * so a trashed Session is recoverable for the rest of this run only — which is
 * exactly the contract the menu option promises.
 * @param ctx - plugin context.
 * @param sessionId - validated session id.
 * @returns the moved entry, and every failure.
 */
async function moveToTrash(ctx, sessionId) {
	const home = resolveDshHome()
	const trashRoot = path.join(home, TRASH_DIR)
	const target = path.join(trashRoot, sessionId)
	const dirs = await sessionDirs(home, sessionId)
	const moved = []
	const errors = []
	if (dirs.length === 0) return { ok: false, error: 'no-session', message: 'this Session has no stored log', moved, errors }
	if (await exists(target)) await removePath(target)
	await fs.mkdir(target, { recursive: true })
	for (const { slug, dir } of dirs) {
		const destination = path.join(target, slug)
		try {
			await fs.rename(dir, destination)
			moved.push({ from: dir, to: destination })
		} catch (error) {
			// A cross-device move is impossible on one Harness home, but an antivirus
			// lock is not: fall back to a copy, then remove the source.
			try {
				await fs.cp(dir, destination, { recursive: true })
				const result = await removePath(dir)
				if (!result.ok) throw new Error(result.message)
				moved.push({ from: dir, to: destination, copied: true })
			} catch (inner) {
				errors.push({ path: dir, message: inner instanceof Error ? inner.message : String(inner) })
			}
		}
	}
	if (moved.length === 0) {
		await removePath(target)
		return { ok: false, error: 'move-failed', message: 'could not move the Session log', moved, errors }
	}
	const title = await titleOf(home, sessionId)
	// Remember which workspace listed the Session, so a restore can put the id
	// back where the user expects to find it.
	const workspaceId = (await registryIndex(home)).get(sessionId)
	await fs.writeFile(
		path.join(target, 'trash.json'),
		`${JSON.stringify({ sessionId, title, workspaceId: workspaceId ?? null, movedAt: Date.now(), slugs: moved.map((entry) => path.basename(entry.to)) })}\n`,
		'utf8'
	)
	const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
	await removePath(cacheFile)
	// The Session is now invisible to the catalog: drop its id from the registry
	// records, or the sidebar keeps rendering an empty dimmed row for it.
	const scrubbed = await scrubIndexes(home, sessionId)
	return { ok: true, moved, errors, title, workspaceId: workspaceId ?? null, indexFiles: scrubbed.changed, trashPath: target }
}

/**
 * Every Session currently sitting in the trash.
 * @returns one entry per trashed Session, newest first.
 */
async function listTrash() {
	const home = resolveDshHome()
	const trashRoot = path.join(home, TRASH_DIR)
	let entries = []
	try {
		entries = await fs.readdir(trashRoot, { withFileTypes: true })
	} catch {
		return { ok: true, home, trashPath: trashRoot, entries: [] }
	}
	const listed = []
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		if (!SESSION_ID.test(entry.name)) continue
		const target = path.join(trashRoot, entry.name)
		let meta = {}
		try {
			meta = JSON.parse(await fs.readFile(path.join(target, 'trash.json'), 'utf8'))
		} catch {
			meta = {}
		}
		listed.push({
			sessionId: entry.name,
			title: typeof meta.title === 'string' ? meta.title : '',
			workspaceId: typeof meta.workspaceId === 'string' ? meta.workspaceId : '',
			movedAt: typeof meta.movedAt === 'number' ? meta.movedAt : 0
		})
	}
	listed.sort((left, right) => right.movedAt - left.movedAt)
	return { ok: true, home, trashPath: trashRoot, entries: listed }
}

/**
 * Restore one trashed Session to the project slug it came from.
 * @param sessionId - validated session id.
 * @returns the restored directories, and every failure.
 */
async function restoreFromTrash(sessionId) {
	const home = resolveDshHome()
	const source = path.join(home, TRASH_DIR, sessionId)
	if (!(await isDirectory(source))) return { ok: false, error: 'not-in-trash', message: 'this Session is not in the trash', restored: [] }
	let meta = {}
	try {
		meta = JSON.parse(await fs.readFile(path.join(source, 'trash.json'), 'utf8'))
	} catch {
		meta = {}
	}
	let children = []
	try {
		children = (await fs.readdir(source, { withFileTypes: true })).filter((entry) => entry.isDirectory())
	} catch {
		children = []
	}
	const restored = []
	const errors = []
	for (const child of children) {
		const slug = /^--[A-Za-z0-9._~-]+--$/.test(child.name) ? child.name : '--restored--'
		const destination = path.join(home, 'sessions', slug, sessionId)
		await fs.mkdir(path.dirname(destination), { recursive: true })
		try {
			if (await exists(destination)) await removePath(destination)
			await fs.rename(path.join(source, child.name), destination)
			restored.push(destination)
		} catch (error) {
			errors.push({ path: destination, message: error instanceof Error ? error.message : String(error) })
		}
	}
	if (restored.length === 0) return { ok: false, error: 'restore-failed', message: 'could not move the Session log back', restored, errors }
	await removePath(source)
	// Put the id back into the registry, or the restored log stays invisible until
	// the registry is rebuilt at the next start.
	const reinstated = await addToWorkspaceIndex(home, sessionId, typeof meta.workspaceId === 'string' ? meta.workspaceId : undefined)
	return { ok: true, restored, errors, reinstated, title: typeof meta.title === 'string' ? meta.title : '' }
}

/**
 * Delete everything in the trash. Runs once per process start, which is what
 * makes a trashed Session survive exactly until the next Harness restart.
 * @returns the removed Session ids and the trash path.
 */
async function purgeTrash() {
	const home = resolveDshHome()
	const trashRoot = path.join(home, TRASH_DIR)
	let entries = []
	try {
		entries = await fs.readdir(trashRoot, { withFileTypes: true })
	} catch {
		return { home, trashPath: trashRoot, purged: [], errors: [] }
	}
	const purged = []
	const errors = []
	for (const entry of entries) {
		const target = path.join(trashRoot, entry.name)
		const result = await removePath(target)
		if (result.ok) purged.push(entry.name)
		else errors.push({ path: target, code: result.code, message: result.message })
	}
	await removePath(trashRoot)
	return { home, trashPath: trashRoot, purged, errors }
}

/**
 * Answer one "move to trash" request.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleTrash(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	const body = await readJsonBody(req)
	if (!body.ok) {
		sendJson(res, body.status, { ok: false, error: body.error, message: 'expected {"sessionId":"session-..."}' })
		return
	}
	const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId : ''
	if (!SESSION_ID.test(sessionId)) {
		sendJson(res, 400, { ok: false, error: 'invalid-session', message: 'sessionId must look like session-<id>' })
		return
	}
	try {
		// A live Session keeps flushing into its directory, which would recreate the
		// very path this call moves away: evict first, exactly as the erase route does.
		const wasLive = typeof ctx.sessions?.get === 'function' && ctx.sessions.get(sessionId) !== undefined
		const evicted = wasLive ? evictLive(ctx, sessionId) : false
		if (evicted) await delay(120)
		const result = await moveToTrash(ctx, sessionId)
		if (result.ok) await unarchiveQuietly(ctx, sessionId)
		await appendReport({ event: 'host-trash', sessionId, ok: result.ok, wasLive, evicted, title: result.title ?? '', moved: result.moved?.length ?? 0 })
		sendJson(res, result.ok ? 200 : 500, { ...result, sessionId, wasLive, evicted })
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: trash failed: ${String(error)}`)
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Answer one trash listing request.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleTrashList(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	try {
		sendJson(res, 200, await listTrash())
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Answer one restore request.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleRestore(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	const body = await readJsonBody(req)
	if (!body.ok) {
		sendJson(res, body.status, { ok: false, error: body.error, message: 'expected {"sessionId":"session-..."}' })
		return
	}
	const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId : ''
	if (!SESSION_ID.test(sessionId)) {
		sendJson(res, 400, { ok: false, error: 'invalid-session', message: 'sessionId must look like session-<id>' })
		return
	}
	try {
		const result = await restoreFromTrash(sessionId)
		await appendReport({ event: 'host-restore', sessionId, ok: result.ok, restored: result.restored?.length ?? 0 })
		sendJson(res, result.ok ? 200 : 500, { ...result, sessionId })
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Answer one "restore everything" request: every trashed Session goes back to
 * the project slug it came from.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleRestoreAll(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	try {
		const listed = await listTrash()
		const restored = []
		const failed = []
		for (const entry of listed.entries) {
			const result = await restoreFromTrash(entry.sessionId)
			if (result.ok) restored.push(entry.sessionId)
			else failed.push({ sessionId: entry.sessionId, error: result.error, message: result.message })
		}
		await appendReport({ event: 'host-restore-all', ok: failed.length === 0, restored: restored.length, failed: failed.length })
		sendJson(res, 200, { ok: true, restored, failed })
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Answer one "empty the trash" request. Unlike the start-up purge this one also
 * clears the registry and index residue of every id it deleted.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleTrashPurge(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	try {
		const home = resolveDshHome()
		const result = await purgeTrash()
		for (const sessionId of result.purged) {
			if (!SESSION_ID.test(sessionId)) continue
			await unarchiveQuietly(ctx, sessionId)
			await scrubIndexes(home, sessionId)
		}
		await pruneOrphanCaches(ctx, home)
		await appendReport({ event: 'host-trash-purge', ok: result.errors.length === 0, purged: result.purged.length })
		sendJson(res, 200, { ok: true, purged: result.purged, errors: result.errors })
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}
//#endregion

//#region message surgery
/**
 * Absolute log file of one Session, wherever its project slug put it.
 * @param home - Harness home directory.
 * @param sessionId - session id.
 * @returns the log path, or undefined when the Session has no stored log.
 */
async function logFileOf(home, sessionId) {
	for (const { dir } of await sessionDirs(home, sessionId)) {
		for (const name of LOG_NAMES) {
			const candidate = path.join(dir, name)
			if (await exists(candidate)) return candidate
		}
	}
	return undefined
}

/**
 * Ask the Host's own reader to decode one Session log.
 *
 * This is the verification step: `sessionPersistence.open` replays the whole
 * artifact through `assertReleasedV4Relationships`, so a rewrite that broke a
 * lifecycle, surface, or title relationship is refused here rather than by the
 * user's next attempt to open the conversation.
 * @param ctx - plugin context carrying the persistence service.
 * @param sessionId - session id.
 * @returns the decoded event count, or the refusal text.
 */
async function verifyStoredLog(ctx, sessionId) {
	const persistence = ctx.sessionPersistence
	if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') return { ok: false, message: 'session persistence is unavailable' }
	let handle
	try {
		handle = await persistence.open(sessionId, 'read')
		const read = await handle.read()
		return { ok: true, events: Array.isArray(read?.events) ? read.events.length : 0 }
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) }
	} finally {
		try {
			await handle?.close?.()
		} catch {
			// Closing a verification handle must never mask the verdict.
		}
	}
}

/**
 * Copy one log into `<DSH_HOME>/session-msg-backups/<id>/<timestamp>.<name>`.
 * @param home - Harness home directory.
 * @param sessionId - session id.
 * @param logFile - the log to copy.
 * @returns the backup path, or undefined when the copy failed.
 */
async function backupLog(home, sessionId, logFile) {
	const dir = path.join(home, BACKUP_DIR, sessionId)
	try {
		await fs.mkdir(dir, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		const target = path.join(dir, `${stamp}.${path.basename(logFile)}`)
		await fs.copyFile(logFile, target)
		const names = (await fs.readdir(dir)).filter((name) => name.includes('.session.v4.')).sort()
		for (const stale of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) await removePath(path.join(dir, stale))
		return target
	} catch {
		return undefined
	}
}

/**
 * Newest backup of one Session's log.
 * @param home - Harness home directory.
 * @param sessionId - session id.
 * @returns the backup path, or undefined when there is none.
 */
async function newestBackup(home, sessionId) {
	const dir = path.join(home, BACKUP_DIR, sessionId)
	try {
		const names = (await fs.readdir(dir)).filter((name) => name.includes('.session.v4.')).sort()
		const newest = names.at(-1)
		return newest === undefined ? undefined : path.join(dir, newest)
	} catch {
		return undefined
	}
}

/**
 * Publish a rewritten log atomically: write beside it, then swap.
 * @param logFile - the log to replace.
 * @param bytes - complete replacement artifact.
 */
async function publishLog(logFile, bytes) {
	const temporary = `${logFile}.rewrite-${process.pid}`
	const previous = `${logFile}.previous-${process.pid}`
	await fs.writeFile(temporary, bytes)
	await removePath(previous)
	await fs.rename(logFile, previous)
	try {
		await fs.rename(temporary, logFile)
	} catch (error) {
		await fs.rename(previous, logFile)
		await removePath(temporary)
		throw error
	}
	await removePath(previous)
}

/**
 * Answer one "list messages" request.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleMessages(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	const body = await readJsonBody(req)
	if (!body.ok) {
		sendJson(res, body.status, { ok: false, error: body.error, message: 'expected {"sessionId":"session-..."}' })
		return
	}
	const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId : ''
	if (!SESSION_ID.test(sessionId)) {
		sendJson(res, 400, { ok: false, error: 'invalid-session', message: 'sessionId must look like session-<id>' })
		return
	}
	try {
		const home = resolveDshHome()
		const logFile = await logFileOf(home, sessionId)
		if (logFile === undefined) {
			sendJson(res, 404, { ok: false, error: 'no-log', message: 'this Session has no stored log', messages: [] })
			return
		}
		const decoded = decodeSessionLog(await fs.readFile(logFile))
		const live = typeof ctx.sessions?.get === 'function' && ctx.sessions.get(sessionId) !== undefined
		sendJson(res, 200, {
			ok: true,
			sessionId,
			logFile,
			live,
			compressed: decoded.compressed,
			events: decoded.events.length,
			messages: describeMessages(decoded.events)
		})
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Whether one Session is currently inside a live turn. Evicting a Session
 * mid-turn would pull the running agent out from under its own writer, so the
 * message routes refuse instead of racing it.
 * @param ctx - plugin context carrying the `agents` service.
 * @param sessionId - the Session in question.
 * @returns true when the Agent reports a running turn.
 */
function isRunning(ctx, sessionId) {
	try {
		const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
		const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
		return agent?.status === 'running'
	} catch {
		return false
	}
}

/**
 * Bring back a Session this route just evicted, so the conversation in front of
 * the user keeps working — on the rewritten log — instead of being left as a
 * removed Session. A refusal here is not fatal: the log is already correct and
 * the next open picks it up.
 * @param ctx - plugin context carrying the `agents` service.
 * @param sessionId - the Session to reopen.
 * @param wasLive - whether this route evicted it in the first place.
 * @returns whether the runtime accepted it again.
 */
async function reopenSession(ctx, sessionId, wasLive) {
	if (!wasLive) return { resumed: false, reason: 'not-live' }
	try {
		const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
		if (agents === undefined || typeof agents.resume !== 'function') return { resumed: false, reason: 'no-agent-service' }
		await agents.resume({ resumeSessionId: sessionId })
		return { resumed: true }
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		ctx.logger?.warn?.(`session-delete: could not reopen ${sessionId}: ${reason}`)
		return { resumed: false, reason }
	}
}

/**
 * Answer one "remove one message" request.
 *
 * Order matters: evict the live entry (so nothing appends to the file being
 * replaced), back the log up, publish the rewrite, then let the Host's reader
 * judge it. A refusal restores the backup before the response leaves.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleMessageDelete(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	const body = await readJsonBody(req)
	if (!body.ok) {
		sendJson(res, body.status, { ok: false, error: body.error, message: 'expected {"sessionId":"session-...","seq":0}' })
		return
	}
	const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId : ''
	const messageId = typeof body.value.messageId === 'string' ? body.value.messageId : ''
	let seq = body.value.seq
	if (!SESSION_ID.test(sessionId)) {
		sendJson(res, 400, { ok: false, error: 'invalid-session', message: 'sessionId must look like session-<id>' })
		return
	}
	if (!Number.isSafeInteger(seq) && messageId !== '') seq = undefined
	if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) {
		sendJson(res, 400, { ok: false, error: 'invalid-seq', message: 'seq must be a non-negative safe integer' })
		return
	}
	if (seq === undefined && messageId === '') {
		sendJson(res, 400, { ok: false, error: 'missing-target', message: 'expected {"sessionId":"session-...","seq":0} or {"sessionId":"session-...","messageId":"<uuid>"}' })
		return
	}

	const home = resolveDshHome()
	let logFile
	try {
		logFile = await logFileOf(home, sessionId)
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
		return
	}
	if (logFile === undefined) {
		sendJson(res, 404, { ok: false, error: 'no-log', message: 'this Session has no stored log' })
		return
	}

	try {
		const wasLive = typeof ctx.sessions?.get === 'function' && ctx.sessions.get(sessionId) !== undefined
		if (isRunning(ctx, sessionId)) {
			sendJson(res, 409, {
				ok: false,
				error: 'session-running',
				message: 'this Session is answering right now; stop or wait for that answer, then try again',
				wasLive,
				evicted: false
			})
			return
		}
		// The action row knows the id of the answered turn, not a seq, so resolve
		// it against the log before anything is displaced.
		if (seq === undefined) {
			const preview = decodeSessionLog(await fs.readFile(logFile))
			const resolved = seqOfMessageId(preview.events, messageId)
			if (resolved < 0) {
				sendJson(res, 404, { ok: false, error: 'no-message', message: 'no message with that id is stored in this Session', wasLive, evicted: false })
				return
			}
			seq = resolved
		}
		const evicted = wasLive ? evictLive(ctx, sessionId) : false
		if (evicted) await delay(150)

		const original = await fs.readFile(logFile)
		const decoded = decodeSessionLog(original)
		const result = removeMessage(decoded.events, seq)
		if (!result.ok) {
			await reopenSession(ctx, sessionId, wasLive)
			sendJson(res, 400, { ok: false, error: result.error, message: result.message, wasLive, evicted })
			return
		}
		if (result.dropped.length === 0) {
			await reopenSession(ctx, sessionId, wasLive)
			sendJson(res, 400, { ok: false, error: 'nothing-removed', message: 'that message could not be removed', wasLive, evicted })
			return
		}

		const backup = await backupLog(home, sessionId, logFile)
		await publishLog(logFile, encodeSessionLog(decoded.headerText, result.events))

		const verdict = await verifyStoredLog(ctx, sessionId)
		if (!verdict.ok) {
			// The Host's reader refused the rewrite: put the untouched bytes back, so a
			// refused removal can never leave an unopenable conversation behind.
			if (backup !== undefined) await publishLog(logFile, await fs.readFile(backup))
			else await publishLog(logFile, original)
			await reopenSession(ctx, sessionId, wasLive)
			await appendReport({ event: 'host-message-delete', sessionId, seq, ok: false, refused: verdict.message, wasLive, evicted })
			sendJson(res, 409, {
				ok: false,
				error: 'refused-by-host',
				message: verdict.message,
				rolledBack: true,
				wasLive,
				evicted
			})
			return
		}

		const reopened = await reopenSession(ctx, sessionId, wasLive)
		await appendReport({
			event: 'host-message-delete',
			sessionId,
			seq,
			ok: true,
			dropped: result.dropped.length,
			remaining: result.events.length,
			backup: backup === undefined ? '' : path.basename(backup),
			wasLive,
			evicted,
			resumed: reopened.resumed
		})
		sendJson(res, 200, {
			ok: true,
			sessionId,
			seq,
			dropped: result.dropped,
			remaining: result.events.length,
			backup: backup === undefined ? '' : path.basename(backup),
			verified: true,
			wasLive,
			evicted,
			resumed: reopened.resumed,
			resumeError: reopened.reason,
			canUndo: backup !== undefined
		})
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: message removal failed: ${String(error)}`)
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Answer one "undo the last message removal" request.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleMessageUndo(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	const body = await readJsonBody(req)
	if (!body.ok) {
		sendJson(res, body.status, { ok: false, error: body.error, message: 'expected {"sessionId":"session-..."}' })
		return
	}
	const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId : ''
	if (!SESSION_ID.test(sessionId)) {
		sendJson(res, 400, { ok: false, error: 'invalid-session', message: 'sessionId must look like session-<id>' })
		return
	}
	try {
		const home = resolveDshHome()
		const logFile = await logFileOf(home, sessionId)
		const backup = await newestBackup(home, sessionId)
		if (logFile === undefined) {
			sendJson(res, 404, { ok: false, error: 'no-log', message: 'this Session has no stored log' })
			return
		}
		if (backup === undefined) {
			sendJson(res, 404, { ok: false, error: 'no-backup', message: 'there is no removal to undo' })
			return
		}
		const wasLive = typeof ctx.sessions?.get === 'function' && ctx.sessions.get(sessionId) !== undefined
		if (isRunning(ctx, sessionId)) {
			sendJson(res, 409, { ok: false, error: 'session-running', message: 'this Session is answering right now; stop or wait for that answer, then try again', wasLive, evicted: false })
			return
		}
		const evicted = wasLive ? evictLive(ctx, sessionId) : false
		if (evicted) await delay(150)
		const bytes = await fs.readFile(backup)
		await publishLog(logFile, bytes)
		await removePath(backup)
		const verdict = await verifyStoredLog(ctx, sessionId)
		const reopened = await reopenSession(ctx, sessionId, wasLive)
		await appendReport({ event: 'host-message-undo', sessionId, ok: verdict.ok, wasLive, evicted, resumed: reopened.resumed })
		sendJson(res, verdict.ok ? 200 : 500, { ok: verdict.ok, sessionId, restored: path.basename(backup), verified: verdict.ok, message: verdict.ok ? undefined : verdict.message, wasLive, evicted, resumed: reopened.resumed, resumeError: reopened.reason })
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Answer one "prune every residue" request.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleOrphans(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	try {
		const home = resolveDshHome()
		const swept = await sweepArchived(ctx)
		// Every id that has no stored log is residue, whether or not it was archived.
		const onDisk = new Set()
		for (const slug of await fs.readdir(path.join(home, 'sessions')).catch(() => [])) {
			const dirs = await fs.readdir(path.join(home, 'sessions', slug), { withFileTypes: true }).catch(() => [])
			for (const dir of dirs) if (dir.isDirectory()) onDisk.add(dir.name)
		}
		const registryFile = path.join(home, 'storages', 'workspace.json')
		let named = []
		try {
			const parsed = JSON.parse(await fs.readFile(registryFile, 'utf8'))
			const collect = (value, into) => {
				if (Array.isArray(value)) {
					for (const item of value) collect(item, into)
					return
				}
				if (value === null || typeof value !== 'object') return
				for (const [key, item] of Object.entries(value)) {
					if (SESSION_ID.test(key) || (typeof item === 'string' && SESSION_ID.test(item))) into.add(SESSION_ID.test(key) ? key : item)
					collect(item, into)
				}
			}
			const into = new Set()
			collect(parsed, into)
			named = [...into]
		} catch {
			named = []
		}
		const removedIndexes = []
		for (const id of named) {
			if (onDisk.has(id)) continue
			const result = await scrubIndexes(home, id)
			removedIndexes.push(...result.changed)
		}
		const databases = await removeDerivedDatabases(home)
		const prunedCaches = await pruneOrphanCaches(ctx, home)
		const payload = {
			ok: true,
			home,
			swept,
			indexFiles: [...new Set(removedIndexes)],
			databases,
			prunedCaches,
			onDisk: [...onDisk].sort()
		}
		await appendReport({ event: 'host-orphans', indexes: payload.indexFiles.length, databases: databases.length, prunedCaches })
		sendJson(res, 200, payload)
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}
//#endregion

/**
 * Answer one read-only diagnostic request: which Sessions the Host still holds,
 * compared with what is actually on disk.
 *
 * The sidebar renders the Host's `session.list`, which is persisted ∪ live. A
 * Session that is still resident in the Host registry stays listed even after
 * its files are gone, which is what keeps a deleted row alive until a restart.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleDebug(ctx, req, res) {
	if (req.method !== 'GET') {
		sendJson(res, 405, { ok: false, error: 'method-not-allowed', message: 'GET only' })
		return
	}
	try {
		const home = resolveDshHome()
		const onDisk = new Set()
		const root = path.join(home, 'sessions')
		for (const slug of await fs.readdir(root).catch(() => [])) {
			const entries = await fs.readdir(path.join(root, slug), { withFileTypes: true }).catch(() => [])
			for (const entry of entries) if (entry.isDirectory()) onDisk.add(entry.name)
		}
		const live = ctx.sessions.list().map((session) => session.id).sort()
		const persisted = (await ctx.sessionPersistence.list()).map((record) => record.header.id).sort()
		const trash = await listTrash()
		sendJson(res, 200, {
			ok: true,
			home,
			live,
			persisted,
			onDisk: [...onDisk].sort(),
			trash: trash.entries.map((entry) => entry.sessionId),
			liveButNotOnDisk: live.filter((id) => !onDisk.has(id)),
			persistedButNotOnDisk: persisted.filter((id) => !onDisk.has(id))
		})
	} catch (error) {
		sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
	}
}

/**
 * Append one browser report to `<DSH_HOME>/session-delete.log` so the next
 * investigation can see what the loaded bundle actually did, and in which
 * order. The route is diagnostic only: it accepts no caller-supplied path and
 * truncates every value it keeps.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleReport(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	let body
	try {
		body = await readBody(req)
	} catch (error) {
		const tooLarge = error instanceof Error && error.message === 'body-too-large'
		sendJson(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'body-too-large' : 'bad-body' })
		return
	}
	let fields = {}
	try {
		const parsed = JSON.parse(body)
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed
	} catch {
		fields = { raw: body.slice(0, 400) }
	}
	const line = {}
	for (const [key, value] of Object.entries(fields)) {
		if (typeof value === 'string') line[key] = value.slice(0, 400)
		else if (typeof value === 'number' || typeof value === 'boolean' || value === null) line[key] = value
	}
	const written = await appendReport(line)
	sendJson(res, 200, { ok: true, logged: written })
}

/**
 * Evict one Session from the live store without touching any file.
 *
 * A repair entry point for an erase that already happened but left a row
 * behind: it is the same eviction the delete route runs, exposed so an
 * already-deleted Session can be cleared without deleting it twice.
 * @param ctx - plugin context.
 * @param req - incoming request.
 * @param res - response.
 */
async function handleEvict(ctx, req, res) {
	if (refuseForeignCaller(ctx, req, res)) return
	const body = await readJsonBody(req)
	if (!body.ok) {
		sendJson(res, body.status, { ok: false, error: body.error, message: 'expected {"sessionId":"session-..."}' })
		return
	}
	const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId : ''
	if (!SESSION_ID.test(sessionId)) {
		sendJson(res, 400, { ok: false, error: 'invalid-session', message: 'sessionId must look like session-<id>' })
		return
	}
	const live = typeof ctx.sessions?.get === 'function' && ctx.sessions.get(sessionId) !== undefined
	const evicted = live ? evictLive(ctx, sessionId) : false
	await appendReport({ event: 'evict', sessionId, live, evicted })
	sendJson(res, 200, { ok: true, sessionId, live, evicted })
}

/**
 * Mount every route, then run the start-up pass that empties the trash and
 * prunes residue left by Sessions erased in an earlier run.
 * @param ctx - plugin context carrying the web server and the registry.
 */
export function apply(ctx) {
	const routes = [
		[ROUTE_PATH, (req, res) => handleDelete(ctx, req, res), 'delete'],
		[SWEEP_PATH, (req, res) => handleSweep(ctx, req, res), 'sweep'],
		[TRASH_PATH, (req, res) => handleTrash(ctx, req, res), 'trash'],
		[TRASH_LIST_PATH, (req, res) => handleTrashList(ctx, req, res), 'trash-list'],
		[RESTORE_PATH, (req, res) => handleRestore(ctx, req, res), 'restore'],
		[RESTORE_ALL_PATH, (req, res) => handleRestoreAll(ctx, req, res), 'restore-all'],
		[TRASH_PURGE_PATH, (req, res) => handleTrashPurge(ctx, req, res), 'trash-purge'],
		[MESSAGES_PATH, (req, res) => handleMessages(ctx, req, res), 'messages'],
		[MESSAGE_DELETE_PATH, (req, res) => handleMessageDelete(ctx, req, res), 'message-delete'],
		[MESSAGE_UNDO_PATH, (req, res) => handleMessageUndo(ctx, req, res), 'message-undo'],
		[ORPHANS_PATH, (req, res) => handleOrphans(ctx, req, res), 'orphans'],
		[DEBUG_PATH, (req, res) => handleDebug(ctx, req, res), 'debug'],
		[EVICT_PATH, (req, res) => handleEvict(ctx, req, res), 'evict'],
		[REPORT_PATH, (req, res) => handleReport(ctx, req, res), 'report']
	]
	for (const [routePath, handler, label] of routes) {
		ctx.effect(
			() => ctx.webServer.register({ kind: 'exact', path: routePath, handler }),
			`session-delete: ${label} route`
		)
	}

	// The start-up pass: a trashed Session lives exactly until the next start, and
	// residue from an earlier erase is pruned once here instead of on every render.
	ctx.effect(() => {
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const purged = await purgeTrash()
					// A purged Session has no files left, so its registry records are now
					// residue: drop the ids before the sidebar reads them.
					for (const id of purged.purged) {
						if (!SESSION_ID.test(id)) continue
						await unarchiveQuietly(ctx, id)
						await scrubIndexes(purged.home, id)
					}
					const swept = await sweepArchived(ctx)
					const databases = await removeDerivedDatabases(purged.home)
					const prunedCaches = await pruneOrphanCaches(ctx, purged.home)
					await appendReport({
						event: 'host-startup-sweep',
						ok: true,
						purged: purged.purged.length,
						unarchived: swept.unarchived?.length ?? 0,
						databases: databases.length,
						prunedCaches
					})
				} catch (error) {
					ctx.logger?.warn?.(`session-delete: start-up sweep failed: ${String(error)}`)
				}
			})()
		}, 2000)
		if (typeof timer.unref === 'function') timer.unref()
		return () => clearTimeout(timer)
	}, 'session-delete: start-up sweep')
}
