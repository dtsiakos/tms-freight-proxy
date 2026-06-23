
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
 
const app = express();
const PORT = process.env.PORT || 3000;
const TMS_BASE = 'https://restapiv7.tmssaas.com';
const SHIPPO_TOKEN = process.env.SHIPPO_TOKEN;
const TMS_USER = process.env.TMS_USER || 'RatingTool';
const TMS_PASS = process.env.TMS_PASSWORD || '';
const TMS_SRV_TOKEN = process.env.TMS_SRV_TOKEN || '';
const ADMIN_USERS = (process.env.ADMIN_USERS || 'DT').split(',').map(u => u.trim());
 
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4
}) : null;
 
const sessions = {};
 
function getUsers() {
  const raw = process.env.USERS || '';
  const users = {};
  raw.split(',').forEach(pair => {
    const idx = pair.indexOf(':');
    if (idx > 0) {
      const u = pair.slice(0, idx).trim();
      const p = pair.slice(idx + 1).trim();
      if (u && p) users[u] = p;
    }
  });
  return users;
}
 
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (token && sessions[token] && sessions[token].expires > Date.now()) {
    req.username = sessions[token].username;
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
 
function requireAdmin(req, res, next) {
  if (ADMIN_USERS.includes(req.username)) {
    next();
  } else {
    res.status(403).json({ error: 'Admin access required' });
  }
}
 
async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipment (
        id SERIAL PRIMARY KEY,
        model VARCHAR(50) UNIQUE NOT NULL,
        weight INTEGER,
        dim_l NUMERIC(8,2),
        dim_w NUMERIC(8,2),
        dim_h NUMERIC(8,2),
        liftgate BOOLEAN,
        carrier VARCHAR(10) DEFAULT 'ltl',
        ups_weight INTEGER,
        ups_dim_l NUMERIC(8,2),
        ups_dim_w NUMERIC(8,2),
        ups_dim_h NUMERIC(8,2),
        cost NUMERIC(10,2),
        freight_class VARCHAR(10),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Add new columns to existing databases
    await pool.query(`ALTER TABLE equipment ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2)`);
 
    await pool.query(`ALTER TABLE equipment ADD COLUMN IF NOT EXISTS freight_class VARCHAR(10)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await pool.query(`INSERT INTO settings (key, value) VALUES ('default_origin_zip', '03079') ON CONFLICT (key) DO NOTHING`);
    await pool.query(`INSERT INTO settings (key, value) VALUES ('default_freight_class', '70') ON CONFLICT (key) DO NOTHING`);
    console.log('Database ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}
 
app.use(cors());
app.use(express.json());
 
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/tool', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));
 
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  if (users[username] && users[username] === password) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = { username, expires: Date.now() + 8 * 60 * 60 * 1000 };
    console.log('Login:', username);
    res.json({ token, username, isAdmin: ADMIN_USERS.includes(username) });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});
 
app.post('/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) delete sessions[token];
  res.json({ ok: true });
});
 
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.json({});
    const result = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/api/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
    res.json({ ok: true, key, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/api/equipment', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    const result = await pool.query('SELECT * FROM equipment ORDER BY model ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.put('/api/equipment/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { model, weight, dim_l, dim_w, dim_h, liftgate, carrier,
            ups_weight, ups_dim_l, ups_dim_w, ups_dim_h,
            cost, freight_class } = req.body;
    const result = await pool.query(
      `UPDATE equipment SET model=$1, weight=$2, dim_l=$3, dim_w=$4, dim_h=$5,
       liftgate=$6, carrier=$7, ups_weight=$8, ups_dim_l=$9, ups_dim_w=$10, ups_dim_h=$11,
       cost=$12, freight_class=$13,
       updated_at=NOW() WHERE id=$14 RETURNING *`,
      [model, weight||null, dim_l||null, dim_w||null, dim_h||null,
       liftgate, carrier, ups_weight||null, ups_dim_l||null, ups_dim_w||null, ups_dim_h||null,
       cost||null, freight_class||null,
       req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/api/equipment', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { model, weight, dim_l, dim_w, dim_h, liftgate, carrier,
            ups_weight, ups_dim_l, ups_dim_w, ups_dim_h,
            cost, freight_class } = req.body;
    const result = await pool.query(
      `INSERT INTO equipment (model, weight, dim_l, dim_w, dim_h, liftgate, carrier,
       ups_weight, ups_dim_l, ups_dim_w, ups_dim_h, cost, freight_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [model, weight||null, dim_l||null, dim_w||null, dim_h||null,
       liftgate||false, carrier||'ltl',
       ups_weight||null, ups_dim_l||null, ups_dim_w||null, ups_dim_h||null,
       cost||null, freight_class||null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.delete('/api/equipment/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM equipment WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/api/equipment/seed', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { items } = req.body;
    let count = 0;
    for (const item of items) {
      const p = item.dims ? item.dims.split('x') : [];
      const up = item.upsDims ? item.upsDims.split('x') : [];
      await pool.query(
        `INSERT INTO equipment (model, weight, dim_l, dim_w, dim_h, liftgate, carrier, ups_weight, ups_dim_l, ups_dim_w, ups_dim_h)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (model) DO NOTHING`,
        [item.model, item.weight||null, p[0]||null, p[1]||null, p[2]||null,
         item.liftgate||false, item.carrier||'ltl',
         item.upsWeight||null, up[0]||null, up[1]||null, up[2]||null]
      );
      count++;
    }
    res.json({ seeded: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/login', requireAuth, async (req, res) => {
  try {
    const response = await fetch(TMS_BASE + '/ShipmentLiteService/Login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ userName: TMS_USER, password: TMS_PASS, srvToken: TMS_SRV_TOKEN })
    });
    const data = await response.text();
    const token = data.replace(/^"|"$/g, '').trim();
    res.status(response.status).send(JSON.stringify(token));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/rates', requireAuth, async (req, res) => {
  try {
    const token = req.headers['usertoken'] || '';
    const rateBody = Object.assign({}, req.body, {
      UsrToken: token,
      SrvToken: TMS_SRV_TOKEN,
      ProfileCode: process.env.TMS_PROFILE_CODE || '',
      ClientCode: process.env.TMS_CLIENT_CODE || ''
    });
    const response = await fetch(TMS_BASE + '/ShipmentLiteService/GetLTLRates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(rateBody)
    });
    const data = await response.text();
    res.status(response.status).send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/ups-rates', requireAuth, async (req, res) => {
  try {
    const { origZip, destZip, weight, length, width, height } = req.body;
    const shipment = {
      address_from: { zip: origZip, country: 'US' },
      address_to: { zip: destZip, country: 'US' },
      parcels: [{ length: String(length||12), width: String(width||12), height: String(height||12), distance_unit: 'in', weight: String(weight||1), mass_unit: 'lb' }],
      async: false
    };
    let data, response;
    for (let attempt = 0; attempt < 5; attempt++) {
      response = await fetch('https://api.goshippo.com/shipments/', {
        method: 'POST',
        headers: { 'Authorization': 'ShippoToken ' + SHIPPO_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(shipment)
      });
      data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data });
      if ((data.rates||[]).filter(r => r.provider==='UPS').length > 0) break;
      if (attempt < 4) await new Promise(r => setTimeout(r, 3000));
    }
    const UPS_SERVICES = { 'ups_ground':'UPS Ground','ups_3_day_select':'UPS 3-Day Select','ups_second_day_air':'UPS 2nd Day Air','ups_next_day_air_saver':'UPS Next Day Air Saver','ups_next_day_air':'UPS Next Day Air','ups_next_day_air_early_am':'UPS Next Day Air Early' };
    const SERVICE_ORDER = ['ups_ground','ups_3_day_select','ups_second_day_air','ups_next_day_air_saver','ups_next_day_air','ups_next_day_air_early_am'];
    const rates = (data.rates||[]).filter(r=>r.provider==='UPS'&&UPS_SERVICES[r.servicelevel.token]).map(r=>({ service:UPS_SERVICES[r.servicelevel.token], token:r.servicelevel.token, amount:parseFloat(r.amount), currency:r.currency, days:r.estimated_days })).sort((a,b)=>SERVICE_ORDER.indexOf(a.token)-SERVICE_ORDER.indexOf(b.token));
    res.json({ rates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/health', (req, res) => res.json({ status: 'ok' }));
 
initDB().then(() => app.listen(PORT, () => console.log('TMS proxy running on port ' + PORT)));
