function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function checkToken(req) {
  const configured = process.env.DASHBOARD_TOKEN || '';
  if (!configured) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerToken = req.headers['x-dashboard-token'] || '';
  return bearer === configured || headerToken === configured;
}

export default async function handler(req, res) {
  try {
    if (!checkToken(req)) return json(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

    const gasUrl = requireEnv('GAS_API_URL').replace(/\?.*$/, '');
    const gasKey = requireEnv('GAS_API_KEY');

    const params = new URLSearchParams({ key: gasKey, action: 'operations' });
    const date = req.query?.date;
    const nocache = req.query?.nocache;
    if (date) params.set('date', String(date));
    if (nocache) params.set('nocache', '1');

    const upstream = await fetch(`${gasUrl}?${params.toString()}`, {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'application/json' }
    });

    const text = await upstream.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: 'invalid GAS response', body: text.slice(0, 500) }; }
    }
    if (!upstream.ok) {
      return json(res, 502, { error: `GAS ${upstream.status}`, detail: data });
    }
    if (data && data.error) {
      return json(res, 502, { error: data.error, detail: data });
    }
    return json(res, 200, data || { error: 'empty GAS response' });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}
