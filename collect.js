#!/usr/bin/env node
// Fetches current departures from Oslo transit hubs and records punctuality stats.
// Appends one data point to data/stats.json, keeps last 1000 samples (~10 days at 15 min intervals).

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const STOPS = [
  'NSR:StopPlace:59872',  // Oslo S
  'NSR:StopPlace:58404',  // Nationaltheatret
  'NSR:StopPlace:58381',  // Majorstuen
  'NSR:StopPlace:4029',   // Stortinget
  'NSR:StopPlace:58243',  // Jernbanetorget
];

const QUERY = (stopId) => JSON.stringify({ query: `{
  stopPlace(id: "${stopId}") {
    name
    estimatedCalls(timeRange: 600, numberOfDepartures: 40) {
      realtime
      cancellation
      aimedDepartureTime
      expectedDepartureTime
      serviceJourney {
        journeyPattern { line { publicCode transportMode } }
      }
    }
  }
}` });

function post(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = https.request({
      hostname: 'api.entur.io',
      path: '/journey-planner/v3/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'ET-Client-Name': 'pie-derby-oslostat',
      }
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  let total = 0, onTime = 0, delayed = 0, cancelled = 0;
  const byMode = {};

  for (const stopId of STOPS) {
    try {
      const res = await post(QUERY(stopId));
      const calls = res?.data?.stopPlace?.estimatedCalls ?? [];
      for (const c of calls) {
        if (!c.realtime) continue; // skip non-realtime entries
        total++;
        const mode = c.serviceJourney?.journeyPattern?.line?.transportMode ?? 'unknown';
        if (!byMode[mode]) byMode[mode] = { total: 0, onTime: 0, delayed: 0, cancelled: 0 };
        byMode[mode].total++;

        if (c.cancellation) {
          cancelled++;
          byMode[mode].cancelled++;
        } else if (c.aimedDepartureTime !== c.expectedDepartureTime) {
          const diffMs = new Date(c.expectedDepartureTime) - new Date(c.aimedDepartureTime);
          const diffMin = Math.round(diffMs / 60000);
          if (diffMin > 1) { // >1 min late counts as delayed
            delayed++;
            byMode[mode].delayed++;
          } else {
            onTime++;
            byMode[mode].onTime++;
          }
        } else {
          onTime++;
          byMode[mode].onTime++;
        }
      }
    } catch(e) {
      console.error(`Failed ${stopId}:`, e.message);
    }
  }

  if (total === 0) {
    console.log('No realtime data available, skipping write.');
    process.exit(0);
  }

  const point = {
    t: Math.floor(Date.now() / 1000),
    total, onTime, delayed, cancelled,
    modes: byMode,
  };

  const statsPath = path.join(__dirname, 'data', 'stats.json');
  let db = { updated: null, history: [] };
  try { db = JSON.parse(fs.readFileSync(statsPath, 'utf8')); } catch {}

  db.history.push(point);
  if (db.history.length > 1000) db.history = db.history.slice(-1000);
  db.updated = new Date().toISOString();

  fs.writeFileSync(statsPath, JSON.stringify(db));

  const pct = total > 0 ? Math.round(onTime / total * 100) : 0;
  console.log(`✓ ${new Date().toISOString()} — ${pct}% on time (${onTime}/${total}, ${delayed} delayed, ${cancelled} cancelled)`);
}

main().catch(e => { console.error(e); process.exit(1); });
