import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

export class WhatsappService {
  private socket: any = null;
  private isReady = false;
  private initializing = false;
  private latestQr: string | null = null;
  private connectingPromise: Promise<void> | null = null;

  constructor() {
    this.connect().catch(err => {
      console.error('WhatsApp init failed silently', err);
    });
  }

  async sendTextToPhone(phoneNumber: string, text: string, retry = true): Promise<void> {
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
      } else {
        console.log(`Número verificado en WhatsApp: ${resultExist.jid}`);
      }

      const finalJid = resultExist?.jid || jid;
      const result = await this.socket.sendMessage(finalJid, { text });
      console.log('✅ Mensaje enviado correctamente (ID: ' + result.key.id + ')');
    } catch (error: any) {
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

  async logout(): Promise<void> {
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch (error) {
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

  private clearSession() {
    const authDir = process.env.WHATSAPP_AUTH_DIR ?? path.join(process.cwd(), 'whatsapp-session');
    if (fs.existsSync(authDir)) {
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('Archivos de sesión eliminados');
      } catch (error) {
        console.error('Error eliminando sesión:', error);
      }
    }
  }

  private async waitForReady(timeoutMs = 15000): Promise<void> {
    if (this.isReady && this.socket) {
      return;
    }

    await this.connect();

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isReady && this.socket) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Timeout esperando que WhatsApp esté listo');
  }

  private async connect(): Promise<void> {
    if (this.connectingPromise) {
      return this.connectingPromise;
    }
    if (this.isReady && this.socket) {
      return;
    }
    this.connectingPromise = this.doConnect();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    if (this.initializing) return;
    if (this.isReady && this.socket) return;

    this.initializing = true;
    this.isReady = false;

    try {
      const authDir = process.env.WHATSAPP_AUTH_DIR ?? path.join(process.cwd(), 'whatsapp-session');
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        auth: state,
        version,
        browser: Browsers.macOS('Chrome'),
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
      });

      socket.ev.on('creds.update', saveCreds);

      // Promesa que se resuelve después de una espera fija + verificación de usuario
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout esperando conexión de WhatsApp'));
        }, 20000);

        socket.ev.on('connection.update', async (update: any) => {
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
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
            console.log(`Conexión cerrada. Código: ${statusCode}`);
            this.isReady = false;
            this.socket = null;

            if (statusCode !== DisconnectReason.loggedOut) {
              console.warn('Reintentando conexión en 5 segundos...');
              setTimeout(() => {
                void this.connect();
              }, 5000);
            } else {
              this.latestQr = null;
              this.clearSession();
              console.warn('Sesión cerrada por logout. Escanea el QR nuevamente.');
            }
            reject(new Error(`Conexión cerrada con código ${statusCode}`));
          }
        });
      });
    } catch (error) {
      this.isReady = false;
      this.socket = null;
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  private toWhatsAppJid(phoneNumber: string): string {
    let digits = phoneNumber.replace(/\D/g, '');
    if (!digits) throw new Error('Número de teléfono inválido');

    const countryCode = process.env.WHATSAPP_COUNTRY_CODE ?? '593';
    if (digits.startsWith(countryCode)) {
      let local = digits.slice(countryCode.length);
      if (local.startsWith('0')) local = local.slice(1);
      digits = countryCode + local;
    } else {
      const local = digits.startsWith('0') ? digits.slice(1) : digits;
      digits = countryCode + local;
    }
    return `${digits}@s.whatsapp.net`;
  }
}