"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsappService = void 0;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
class WhatsappService {
    socket = null;
    isReady = false;
    initializing = false;
    latestQr = null;
    connectingPromise = null;
    constructor() {
        this.connect().catch(err => {
            console.error('WhatsApp init failed silently', err);
        });
    }
    async sendTextToPhone(phoneNumber, text, retry = true) {
        await this.waitForReady();
        if (!this.socket || !this.isReady) {
            throw new Error('WhatsApp no está conectado o no está listo');
        }
        const jid = this.toWhatsAppJid(phoneNumber);
        console.log(`Intentando enviar mensaje a: ${phoneNumber} -> JID: ${jid}`);
        try {
            const [resultExist] = await this.socket.onWhatsApp(jid);
            if (!resultExist || !resultExist.exists) {
                console.warn(`El número ${phoneNumber} no parece estar registrado en WhatsApp (JID: ${jid})`);
            }
            else {
                console.log(`Número verificado en WhatsApp: ${resultExist.jid}`);
            }
            const finalJid = resultExist?.jid || jid;
            const result = await this.socket.sendMessage(finalJid, { text });
            console.log('✅ Mensaje enviado correctamente (ID: ' + result.key.id + ')');
        }
        catch (error) {
            console.error('Error al enviar:', error);
            // Si falla y es la primera vez, reintentamos una vez después de 2 segundos
            if (retry && (error.message?.includes('not ready') || error.message?.includes('connection'))) {
                console.log('Reintentando envío en 2 segundos...');
                await new Promise(r => setTimeout(r, 2000));
                return this.sendTextToPhone(phoneNumber, text, false);
            }
            throw new Error(`Error al enviar mensaje: ${error.message}`);
        }
    }
    getStatus() {
        return {
            connected: this.isReady,
            hasQr: Boolean(this.latestQr),
            user: this.isReady ? this.socket?.user : null,
        };
    }
    getQr() {
        if (!this.isReady && !this.initializing && !this.latestQr) {
            console.log('No hay conexión activa ni QR, intentando conectar...');
            this.connect().catch(err => console.error('connect error', err));
        }
        return {
            connected: this.isReady,
            qr: this.latestQr,
        };
    }
    async logout() {
        if (this.socket) {
            try {
                await this.socket.logout();
            }
            catch (error) {
                console.error('Error during socket logout:', error);
            }
            this.socket = null;
        }
        this.isReady = false;
        this.latestQr = null;
        this.connectingPromise = null;
        this.clearSession();
        console.log('Sesión de WhatsApp cerrada correctamente');
    }
    clearSession() {
        const authDir = process.env.WHATSAPP_AUTH_DIR ?? path.join(process.cwd(), 'whatsapp-session');
        if (fs.existsSync(authDir)) {
            try {
                fs.rmSync(authDir, { recursive: true, force: true });
                console.log('Archivos de sesión eliminados');
            }
            catch (error) {
                console.error('Error eliminando sesión:', error);
            }
        }
    }
    async waitForReady(timeoutMs = 15000) {
        if (this.isReady && this.socket) {
            return;
        }
        try {
            await this.connect();
        }
        catch (error) {
            console.error('Error conectando WhatsApp:', error);
        }
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isReady && this.socket) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error('Timeout esperando que WhatsApp esté listo');
    }
    async connect() {
        if (this.connectingPromise) {
            return this.connectingPromise;
        }
        if (this.isReady && this.socket) {
            return;
        }
        this.connectingPromise = this.doConnect();
        try {
            await this.connectingPromise;
        }
        finally {
            this.connectingPromise = null;
        }
    }
    async doConnect() {
        if (this.initializing)
            return;
        if (this.isReady && this.socket)
            return;
        this.initializing = true;
        this.isReady = false;
        try {
            const authDir = process.env.WHATSAPP_AUTH_DIR ?? path.join(process.cwd(), 'whatsapp-session');
            const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(authDir);
            const { version } = await (0, baileys_1.fetchLatestBaileysVersion)();
            const socket = (0, baileys_1.default)({
                auth: state,
                version,
                browser: baileys_1.Browsers.macOS('Chrome'),
                logger: (0, pino_1.default)({ level: 'silent' }),
                printQRInTerminal: true,
            });
            socket.ev.on('creds.update', saveCreds);
            // Promesa que se resuelve después de una espera fija + verificación de usuario
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    console.warn('Tiempo agotado esperando conexión de WhatsApp');
                    resolve();
                }, 120000);
                socket.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;
                    if (qr) {
                        this.latestQr = qr;
                        console.log('Nuevo QR generado');
                    }
                    if (connection === 'open') {
                        clearTimeout(timeout);
                        this.socket = socket;
                        this.latestQr = null;
                        // Esperamos 1.5 segundos para que Baileys termine la negociación interna
                        await new Promise(r => setTimeout(r, 1500));
                        // Verificación adicional: el socket debe tener un usuario
                        if (!socket.user || !socket.user.id) {
                            reject(new Error('Socket abierto pero usuario no autenticado'));
                            return;
                        }
                        this.isReady = true;
                        console.log('✅ WhatsApp conectado y listo para enviar mensajes');
                        console.log('Usuario:', socket.user);
                        resolve();
                    }
                    if (connection === 'close') {
                        clearTimeout(timeout);
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        console.log(`Conexión cerrada. Código: ${statusCode}`);
                        this.isReady = false;
                        this.socket = null;
                        if (statusCode !== baileys_1.DisconnectReason.loggedOut) {
                            console.warn('Reintentando conexión en 5 segundos...');
                            setTimeout(() => {
                                void this.connect();
                            }, 5000);
                        }
                        else {
                            this.latestQr = null;
                            this.clearSession();
                            console.warn('Sesión cerrada por logout. Escanea el QR nuevamente.');
                        }
                        resolve();
                    }
                });
            });
        }
        catch (error) {
            this.isReady = false;
            this.socket = null;
            throw error;
        }
        finally {
            this.initializing = false;
        }
    }
    toWhatsAppJid(phoneNumber) {
        let digits = phoneNumber.replace(/\D/g, '');
        if (!digits)
            throw new Error('Número de teléfono inválido');
        const countryCode = process.env.WHATSAPP_COUNTRY_CODE ?? '593';
        if (digits.startsWith(countryCode)) {
            let local = digits.slice(countryCode.length);
            if (local.startsWith('0'))
                local = local.slice(1);
            digits = countryCode + local;
        }
        else {
            const local = digits.startsWith('0') ? digits.slice(1) : digits;
            digits = countryCode + local;
        }
        return `${digits}@s.whatsapp.net`;
    }
}
exports.WhatsappService = WhatsappService;
