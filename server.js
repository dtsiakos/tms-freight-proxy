const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
 
const app = express();
const PORT = process.env.PORT || 3000;
const TMS_BASE = 'https://restapiv7.tmssaas.com';
const SHIPPO_TOKEN = process.env.SHIPPO_TOKEN;
const TMS_USER = process.env.TMS_USER || 'RatingTool';
const TMS_PASS = process.env.TMS_PASSWORD || '';
const TMS_SRV_TOKEN = process.env.TMS_SRV_TOKEN || '';
 
// Users stored as env vars: USERS="TS:Univex1948!,JK:Univex1948!,..."
// Sessions stored in memory (reset on redeploy — acceptable for free tier)
const sessions = {};
 
function getUsers() {
  const raw = process.env.USERS || '';
  const users = {};
  raw.split(',').forEach(pair => {
    const [u, p] = pair.split(':');
    if (u && p) users[u.trim()] = p.trim();
  });
  return users;
}
 
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'] || req.query.token;
  if (token && sessions[token] && sessions[token].expires > Date.now()) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
 
app.use(cors());
app.use(express.json());
 
// Serve login page at root if not authenticated
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
 
// Serve freight tool - protected
app.get('/tool', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
 
// Static assets
app.use(express.static(path.join(__dirname, 'public')));
 
// Login endpoint
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const users = getUsers();
  if (users[username] && users[username] === password) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = { username, expires: Date.now() + 8 * 60 * 60 * 1000 }; // 8 hours
    console.log('Login success:', username);
    res.json({ token, username });
  } else {
    console.log('Login failed for:', username);
    res.status(401).json({ error: 'Invalid username or password' });
  }
});
 
// Logout
app.post('/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) delete sessions[token];
  res.json({ ok: true });
});
 
// TMS Login
app.post('/login', requireAuth, async (req, res) => {
  try {
    const response = await fetch(TMS_BASE + '/ShipmentLiteService/Login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ userName: TMS_USER, password: TMS_PASS, srvToken: TMS_SRV_TOKEN })
    });
    const data = await response.text();
    const token = data.replace(/^"|"$/g, '').trim();
    console.log('TMS Login status:', response.status, 'token:', token);
    res.status(response.status).send(JSON.stringify(token));
  } catch (err) {
    console.log('TMS Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
// TMS Rates
app.post('/rates', requireAuth, async (req, res) => {
  try {
    const token = req.headers['usertoken'] || '';
    const body = req.body;
    const rateBody = Object.assign({}, body, {
      UsrToken: token,
      SrvToken: TMS_SRV_TOKEN,
      ProfileCode: process.env.TMS_PROFILE_CODE || '',
      ClientCode: process.env.TMS_CLIENT_CODE || ''
    });
    console.log('TMS Rates sending UsrToken:', token);
    const response = await fetch(TMS_BASE + '/ShipmentLiteService/GetLTLRates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(rateBody)
    });
    const data = await response.text();
    console.log('TMS Rates status:', response.status, 'response:', data.slice(0, 200));
    res.status(response.status).send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// UPS Rates via Shippo
app.post('/ups-rates', requireAuth, async (req, res) => {
  try {
    const { origZip, destZip, weight, length, width, height } = req.body;
    const shipment = {
      address_from: { zip: origZip, country: 'US' },
      address_to: { zip: destZip, country: 'US' },
      parcels: [{
        length: String(length || 12),
        width: String(width || 12),
        height: String(height || 12),
        distance_unit: 'in',
        weight: String(weight || 1),
        mass_unit: 'lb'
      }],
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
      const upsRates = (data.rates || []).filter(r => r.provider === 'UPS');
      if (upsRates.length > 0) break;
      if (attempt < 4) await new Promise(r => setTimeout(r, 3000));
    }
 
    const UPS_SERVICES = {
      'ups_ground': 'UPS Ground',
      'ups_3_day_select': 'UPS 3-Day Select',
      'ups_second_day_air': 'UPS 2nd Day Air',
      'ups_next_day_air_saver': 'UPS Next Day Air Saver',
      'ups_next_day_air': 'UPS Next Day Air',
      'ups_next_day_air_early_am': 'UPS Next Day Air Early'
    };
    const SERVICE_ORDER = ['ups_ground','ups_3_day_select','ups_second_day_air','ups_next_day_air_saver','ups_next_day_air','ups_next_day_air_early_am'];
 
    const rates = (data.rates || [])
      .filter(r => r.provider === 'UPS' && UPS_SERVICES[r.servicelevel.token])
      .map(r => ({
        service: UPS_SERVICES[r.servicelevel.token] || r.servicelevel.name,
        token: r.servicelevel.token,
        amount: parseFloat(r.amount),
        currency: r.currency,
        days: r.estimated_days,
        arrives: r.arrives_by
      }))
      .sort((a, b) => SERVICE_ORDER.indexOf(a.token) - SERVICE_ORDER.indexOf(b.token));
 
    res.json({ rates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/health', (req, res) => res.json({ status: 'ok' }));
 
app.listen(PORT, () => console.log('TMS proxy running on port ' + PORT));
