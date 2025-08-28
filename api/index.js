// api/index.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// armazenamento em memória
const orders = [];

// helper para aceitar /rota e /api/rota
const both = (path) => [path, path.startsWith('/api') ? path.replace(/^\/api/, '') : `/api${path}`];

// Health
app.get(both('/api'), (_req, res) => {
  res.json({
    status: 'ok',
    routes: {
      checkout: ['POST /api/checkout', 'POST /checkout'],
      ticket: ['GET /api/ticket/:id', 'GET /ticket/:id'],
    },
  });
});

// POST /api/checkout (e /checkout)
app.post(both('/api/checkout'), async (req, res) => {
  try {
    const { name, email, ticketType } = req.body || {};
    if (!name || !email || !ticketType) {
      return res.status(400).json({ error: 'Campos obrigatórios: name, email, ticketType' });
    }

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const order = { id, name, email, ticketType, createdAt };

    const qr = await QRCode.toDataURL(JSON.stringify(order), {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 1,
      scale: 6,
    });

    const stored = { ...order, qr };
    orders.push(stored);

    res.status(201).json({ id, qr, order: stored });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Erro ao processar checkout' });
  }
});

// GET /api/ticket/:id (e /ticket/:id)
app.get(both('/api/ticket/:id'), (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  res.json({ id: order.id, qr: order.qr, order });
});

// export para Vercel
module.exports = app;
