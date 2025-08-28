// File: api/index.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { kv } = require('@vercel/kv');

const app = express();
app.use(express.json({ limit: '256kb' }));

// --- Config ---
const QR_SECRET = process.env.QR_SECRET || 'dev-secret-change-me';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null; // defina em produção
const ALLOWED_TICKET_TYPES = new Set(['VIP', 'PISTA', 'MEIA', 'CAMAROTE']);

// Aceitar rotas com e sem prefixo /api
const both = (path) => [path, path.startsWith('/api') ? path.replace(/^\/api/, '') : `/api${path}`];

// --- Helpers ---
function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}
function sign(obj) {
  const payload = JSON.stringify(obj);
  const sig = crypto.createHmac('sha256', QR_SECRET).update(payload).digest('hex');
  return { payload, sig };
}
function timingSafeEq(a, b) {
  if (!a || !b) return false;
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}
async function saveOrder(order) {
  // salva objeto inteiro (JSON) e índice para listagem
  await kv.set(`order:${order.id}`, order);
  await kv.sadd('orders:ids', order.id);
  await kv.zadd('orders:byTime', { score: Date.now(), member: order.id });
}
async function getOrder(id) {
  return await kv.get(`order:${id}`);
}

// --- Middlewares ---
const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN não configurado' });
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// --- Health/Info ---
app.get(both('/api'), (_req, res) => {
  res.json({
    status: 'ok',
    message: 'Ticket API running',
    routes: {
      health: ['GET /api', 'GET /'],
      checkout: ['POST /api/checkout', 'POST /checkout'],
      ticket: ['GET /api/ticket/:id', 'GET /ticket/:id'],
      verify: ['POST /api/verify', 'POST /verify'],
      admin: {
        list: ['GET /api/admin/orders?limit=50', 'GET /admin/orders?limit=50'],
        get: ['GET /api/admin/order/:id', 'GET /admin/order/:id']
      }
    }
  });
});

// --- Checkout ---
app.post(both('/api/checkout'), checkoutLimiter, async (req, res) => {
  try {
    const { name, email, ticketType } = req.body || {};

    // validação simples e leve
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ error: 'Nome inválido' });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    if (!ALLOWED_TICKET_TYPES.has(String(ticketType || '').toUpperCase())) {
      return res.status(400).json({ error: `ticketType inválido. Use um de: ${[...ALLOWED_TICKET_TYPES].join(', ')}` });
    }

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const order = { id, name: String(name).trim(), email: String(email).trim(), ticketType: String(ticketType).toUpperCase(), createdAt, status: 'issued' };

    // Assinatura do payload anti-fraude
    const { payload, sig } = sign(order);

    // QR carrega { payload, sig, v:1 }
    const qrData = { payload, sig, v: 1 };
    const qr = await QRCode.toDataURL(JSON.stringify(qrData), {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 1,
      scale: 6
    });

    // Salvar (inclui qr para consulta rápida)
    const stored = { ...order, qr };
    await saveOrder(stored);

    return res.status(201).json({
      id,
      qr,         // data:image/png;base64,...
      order: stored
      // (se quiser depurar/verificar sem ler o QR, você pode expor {payload, sig})
    });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Erro ao processar checkout' });
  }
});

// --- Ticket por ID ---
app.get(both('/api/ticket/:id'), async (req, res) => {
  try {
    const { id } = req.params;
    const order = await getOrder(id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    return res.json({ id: order.id, qr: order.qr, order });
  } catch (err) {
    console.error('Ticket error:', err);
    return res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// --- Verificar QR (payload + sig) ---
app.post(both('/api/verify'), async (req, res) => {
  try {
    const { payload, sig } = req.body || {};
    if (!payload || !sig) return res.status(400).json({ ok: false, error: 'payload e sig são obrigatórios' });

    const ok = timingSafeEq(
      crypto.createHmac('sha256', QR_SECRET).update(String(payload)).digest('hex'),
      String(sig)
    );
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid-signature' });

    const data = JSON.parse(payload);

    // opcional: checar se existe no banco (e status)
    const fromDb = await getOrder(data.id);
    if (!fromDb) return res.status(404).json({ ok: false, error: 'order-not-found' });

    // aqui você poderia checar "status !== used" e marcá-lo como usado
    // await kv.set(`order:${data.id}`, { ...fromDb, status: 'used', usedAt: new Date().toISOString() });

    return res.json({ ok: true, order: data });
  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ ok: false, error: 'Erro ao verificar QR' });
  }
});

// --- Admin: listar pedidos (mais recentes) ---
app.get(both('/api/admin/orders'), requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    // ids mais recentes
    const ids = await kv.zrevrange('orders:byTime', 0, limit - 1);
    const orders = [];
    for (const id of ids) {
      const o = await getOrder(id);
      if (o) orders.push(o);
    }
    return res.json({ count: orders.length, orders });
  } catch (err) {
    console.error('Admin list error:', err);
    return res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

// --- Admin: buscar pedido por id ---
app.get(both('/api/admin/order/:id'), requireAdmin, async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    return res.json(order);
  } catch (err) {
    console.error('Admin get error:', err);
    return res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// Exporta app para Vercel Serverless Function
module.exports = app;
