// File: api/index.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const app = express();

// Parse JSON bodies
app.use(express.json());

// Armazenamento em memória (volátil por instância)
const orders = [];

/**
 * Healthcheck / info
 */
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Ticket API running',
    routes: {
      checkout: { method: 'POST', path: '/checkout' },
      ticket: { method: 'GET', path: '/ticket/:id' },
    },
    note: 'Na Vercel, estas rotas ficam acessíveis como /api/checkout e /api/ticket/:id',
  });
});

/**
 * POST /checkout
 * Body JSON: { name, email, ticketType }
 * Gera ID do pedido, QR Code base64 e salva em memória
 */
app.post('/checkout', async (req, res) => {
  try {
    const { name, email, ticketType } = req.body || {};

    // validações mínimas
    if (!name || !email || !ticketType) {
      return res.status(400).json({
        error: 'Campos obrigatórios: name, email, ticketType',
      });
    }

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const order = { id, name, email, ticketType, createdAt };

    // Dados codificados no QR (JSON)
    const qrPayload = JSON.stringify(order);

    // Gera QR base64 (data URL)
    const qr = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: 'M', // bom equilíbrio entre tamanho e robustez
      type: 'image/png',
      margin: 1,
      scale: 6,
    });

    // salva em memória (inclui o QR junto para facilitar consulta)
    const stored = { ...order, qr };
    orders.push(stored);

    return res.status(201).json({
      id,
      qr,        // data:image/png;base64,....
      order: stored,
    });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Erro ao processar checkout' });
  }
});

/**
 * GET /ticket/:id
 * Retorna os dados do pedido + QR base64
 */
app.get('/ticket/:id', (req, res) => {
  const { id } = req.params;
  const order = orders.find((o) => o.id === id);

  if (!order) {
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  return res.json({
    id: order.id,
    qr: order.qr, // data URL base64
    order,
  });
});

// Exporta o app para funcionar como Serverless Function na Vercel
module.exports = app;
