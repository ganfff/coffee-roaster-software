import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.env.ROASTER_SIM_PORT || 8000);
const scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.split('=')[1] || 'roasting';
const freeze = process.argv.includes('--freeze');

const profiles = [
  {
    id: 'ethiopia-natural-medium-dark',
    name: '中深烘 · 日晒耶加雪菲',
    description: '焦糖、莓果与可可，适合浓缩和奶咖。',
    end_temp: 214,
    nodes: [
      { time: 0, temperature: 28 }, { time: 60, temperature: 62 },
      { time: 120, temperature: 99 }, { time: 195, temperature: 145 },
      { time: 342, temperature: 170.6 }, { time: 430, temperature: 195 },
      { time: 520, temperature: 207 },
      { time: 620, temperature: 214 },
    ],
  },
  {
    id: 'colombia-washed-medium', name: '中烘 · 水洗哥伦比亚', description: '坚果、红糖与平衡酸质。', end_temp: 208,
    nodes: [{ time: 0, temperature: 28 }, { time: 70, temperature: 66 }, { time: 210, temperature: 148 }, { time: 420, temperature: 192 }, { time: 590, temperature: 208 }],
  },
  {
    id: 'kenya-light-filter', name: '浅烘 · 肯尼亚手冲', description: '黑加仑、柑橘与清晰甜感。', end_temp: 202,
    nodes: [{ time: 0, temperature: 27 }, { time: 70, temperature: 63 }, { time: 225, temperature: 144 }, { time: 455, temperature: 190 }, { time: 635, temperature: 202 }],
  },
];

function interpolate(nodes, time) {
  if (time <= nodes[0].time) return nodes[0].temperature;
  for (let index = 1; index < nodes.length; index += 1) {
    const current = nodes[index];
    const previous = nodes[index - 1];
    if (time <= current.time) {
      const ratio = (time - previous.time) / Math.max(1, current.time - previous.time);
      return previous.temperature + ratio * (current.temperature - previous.temperature);
    }
  }
  return nodes.at(-1).temperature;
}

function makeRecord(index, profile, offsetDays) {
  const duration = profile.nodes.at(-1).time;
  const data = [];
  for (let time = 0; time <= duration; time += 5) {
    const sv = interpolate(profile.nodes, time);
    const ror = Math.max(3.2, 19.5 - time / 45) + Math.sin(time / 48 + index) * 0.35;
    const pv = sv - Math.max(1.1, 4.4 - time / 155) + Math.sin(time / 35 + index) * 0.5;
    data.push([time, Number(pv.toFixed(1)), Number(sv.toFixed(1)), Number(ror.toFixed(1))]);
  }
  const startedAt = new Date(Date.now() - offsetDays * 86400000).toISOString();
  return {
    session_id: `sim-record-${index}`,
    seq_no: 20 - index,
    display_name: `log${String(20 - index).padStart(3, '0')}`,
    profile_id: profile.id,
    profile_name: profile.name,
    started_at: startedAt,
    duration_sec: duration,
    end_temp: profile.end_temp,
    data,
    events: [
      { type: 'charge', time: 0, temperature: data[0][1] },
      { type: 'yellowing', time: 195 + index * 4, temperature: 145 + index },
      { type: 'first_crack', time: 430 + index * 3, temperature: 196 + index * 0.5 },
      { type: 'drop', time: duration, temperature: profile.end_temp - 1 + index * 0.3 },
    ],
    profile_snapshot: profile,
  };
}

const records = [
  makeRecord(0, profiles[0], 1), makeRecord(1, profiles[1], 4),
  makeRecord(2, profiles[2], 9), makeRecord(3, profiles[0], 16),
];

let currentProfile = profiles[0];
let stateName = scenario === 'idle' ? 'IDLE' : scenario === 'error' ? 'ERROR' : scenario === 'cooling' ? 'COOLING' : 'ROASTING';
let elapsed = stateName === 'IDLE' ? 0 : 342;
let sessionId = 'sim-live-session';
let errorReason = stateName === 'ERROR' ? '模拟器：TC4S 通信超时' : null;
let liveEvents = [{ type: 'charge', time: 0, temperature: 197.2 }, { type: 'yellowing', time: 195, temperature: 145.1 }];
if (stateName === 'COOLING') liveEvents.push({ type: 'first_crack', time: 430, temperature: 196.2 }, { type: 'drop', time: 620, temperature: 213.4 });

function currentPhase(time = elapsed) {
  if (stateName === 'IDLE') return 'idle';
  if (stateName === 'COOLING') return 'cooling';
  if (time < 195) return 'drying';
  if (time < 430) return 'maillard';
  return 'development';
}

function makeState(time = elapsed) {
  const sv = interpolate(currentProfile.nodes, time);
  const pv = sv - Math.max(1.1, 4.4 - time / 155) + Math.sin(time / 26) * 0.28;
  const ror = Math.max(3.2, 19.5 - time / 45) + Math.sin(time / 48) * 0.35;
  const visibleEvents = liveEvents.filter(event => event.time <= time || stateName !== 'ROASTING');
  const segmentTimes = {};
  const segmentRatios = {};
  if (visibleEvents.some(event => event.type === 'yellowing')) {
    segmentTimes['脱水期'] = 195;
    segmentRatios['脱水期'] = 31.5;
  }
  if (visibleEvents.some(event => event.type === 'first_crack')) {
    segmentTimes['梅纳期'] = 235;
    segmentRatios['梅纳期'] = 37.9;
  }
  if (visibleEvents.some(event => event.type === 'drop')) {
    segmentTimes['发展期'] = 190;
    segmentRatios['发展期'] = 30.6;
  }
  return {
    state: stateName,
    pv: Number(pv.toFixed(1)), sv: Number(sv.toFixed(1)), ror: Number(ror.toFixed(1)),
    elapsed: Math.max(0, Math.round(time)),
    profile_id: currentProfile.id, profile_name: currentProfile.name,
    session_id: sessionId,
    events: visibleEvents,
    event_stats: { segment_times: segmentTimes, segment_ratios: segmentRatios },
    connected: stateName !== 'ERROR', error_reason: errorReason,
    lookahead_used: 1.4, lookahead_offset: 0,
    current_phase: currentPhase(time),
    phase_lookahead_config: { drying: 1, maillard: 0.5, development: 1 },
  };
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise(resolve => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

function resetIdle() {
  stateName = 'IDLE'; elapsed = 0; liveEvents = []; errorReason = null;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `localhost:${port}`}`);
  if (request.method === 'OPTIONS') return json(response, 204, {});
  if (url.pathname === '/api/v1/status') return json(response, 200, makeState());
  if (url.pathname === '/api/v1/profiles' && request.method === 'GET') {
    return json(response, 200, profiles.map(({ nodes, ...summary }) => ({ ...summary, node_count: nodes.length })));
  }
  if (url.pathname === '/api/v1/profiles/import' && request.method === 'POST') {
    const raw = await readBody(request);
    try {
      const imported = JSON.parse(raw);
      const id = imported.id || `imported-${Date.now()}`;
      profiles.push({ ...imported, id });
      return json(response, 200, { success: true, id });
    } catch { return json(response, 400, { success: false, error: 'invalid json' }); }
  }
  const profileMatch = url.pathname.match(/^\/api\/v1\/profiles\/([^/]+)(?:\/(export))?$/);
  if (profileMatch) {
    const profile = profiles.find(item => item.id === decodeURIComponent(profileMatch[1]));
    if (!profile) return json(response, 404, { error: 'profile not found' });
    if (request.method === 'DELETE') {
      const index = profiles.indexOf(profile);
      if (index >= 0) profiles.splice(index, 1);
      return json(response, 200, { success: true });
    }
    return json(response, 200, profile, profileMatch[2] ? { 'Content-Disposition': `attachment; filename="${profile.id}.json"` } : {});
  }
  if (url.pathname === '/api/v1/records') {
    return json(response, 200, records.map(({ data, events, profile_snapshot, ...summary }) => summary));
  }
  const recordMatch = url.pathname.match(/^\/api\/v1\/records\/([^/]+)(?:\/export\/(csv|json))?$/);
  if (recordMatch) {
    const record = records.find(item => item.session_id === decodeURIComponent(recordMatch[1]));
    if (!record) return json(response, 404, { error: 'record not found' });
    if (recordMatch[2] === 'csv') {
      const csv = ['time,pv,sv,ror', ...record.data.map(row => row.join(','))].join('\n');
      response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return response.end(csv);
    }
    return json(response, 200, record);
  }
  if (url.pathname.startsWith('/api/v1/control/') && request.method === 'POST') {
    const action = url.pathname.split('/').at(-1);
    if (action === 'start') { stateName = 'ROASTING'; elapsed = 0; liveEvents = [{ type: 'charge', time: 0, temperature: 197.2 }]; errorReason = null; sessionId = `sim-${Date.now()}`; }
    if (action === 'end') stateName = 'COOLING';
    if (action === 'save_and_clear' || action === 'discard_and_clear') resetIdle();
    if (action === 'emergency_stop') { stateName = stateName === 'ERROR' ? 'IDLE' : 'ERROR'; errorReason = stateName === 'ERROR' ? '模拟器：已触发急停' : null; }
    return json(response, 200, { success: true });
  }
  return json(response, 404, { error: 'not found' });
});

const webSockets = new WebSocketServer({ server, path: '/ws' });
function broadcast() {
  const payload = JSON.stringify(makeState());
  for (const client of webSockets.clients) if (client.readyState === 1) client.send(payload);
}

webSockets.on('connection', socket => {
  if (stateName === 'ROASTING' && elapsed > 0) {
    for (let time = 0; time < elapsed; time += 5) socket.send(JSON.stringify(makeState(time)));
  }
  socket.send(JSON.stringify(makeState()));
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return socket.send(JSON.stringify({ error: '消息格式错误' })); }
    const command = message.cmd;
    if (command === 'start') {
      const selected = profiles.find(profile => profile.id === message.profile_id);
      if (selected) currentProfile = selected;
      stateName = 'ROASTING'; elapsed = 0; liveEvents = [{ type: 'charge', time: 0, temperature: 197.2 }]; errorReason = null; sessionId = `sim-${Date.now()}`;
    } else if (command === 'event') {
      if (!liveEvents.some(event => event.type === message.type)) liveEvents.push({ type: message.type, time: elapsed, temperature: makeState().pv });
      if (message.type === 'drop') stateName = 'COOLING';
    } else if (command === 'end') stateName = 'COOLING';
    else if (command === 'save_and_clear' || command === 'discard_and_clear') resetIdle();
    else if (command === 'emergency_stop') {
      if (stateName === 'ERROR') resetIdle();
      else { stateName = 'ERROR'; errorReason = '模拟器：已触发急停'; }
    } else if (command && command.startsWith('set_')) {
      socket.send(JSON.stringify({ ok: true }));
      return;
    } else {
      socket.send(JSON.stringify({ error: `未知命令：${command || '空'}` }));
      return;
    }
    broadcast();
  });
});

const timer = setInterval(() => {
  if (!freeze && stateName === 'ROASTING') elapsed += 0.5;
  if (!freeze && stateName === 'COOLING') elapsed += 0.5;
  broadcast();
}, 500);

server.listen(port, '127.0.0.1', () => {
  const mode = freeze ? 'frozen' : 'live';
  console.log(`Roaster simulator ready at http://127.0.0.1:${port} (${scenario}, ${mode}); no hardware access.`);
});

function shutdown() {
  clearInterval(timer);
  webSockets.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
