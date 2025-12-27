import {
	InstanceBase,
	runEntrypoint,
	InstanceStatus,
	SomeCompanionConfigField,
	TCPHelper,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'

interface UmixState {
	/*
	on?: number
	fdra?: number
	fdrb?: number
	mfdr?: number
	ducklvl?: number
	ducka?: number
	duckb?: number
	bala?: number
	balb?: number
	urampb?: number
	drampb?: number
	urampa?: number
	drampa?: number
	enabled?: number
	*/
	//minc?: number
	//inca?: number
	//incb?: number
	[key: string]: string | undefined
}

interface ModuleState {
	umix: Record<string, UmixState>
}

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig // Setup in init()
	declare state: ModuleState
	socket!: TCPHelper
	socketBuffer: string = ''

	constructor(internal: unknown) {
		super(internal)
	}

	// Heartbeat properties
	heartbeatTimer: NodeJS.Timeout | null = null
	heartbeatTimeoutTimer: NodeJS.Timeout | null = null
	lastHeartbeat = Date.now()
	HEARTBEAT_TIMEOUT = 10000 // ms

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		await this.configUpdated(config)
		// Initialize state
		this.state.umix = {}

		this.updateStatus(InstanceStatus.Ok)

		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		this.stopHeartbeat()
		if (this.socket) {
			this.socket.destroy()
		} else {
			this.updateStatus(InstanceStatus.Disconnected)
		}
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		if (this.socket) {
			this.socket.destroy()
			this.socket = undefined as any
		}

		this.config = config

		this.init_tcp()
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	// Heartbeat methods
	//--------------------------
	startHeartbeat(): void {
		this.stopHeartbeat()
		this.heartbeatTimer = setInterval(() => {
			void this.sendHeartbeat()
		}, this.config.pollInterval)
		this.resetHeartbeatTimeout()
	}

	stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
		if (this.heartbeatTimeoutTimer) {
			clearTimeout(this.heartbeatTimeoutTimer)
			this.heartbeatTimeoutTimer = null
		}
	}

	async sendHeartbeat(): Promise<void> {
		await this.send('<>')
		this.resetHeartbeatTimeout()
	}

	resetHeartbeatTimeout(): void {
		if (this.heartbeatTimeoutTimer) {
			clearTimeout(this.heartbeatTimeoutTimer)
		}
		this.heartbeatTimeoutTimer = setTimeout(() => {
			this.onHeartbeatTimeout()
		}, this.HEARTBEAT_TIMEOUT)
	}

	onHeartbeatTimeout(): void {
		this.updateStatus(InstanceStatus.ConnectionFailure, 'Heartbeat lost, reconnecting...')
		this.stopHeartbeat()
		if (this.socket) {
			this.socket.destroy()
			this.socket = undefined as any
		}
		setTimeout(() => {
			this.init_tcp()
		}, 5000)
	}

	// Initialize TCP Socket
	init_tcp(): void {
		if (this.socket) {
			this.socket.destroy()
			this.socket = undefined as any
			this.socketBuffer = '' // Buffer for incoming data
		}

		this.updateStatus(InstanceStatus.Connecting)

		if (this.config.host && this.config.port) {
			this.socket = new TCPHelper(this.config.host, this.config.port)

			this.socket.on('status_change', (status: InstanceStatus, message: string | undefined) => {
				this.updateStatus(status, message)
			})

			this.socket.on('error', (err: Error) => {
				this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
				this.log('error', 'Network error: ' + err.message)
			})

			this.socket.on('data', (data: Buffer) => {
				const message = data.toString('utf8').trim()
				this.log('debug', `Received data: ${message}`)
				// Heartbeat: If we get any data
				this.lastHeartbeat = Date.now()
				if (this.heartbeatTimeoutTimer) {
					this.resetHeartbeatTimeout()
				}
				this.handleMessage(message)
			})
		}
	}

	// Subscribe to UMix parameter updates
	// Send <UMIXSUB:1.2|ON:1>
	// Response <OK>
	// ON
	// FDRA
	// FDRB
	// MFDR
	// DUCKA
	// DUCKB
	async subscribeUmix(channel: string, parameter: string): Promise<void> {
		const cmd = `<UMIXSUB:${channel}|${parameter}:1>`
		await this.send(cmd)
	}

	// Unsubscribe from UMix parameter updates
	// Send <UMIXSUB:1.2|ON:0>
	// Response <OK>
	async unsubscribeUmix(channel: string, parameter: string): Promise<void> {
		const cmd = `<UMIXSUB:${channel}|${parameter}:0>`
		await this.send(cmd)
	}

	// Send command to Device
	async send(cmd: string): Promise<void> {
		const sendBuf = Buffer.from(cmd + '\r\n', 'latin1')
		this.log('info', 'sending to ' + this.config.host + ': ' + sendBuf.toString())

		if (this.socket !== undefined && this.socket.isConnected) {
			await this.socket.send(sendBuf)
		} else {
			this.log('info', 'Socket not connected :(')
		}
	}

	// Handle incoming message from Device
	// <UMIXEVENT:1.2|ON:1>  (Utility Mixer 1 Input 2 is turned on)
	// <UMIXEVENT:1.2|ON:0>  (Utility Mixer 1 Input 2 is turned off)
	// <SRC:00400002|NAME:mic/:Bob> (Source name contains escaped colon)
	// <SYS|NAME:Blade03,BLID:3,MODEL:IP88a,VERSION:1.6.5,...> (System info)
	// Handles escaping: | -> /| , : -> /: , ? -> /? , < -> /< , > -> />
	handleMessage(msg: string): void {
		// remove < >
		msg = msg.replace(/<|>/g, '')

		// split target + params
		// goal: target = "UMIXEVENT:1.2", paramString = "ON:1,FDRA:-80.0,..."
		// or target = "SYS", paramString = "NAME:Blade03,BLID:3,..."
		const [target, paramString] = msg.split('|')

		// split target into type + channel if applicable
		// goal: type = "UMIXEVENT", channel = "1.2" (or channel = undefined for "SYS")
		const colonIndex = target.indexOf(':')
		const type = colonIndex !== -1 ? target.substring(0, colonIndex) : target
		const channel = colonIndex !== -1 ? target.substring(colonIndex + 1) : undefined

		// parse params into object, unescaping values
		const paramObj: Record<string, string> = {}

		// Split parameters by comma
		const paramList = paramString?.split(',') || []
		// Process each parameter
		paramList.forEach((param) => {
			const trimmedParam = param.trim()
			// Split only on first colon to handle escaped colons in values
			const colonIndex = trimmedParam.indexOf(':')
			if (colonIndex !== -1) {
				const paramKey = trimmedParam.substring(0, colonIndex)
				const paramValue = trimmedParam.substring(colonIndex + 1)
				paramObj[paramKey] = this.unescapeValue(paramValue)
			}
		})

		if ((type === 'UMIXEVENT' || type === 'UMIX') && channel) {
			this.state.umix[channel] = paramObj
			this.checkFeedbacks('umix_on')
		} else if (type === 'SYS') {
			this.log('info', 'System info: ' + JSON.stringify(paramObj))
			// Store system info if needed
		} else {
			this.log('warn', 'Unknown message type: ' + type)
			this.log('warn', 'Message content: ' + JSON.stringify(paramObj))
		}
	}

	// On successful connection after welcome message?
	async onConnected(): Promise<void> {
		this.updateStatus(InstanceStatus.Ok)
		this.log('info', 'Connected to: ' + this.config.host + ':' + this.config.port)
		await this.send('<SYS?>') // optional. get system info

		if (this.config.pollInterval > 0) {
			this.log('info', 'Starting heartbeat with interval: ' + this.config.pollInterval + ' ms')
			this.startHeartbeat()
		}
	}

	// Escaping/Unescaping helper methods
	// Device escapes: | -> /| , : -> /: , ? -> /? , < -> /< , > -> />
	// Example: "mic|Joe" -> "mic/|Joe", "<mic>Joe" -> "/<mic/>Joe"
	private unescapeValue(value: string): string {
		return value
			.replace(/\/\|/g, '|') // /| -> |
			.replace(/\/:/g, ':') // /: -> :
			.replace(/\/\?/g, '?') // /? -> ?
			.replace(/\/</g, '<') // /< -> <
			.replace(/\/>/g, '>') // /> -> >
	}

	/*
	private escapeValue(value: string): string {
		return value
			.replace(/\?/g, '/?') // ? -> /?
			.replace(/:/g, '/:') // : -> /:
			.replace(/\|/g, '/|') // | -> /|
			.replace(/</g, '/<') // < -> /<
			.replace(/>/g, '/>') // > -> />
	}
	*/
}

runEntrypoint(ModuleInstance, UpgradeScripts)
