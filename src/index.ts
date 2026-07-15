import express from 'express';
import cors from 'cors';
import { WhatsappService } from './whatsapp.service';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Middleware para logging de peticiones
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const whatsappService = new WhatsappService();

const router = express.Router();

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
  } catch (error: any) {
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
