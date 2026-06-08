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
  private connected = false;
  private initializing = false;
  private latestQr: string | null = null;

  constructor() {
    this.connect().catch(err => {
      console.error('WhatsApp init failed silently', err);
    });

    // Evitar spin-down de Render (duerme a los 15 min de inactividad)
    const selfUrl = process.env.RENDER_EXTERNAL_URL;
    if (selfUrl) {
      setInterval(async () => {
        try {
          await fetch(`${selfUrl}/whatsapp/status`);
          console.log('Keep-alive ping OK');
        } catch (e: any) {
          console.warn('Keep-alive ping falló:', e.message);
        }
      }, 14 * 60 * 1000); // cada 14 minutos
    }
  }

  async sendTextToPhone(phoneNumber: string, text: string): Promise<void> {
    await this.ensureConnected();

    if (!this.socket) {
      throw new Error('La conexión de WhatsApp no está disponible');
    }

    const jid = this.toWhatsAppJid(phoneNumber);
    console.log(`Intentando enviar mensaje a: ${phoneNumber} -> JID: ${jid}`);
    
    try {
      // Verificar si el número existe en WhatsApp antes de enviar
      const [resultExist] = await this.socket.onWhatsApp(jid);
      
      if (!resultExist || !resultExist.exists) {
        console.warn(`El número ${phoneNumber} no parece estar registrado en WhatsApp (JID: ${jid})`);
        // Intentamos enviar de todos modos por si acaso, pero avisamos
      } else {
        console.log(`Número verificado en WhatsApp: ${resultExist.jid}`);
      }

      const finalJid = resultExist?.jid || jid;
      const result = await this.socket.sendMessage(finalJid, { text });
      console.log('Resultado del envío:', result ? 'Enviado correctamente (ID: ' + result.key.id + ')' : 'Sin respuesta del socket');
    } catch (error) {
      console.error('Error al ejecutar sendMessage o onWhatsApp en el socket:', error);
      throw error;
    }
  }

  getStatus() {
    return {
      connected: this.connected,
      hasQr: Boolean(this.latestQr),
      user: this.connected ? this.socket?.user : null
    };
  }

  getQr() {
    if (!this.connected && !this.initializing && !this.latestQr) {
      console.log('No hay conexión activa ni QR, intentando conectar...');
      this.connect().catch(err => console.error('connect error', err));
    }
    
    return {
      connected: this.connected,
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
    
    this.connected = false;
    this.latestQr = null;

    this.clearSession();
    console.log('Sesión de WhatsApp cerrada correctamente');
  }

  private clearSession() {
    const authDir =
      process.env.WHATSAPP_AUTH_DIR ?? path.join(process.cwd(), 'whatsapp-session');
    if (fs.existsSync(authDir)) {
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log('Archivos de sesión eliminados correctamente');
      } catch (error) {
        console.error('Error eliminando archivos de sesión:', error);
      }
    }
  }

  private async ensureConnected() {
    if (!this.connected) {
      await this.connect();
    }
    // De 10s → 30s para tolerar el cold start de Render
    await this.waitForConnection(30000);
  }

  private async connect() {
    if (this.initializing) {
      // Si ya está iniciando, simplemente esperar a que termine
      await this.waitForConnection(30000);
      return;
    }

    if (this.connected && this.socket) return;

    this.initializing = true;

    try {
      const authDir =
        process.env.WHATSAPP_AUTH_DIR ?? path.join(process.cwd(), 'whatsapp-session');
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
      socket.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.latestQr = qr;
          console.log('Nuevo QR generado.');
        }

        if (connection === 'open') {
          this.connected = true;
          this.latestQr = null;
          this.socket = socket;
          console.log('--- WhatsApp conectado ---', socket.user);
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          console.log(`Conexión cerrada. Código: ${statusCode}`);
          this.connected = false;
          this.socket = null;

          if (statusCode !== DisconnectReason.loggedOut) {
            console.warn('Reintentando conexión en 5 segundos...');
            setTimeout(() => void this.connect(), 5000);
          } else {
            this.latestQr = null;
            this.clearSession();
            console.warn('Sesión cerrada por logout. Vuelve a vincular.');
          }
        }
      });

      // ✅ CLAVE: esperar aquí a que el socket se conecte (o falle por timeout)
      //    antes de retornar, para que ensureConnected sepa el estado real
      await this.waitForConnection(30000).catch(() => {
        // No lanzar error aquí; si no conectó, el socket sigue en background
        // y el siguiente intento lo encontrará listo
        console.warn('connect(): timeout esperando conexión inicial (puede ser QR pendiente)');
      });

    } catch (error) {
      this.connected = false;
      this.socket = null;
      console.error('No fue posible inicializar WhatsApp', error);
      throw error;
    } finally {
      this.initializing = false;
    }
  }

  private async waitForConnection(timeoutMs = 10000) {
    const startedAt = Date.now();

    while (!this.connected) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error('Tiempo de espera agotado esperando la conexión de WhatsApp');
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private toWhatsAppJid(phoneNumber: string): string {
    let digits = phoneNumber.replace(/\D/g, '');

    if (!digits) {
      throw new Error('Número de teléfono inválido');
    }

    const countryCode = process.env.WHATSAPP_COUNTRY_CODE ?? '593';

    // Si el número empieza con el código de país
    if (digits.startsWith(countryCode)) {
      // Quitamos el código de país temporalmente para limpiar el número local
      let local = digits.slice(countryCode.length);
      // En Ecuador y otros países, a veces incluyen un '0' después del código de país (ej: 593 099...)
      // Para WhatsApp, ese '0' debe eliminarse.
      if (local.startsWith('0')) {
        local = local.slice(1);
      }
      digits = countryCode + local;
    } else {
      // Si no tiene código de país, quitamos el '0' inicial si lo tiene y lo añadimos
      const local = digits.startsWith('0') ? digits.slice(1) : digits;
      digits = countryCode + local;
    }

    return `${digits}@s.whatsapp.net`;
  }
}
