"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.makeSocket = void 0;

const boom_1 = require("@hapi/boom");
const crypto_1 = require("crypto");
const url_1 = require("url");
const util_1 = require("util");

const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const Types_1 = require("../Types");
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const Client_1 = require("./Client");

/**
 * Creates and manages a WhatsApp MD socket connection.
 */
const makeSocket = (config) => {
    const {
        waWebSocketUrl,
        connectTimeoutMs,
        logger,
        keepAliveIntervalMs,
        browser,
        auth: authState,
        printQRInTerminal,
        defaultQueryTimeoutMs,
        transactionOpts,
        qrTimeout,
        makeSignalRepository,
        socket,
    } = config;

    // Prepare URL
    let url = typeof waWebSocketUrl === 'string' ? new url_1.URL(waWebSocketUrl) : waWebSocketUrl;
    config.mobile = config.mobile || url.protocol === 'tcp:';

    if (config.mobile && url.protocol !== 'tcp:') {
        url = new url_1.URL(`tcp://${Defaults_1.MOBILE_ENDPOINT}:${Defaults_1.MOBILE_PORT}`);
    }

    if (!config.mobile && url.protocol === 'wss:' && authState?.creds?.routingInfo) {
        url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'));
    }

    const ws = socket
        ? socket
        : config.mobile
            ? new Client_1.MobileSocketClient(url, config)
            : new Client_1.WebSocketClient(url, config);

    ws.connect();

        const ev = (0, Utils_1.makeEventBuffer)(logger);

    // Ephemeral key pair untuk komunikasi noise protocol
    const ephemeralKeyPair = Utils_1.Curve.generateKeyPair();

    const noise = (0, Utils_1.makeNoiseHandler)({
        keyPair: ephemeralKeyPair,
        NOISE_HEADER: config.mobile ? Defaults_1.MOBILE_NOISE_HEADER : Defaults_1.NOISE_WA_HEADER,
        mobile: config.mobile,
        logger,
        routingInfo: authState?.creds?.routingInfo,
    });

    const { creds } = authState;

    // Tambahkan kemampuan transaksi pada keys
    const keys = (0, Utils_1.addTransactionCapability)(authState.keys, logger, transactionOpts);

    const signalRepository = makeSignalRepository({ creds, keys });

    let lastDateRecv;
    let epoch = 1;
    let keepAliveReq;
    let qrTimer;
    let closed = false;

    const uqTagId = (0, Utils_1.generateMdTagPrefix)();
    const generateMessageTag = () => `${uqTagId}${epoch++}`;
    const sendPromise = (0, util_1.promisify)(ws.send);

        /** Mengirim raw buffer ke server */
    const sendRawMessage = async (data) => {
        if (!ws.isOpen) {
            throw new boom_1.Boom('Connection Closed', {
                statusCode: Types_1.DisconnectReason.connectionClosed
            });
        }
        const bytes = noise.encodeFrame(data);
        await (0, Utils_1.promiseTimeout)(connectTimeoutMs, async (resolve, reject) => {
            try {
                await sendPromise.call(ws, bytes);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    };

    /** Mengirim binary node (dalam bentuk XML WhatsApp) */
    const sendNode = (frame) => {
        if (logger.level === 'trace') {
            logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'xml send' });
        }
        const buff = (0, WABinary_1.encodeBinaryNode)(frame);
        return sendRawMessage(buff);
    };

    /** Tangani error tak terduga */
    const onUnexpectedError = (err, msg) => {
        logger.error({ err }, `unexpected error in '${msg}'`);
    };
    /** Tunggu satu pesan masuk (opsional kirim pesan dulu) */
    const awaitNextMessage = async (sendMsg) => {
        if (!ws.isOpen) {
            throw new boom_1.Boom('Connection Closed', {
                statusCode: Types_1.DisconnectReason.connectionClosed
            });
        }

        let onOpen;
        let onClose;

        const result = (0, Utils_1.promiseTimeout)(connectTimeoutMs, (resolve, reject) => {
            onOpen = resolve;
            onClose = mapWebSocketError(reject);

            ws.on('frame', onOpen);
            ws.on('close', onClose);
            ws.on('error', onClose);
        }).finally(() => {
            ws.off('frame', onOpen);
            ws.off('close', onClose);
            ws.off('error', onClose);
        });

        if (sendMsg) {
            sendRawMessage(sendMsg).catch(onClose);
        }

        return result;
    };

    /** Menunggu message tag tertentu */
    const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
        let onRecv;
        let onErr;

        try {
            return await (0, Utils_1.promiseTimeout)(timeoutMs, (resolve, reject) => {
                onRecv = resolve;
                onErr = err => {
                    reject(err || new boom_1.Boom('Connection Closed', {
                        statusCode: Types_1.DisconnectReason.connectionClosed
                    }));
                };

                ws.on(`TAG:${msgId}`, onRecv);
                ws.on('close', onErr);
                ws.off('error', onErr);
            });
        } finally {
            ws.off(`TAG:${msgId}`, onRecv);
            ws.off('close', onErr);
            ws.off('error', onErr);
        }
    };

    /** Kirim query & tunggu respon */
    const query = async (node, timeoutMs) => {
        if (!node.attrs.id) {
            node.attrs.id = generateMessageTag();
        }

        const msgId = node.attrs.id;
        const wait = waitForMessage(msgId, timeoutMs);
        await sendNode(node);
        const result = await wait;

        if ('tag' in result) {
            (0, WABinary_1.assertNodeErrorFree)(result);
        }

        return result;
    };

        /** Proses handshake untuk validasi koneksi */
    const validateConnection = async () => {
        let helloMsg = {
            clientHello: { ephemeral: ephemeralKeyPair.public }
        };

        helloMsg = WAProto_1.proto.HandshakeMessage.fromObject(helloMsg);
        logger.info({ browser, helloMsg }, 'connected to WA');

        const init = WAProto_1.proto.HandshakeMessage.encode(helloMsg).finish();
        const result = await awaitNextMessage(init);

        const handshake = WAProto_1.proto.HandshakeMessage.decode(result);
        logger.trace({ handshake }, 'handshake recv from WA');

        const keyEnc = noise.processHandshake(handshake, creds.noiseKey);

        let node;
        if (config.mobile) {
            node = (0, Utils_1.generateMobileNode)(config);
        } else if (!creds.me) {
            node = (0, Utils_1.generateRegistrationNode)(creds, config);
            logger.info({ node }, 'not logged in, attempting registration...');
        } else {
            node = (0, Utils_1.generateLoginNode)(creds.me.id, config);
            logger.info({ node }, 'logging in...');
        }

        const payloadEnc = noise.encrypt(WAProto_1.proto.ClientPayload.encode(node).finish());

        await sendRawMessage(WAProto_1.proto.HandshakeMessage.encode({
            clientFinish: {
                static: keyEnc,
                payload: payloadEnc,
            },
        }).finish());

        noise.finishInit();
        startKeepAliveRequest();
    };

    // Kirim pre-keys ke server WA supaya bisa terima pesan terenkripsi
const sendPreKeys = async () => {
    const preKeys = generatePreKeys(5); // misal buat 5 pre-keys baru
    const keysNode = {
        preKeys: preKeys.map(key => ({
            keyId: key.keyId,
            publicKey: key.publicKey,
        }))
    };

    await sendNode('prekeys', keysNode);
    logger.info('Pre-keys sent to WhatsApp server');
};

// Fungsi untuk terus kirim keep-alive biar koneksi gak putus
const startKeepAliveRequest = () => {
    setInterval(() => {
        sendNode('keepalive', { type: 'ping' });
        logger.debug('Keep-alive ping sent');
    }, 30000); // tiap 30 detik
};
