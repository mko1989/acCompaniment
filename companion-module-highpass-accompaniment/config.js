import { DEFAULT_PORT } from './client.js'

export function getConfigFields() {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Connection',
			value:
				'Connects to the acCompaniment server on the same port as its web interface (the port shown in the acCompaniment tray menu / settings, 3333 by default).',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'acCompaniment IP Address',
			width: 8,
			default: '127.0.0.1',
		},
		{
			type: 'number',
			id: 'port',
			label: 'acCompaniment Port',
			width: 4,
			default: DEFAULT_PORT,
			min: 1,
			max: 65535,
		},
		{
			type: 'checkbox',
			id: 'reconnect',
			label: 'Attempt Reconnect',
			default: true,
		},
	]
}
