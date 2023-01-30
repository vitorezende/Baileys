import { Boom } from '@hapi/boom'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast, makeCacheableSignalKeyStore, useMultiFileAuthState } from '../src'
import MAIN_LOGGER from '../src/Utils/logger'
import * as dotenv from 'dotenv'
import { Configuration, OpenAIApi } from "openai"

const logger = MAIN_LOGGER.child({ })
logger.level = 'trace'
dotenv.config()

const iaCommands = {
	davinci3: "/ia",
	dalle: "/img"
}

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: true,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries
		getMessage: async key => {
			// only if store is present
			return {
				conversation: 'hello'
			}
		},
		patchMessageBeforeSending: (message) => {
			const requirePatch = !!(message.buttonsMessage || message.listMessage || message.templateMessage);
			if (requirePatch) {
				message = {
					viewOnceMessageV2: {
						message: {
							messageContextInfo: {
								deviceListMetadataVersion: 2,
								deviceListMetadata: {},
							},
							...message,
						},
					},
				};
			}
			return message;
		}
	})

	const sendMessageWTyping = async(msg, jid) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}
	const configuration = new Configuration({
		organization: process.env.ORGANIZATION_ID,
		apiKey: process.env.OPENAI_KEY,
	});
	
	const openai = new OpenAIApi(configuration);

	const getDavinciResponse = async (clientText) => {
		const options = {
			model: "text-davinci-003", // Modelo GPT a ser usado
			prompt: clientText, // Texto enviado pelo usuário
			temperature: 1, // Nível de variação das respostas geradas, 1 é o máximo
			max_tokens: 4000 // Quantidade de tokens (palavras) a serem retornadas pelo bot, 4000 é o máximo
		}
	
		try {
			const response = await openai.createCompletion(options)
			let botResponse = ""
			response.data.choices.forEach(({ text }) => {
				botResponse += text
			})
			return `🤖\n ${botResponse.trim()}`
		} catch (e) {
			return `❌ OpenAI Response Error: ${e.response.data.error.message}`
		}
	}

	const getDalleResponse = async (clientText) => {
		try {
			const response = await openai.createImage({
				prompt: clientText, // Descrição da imagem
				n: 1, // Número de imagens a serem geradas
				size: "1024x1024", // Tamanho da imagem
			});
			return response.data.data[0].url
		} catch (e) {
			return `❌ OpenAI Response Error: ${e.response.data.error.message}`
		}
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
					}
				}

				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest } = events['messaging-history.set']
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`)
			}

			// received a new message
			if(events['messages.upsert']) {
				const upsertMessage = events['messages.upsert']
				console.log('recv messages ', JSON.stringify(upsertMessage, undefined, 2))

				if(upsertMessage.type === 'notify') {
					for(const msg of upsertMessage.messages) {
						const jid = msg.key.remoteJid;

						if(!msg.key.fromMe && jid !== 'status@bardcast') {
							console.log('replying to', msg.key.remoteJid)
							await sock!.readMessages([msg.key])
							const msgToChatGpt = msg.message?.conversation;

							let firstWord = msgToChatGpt?.substring(0, msgToChatGpt.indexOf(" "));

							switch (firstWord) {
								case iaCommands.davinci3:
									const question = msgToChatGpt?.substring(msgToChatGpt.indexOf(" "));
									getDavinciResponse(question).then((response) => {
										/*
										 * Faremos uma validação no message.from
										 * para caso a gente envie um comando
										 * a response não seja enviada para
										 * nosso próprio número e sim para 
										 * a pessoa ou grupo para o qual eu enviei
										 */
										sendMessageWTyping({ text: response }, jid!);
									})
									break;
						
								case iaCommands.dalle:
									const imgDescription = msgToChatGpt?.substring(msgToChatGpt.indexOf(" "));
									getDalleResponse(imgDescription).then((imgUrl?: string) => {
										const imgPayload = {
											caption: imgDescription,
											image: {
												url: imgUrl
											}
										}
										sendMessageWTyping(imgPayload, msg.key.remoteJid)
											.then(result => console.log('RESULT: ', result))
											.catch(err => console.log('ERROR: ', err))

									})
									break;
							}
						}
					}
				}
			}

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				console.log(events['messages.update'])
			}

			if(events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if(events['presence.update']) {
				console.log(events['presence.update'])
			}

			if(events['chats.update']) {
				console.log(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if(events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock
}

startSock()