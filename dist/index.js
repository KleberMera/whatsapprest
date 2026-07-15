"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const whatsapp_service_1 = require("./whatsapp.service");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = process.env.PORT || 3001;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Middleware para logging de peticiones
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});
const whatsappService = new whatsapp_service_1.WhatsappService();
const router = express_1.default.Router();
router.get('/status', (req, res) => {
    res.json(whatsappService.getStatus());
});
router.get('/qr', (req, res) => {
    res.json(whatsappService.getQr());
});
router.post('/logout', async (req, res) => {
    await whatsappService.logout();
    res.json({ message: 'Sesión de WhatsApp cerrada correctamente' });
});
router.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }
    try {
        await whatsappService.sendTextToPhone(phone, message);
        res.json({ message: 'Mensaje enviado correctamente' });
    }
    catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message || 'Error sending message' });
    }
});
router.get('/qr-view', async (req, res) => {
    const data = whatsappService.getQr();
    if (!data.qr) {
        return res.send('No hay QR disponible');
    }
    res.send(`
    <html>
      <body>
        <h2>Escanea este QR con WhatsApp</h2>
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.qr)}"/>
      </body>
    </html>
  `);
});
app.use('/whatsapp', router);
// app.listen(port, () => {
//   console.log(`WhatsApp service listening at http://localhost:${port}`);
// });
app.listen(4000, '0.0.0.0', () => {
    console.log('Servidor escuchando en todas las interfaces');
});
