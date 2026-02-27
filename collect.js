#!/usr/bin/env node
// Fetches current departures from Oslo transit hubs, records punctuality stats,
// and updates data/stats.json in the GitHub repo via the Contents API.

const https  = require('https');
const REPO   = 'PiE-Derby/oslo-on-time';
const GH_TOKEN = process.env.GH_TOKEN;

const STOPS = [
  'NSR:StopPlace:59872',  // Oslo S
  'NSR:StopPlace:58404',  // Nationaltheatret
  'NSR:StopPlace:58381',  // Majorstuen
  'NSR:StopPlace:4029',   // Stortinget
  'NSR:StopPlace:58243',  // Jernbanetorget
];

function request(options, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    if (data) options.headers['Content-Length'] = data.length;
    const req = https.request(options, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function enturQuery(stopId) {
  return JSON.stringify({ query: `{
    stopPlace(id: "${stopId}") {
      estimatedCalls(timeRange: 600, numberOfDepartures: 40) {
        realtime cancellation aimedDepartureTime expectedDepartureTime
        serviceJourney { journeyPattern { line { transportMode } } }
      }
    }
  }` });
}

async function fetchStop(stopId) {
  const r = await request({
    hostname: 'api.entur.io', path: '/journey-planner/v3/graphql', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'ET-Client-Name': 'pie-derby-oslostat' }
  }, enturQuery(stopId));
  return r.body?.data?.stopPlace?.estimatedCalls ?? [];
}

async function getStats() {
  const r = await request({
    hostname: 'api.github.com',
    path: `/repos/${REPO}/contents/data/stats.json`,
    method: 'GET',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'User-Agent': 'pie-derby', Accept: 'application/vnd.github+json' }
  });
  if (r.status !== 200) return { sha: null, db: { updated: null, history: [] } };
  const content = Buffer.from(r.body.content, 'base64').toString('utf8');
  return { sha: r.body.sha, db: JSON.parse(content) };
}

async function putStats(db, sha) {
  const content = Buffer.from(JSON.stringify(db)).toString('base64');
  const body = JSON.stringify({
    message: `stats: ${new Date().toUTCString()}`,
    content,
    ...(sha ? { sha } : {})
  });
  const r = await request({
    hostname: 'api.github.com',
    path: `/repos/${REPO}/contents/data/stats.json`,
    method: 'PUT',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'User-Agent': 'pie-derby', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
  }, body);
  return r.status === 200 || r.status === 201;
}

async function main() {
  let total = 0, onTime = 0, delayed = 0, cancelled = 0;
  const byMode = {};

  for (const stopId of STOPS) {
    try {
      const calls = await fetchStop(stopId);
      for (const c of calls) {
        if (!c.realtime) continue;
        total++;
        const mode = c.serviceJourney?.journeyPattern?.line?.transportMode ?? 'unknown';
        if (!byMode[mode]) byMode[mode] = { total: 0, onTime: 0, delayed: 0, cancelled: 0 };
        byMode[mode].total++;
        if (c.cancellation) {
          cancelled++; byMode[mode].cancelled++;
        } else if (c.aimedDepartureTime !== c.expectedDepartureTime) {
          const diff = Math.round((new Date(c.expectedDepartureTime) - new Date(c.aimedDepartureTime)) / 60000);
          if (diff > 1) { delayed++; byMode[mode].delayed++; }
          else          { onTime++;  byMode[mode].onTime++; }
        } else {
          onTime++; byMode[mode].onTime++;
        }
      }
    } catch(e) { console.error(`Failed ${stopId}:`, e.message); }
  }

  if (total === 0) { console.log('No realtime data, skipping.'); return; }

  const point = { t: Math.floor(Date.now() / 1000), total, onTime, delayed, cancelled, modes: byMode };

  const { sha, db } = await getStats();
  db.history.push(point);
  if (db.history.length > 1000) db.history = db.history.slice(-1000);
  db.updated = new Date().toISOString();

  const ok = await putStats(db, sha);
  const pct = Math.round(onTime / total * 100);
  console.log(`${ok ? '✓' : '✗'} ${new Date().toISOString()} — ${pct}% on time (${onTime}/${total}, ${delayed} delayed, ${cancelled} cancelled)`);
}

main().catch(e => { console.error(e); process.exit(1); });
