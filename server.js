const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const TMS_BASE = 'https://restapiv7.tmssaas.com';

app.use(cors());
app.use(express.json());

app.post('/login', async (req, res) => {
  try {
    const response = await fetch(TMS_BASE + '/ShipmentLiteService/Login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.text();
    res.status(response.status).send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/rates', async (req, res) => {
  try {
    const token = req.headers['usertoken'] || '';
    const response = await fetch(TMS_BASE + '/ShipmentLiteService/GetLTLRates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'UserToken': token },
      body: JSON.stringify(req.body)
    });
    const data = await response.text();
    res.status(response.status).send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log('TMS proxy running on port ' + PORT));
