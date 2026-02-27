#!/usr/bin/env node
// Oslo Transit Collector — samples 26 stops across Oslo, stores per-stop + per-area stats.

const https  = require('https');
const REPO   = 'PiE-Derby/oslo-on-time';
const GH_TOKEN = process.env.GH_TOKEN;

// 26 stops across 10 Oslo districts
const STOPS = {
  'NSR:StopPlace:59872': { name: 'Oslo S',           area: 'Sentrum',             lat: 59.91040, lon: 10.75310 },
  'NSR:StopPlace:58404': { name: 'Nationaltheatret', area: 'Sentrum',             lat: 59.91500, lon: 10.73220 },
  'NSR:StopPlace:4029':  { name: 'Stortinget',       area: 'Sentrum',             lat: 59.91340, lon: 10.74330 },
  'NSR:StopPlace:58243': { name: 'Jernbanetorget',   area: 'Sentrum',             lat: 59.91190, lon: 10.75040 },
  'NSR:StopPlace:58259': { name: 'Schous plass',     area: 'Grünerløkka',         lat: 59.92080, lon: 10.75930 },
  'NSR:StopPlace:58258': { name: 'Olaf Ryes plass',  area: 'Grünerløkka',         lat: 59.92290, lon: 10.75920 },
  'NSR:StopPlace:58189': { name: 'Carl Berners plass',area:'Grünerløkka',         lat: 59.92610, lon: 10.77630 },
  'NSR:StopPlace:58381': { name: 'Majorstuen',       area: 'Frogner/Majorstuen',  lat: 59.92920, lon: 10.71630 },
  'NSR:StopPlace:58356': { name: 'Frogner plass',    area: 'Frogner/Majorstuen',  lat: 59.92220, lon: 10.70490 },
  'NSR:StopPlace:58256': { name: 'Torshov',          area: 'Sagene',              lat: 59.93500, lon: 10.76490 },
  'NSR:StopPlace:6369':  { name: 'Bjølsen',          area: 'Sagene',              lat: 59.94260, lon: 10.75960 },
  'NSR:StopPlace:59516': { name: 'Helsfyr',          area: 'Østre Aker',          lat: 59.91270, lon: 10.80110 },
  'NSR:StopPlace:58197': { name: 'Brynseng',         area: 'Østre Aker',          lat: 59.90940, lon: 10.81350 },
  'NSR:StopPlace:58265': { name: 'Ullevål stadion',  area: 'Nordre Aker',         lat: 59.94800, lon: 10.73250 },
  'NSR:StopPlace:58273': { name: 'Smestad',          area: 'Nordre Aker',         lat: 59.93730, lon: 10.68400 },
  'NSR:StopPlace:6332':  { name: 'Blindern',         area: 'Nordre Aker',         lat: 59.94020, lon: 10.71620 },
  'NSR:StopPlace:63284': { name: 'Løren',            area: 'Bjerke',              lat: 59.92950, lon: 10.79130 },
  'NSR:StopPlace:59704': { name: 'Vollebekk',        area: 'Bjerke',              lat: 59.93610, lon: 10.83200 },
  'NSR:StopPlace:58216': { name: 'Grorud',           area: 'Grorud',              lat: 59.96120, lon: 10.88250 },
  'NSR:StopPlace:5780':  { name: 'Romsås',           area: 'Grorud',              lat: 59.96250, lon: 10.89270 },
  'NSR:StopPlace:59518': { name: 'Ammerud',          area: 'Grorud',              lat: 59.95770, lon: 10.87180 },
  'NSR:StopPlace:58228': { name: 'Mortensrud',       area: 'Søndre Nordstrand',   lat: 59.84940, lon: 10.82940 },
  'NSR:StopPlace:58245': { name: 'Lambertseter',     area: 'Søndre Nordstrand',   lat: 59.87350, lon: 10.81030 },
  'NSR:StopPlace:59635': { name: 'Hauketo',          area: 'Søndre Nordstrand',   lat: 59.84600, lon: 10.80310 },
  'NSR:StopPlace:59762': { name: 'Ensjø',            area: 'Gamle Oslo',          lat: 59.91410, lon: 10.78730 },
  'NSR:StopPlace:58248': { name: 'Ryen',             area: 'Gamle Oslo',          lat: 59.89550, lon: 10.80480 },
};

function req(options, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    if (data) options.headers['Content-Length'] = data.length;
    const r = https.request(options, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch(e) { reject(e); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function enturQuery(stopId) {
  return JSON.stringify({ query: `{
    stopPlace(id: "${stopId}") {
      estimatedCalls(timeRange: 600, numberOfDepartures: 30) {
        realtime cancellation aimedDepartureTime expectedDepartureTime
        serviceJourney { journeyPattern { line { transportMode } } }
      }
    }
  }` });
}

function tally(calls) {
  let total=0, onTime=0, delayed=0, cancelled=0;
  const modes = {};
  for (const c of calls) {
    if (!c.realtime) continue;
    total++;
    const mode = c.serviceJourney?.journeyPattern?.line?.transportMode ?? 'unknown';
    if (!modes[mode]) modes[mode] = {total:0,onTime:0,delayed:0,cancelled:0};
    modes[mode].total++;
    if (c.cancellation) {
      cancelled++; modes[mode].cancelled++;
    } else {
      const diff = Math.round((new Date(c.expectedDepartureTime) - new Date(c.aimedDepartureTime)) / 60000);
      if (diff > 1) { delayed++; modes[mode].delayed++; }
      else          { onTime++;  modes[mode].onTime++;  }
    }
  }
  return { total, onTime, delayed, cancelled, modes };
}

async function fetchStop(id) {
  const r = await req({
    hostname: 'api.entur.io', path: '/journey-planner/v3/graphql', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'ET-Client-Name': 'pie-derby-oslostat' }
  }, enturQuery(id));
  return r.body?.data?.stopPlace?.estimatedCalls ?? [];
}

async function getStats() {
  const r = await req({
    hostname: 'api.github.com', path: `/repos/${REPO}/contents/data/stats.json`,
    method: 'GET',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'User-Agent': 'pie-derby', Accept: 'application/vnd.github+json' }
  });
  if (r.status !== 200) return { sha: null, db: { stops: STOPS, history: [] } };
  const content = Buffer.from(r.body.content, 'base64').toString('utf8');
  return { sha: r.body.sha, db: JSON.parse(content) };
}

async function putStats(db, sha) {
  const content = Buffer.from(JSON.stringify(db)).toString('base64');
  const r = await req({
    hostname: 'api.github.com', path: `/repos/${REPO}/contents/data/stats.json`,
    method: 'PUT',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'User-Agent': 'pie-derby', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
  }, JSON.stringify({ message: `stats: ${new Date().toUTCString()}`, content, ...(sha ? { sha } : {}) }));
  return r.status === 200 || r.status === 201;
}

async function main() {
  const stopStats = {};
  let globalTotal=0, globalOnTime=0, globalDelayed=0, globalCancelled=0;
  const globalModes = {};

  for (const [id] of Object.entries(STOPS)) {
    try {
      const calls = await fetchStop(id);
      const t = tally(calls);
      stopStats[id] = { total: t.total, onTime: t.onTime, delayed: t.delayed, cancelled: t.cancelled };
      globalTotal     += t.total;
      globalOnTime    += t.onTime;
      globalDelayed   += t.delayed;
      globalCancelled += t.cancelled;
      for (const [m, v] of Object.entries(t.modes)) {
        if (!globalModes[m]) globalModes[m] = {total:0,onTime:0,delayed:0,cancelled:0};
        for (const k of ['total','onTime','delayed','cancelled']) globalModes[m][k] += v[k]||0;
      }
    } catch(e) { console.error(`Failed ${id}:`, e.message); }
  }

  if (globalTotal === 0) { console.log('No data.'); return; }

  const point = {
    t: Math.floor(Date.now() / 1000),
    total: globalTotal, onTime: globalOnTime, delayed: globalDelayed, cancelled: globalCancelled,
    modes: globalModes,
    stops: stopStats,
  };

  const { sha, db } = await getStats();
  db.stops = STOPS; // always keep stop metadata fresh
  db.history.push(point);
  if (db.history.length > 1000) db.history = db.history.slice(-1000);
  db.updated = new Date().toISOString();

  const ok = await putStats(db, sha);
  const pct = Math.round(globalOnTime / globalTotal * 100);
  console.log(`${ok?'✓':'✗'} ${new Date().toISOString()} — ${pct}% i rute (${globalOnTime}/${globalTotal}, ${globalDelayed} forsinket, ${globalCancelled} innstilt)`);
}

main().catch(e => { console.error(e); process.exit(1); });
