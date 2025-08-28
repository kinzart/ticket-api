// File: api/index.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { kv } = require('@vercel/kv');

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS básico (antes de qualquer rota/middleware)
app.use((req, res, next) => {
  // Permita seu front local. Para testes: '*'
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Métodos permitidos
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Headers permitidos (inclui os que usamos)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');

  // Responder preflight rapidamente
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});


// ========= CONFIG =========
const QR_SECRET = process.env.QR_SECRET || 'dev-secret-change-me';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null; // defina em produção
const ALLOWED_TICKET_TYPES = new Set(['VIP', 'PISTA', 'MEIA', 'CAMAROTE']);

const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const FROM_EMAIL = process.env.FROM_EMAIL || null; // ex: "Ingressos <noreply@seu-dominio.com>"
const PROJECT_NAME = process.env.PROJECT_NAME || 'Ticket API';
const BASE_URL = process.env.BASE_URL || ''; // ex: https://ticket-api-xyz.vercel.app

// aceita rotas com e sem prefixo /api
const both = (path) => [path, path.startsWith('/api') ? path.replace(/^\/api/, '') : `/api${path}`];

// ========= HELPERS =========
function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}
function sign(obj) {
  const payload = JSON.stringify(obj);
  const sig = crypto.createHmac('sha256', QR_SECRET).update(payload).digest('hex');
  return { payload, sig };
}
function verifySig(payload, sig) {
  const expected = crypto.createHmac('sha256', QR_SECRET).update(String(payload)).digest('hex');
  // evite ataques de timing
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
  } catch {
    return false;
  }
}
async function saveOrder(order) {
  await kv.set(`order:${order.id}`, order);
  await kv.sadd('orders:ids', order.id);
  await kv.zadd('orders:byTime', { score: Date.now(), member: order.id });
}
async function getOrder(id) {
  return await kv.get(`order:${id}`);
}
function asISO(d) {
  return new Date(d).toISOString();
}
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ========= RATE LIMIT =========
const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// ========= AUTH MIDDLEWARE (ADMIN) =========
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

// ========= EMAIL (Resend, via fetch nativo) =========
async function sendTicketEmail(order) {
  if (!RESEND_API_KEY || !FROM_EMAIL) return { sent: false, reason: 'email-disabled' };

  const ticketUrl = BASE_URL ? `${BASE_URL.replace(/\/$/, '')}/api/ticket/${order.id}` : '';
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:16px">
    <h2 style="margin:0 0 8px">${PROJECT_NAME} - Ingresso</h2>
    <p style="margin:4px 0;color:#444">Olá, ${order.name}!</p>
    <p style="margin:4px 0;color:#444">Seu ingresso <b>${order.ticketType}</b> foi emitido em <b>${new Date(order.createdAt).toLocaleString()}</b>.</p>
    ${ticketUrl ? `<p style="margin:4px 0;color:#444">Link do ingresso: <a href="${ticketUrl}">${ticketUrl}</a></p>` : ''}
    <div style="margin:12px 0;padding:12px;border:1px solid #eee;border-radius:8px;text-align:center">
      <img alt="QR Code do ingresso" src="${order.qr}" style="max-width:260px;width:100%;height:auto"/>
      <p style="margin:8px 0 0;color:#666;font-size:12px">ID do pedido: ${order.id}</p>
    </div>
    <p style="margin:12px 0 0;color:#999;font-size:12px">Apresente este QR Code na entrada do evento.</p>
  </div>`.trim();

  const body = {
    from: FROM_EMAIL,
    to: [order.email],
    subject: `${PROJECT_NAME} - Seu ingresso (${order.ticketType})`,
    html
  };

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error('Resend error:', resp.status, text);
    return { sent: false, reason: `resend-${resp.status}` };
  }
  return { sent: true };
}

// ========= HEALTH =========
app.get(both('/api'), (_req, res) => {
  res.json({
    status: 'ok',
    message: 'Ticket API running',
    routes: {
      health: ['GET /api', 'GET /'],
      checkout: ['POST /api/checkout', 'POST /checkout'],
      ticket: ['GET /api/ticket/:id', 'GET /ticket/:id'],
      verify: ['POST /api/verify', 'POST /verify'],
      scan: ['POST /api/scan', 'POST /scan'],
      admin: {
        list: ['GET /api/admin/orders?limit=50', 'GET /admin/orders?limit=50'],
        get: ['GET /api/admin/order/:id', 'GET /admin/order/:id'],
        exportCsv: ['GET /api/admin/export.csv?limit=1000', 'GET /admin/export.csv?limit=1000']
      }
    }
  });
});

// ========= CHECKOUT (com idempotência) =========
app.post(both('/api/checkout'), checkoutLimiter, async (req, res) => {
  try {
    const { name, email, ticketType } = req.body || {};
    // validação leve
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ error: 'Nome inválido' });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    const tt = String(ticketType || '').toUpperCase();
    if (!ALLOWED_TICKET_TYPES.has(tt)) {
      return res.status(400).json({ error: `ticketType inválido. Use: ${[...ALLOWED_TICKET_TYPES].join(', ')}` });
    }

    // idempotência (melhor esforço)
    const idemKey = req.headers['idempotency-key'] || null;
    if (idemKey) {
      const existingId = await kv.get(`idem:${idemKey}`);
      if (existingId) {
        const existingOrder = await getOrder(existingId);
        if (existingOrder) {
          return res.status(200).json({ id: existingOrder.id, qr: existingOrder.qr, order: existingOrder, idempotent: true });
        }
      }
    }

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const order = { id, name: String(name).trim(), email: String(email).trim(), ticketType: tt, createdAt, status: 'issued' };

    // Assinatura anti-fraude
    const { payload, sig } = sign(order);
    const qrData = { payload, sig, v: 1 };

    // QR base64
    const qr = await QRCode.toDataURL(JSON.stringify(qrData), {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      margin: 1,
      scale: 6
    });

    const stored = { ...order, qr };
    await saveOrder(stored);

    // set idempotency mapping (TTL 10 min)
    if (idemKey) {
      try { await kv.set(`idem:${idemKey}`, id, { ex: 600 }); } catch (e) { /* noop */ }
    }

    // e-mail (não bloqueia a resposta)
    sendTicketEmail(stored).catch(() => {});

    return res.status(201).json({ id, qr, order: stored });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Erro ao processar checkout' });
  }
});

// ========= TICKET POR ID =========
app.get(both('/api/ticket/:id'), async (req, res) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    return res.json({ id: order.id, qr: order.qr, order });
  } catch (err) {
    console.error('Ticket error:', err);
    return res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// ========= VERIFY (valida assinatura) =========
app.post(both('/api/verify'), async (req, res) => {
  try {
    // aceita {payload, sig} ou {qrData: string/obj}
    let payload = req.body?.payload;
    let sig = req.body?.sig;

    if (!payload || !sig) {
      const raw = req.body?.qrData;
      const obj = typeof raw === 'string' ? safeJsonParse(raw) : raw;
      if (obj && obj.payload && obj.sig) {
        payload = obj.payload;
        sig = obj.sig;
      }
    }
    if (!payload || !sig) return res.status(400).json({ ok: false, error: 'payload/sig ausentes' });

    const ok = verifySig(payload, sig);
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid-signature' });

    const data = safeJsonParse(payload);
    if (!data?.id) return res.status(400).json({ ok: false, error: 'payload inválido' });

    const fromDb = await getOrder(data.id);
    if (!fromDb) return res.status(404).json({ ok: false, error: 'order-not-found' });

    return res.json({ ok: true, order: data, status: fromDb.status, usedAt: fromDb.usedAt || null });
  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ ok: false, error: 'Erro ao verificar QR' });
  }
});

// ========= SCAN (valida e marca como USADO) =========
app.post(both('/api/scan'), async (req, res) => {
  try {
    let payload = req.body?.payload;
    let sig = req.body?.sig;

    if (!payload || !sig) {
      const raw = req.body?.qrData;
      const obj = typeof raw === 'string' ? safeJsonParse(raw) : raw;
      if (obj && obj.payload && obj.sig) {
        payload = obj.payload;
        sig = obj.sig;
      }
    }
    if (!payload || !sig) return res.status(400).json({ ok: false, error: 'payload/sig ausentes' });

    if (!verifySig(payload, sig)) {
      return res.status(401).json({ ok: false, error: 'invalid-signature' });
    }

    const data = safeJsonParse(payload);
    if (!data?.id) return res.status(400).json({ ok: false, error: 'payload inválido' });

    const order = await getOrder(data.id);
    if (!order) return res.status(404).json({ ok: false, error: 'order-not-found' });

    if (order.status === 'used') {
      return res.status(409).json({ ok: false, error: 'already-used', usedAt: order.usedAt });
    }

    const usedAt = new Date().toISOString();
    const updated = { ...order, status: 'used', usedAt };
    await kv.set(`order:${order.id}`, updated);

    // índice opcional por uso
    await kv.zadd('orders:usedByTime', { score: Date.now(), member: order.id });

    return res.json({ ok: true, order: updated });
  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ ok: false, error: 'Erro ao escanear QR' });
  }
});

// ========= ADMIN: LISTAR =========
app.get(both('/api/admin/orders'), requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 50));
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

// ========= ADMIN: BUSCAR =========
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

// ========= ADMIN: EXPORT CSV =========
app.get(both('/api/admin/export.csv'), requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(10000, Number(req.query.limit) || 1000));
    const ids = await kv.zrevrange('orders:byTime', 0, limit - 1);
    const rows = [];
    rows.push(['id', 'name', 'email', 'ticketType', 'status', 'createdAt', 'usedAt'].join(','));
    for (const id of ids) {
      const o = await getOrder(id);
      if (!o) continue;
      const line = [
        o.id,
        JSON.stringify(o.name ?? ''),   // aspas seguras
        JSON.stringify(o.email ?? ''),
        o.ticketType ?? '',
        o.status ?? '',
        o.createdAt ? asISO(o.createdAt) : '',
        o.usedAt ? asISO(o.usedAt) : ''
      ].join(',');
      rows.push(line);
    }
    const csv = rows.join('\n');
    const filename = `orders-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  } catch (err) {
    console.error('Export CSV error:', err);
    return res.status(500).send('Erro ao exportar CSV');
  }
});

// ========= EXPORT APP p/ Vercel =========
module.exports = app;
