/**
 * Smoke test for the Client half, without a browser.
 *
 * `client.js` is a `__ModuleLoader__` bundle, so this stubs the loader, React
 * (element factory + the four hooks it uses) and `fetch`, then calls every
 * registered component as a plain function. That catches a broken bundle, a
 * missing dictionary key, a bad slot registration, and a dialog that only
 * renders once before throwing — the failures a browser would show.
 *
 * Usage: node tools/smoke-client.mjs
 */

import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile('E:/蓝色大肥鱼正在工作/dsh-session-delete/client.js', 'utf8')

let failures = 0
function check(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`)
		return
	}
	failures += 1
	console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// --- React shim ------------------------------------------------------------
// A state cell list stands in for React's hook slots: each render restarts the
// cursor, so a re-render sees whatever the effects wrote into the cells.
let cells = []
let rerender = () => null
let cursor = 0
let effects = []
function makeReact() {
	return {
		createElement: (type, props, ...children) => ({
			type,
			props: props ?? {},
			children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
		}),
		useState: (initial) => {
			const index = cursor
			cursor += 1
			if (index >= cells.length) cells[index] = { value: typeof initial === 'function' ? initial() : initial }
			const cell = cells[index]
			return [cell.value, (next) => {
				cell.value = typeof next === 'function' ? next(cell.value) : next
			}]
		},
		useEffect: (fn) => {
			effects.push(fn)
		},
		useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useRef: (value) => ({ current: value })
	}
}

// --- loader + module -------------------------------------------------------
let loaded = null
const reloads = []
const sandbox = {
	window: {},
	document: {
		body: null,
		createElement: () => ({ setAttribute: () => {}, textContent: '', remove: () => {} }),
		head: { appendChild: () => {} },
		querySelector: () => null
	},
	console,
	setTimeout,
	clearTimeout,
	queueMicrotask,
	location: { origin: 'http://127.0.0.1:10205', pathname: '/', reload: () => reloads.push(Date.now()) }
}
sandbox.window = {
	__ModuleLoader__: {
		load: (definition) => {
			loaded = definition.factory((name) => {
				if (name === 'react') return makeReact()
				throw new Error(`unexpected require(${name})`)
			})
			loaded.__id = definition.id
		}
	},
	addEventListener: () => {},
	removeEventListener: () => {}
}
sandbox.window.document = sandbox.document
sandbox.window.location = sandbox.location

vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('bundle registered itself', loaded !== null)
const module = loaded
check('bundle id is the package id', module?.__id === 'dsh-trash-delete', module?.__id)
check('bundle injects its services', Array.isArray(module.inject) && module.inject.includes('slots'), module.inject)

// --- fetch stub ------------------------------------------------------------
const calls = []
const replies = {
	'/api/session-delete/report': { ok: true, logged: true },
	'/api/session-delete/sweep': { ok: true, unarchived: [] },
	'/api/session-delete/trash-list': { ok: true, entries: [{ sessionId: 'session-a', title: 'Old chat', movedAt: 1_700_000_000_000 }] },
	'/api/session-delete/message-delete': { ok: true, dropped: [9], remaining: 10, resumed: true },
	'/api/session-delete/trash': { ok: true, moved: [{}], title: 'Old chat' },
	'/api/session-delete/restore': { ok: true, restored: ['x'] },
	'/api/session-delete/restore-all': { ok: true, restored: ['session-a'], failed: [] },
	'/api/session-delete/trash-purge': { ok: true, purged: ['session-a'], errors: [] },
	'/api/session-delete/delete': { ok: true, removed: ['x'] }
}
sandbox.fetch = async (url, init) => {
	calls.push({ url, body: init?.body })
	const payload = replies[url] ?? { ok: false, error: 'unknown-route', message: url }
	return { ok: payload.ok === true, status: payload.ok === true ? 200 : 400, json: async () => payload }
}
sandbox.window.fetch = sandbox.fetch
globalThis.fetch = sandbox.fetch

// --- apply ----------------------------------------------------------------
const registrations = []
const dictionaries = []
const ctx = {
	effect: (fn) => fn(),
	locale: {
		register: (ns, dict) => dictionaries.push({ ns, dict }),
		translate: (ns, key, vars) => {
			const dictionary = dictionaries.find((entry) => entry.ns === ns)
			const template = dictionary?.dict.zh?.[key]
			if (template === undefined) return key
			if (vars === undefined) return template
			return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
		}
	},
	slots: {
		inject: (name, factory) => {
			const registered = factory()
			if (registered !== null && typeof registered === 'object') registrations.push({ name, ...registered })
		},
		register: (definition, component) => ({ definition, component })
	},
	uiWorkspace: {
		archiveSession: async (id) => calls.push({ url: 'uiWorkspace.archiveSession', body: id }),
		unarchiveSession: async (id) => calls.push({ url: 'uiWorkspace.unarchiveSession', body: id })
	},
	sessions: { refresh: async () => calls.push({ url: 'sessions.refresh' }) }
}

let applyError = null
try {
	module.apply(ctx)
} catch (error) {
	applyError = error
}
check('apply() ran', applyError === null, applyError === null ? undefined : String(applyError))
check('registered a dictionary', dictionaries.length === 1 && dictionaries[0].ns === 'sessionDelete', dictionaries.map((entry) => entry.ns))

const bySlot = new Map()
for (const entry of registrations) bySlot.set(entry.name, entry)

check('registered exactly three things', registrations.length === 3, registrations.map((entry) => entry.name))
check('one menu row', bySlot.has('sidebar.workspaces.session.menu.item') && registrations.filter((entry) => entry.name === 'sidebar.workspaces.session.menu.item').length === 1)
check('one per-answer action', bySlot.has('conversation.chat.assistant-actions'))
check('one overlay', bySlot.has('shell.overlay'))
check('the answer action sorts before the branch icon', bySlot.get('conversation.chat.assistant-actions')?.definition.order === 45, bySlot.get('conversation.chat.assistant-actions')?.definition.order)

const overlay = bySlot.get('shell.overlay').component
const overlaySeat = bySlot.get('shell.overlay').definition.inject()
const store = overlaySeat.store
check('overlay exposes its store', store !== null && typeof store.set === 'function')

// --- the menu row ---------------------------------------------------------
const setCalls = []
const t = (key, vars) => {
	const dictionary = dictionaries[0].dict.zh
	const template = dictionary[key]
	if (template === undefined) return key
	if (vars === undefined) return template
	return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
}
const MenuRow = bySlot.get('sidebar.workspaces.session.menu.item').component
const rowTree = MenuRow({ sessionId: 'session-a', displayTitle: 'Old chat', t, useMenuOpenState: () => [true, (next) => setCalls.push(next)] })
check('the menu row renders its label', collectText(rowTree).includes('删除会话'), collectText(rowTree))
rowTree.props.onClick()
check('the menu closes when the row is clicked', setCalls.length === 1 && setCalls[0] === false, setCalls)
check('the row opens the delete dialog', store.getSnapshot()?.kind === 'delete' && store.getSnapshot()?.sessionId === 'session-a', store.getSnapshot())

// --- the per-answer action ------------------------------------------------
const Answer = bySlot.get('conversation.chat.assistant-actions').component
const answerSeat = bySlot.get('conversation.chat.assistant-actions').definition.inject('session-a')
const answerTree = Answer({ messageId: 'msg-1', sessionId: 'session-a', t, ...answerSeat })
check('the answer action renders a button', answerTree !== null && answerTree.type === 'button', answerTree === null ? null : answerTree.type)
check('the answer action is a trash glyph', JSON.stringify(answerTree?.props).includes('删除这条回答'), answerTree?.props?.title)
answerTree.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
check('the answer action opens the message dialog', store.getSnapshot()?.kind === 'message' && store.getSnapshot()?.messageId === 'msg-1', store.getSnapshot())

// --- rendering the overlay for each dialog kind ---------------------------
async function renderKind(request, label) {
	store.set(request)
	cells = []
	effects = []
	const render = () => {
		cursor = 0
		try {
			return { tree: overlay({ store, archive: ctx.uiWorkspace.archiveSession, unarchive: ctx.uiWorkspace.unarchiveSession, refresh: ctx.sessions.refresh, t }), error: null }
		} catch (renderError) {
			return { tree: null, error: renderError }
		}
	}
	rerender = () => render().tree
	const first = render()
	check(`${label} dialog renders`, first.error === null && first.tree !== null, first.error === null ? undefined : String(first.error))
	// Run its effects (the mount sweep and the content loader) and let the
	// pending fetch promises settle, then render again so state shows up.
	for (const effect of effects) {
		try {
			effect()
		} catch (effectError) {
			check(`${label} effects run`, false, String(effectError))
		}
	}
	await new Promise((resolve) => setTimeout(resolve, 20))
	return render().tree
}

const deleteTree = await renderKind({ kind: 'delete', sessionId: 'session-a', displayTitle: 'Old chat' }, 'delete')
const deleteText = collectText(deleteTree)
check('delete dialog names its target', deleteText.includes('Old chat'), deleteText)
check('delete dialog offers the three answers', ['永久删除', '移动到回收站', '取消'].every((label) => deleteText.includes(label)), deleteText)
check('the answers are ordered erase, trash, cancel', deleteText.indexOf('永久删除') < deleteText.indexOf('移动到回收站') && deleteText.indexOf('移动到回收站') < deleteText.indexOf('取消'), deleteText)

// «移动到回收站» in the delete dialog must reach the trash route.
const trashButton = findButton(deleteTree, '移动到回收站')
trashButton?.props?.onClick?.()
await new Promise((resolve) => setTimeout(resolve, 20))
check('the delete dialog can move the session instead', calls.some((entry) => entry.url === '/api/session-delete/trash'), calls.map((entry) => entry.url))

// «永久删除» must archive first and then erase.
const eraseButton = findButton(deleteTree, '永久删除')
eraseButton?.props?.onClick?.()
await new Promise((resolve) => setTimeout(resolve, 20))
check('the delete dialog erases on demand', calls.some((entry) => entry.url === '/api/session-delete/delete') && calls.some((entry) => entry.url === 'uiWorkspace.archiveSession'), calls.map((entry) => entry.url))

const messageTree = await renderKind({ kind: 'message', sessionId: 'session-a', messageId: 'msg-1' }, 'message')
const messageText = collectText(messageTree)
check('the message dialog asks for confirmation', messageText.includes('删除这条回答？'), messageText)
const messageErase = findButton(messageTree, '删除')
messageErase?.props?.onClick?.()
await new Promise((resolve) => setTimeout(resolve, 20))
const deleteCall = calls.find((entry) => entry.url === '/api/session-delete/message-delete')
check('the message dialog sends the message id', deleteCall !== undefined && JSON.parse(deleteCall.body).messageId === 'msg-1', deleteCall?.body)
check('the message dialog reloads the page afterwards', reloads.length === 1, reloads.length)

const binTree = await renderKind({ kind: 'bin', sessionId: 'session-a' }, 'bin')
check('the bin dialog fetched the trash', calls.some((entry) => entry.url === '/api/session-delete/trash-list'))
const binText = collectText(binTree)
check('the bin dialog names its row action 还原', binText.includes('还原'), binText)
check('the bin dialog offers 清空回收站 and 还原全部会话', binText.includes('清空回收站') && binText.includes('还原全部会话'), binText)
check('the bin title carries no badge glyph', hasClass(binTree, 'sd-dialog-badge') === false, 'badge is absent')

const purgeButton = findButton(binTree, '清空回收站')
purgeButton?.props?.onClick?.()
await new Promise((resolve) => setTimeout(resolve, 10))
check('清空回收站 asks for a second click first', !calls.some((entry) => entry.url === '/api/session-delete/trash-purge'), calls.map((entry) => entry.url))
const armedTree = rerender()
const armedText = collectText(armedTree)
check('the armed label replaces the first one', armedText.includes('确认清空'), armedText)
const confirmPurge = findButton(armedTree, '确认清空')
confirmPurge?.props?.onClick?.()
await new Promise((resolve) => setTimeout(resolve, 20))
check('确认清空 empties the trash on the Host', calls.some((entry) => entry.url === '/api/session-delete/trash-purge'), calls.map((entry) => entry.url))

const restoreAllButton = findButton(binTree, '还原全部会话')
restoreAllButton?.props?.onClick?.()
await new Promise((resolve) => setTimeout(resolve, 20))
check('还原全部会话 restores every Session', calls.some((entry) => entry.url === '/api/session-delete/restore-all'), calls.map((entry) => entry.url))

store.set(null)
check('closed request renders nothing', overlay({ store, archive: async () => {}, unarchive: async () => {}, refresh: async () => {}, t }) === null)

// Every key the bundle asks for must exist in both dictionaries.
const usedKeys = [...source.matchAll(/(?<![A-Za-z0-9_$.])t\('([a-zA-Z]+\.[a-zA-Z.]+)'/g)].map((match) => match[1])
const missing = usedKeys.filter((key) => dictionaries[0].dict.zh[key] === undefined || dictionaries[0].dict.en[key] === undefined)
check('every translated key exists', missing.length === 0, [...new Set(missing)])

// --- the injected trash opener --------------------------------------------
// A second load, this time with a sidebar-shaped DOM and a ReactDOM stub, so
// the only code path the first load skipped (mountTrashButton with a real body)
// is exercised too.
{
	const searchInput = fakeElement('input')
	const searchRow = fakeElement('div')
	const searchSlot = fakeElement('div')
	const section = fakeElement('div')
	searchRow.appendChild(searchInput)
	searchSlot.appendChild(searchRow)
	section.appendChild(searchSlot)
	const body = fakeElement('body')
	body.appendChild(section)

	const documentStub = {
		body,
		head: { appendChild: () => {} },
		createElement: (tag) => fakeElement(tag),
		querySelector: (selector) => (selector === 'input[maxlength="500"]' ? searchInput : null)
	}

	const roots = []
	const sandbox2 = {
		window: {},
		document: documentStub,
		console,
		setTimeout,
		clearTimeout,
		queueMicrotask,
		location: { origin: 'http://127.0.0.1:10205', pathname: '/', reload: () => {} },
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback) => {
			callback()
			return 1
		},
		cancelAnimationFrame: () => {},
		fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, unarchived: [] }) })
	}
	let mounted = null
	sandbox2.window = {
		__ModuleLoader__: {
			load: (definition) => {
				mounted = definition.factory((name) => {
					if (name === 'react') return makeReact()
					if (name === 'react-dom/client') {
						return {
							createRoot: (host) => {
								const root = {
									render: (tree) => {
										host._tree = tree
									},
									unmount: () => {
										host._unmounted = true
									}
								}
								roots.push(root)
								return root
							}
						}
					}
					if (name === '@deepseek-ai/dsh-client-ui-primitives') {
						const shim = makeReact()
						return {
							Tooltip: (props) => shim.createElement('span', { className: 'dsw-tooltip', 'data-label': props.label }, props.children),
							IconTrashOutlineRegular: (props) => shim.createElement('svg', { className: 'dsw-icon-trash', ...props })
						}
					}
					throw new Error(`unexpected require(${name})`)
				})
			}
		},
		addEventListener: () => {},
		removeEventListener: () => {}
	}
	sandbox2.window.document = documentStub
	sandbox2.window.location = sandbox2.location
	vm.createContext(sandbox2)
	vm.runInContext(source, sandbox2, { filename: 'client.js' })

	const openerRegistrations = []
	const openerCtx = {
		effect: (fn) => fn(),
		locale: {
			register: (ns, dict) => dictionaries.push({ ns, dict }),
			translate: (ns, key) => dictionaries.find((entry) => entry.ns === ns)?.dict.zh?.[key] ?? key
		},
		slots: {
			inject: (name, factory) => {
				const registered = factory()
				if (registered !== null && typeof registered === 'object') openerRegistrations.push({ name, ...registered })
			},
			register: (definition, component) => ({ definition, component })
		},
		uiWorkspace: { archiveSession: async () => {}, unarchiveSession: async () => {} },
		sessions: { refresh: async () => {} }
	}
	let openerError = null
	try {
		mounted.apply(openerCtx)
	} catch (error) {
		openerError = error
	}
	check('the opener mounts beside the search field', openerError === null && section.children.length === 2, openerError === null ? section.children.length : String(openerError))
	const host = section.children[1]
	check('the opener lives after the search row', host !== undefined && host.className === 'sd-bin-host', host?.className)
	const openerTree = host?._tree
	check('the opener renders through React, not innerHTML', openerTree !== undefined && openerTree !== null, openerTree === undefined ? 'no tree' : typeof openerTree)
	const openerLabel = JSON.stringify(openerTree ?? {}).includes('会话回收站')
	check('the opener carries the translated label', openerLabel, JSON.stringify(openerTree ?? {}).slice(0, 200))
	check('the opener is wrapped in the app tooltip', hasClass(openerTree, 'dsw-tooltip'), 'tooltip wrapper')

	const openerButton = findNode(openerTree, (node) => node.type === 'button')
	check('the opener is a button', openerButton !== null)
	openerButton?.props?.onClick?.({ preventDefault() {}, stopPropagation() {} })
	const openerStore = openerRegistrations.find((entry) => entry.name === 'shell.overlay')?.definition.inject().store
	check('clicking the opener opens the bin dialog', openerStore?.getSnapshot()?.kind === 'bin', openerStore?.getSnapshot())
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

/** Minimal DOM node good enough for the sidebar header. */
function fakeElement(tagName) {
	const element = {
		tagName: String(tagName).toUpperCase(),
		children: [],
		parent: null,
		className: '',
		innerHTML: '',
		title: '',
		isConnected: true,
		appendChild(child) {
			child.parent = element
			element.children.push(child)
			return child
		},
		insertAdjacentElement(_where, node) {
			const parent = element.parent
			if (parent === null) return
			const index = parent.children.indexOf(element)
			node.parent = parent
			parent.children.splice(index + 1, 0, node)
		},
		remove() {
			const parent = element.parent
			if (parent === null) return
			const index = parent.children.indexOf(element)
			if (index >= 0) parent.children.splice(index, 1)
			element.isConnected = false
		},
		setAttribute() {},
		addEventListener() {},
		get parentElement() {
			return element.parent
		},
		get previousElementSibling() {
			const siblings = element.parent?.children ?? []
			const index = siblings.indexOf(element)
			return index > 0 ? siblings[index - 1] : null
		}
	}
	return element
}

/** First node in the tree matching `predicate`. */
function findNode(node, predicate) {
	if (node === null || node === undefined || typeof node !== 'object') return null
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findNode(child, predicate)
			if (hit !== null) return hit
		}
		return null
	}
	if (typeof node.type === 'function') {
		try {
			const hit = findNode(node.type(node.props), predicate)
			if (hit !== null) return hit
		} catch {
			return null
		}
	}
	if (predicate(node)) return node
	for (const child of node.children ?? []) {
		const hit = findNode(child, predicate)
		if (hit !== null) return hit
	}
	return null
}

function collectText(node) {
	if (node === null || node === undefined) return []
	if (typeof node === 'string' || typeof node === 'number') return [String(node)]
	if (Array.isArray(node)) return node.flatMap(collectText)
	if (typeof node !== 'object') return []
	// A child element whose type is a component function: call it to see its text.
	if (typeof node.type === 'function') {
		try {
			return collectText(node.type(node.props))
		} catch {
			return []
		}
	}
	const out = []
	for (const child of node.children ?? []) out.push(...collectText(child))
	return out
}

/** Whether any element in the tree carries `className`. */
function hasClass(node, className) {
	if (node === null || node === undefined || typeof node !== 'object') return false
	if (Array.isArray(node)) return node.some((child) => hasClass(child, className))
	if (typeof node.type === 'function') {
		try {
			return hasClass(node.type(node.props), className)
		} catch {
			return false
		}
	}
	if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className)) return true
	return (node.children ?? []).some((child) => hasClass(child, className))
}

/** First `button` in the tree whose own text contains `label`. */
function findButton(node, label) {
	if (node === null || node === undefined || typeof node !== 'object') return null
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findButton(child, label)
			if (hit !== null) return hit
		}
		return null
	}
	if (node.type === 'button' && collectText(node).join(' ').includes(label)) return node
	for (const child of node.children ?? []) {
		const hit = findButton(child, label)
		if (hit !== null) return hit
	}
	return null
}

