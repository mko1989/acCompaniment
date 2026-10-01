/**
 * Test helpers: a fake acCompaniment WebSocket server, a stand-in for the
 * Companion InstanceBase, and waiting utilities.
 */

import { WebSocketServer } from 'ws'
import { AccompanimentClient } from '../client.js'
import { wireClient, defineEverything } from '../instance.js'

/** A WebSocket server that records what clients send and can push messages. */
export async function fakeServer() {
	const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
	await new Promise((resolve) => wss.on('listening', resolve))
	const received = []
	const sockets = new Set()
	const listeners = []
	wss.on('connection', (socket) => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
		socket.on('message', (data) => {
			const message = JSON.parse(data.toString())
			received.push(message)
			for (const fn of listeners.splice(0)) fn()
		})
		for (const fn of server.onConnect) fn(socket)
	})
	const server = {
		port: wss.address().port,
		received,
		onConnect: [],
		push(type, payload) {
			for (const socket of sockets) socket.send(JSON.stringify({ type, payload }))
		},
		pushRaw(text) {
			for (const socket of sockets) socket.send(text)
		},
		clientCount: () => sockets.size,
		/** Resolves with the next command of `type` a client sends. */
		async nextCommand(type, timeoutMs = 2000) {
			const deadline = Date.now() + timeoutMs
			for (;;) {
				const found = received.find((m) => m.type === type && !m.seen)
				if (found) {
					found.seen = true
					return found
				}
				if (Date.now() > deadline) throw new Error(`no ${type} command received`)
				await new Promise((resolve) => {
					listeners.push(resolve)
					setTimeout(resolve, 50)
				})
			}
		},
		dropClients() {
			for (const socket of sockets) socket.terminate()
		},
		close: () =>
			new Promise((resolve) => {
				for (const socket of sockets) socket.terminate()
				wss.close(() => resolve())
			}),
	}
	return server
}

/** Polls `fn` until it returns something truthy. */
export async function until(fn, { timeoutMs = 3000, intervalMs = 20, message = 'condition' } = {}) {
	const deadline = Date.now() + timeoutMs
	let last
	for (;;) {
		last = await fn()
		if (last) return last
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`)
		await new Promise((r) => setTimeout(r, intervalMs))
	}
}

/**
 * A stand-in for the Companion instance: records variables, definitions,
 * statuses and logs. (Option values reach callbacks already resolved -
 * Companion does variables/expressions - so none are parsed here.)
 */
export function fakeInstance({
	client = new AccompanimentClient({ reconnect: false }),
	config = {},
	wire = true,
} = {}) {
	const self = {
		label: 'acc',
		client,
		config: { host: '127.0.0.1', port: 3333, reconnect: false, ...config },
		variables: {},
		variableDefinitions: {},
		actions: {},
		feedbacks: {},
		presets: {},
		presetStructure: [],
		statuses: [],
		logs: [],
		checked: [],
		log: (level, text) => self.logs.push({ level, text }),
		updateStatus: (status, message) => self.statuses.push({ status, message }),
		setVariableDefinitions: (defs) => {
			self.variableDefinitions = defs
		},
		setVariableValues: (values) => Object.assign(self.variables, values),
		setActionDefinitions: (defs) => {
			self.actions = defs
		},
		setFeedbackDefinitions: (defs) => {
			self.feedbacks = defs
		},
		setPresetDefinitions: (structure, presets) => {
			self.presetStructure = structure
			self.presets = presets
		},
		checkFeedbacks: (...ids) => self.checked.push(...ids),
		/** Runs an action as Companion would. */
		runAction: (actionId, options = {}) => self.actions[actionId].callback({ actionId, options }, {}),
		/** Evaluates a feedback as Companion would. */
		feedback: (feedbackId, options = {}) => self.feedbacks[feedbackId].callback({ feedbackId, options }, {}),
	}
	if (wire) {
		wireClient(self)
		defineEverything(self)
	}
	return self
}
