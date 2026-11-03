/**
 * dsh-trash-delete — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step). Three registrations:
 *
 *   - `sidebar.workspaces.session.menu.item` (order 500): the single row this
 *     package adds to one Session's "..." menu — «删除会话». The row only
 *     records what was asked for and closes the menu; the dialog lives in
 *     `shell.overlay` because a menu row unmounts with its menu.
 *   - `conversation.chat.assistant-actions` (order 45): a trash button in one
 *     answered turn's action row, between the feedback thumbs and the «在新对话中
 *     分支» icon, so one answer can be removed from the stored history.
 *   - `shell.overlay`: the dialogs. They call the Host half, which is the only
 *     side that touches disk.
 *
 * The Session trash has no header slot next to the workspace search box, so its
 * opener is a DOM button injected beside the search field and re-attached
 * whenever the sidebar re-renders.
 *
 * Deleting archives the Session through the public `uiWorkspace` service first
 * (`stopActivity: true`, which stops its running work and clears it from the
 * sidebar), so the Host can remove the log directory without racing a live
 * writer. Trashing does not archive: the Host evicts the live entry itself and
 * keeps the files recoverable until the next start.
 */

window.__ModuleLoader__.load({
	id: 'dsh-trash-delete',
	factory(require) {
		const React = require('react')

		/**
		 * Host UI primitives — the same `Tooltip` and icon set every built-in
		 * surface uses, so the injected and in-slot controls match the app instead
		 * of inventing their own affordances. Guarded: if this profile ever loads
		 * the bundle without the shared registry entry, the controls fall back to a
		 * plain `title` tooltip and the local glyph.
		 */
		let primitives = null
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		} catch {
			primitives = null
		}
		const Tooltip = primitives?.Tooltip
		const IconTrash = primitives?.IconTrashOutlineRegular
		const IconArchive = primitives?.IconArchiveOutlineRegular
		const IconUnarchive = primitives?.IconUnarchiveOutlineRegular

		/** Wrap a control in the app's tooltip, or leave it bare without primitives. */
		const withTooltip = (label, child) => (Tooltip === undefined ? child : h(Tooltip, { label, side: 'bottom', delayMs: 300 }, child))

		/** Element factory (no JSX transformation here). */
		const h = React.createElement

		/** Locale namespace of this package's Client half. */
		const NS = 'sessionDelete'

		/** Exact route that erases one Session from disk. */
		const ROUTE = '/api/session-delete/delete'

		/** Route that prunes registry records whose session files are already gone. */
		const SWEEP = '/api/session-delete/sweep'

		/** Route that appends this page's own report to a Host-side log. */
		const REPORT = '/api/session-delete/report'

		/** Route that moves one Session into the trash. */
		const TRASH = '/api/session-delete/trash'

		/** Route that lists the trashed Sessions. */
		const TRASH_LIST = '/api/session-delete/trash-list'

		/** Route that moves one trashed Session back. */
		const RESTORE = '/api/session-delete/restore'

		/** Route that moves every trashed Session back. */
		const RESTORE_ALL = '/api/session-delete/restore-all'

		/** Route that empties the trash right now. */
		const TRASH_PURGE = '/api/session-delete/trash-purge'

		/** Route that removes one message from a Session log. */
		const MESSAGE_DELETE = '/api/session-delete/message-delete'

		/** Build marker: the Host log shows which bundle a page really runs. */
		const BUILD = 'v12-answer-delete'

		/** Id of the injected trash opener, so a second mount can find itself. */
		const TRASH_BUTTON_ID = 'sd-trash-trigger'

		/** One self-healing sweep per page load, not per mount. */
		let swept = false

		/**
		 * Tell the Host half what this page did, so a failure can be diagnosed
		 * from disk instead of from the browser console.
		 * @param event - step name.
		 * @param extra - small serialisable details.
		 */
		function report(event, extra) {
			try {
				fetch(REPORT, {
					method: 'POST',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json'
					},
					credentials: 'same-origin',
					body: JSON.stringify({ event, build: BUILD, ...(extra ?? {}) })
				}).catch(() => {})
			} catch {
				// Reporting must never break the action itself.
			}
		}

		/**
		 * POST one JSON body and return the decoded payload, refusing an error.
		 * @param url - exact route of the Host half.
		 * @param body - JSON-serialisable request.
		 * @returns the payload object.
		 */
		async function postJson(url, body) {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/json'
				},
				credentials: 'same-origin',
				body: JSON.stringify(body ?? {})
			})
			const payload = await response.json().catch(() => null)
			if (!response.ok || payload === null || payload.ok !== true) {
				const detail = payload !== null && typeof payload.message === 'string' && payload.message !== ''
					? payload.message
					: payload !== null && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
				throw new Error(detail)
			}
			return payload
		}

		const zh = {
			'menu.delete': '删除会话',
			'menu.deleteHint': '删除或移入回收站',
			'menu.trashLabel': '移动到回收站',

			'dialog.title': '删除这个会话？',
			'dialog.body': '它里面的全部内容都会一起消失：',
			'dialog.warning': '【永久删除】会立刻从磁盘上抹掉会话的全部消息记录、工具调用与本地缓存，无法撤销、无法恢复。',
			'dialog.note': '【移动到回收站】只是先移开，下次启动 Harness 时才会真正删除；在那之前可以还原。',
			'dialog.cancel': '取消',
			'dialog.confirm': '永久删除',
			'dialog.deleting': '删除中…',
			'dialog.failed': '删除失败：{reason}',
			'dialog.failedErase': '会话已从列表移除，但磁盘文件未能删除：{reason}',

			'trash.busy': '移动中…',
			'trash.failed': '移动失败：{reason}',
			'trash.recoverable': '已移入回收站。下次启动 Harness 前可以还原。',

			'bin.trigger': '会话回收站',
			'bin.title': '会话回收站',
			'bin.body': '这些会话将在下次启动 Harness 时被删除。',
			'bin.empty': '回收站是空的。',
			'bin.loading': '读取中…',
			'bin.restore': '还原',
			'bin.restoring': '还原中…',
			'bin.restoreFailed': '还原失败：{reason}',
			'bin.restored': '已还原。刷新后即可在侧栏看到它。',
			'bin.restoreAll': '还原全部会话',
			'bin.restoreAllBusy': '还原中…',
			'bin.restoreAllDone': '已还原 {count} 个会话。刷新后即可在侧栏看到它们。',
			'bin.purge': '清空回收站',
			'bin.purgeArmedLabel': '确认清空',
			'bin.purgeArm': '再点一次「确认清空」就会永久删除这些会话，之后无法还原。',
			'bin.purging': '清空中…',
			'bin.purged': '已永久删除 {count} 个会话，不可再还原。',
			'bin.purgeFailed': '清空失败：{reason}',
			'dialog.done': '完成',

			'msg.action': '删除这条回答',
			'msg.title': '删除这条回答？',
			'msg.body': '它会从这个会话的历史记录里真正移除，界面上的这一段也随之消失：',
			'msg.warning': '这次回答连同它调用的工具记录会一起删掉。删完页面会自动重新载入。',
			'msg.confirm': '删除',
			'msg.deleting': '删除中…',
			'msg.failed': '删除失败：{reason}',
			'msg.running': '这个会话正在回答中，等它结束后再试。'
		}

		const en = {
			'menu.delete': 'Delete session',
			'menu.deleteHint': 'Delete it, or move it to the trash',
			'menu.trashLabel': 'Move to trash',

			'dialog.title': 'Delete this session?',
			'dialog.body': 'Everything inside it goes away with it:',
			'dialog.warning': '«Delete permanently» erases every message, tool call and local cache file of this session from disk. It cannot be undone.',
			'dialog.note': '«Move to trash» only sets it aside: the next Harness start deletes it, and until then it can be restored.',
			'dialog.cancel': 'Cancel',
			'dialog.confirm': 'Delete permanently',
			'dialog.deleting': 'Deleting…',
			'dialog.failed': 'Delete failed: {reason}',
			'dialog.failedErase': 'The session left the list, but its files could not be erased: {reason}',

			'trash.busy': 'Moving…',
			'trash.failed': 'Move failed: {reason}',
			'trash.recoverable': 'Moved to the trash. Restore it before the next Harness start.',

			'bin.trigger': 'Session trash',
			'bin.title': 'Session trash',
			'bin.body': 'These sessions are deleted the next time Harness starts.',
			'bin.empty': 'The trash is empty.',
			'bin.loading': 'Loading…',
			'bin.restore': 'Restore',
			'bin.restoring': 'Restoring…',
			'bin.restoreFailed': 'Restore failed: {reason}',
			'bin.restored': 'Restored. Reload to see it in the sidebar.',
			'bin.restoreAll': 'Restore all sessions',
			'bin.restoreAllBusy': 'Restoring…',
			'bin.restoreAllDone': 'Restored {count} sessions. Reload to see them in the sidebar.',
			'bin.purge': 'Empty trash',
			'bin.purgeArmedLabel': 'Confirm empty',
			'bin.purgeArm': 'One more click on «Confirm empty» permanently deletes these sessions. They cannot be restored afterwards.',
			'bin.purging': 'Emptying…',
			'bin.purged': 'Permanently deleted {count} sessions. They cannot be restored.',
			'bin.purgeFailed': 'Could not empty the trash: {reason}',
			'dialog.done': 'Done',

			'msg.action': 'Delete this answer',
			'msg.title': 'Delete this answer?',
			'msg.body': 'It is really removed from this session history, and this stretch of the conversation disappears with it:',
			'msg.warning': 'The answer and the tool records it made are removed together. The page reloads when it is done.',
			'msg.confirm': 'Delete',
			'msg.deleting': 'Deleting…',
			'msg.failed': 'Delete failed: {reason}',
			'msg.running': 'This session is answering right now — try again when it finishes.'
		}

		/**
		 * Minimal observable store for the pending dialog request. React reads it
		 * through `useSyncExternalStore`, so the dialog re-renders on every request
		 * without this package depending on the shared store module.
		 * @param initial - initial snapshot.
		 */
		function createStore(initial) {
			let value = initial
			const listeners = new Set()
			return {
				getSnapshot: () => value,
				set: (next) => {
					value = next
					for (const listener of Array.from(listeners)) listener()
				},
				subscribe: (listener) => {
					listeners.add(listener)
					return () => {
						listeners.delete(listener)
					}
				}
			}
		}

		/** The dialog request awaiting an answer, or null. */
		const pending = createStore(null)

		/** Message of any thrown value. */
		function reasonOf(error) {
			if (error instanceof Error) return error.message
			const text = String(error)
			return text === '' ? 'unknown error' : text
		}

		/** Trash glyph. */
		function trashIcon(size, className) {
			return h('svg', {
				viewBox: '0 0 16 16',
				width: size,
				height: size,
				className,
				'aria-hidden': 'true',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round'
			},
			h('path', { d: 'M2.6 4.3h10.8' }),
			h('path', { d: 'M6.3 4.3V3.1h3.4v1.2' }),
			h('path', { d: 'M4.1 4.3l.6 8.2a1.5 1.5 0 0 0 1.5 1.4h3.6a1.5 1.5 0 0 0 1.5-1.4l.6-8.2' }),
			h('path', { d: 'M6.9 6.8v4.2M9.1 6.8v4.2' }))
		}

		/** Archive-box glyph: move aside, not destroy. */
		function boxIcon(size, className) {
			return h('svg', {
				viewBox: '0 0 16 16',
				width: size,
				height: size,
				className,
				'aria-hidden': 'true',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round'
			},
			h('path', { d: 'M2.2 5.4h11.6v7.3a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2z' }),
			h('path', { d: 'M1.6 2.4h12.8v3H1.6z' }),
			h('path', { d: 'M6.4 8.4h3.2' }))
		}

		/** Two stacked frames glyph for the trash bin. */
		function stackIcon(size, className) {
			return h('svg', {
				viewBox: '0 0 16 16',
				width: size,
				height: size,
				className,
				'aria-hidden': 'true',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round'
			},
			h('path', { d: 'M2.4 9.8h11.2v2.9a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2z' }),
			h('path', { d: 'M3.4 6.2h9.2v2.4H3.4z' }),
			h('path', { d: 'M4.4 2.1h7.2v2.3H4.4z' }))
		}

		/**
		 * Close the row menu through whatever shape its open-state pair has. The
		 * shipped rows destructure `[open, setOpen]`, so the tuple form is the
		 * normal one; the other accessors are cheap insurance if that changes.
		 * @param menu - value returned by the injected `useMenuOpenState` hook.
		 */
		function closeMenu(menu) {
			if (menu === null || menu === undefined) return
			if (Array.isArray(menu)) {
				if (typeof menu[1] === 'function') menu[1](false)
				return
			}
			if (typeof menu.close === 'function') {
				menu.close()
				return
			}
			if (typeof menu.setOpen === 'function') {
				menu.setOpen(false)
				return
			}
			if (typeof menu.dismiss === 'function') menu.dismiss()
		}

		/**
		 * The one `sidebar.workspaces.session.menu.item` row this package adds.
		 * @param props - the Session it belongs to plus the menu's open state.
		 * @returns the row.
		 */
		function DeleteSessionMenuItem(props) {
			const { sessionId, displayTitle, t } = props
			const menu = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : null
			return h('button', {
				type: 'button',
				role: 'menuitem',
				className: 'sd-menu-row sd-menu-row-danger',
				title: t('menu.deleteHint'),
				onClick: () => {
					closeMenu(menu)
					pending.set({
						kind: 'delete',
						sessionId,
						displayTitle: displayTitle === '' || displayTitle === undefined ? sessionId : displayTitle
					})
				}
			}, h('span', { className: 'sd-menu-icon', 'aria-hidden': 'true' }, IconTrash === undefined ? trashIcon(15) : h(IconTrash, { width: 15, height: 15 })), h('span', null, t('menu.delete')))
		}

		/**
		 * The trash button in one answered turn's action row. It sits before the
		 * «在新对话中分支» icon because `extraActions` is rendered there.
		 * @param props - the answered turn's final assistant `messageId`, plus the
		 *   seam injected by `register`.
		 * @returns the button.
		 */
		function DeleteAnswerAction(props) {
			const { messageId, sessionId, ask, t } = props
			if (typeof messageId !== 'string' || messageId === '') return null
			return withTooltip(t('msg.action'), h('button', {
				type: 'button',
				className: 'sd-icon-button',
				'aria-label': t('msg.action'),
				onClick: (event) => {
					event.preventDefault()
					event.stopPropagation()
					ask(messageId)
				}
			}, IconTrash === undefined ? trashIcon(15) : h(IconTrash, { width: 15, height: 15, 'aria-hidden': 'true' })))
		}

		/**
		 * The `shell.overlay` dialog family. One overlay renders whichever dialog
		 * the pending request names; the request identity resets busy and error
		 * state, so switching requests never inherits a previous message.
		 * @param props - the pending store, the archive hop, the catalog refresh,
		 *   and the locale seat.
		 * @returns the dialog, or null.
		 */
		function SessionDeleteDialog(props) {
			const { store, archive, unarchive, refresh, t } = props
			const request = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState(null)
			const [notice, setNotice] = React.useState(null)
			const [loading, setLoading] = React.useState(false)
			const [bin, setBin] = React.useState(null)
			// Emptying the trash is irreversible, so the first click only arms it.
			const [purgeArmed, setPurgeArmed] = React.useState(false)
			const open = request !== null
			const kind = request === null ? '' : request.kind

			React.useEffect(() => {
				setBusy(false)
				setError(null)
				setNotice(null)
				setBin(null)
				setPurgeArmed(false)
			}, [request])

			// Self-healing pass, once per page load: an id left in the registry whose
			// files are gone, and a Session row this page still lists although its
			// files are gone (the catalog is pulled once at connect).
			React.useEffect(() => {
				if (swept) return
				swept = true
				report('mount', { href: `${location.origin}${location.pathname}` })
				postJson(SWEEP, {})
					.then(async (payload) => {
						const pruned = Array.isArray(payload.unarchived) ? payload.unarchived : []
						report('sweep', { ok: true, pruned: pruned.length })
						if (pruned.length > 0) {
							console.info('session-delete: pruned stale registry records', pruned)
							for (const id of pruned) {
								try {
									await unarchive(id)
								} catch (unarchiveError) {
									console.warn('session-delete: unarchive rejected:', unarchiveError)
								}
							}
						}
						try {
							await refresh()
							report('refreshed', { ok: true, stage: 'sweep' })
						} catch (refreshError) {
							report('refreshed', { ok: false, stage: 'sweep', error: reasonOf(refreshError) })
						}
					})
					.catch((sweepError) => report('sweep', { ok: false, error: reasonOf(sweepError) }))
			}, [])

			// The bin is the only dialog that needs Host content up front.
			React.useEffect(() => {
				if (!open || kind !== 'bin') return undefined
				let cancelled = false
				setLoading(true)
				postJson(TRASH_LIST, {})
					.then((payload) => {
						if (!cancelled) setBin(Array.isArray(payload.entries) ? payload.entries : [])
					})
					.catch((loadError) => {
						if (!cancelled) setError(t('bin.restoreFailed', { reason: reasonOf(loadError) }))
					})
					.finally(() => {
						if (!cancelled) setLoading(false)
					})
				return () => {
					cancelled = true
				}
			}, [open, kind, request])

			React.useEffect(() => {
				if (!open) return undefined
				const onKeyDown = (event) => {
					if (event.key !== 'Escape' || busy) return
					event.preventDefault()
					event.stopPropagation()
					store.set(null)
				}
				window.addEventListener('keydown', onKeyDown, true)
				return () => window.removeEventListener('keydown', onKeyDown, true)
			}, [open, busy, store])

			if (!open) return null

			const close = () => {
				if (busy) return
				store.set(null)
			}

			const afterWrite = async (stage) => {
				try {
					await refresh()
					report('refreshed', { ok: true, stage })
				} catch (refreshError) {
					report('refreshed', { ok: false, stage, error: reasonOf(refreshError) })
				}
			}

			/** Erase the Session: archive, erase from disk, drop the registry row. */
			const submitDelete = async () => {
				if (busy) return
				const target = request
				setBusy(true)
				setError(null)
				let archived = false
				report('confirm', { sessionId: target.sessionId })
				try {
					await archive(target.sessionId)
					archived = true
					report('archived', { ok: true })
				} catch (archiveError) {
					report('archived', { ok: false, error: reasonOf(archiveError) })
				}
				try {
					const payload = await postJson(ROUTE, { sessionId: target.sessionId })
					report('erased', { ok: true, removed: Array.isArray(payload.removed) ? payload.removed.length : 0 })
					try {
						await unarchive(target.sessionId)
						report('unarchived', { ok: true })
					} catch (unarchiveError) {
						report('unarchived', { ok: false, error: reasonOf(unarchiveError) })
					}
					await afterWrite('submit')
					store.set(null)
				} catch (eraseError) {
					setBusy(false)
					setError(t(archived ? 'dialog.failedErase' : 'dialog.failed', { reason: reasonOf(eraseError) }))
				}
			}

			/** Move the Session into the trash instead of erasing it. */
			const submitTrash = async () => {
				if (busy) return
				const target = request
				setBusy(true)
				setError(null)
				report('trash', { sessionId: target.sessionId })
				try {
					const payload = await postJson(TRASH, { sessionId: target.sessionId })
					report('trashed', { ok: true, moved: payload.moved === undefined ? 0 : payload.moved.length })
					await afterWrite('trash')
					store.set(null)
					setNotice(t('trash.recoverable'))
				} catch (trashError) {
					setBusy(false)
					setError(t('trash.failed', { reason: reasonOf(trashError) }))
				}
			}

			/** Remove one answered turn from the stored log. */
			const submitMessage = async () => {
				if (busy) return
				const target = request
				setBusy(true)
				setError(null)
				report('answer-delete', { sessionId: target.sessionId, messageId: target.messageId })
				try {
					const payload = await postJson(MESSAGE_DELETE, { sessionId: target.sessionId, messageId: target.messageId })
					report('answer-deleted', { ok: true, dropped: Array.isArray(payload.dropped) ? payload.dropped.length : 0, resumed: payload.resumed === true })
					// The transcript a page shows is append-only local state, and the Host
					// reopened this Session on the rewritten log, so a reload is what makes
					// the removed answer disappear for sure.
					location.reload()
				} catch (removeError) {
					setBusy(false)
					const reason = reasonOf(removeError)
					setError(t(reason === 'session-running' || reason.includes('answering') ? 'msg.running' : 'msg.failed', { reason }))
				}
			}

			/** Put one trashed Session back. */
			const restoreOne = async (entry) => {
				if (busy) return
				setBusy(true)
				setError(null)
				report('restore', { sessionId: entry.sessionId })
				try {
					await postJson(RESTORE, { sessionId: entry.sessionId })
					const payload = await postJson(TRASH_LIST, {})
					setBin(Array.isArray(payload.entries) ? payload.entries : [])
					setNotice(t('bin.restored'))
					await afterWrite('restore')
				} catch (restoreError) {
					setError(t('bin.restoreFailed', { reason: reasonOf(restoreError) }))
				} finally {
					setBusy(false)
				}
			}

			/** Put every trashed Session back at once. */
			const restoreAll = async () => {
				if (busy) return
				setBusy(true)
				setError(null)
				report('restore-all', {})
				try {
					const payload = await postJson(RESTORE_ALL, {})
					const restored = Array.isArray(payload.restored) ? payload.restored.length : 0
					setBin([])
					setNotice(t('bin.restoreAllDone', { count: String(restored) }))
					await afterWrite('restore-all')
				} catch (restoreError) {
					setError(t('bin.restoreFailed', { reason: reasonOf(restoreError) }))
				} finally {
					setBusy(false)
				}
			}

			/** Empty the trash now instead of at the next start. Two clicks: arm, then empty. */
			const purgeAll = async () => {
				if (busy) return
				if (!purgeArmed) {
					setPurgeArmed(true)
					setNotice(t('bin.purgeArm'))
					return
				}
				setBusy(true)
				setError(null)
				report('trash-purge', {})
				try {
					const payload = await postJson(TRASH_PURGE, {})
					const purged = Array.isArray(payload.purged) ? payload.purged.length : 0
					setBin([])
					setPurgeArmed(false)
					setNotice(t('bin.purged', { count: String(purged) }))
					await afterWrite('trash-purge')
				} catch (purgeError) {
					setError(t('bin.purgeFailed', { reason: reasonOf(purgeError) }))
				} finally {
					setBusy(false)
				}
			}

			const titles = { delete: 'dialog.title', bin: 'bin.title', message: 'msg.title' }
			const bodies = { delete: 'dialog.body', bin: 'bin.body', message: 'msg.body' }
			const warnings = { delete: 'dialog.warning', bin: null, message: 'msg.warning' }
			const notes = { delete: 'dialog.note', bin: null, message: null }
			const badge = kind === 'bin' ? null : IconTrash === undefined ? trashIcon(18) : h(IconTrash, { width: 18, height: 18, 'aria-hidden': 'true' })

			let content
			if (kind === 'bin') {
				const entries = bin === null ? [] : bin
				content = [
					loading && bin === null ? h('p', { className: 'sd-dialog-note', key: 'loading' }, t('bin.loading')) : null,
					bin !== null && entries.length === 0 ? h('p', { className: 'sd-dialog-note', key: 'empty' }, t('bin.empty')) : null,
					entries.length > 0
						? h('div', { className: 'sd-msg-list', key: 'list' },
							entries.map((entry) => h('div', { className: 'sd-msg-row', key: entry.sessionId },
								h('span', { className: 'sd-msg-role' }, IconArchive === undefined ? boxIcon(13) : h(IconArchive, { width: 13, height: 13, 'aria-hidden': 'true' })),
								h('div', { className: 'sd-msg-main' },
									h('p', { className: 'sd-msg-text' }, entry.title === '' ? entry.sessionId : entry.title),
									h('p', { className: 'sd-msg-meta' }, entry.movedAt > 0 ? new Date(entry.movedAt).toLocaleString() : entry.sessionId)),
								h('button', {
									type: 'button',
									className: 'sd-button sd-button-small',
									disabled: busy,
									onClick: () => restoreOne(entry)
								}, t('bin.restore')))))
						: null
				]
			} else if (kind === 'message') {
				content = []
			} else {
				content = [h('p', { className: 'sd-dialog-target', key: 'target' }, request.displayTitle)]
			}

			// «删除会话» asks which kind of removal: permanent first, then the
			// recoverable move, then cancel.
			let actions
			if (kind === 'delete') {
				actions = [
					h('button', {
						type: 'button',
						className: 'sd-button sd-button-danger',
						key: 'erase',
						disabled: busy,
						onClick: submitDelete
					}, t(busy ? 'dialog.deleting' : 'dialog.confirm')),
					h('button', {
						type: 'button',
						className: 'sd-button',
						key: 'trash',
						disabled: busy,
						onClick: submitTrash
					}, t(busy ? 'trash.busy' : 'menu.trashLabel')),
					h('button', {
						type: 'button',
						className: 'sd-button',
						key: 'cancel',
						disabled: busy,
						onClick: close
					}, t('dialog.cancel'))
				]
			} else if (kind === 'message') {
				actions = [
					h('button', {
						type: 'button',
						className: 'sd-button sd-button-danger',
						key: 'erase',
						disabled: busy,
						onClick: submitMessage
					}, t(busy ? 'msg.deleting' : 'msg.confirm')),
					h('button', {
						type: 'button',
						className: 'sd-button',
						key: 'cancel',
						disabled: busy,
						onClick: close
					}, t('dialog.cancel'))
				]
			} else {
				actions = [
					h('button', {
						type: 'button',
						className: 'sd-button sd-button-danger',
						key: 'purge',
						disabled: busy || (bin !== null && bin.length === 0),
						onClick: purgeAll
					}, t(busy ? 'bin.purging' : purgeArmed ? 'bin.purgeArmedLabel' : 'bin.purge')),
					h('button', {
						type: 'button',
						className: 'sd-button',
						key: 'restoreAll',
						disabled: busy || (bin !== null && bin.length === 0),
						onClick: restoreAll
					}, t(busy ? 'bin.restoreAllBusy' : 'bin.restoreAll')),
					h('button', {
						type: 'button',
						className: 'sd-button',
						key: 'close',
						disabled: busy,
						autoFocus: true,
						onClick: close
					}, t('dialog.done'))
				]
			}

			return h('div', {
				className: 'sd-backdrop',
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) close()
				}
			}, h('div', {
				className: kind === 'bin' ? 'sd-dialog sd-dialog-wide' : 'sd-dialog',
				role: 'dialog',
				'aria-modal': 'true',
				'aria-labelledby': 'sd-dialog-title',
				'aria-describedby': 'sd-dialog-warning'
			},
			h('div', { className: 'sd-dialog-head' },
				badge === null ? null : h('span', { className: 'sd-dialog-badge', 'aria-hidden': 'true' }, badge),
				h('div', { className: 'sd-dialog-heading' },
					h('h2', { className: 'sd-dialog-title', id: 'sd-dialog-title' }, t(titles[kind])),
					h('p', { className: 'sd-dialog-body' }, t(bodies[kind])))),
			...content,
			warnings[kind] === null ? null : h('p', { className: 'sd-dialog-warning', id: 'sd-dialog-warning' }, t(warnings[kind])),
			error === null ? null : h('p', { className: 'sd-dialog-error', role: 'alert' }, error),
			notice === null ? null : h('p', { className: 'sd-dialog-notice', role: 'status' }, notice),
			notes[kind] === null || notes[kind] === undefined ? null : h('p', { className: 'sd-dialog-note' }, t(notes[kind])),
			h('div', { className: 'sd-dialog-actions' }, ...actions)))
		}

		/** Markup of the injected trash opener; fixed, so no escaping is needed. */
		const TRASH_BUTTON_MARKUP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 4.3h10.8"/><path d="M6.3 4.3V3.1h3.4v1.2"/><path d="M4.1 4.3l.6 8.2a1.5 1.5 0 0 0 1.5 1.4h3.6a1.5 1.5 0 0 0 1.5-1.4l.6-8.2"/><path d="M6.9 6.8v4.2M9.1 6.8v4.2"/></svg>'

		let createRoot = null
		try {
			createRoot = require('react-dom/client').createRoot
		} catch {
			createRoot = null
		}

		/**
		 * The trash opener itself: the app's icon button, the app's glyph, and the
		 * app's tooltip, so it reads as part of the sidebar header rather than as an
		 * injected foreign control.
		 * @param props - label and click handler.
		 * @returns the button element.
		 */
		const TrashOpenerButton = (props) =>
			withTooltip(props.label, h('button', {
				type: 'button',
				id: TRASH_BUTTON_ID,
				className: 'sd-bin-trigger',
				'aria-label': props.label,
				onClick: (event) => {
					event.preventDefault()
					event.stopPropagation()
					props.openBin()
				}
			}, IconTrash === undefined ? trashIcon(15) : h(IconTrash, { width: 15, height: 15, 'aria-hidden': 'true' })))

		/**
		 * Keep one trash opener attached beside the workspace search field. The
		 * sidebar header declares no slot there, so this injects a button after the
		 * search row and re-attaches it whenever the sidebar re-renders.
		 * @param label - accessible name and tooltip.
		 * @param openBin - what a click does.
		 * @returns disposer that removes the button and stops observing.
		 */
		function mountTrashButton(label, openBin) {
			if (typeof document === 'undefined' || document.body === null) return () => {}
			let host = null
			let root = null
			let frame = 0

			/**
			 * The search field is the only text input with the query length limit, and
			 * the row that owns it is the anchor this button sits after.
			 * @returns the element to insert after, or null while the sidebar is closed.
			 */
			const anchorOf = () => {
				const input = document.querySelector('input[maxlength="500"]')
				if (input === null) return null
				const row = input.parentElement
				if (row === null) return null
				return row.parentElement === null ? row : row.parentElement
			}

			const ensure = () => {
				const anchor = anchorOf()
				if (anchor === null) {
					if (host !== null && host.isConnected) {
						if (root !== null) root.unmount()
						root = null
						host.remove()
						host = null
					}
					return
				}
				if (host === null) {
					host = document.createElement('div')
					host.className = 'sd-bin-host'
					if (createRoot === null) {
						// No renderer available: fall back to plain markup.
						const button = document.createElement('button')
						button.type = 'button'
						button.id = TRASH_BUTTON_ID
						button.className = 'sd-bin-trigger'
						button.title = label
						button.setAttribute('aria-label', label)
						button.innerHTML = TRASH_BUTTON_MARKUP
						button.addEventListener('click', (event) => {
							event.preventDefault()
							event.stopPropagation()
							openBin()
						})
						host.appendChild(button)
					} else {
						root = createRoot(host)
						root.render(h(TrashOpenerButton, { label, openBin }))
					}
				}
				if (host.isConnected && host.previousElementSibling === anchor) return
				anchor.insertAdjacentElement('afterend', host)
			}

			const schedule = () => {
				if (frame !== 0) return
				frame = requestAnimationFrame(() => {
					frame = 0
					ensure()
				})
			}

			ensure()
			const observer = new MutationObserver(schedule)
			observer.observe(document.body, { childList: true, subtree: true })
			return () => {
				observer.disconnect()
				if (frame !== 0) cancelAnimationFrame(frame)
				if (root !== null) root.unmount()
				root = null
				if (host !== null) host.remove()
			}
		}

		/** Stylesheet of every registration, injected once and dropped with the run. */
		const STYLES = `
@keyframes sd-veil-in{from{opacity:0}to{opacity:1}}
@keyframes sd-panel-in{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.sd-menu-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.25;text-align:left;cursor:pointer}
.sd-menu-row-danger{color:var(--dsw-alias-state-error-primary)}
.sd-menu-row:hover,.sd-menu-row:focus-visible{background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06));outline:none}
.sd-menu-icon{flex:none;opacity:.95}
/* While searching, the Host lets the search field take the whole header row and fades
   the trailing header actions out. Step aside the same way instead of overlapping the
   field: the opener collapses to nothing and comes back when the search closes. */
[class*="searchSlotExpanded"] + .sd-bin-host{max-width:0;opacity:0;visibility:hidden;pointer-events:none;margin-left:0;overflow:hidden;transition:max-width .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), visibility 0s linear .18s, margin-left .18s var(--ds-ease-in-out)}
.sd-bin-host{display:inline-flex;align-items:center;flex:none;height:28px;margin-left:2px;max-width:34px;transition:max-width .18s var(--ds-ease-in-out), opacity .12s var(--ds-ease-in-out), visibility 0s linear 0s, margin-left .18s var(--ds-ease-in-out)}
.sd-bin-trigger{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;vertical-align:middle}
.sd-bin-trigger:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.08));color:var(--dsw-alias-label-primary)}
.sd-bin-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sd-icon-button{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta, 0px));height:calc(28px + var(--dsh-content-font-delta, 0px));padding:6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.sd-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.08));color:var(--dsw-alias-label-primary)}
.sd-icon-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sd-backdrop{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.38);background:color-mix(in oklab, var(--dsw-alias-bg-mask-3) 82%, transparent);backdrop-filter:blur(2px);animation:sd-veil-in 140ms ease-out}
.sd-dialog{width:min(452px,100%);box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:22px 22px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent, 0 0 0 .5px var(--dsw-alias-border-l2)),0 24px 56px -20px #00000033;font-size:13px;line-height:1.6;animation:sd-panel-in 170ms cubic-bezier(.2,.8,.3,1)}
.sd-dialog-wide{width:min(620px,100%)}
.sd-dialog-head{display:flex;align-items:flex-start;gap:12px}
.sd-dialog-badge{flex:none;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:11px;background:color-mix(in oklab, var(--dsw-alias-brand-primary) 13%, transparent);color:var(--dsw-alias-brand-primary)}
.sd-dialog-heading{display:flex;flex-direction:column;gap:3px;min-width:0}
.sd-dialog-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.sd-dialog-body{margin:0;color:var(--dsw-alias-label-secondary)}
.sd-dialog-target{margin:0;padding:9px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600;word-break:break-word}
.sd-dialog-warning{margin:0;padding:10px 12px;border-radius:11px;border:1px solid color-mix(in oklab, var(--dsw-alias-state-error-primary) 26%, transparent);background:color-mix(in oklab, var(--dsw-alias-state-error-primary) 8%, transparent);color:var(--dsw-alias-label-secondary)}
.sd-dialog-error{margin:0;padding:9px 12px;border-radius:11px;background:color-mix(in oklab, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}
.sd-dialog-notice{margin:0;padding:9px 12px;border-radius:11px;background:color-mix(in oklab, var(--dsw-alias-brand-primary) 9%, transparent);color:var(--dsw-alias-label-secondary)}
.sd-dialog-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;opacity:.85}
.sd-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:2px;flex-wrap:wrap}
.sd-msg-list{display:flex;flex-direction:column;gap:6px;max-height:min(46vh,380px);overflow:auto;padding-right:2px}
.sd-msg-row{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.sd-msg-role{flex:none;display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:2px 7px;border-radius:999px;background:color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent);color:var(--dsw-alias-brand-primary)}
.sd-msg-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sd-msg-text{margin:0;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.sd-msg-meta{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.sd-button{font:inherit;font-size:13px;padding:8px 16px;border-radius:10px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);transition:background-color 120ms ease, border-color 120ms ease, filter 120ms ease}
.sd-button:hover{background:var(--dsw-alias-bg-layer-2)}
.sd-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sd-button:disabled{opacity:.55;cursor:default}
.sd-button-small{flex:none;padding:4px 10px;font-size:12px;border-radius:8px}
.sd-button.sd-button-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.sd-button.sd-button-small.sd-button-danger{background:transparent;border-color:color-mix(in oklab, var(--dsw-alias-state-error-primary) 40%, transparent);color:var(--dsw-alias-state-error-primary)}
.sd-button.sd-button-danger:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);filter:brightness(1.08)}
.sd-button.sd-button-danger:focus-visible{outline-color:var(--dsw-alias-state-error-primary);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.sd-backdrop,.sd-dialog{animation:none}}
`

		return {
			/** Client services this half needs. */
			inject: ['slots', 'locale', 'uiWorkspace', 'sessions'],
			/**
			 * Register the dictionary, the stylesheet, the menu row, the per-answer
			 * action, the dialogs, and the trash opener.
			 * @param ctx - Client root context.
			 */
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-delete: dictionaries')
				ctx.effect(() => {
					const style = document.createElement('style')
					style.setAttribute('data-dsh-session-delete', '')
					style.textContent = STYLES
					document.head.appendChild(style)
					return () => {
						style.remove()
					}
				}, 'session-delete: styles')

				const translate = (key, params) => ctx.locale.translate(NS, key, params)
				const archive = (sessionId) => ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })
				const unarchive = (sessionId) => ctx.uiWorkspace.unarchiveSession(sessionId)
				// Re-pull the authoritative Session baseline. `session.list` reads
				// persistence, so a Session whose files are gone drops out of the
				// catalog — and out of the sidebar — without an app restart.
				const refresh = () => ctx.sessions.refresh()

				ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
					name: 'sidebar.workspaces.session.menu.item',
					id: 'session-delete-delete',
					order: 500,
					locale: NS
				}, DeleteSessionMenuItem))

				// `extraActions` renders between the copy button and the «在新对话中分支»
				// icon; the thumbs of the feedback package hold order 10.
				ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
					name: 'conversation.chat.assistant-actions',
					id: 'session-delete-answer',
					order: 45,
					locale: NS,
					inject: (sessionId) => ({ ask: (messageId) => pending.set({ kind: 'message', sessionId, messageId }) })
				}, DeleteAnswerAction))

				ctx.slots.inject('shell.overlay', () => ctx.slots.register({
					name: 'shell.overlay',
					id: 'session-delete-confirm',
					order: 900,
					locale: NS,
					inject: () => ({ store: pending, archive, unarchive, refresh })
				}, SessionDeleteDialog))

				ctx.effect(() => mountTrashButton(translate('bin.trigger'), () => pending.set({ kind: 'bin' })), 'session-delete: trash opener')
			}
		}
	}
})
