/**
 * 模拟烘焙机后端 —— Flutter/Tauri 前端的本机开发数据源（零 npm 依赖）。
 *
 * 用法:  node tools/mock_backend.js [端口=8000]
 *
 * 实现与树莓派 FastAPI 后端相同的 REST + WebSocket 协议，
 * 内置一个一阶滞后 + 噪声的热仿真模型：开始烘焙后温度沿目标曲线爬升，
 * 支持事件记录、出豆自动结束、保存记录、阶段统计、超前预测回显。
 */

'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 8000;
const TICK_MS = 500;

// ============ 样条（与前端 utils.js 一致） ============
function catmullRom(p0, p1, p2, p3, t) {
  return 0.5 * ((2 * p1) + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}
function splineTemp(nodes, elapsed) {
  if (!nodes.length) return 0;
  if (elapsed <= nodes[0].time) return nodes[0].temperature;
  const n = nodes.length;
  for (let i = 0; i < n - 1; i++) {
    const prev = nodes[i], curr = nodes[i + 1];
    if (prev.time <= elapsed && elapsed <= curr.time) {
      if (n < 4) {
        const r = (elapsed - prev.time) / (curr.time - prev.time);
        return prev.temperature + r * (curr.temperature - prev.temperature);
      }
      const p1 = prev.temperature, p2 = curr.temperature;
      const p0 = i === 0 ? p1 : nodes[i - 1].temperature;
      const p3 = i === n - 2 ? p2 : nodes[i + 2].temperature;
      const t = (elapsed - prev.time) / (curr.time - prev.time);
      return catmullRom(p0, p1, p2, p3, t);
    }
  }
  return nodes[n - 1].temperature;
}

// ============ 内存数据 ============
const profiles = new Map();
const defaultProfile = {
  id: 'default-light-roast',
  name: '耶加雪菲·浅焙',
  description: '7 节点默认浅焙模板',
  nodes: [
    { time: 0, temperature: 30 }, { time: 60, temperature: 100 },
    { time: 120, temperature: 135 }, { time: 180, temperature: 155 },
    { time: 270, temperature: 188 }, { time: 360, temperature: 203 },
    { time: 435, temperature: 212 },
  ],
  end_temp: 210,
};
profiles.set(defaultProfile.id, defaultProfile);

const records = [];
let recordSeq = 0;

// ============ 仿真状态机 ============
const sim = {
  state: 'IDLE',           // IDLE / ROASTING / COOLING / ERROR
  pv: 28.5,
  sv: 0,
  ror: 0,
  elapsed: 0,
  profile: null,
  sessionId: null,
  events: [],
  data: [],                // [elapsed, pv, sv, ror]
  startedAt: null,
  lookaheadOffset: 0,
  phaseLookahead: { drying: 1.0, maillard: 0.5, development: 1.0 },
  _rorSmooth: 0,
};

function currentPhase() {
  if (sim.state !== 'ROASTING') return null;
  const has = (t) => sim.events.some((e) => e.type === t);
  if (has('first_crack')) return 'development';
  if (has('yellowing')) return 'maillard';
  return 'drying';
}

function lookaheadUsed() {
  const ph = currentPhase() || 'drying';
  return (sim.phaseLookahead[ph] ?? 1.0) + sim.lookaheadOffset;
}

function eventStats() {
  const has = (t) => sim.events.find((e) => e.type === t);
  const charge = has('charge');
  if (!charge || sim.elapsed <= 0) return { total_time: 0, segment_times: {}, segment_ratios: {} };
  const y = has('yellowing');
  const fc = has('first_crack');
  const drop = has('drop');
  const end = drop ? drop.time : sim.elapsed;
  const times = {};
  times['脱水期'] = (y ? y.time : sim.elapsed) - charge.time;
  if (y) times['梅纳期'] = (fc ? fc.time : sim.elapsed) - y.time;
  if (fc) times['发展期'] = end - fc.time;
  const ratios = {};
  for (const k of Object.keys(times)) {
    ratios[k] = Math.round((times[k] / sim.elapsed) * 1000) / 10;
  }
  return { total_time: sim.elapsed, segment_times: times, segment_ratios: ratios };
}

function statePayload() {
  return {
    state: sim.state,
    pv: Math.round(sim.pv * 100) / 100,
    sv: Math.round(sim.sv * 100) / 100,
    ror: Math.round(sim.ror * 100) / 100,
    elapsed: sim.elapsed,
    profile_id: sim.profile ? sim.profile.id : null,
    profile_name: sim.profile ? sim.profile.name : null,
    session_id: sim.sessionId,
    events: sim.events,
    event_stats: eventStats(),
    connected: true,
    error_reason: null,
    lookahead_used: sim.state === 'ROASTING' ? Math.round(lookaheadUsed() * 10) / 10 : null,
    lookahead_offset: sim.lookaheadOffset,
    current_phase: currentPhase(),
    phase_lookahead_config: sim.phaseLookahead,
  };
}

function tick() {
  const dt = TICK_MS / 1000;
  if (sim.state === 'ROASTING' && sim.profile) {
    sim.elapsed += dt;
    const target = splineTemp(sim.profile.nodes, sim.elapsed + lookaheadUsed());
    sim.sv = Math.round(target * 10) / 10;
    // 一阶热惯性（tau≈9s）+ 轻噪声
    const prevPv = sim.pv;
    sim.pv += ((sim.sv - sim.pv) * dt) / 9 + (Math.random() - 0.5) * 0.3;
    const instRor = ((sim.pv - prevPv) / dt) * 60;
    sim._rorSmooth = 0.15 * instRor + 0.85 * sim._rorSmooth;
    sim.ror = sim._rorSmooth;
    sim.data.push([Math.round(sim.elapsed * 10) / 10,
      Math.round(sim.pv * 100) / 100, sim.sv, Math.round(sim.ror * 100) / 100]);
    // 到达结束温度自动出豆
    if (sim.profile.end_temp > 0 && sim.pv >= sim.profile.end_temp &&
        !sim.events.some((e) => e.type === 'drop')) {
      logEvent('drop');
    }
  } else if (sim.state === 'COOLING') {
    sim.pv += ((25 - sim.pv) * dt) / 20;
    sim.ror *= 0.9;
  } else {
    // IDLE：环境温度轻微波动
    sim.pv += (Math.random() - 0.5) * 0.06;
    sim.pv = Math.max(24, Math.min(35, sim.pv));
    sim.ror *= 0.8;
  }
}

function startRoast(profileId) {
  const p = profiles.get(profileId);
  if (!p) throw new Error('曲线不存在: ' + profileId);
  if (sim.state !== 'IDLE') throw new Error('当前状态不能开始烘焙');
  sim.profile = p;
  sim.state = 'ROASTING';
  sim.elapsed = 0;
  sim.events = [{ time: 0, type: 'charge', note: '', temperature: Math.round(sim.pv * 10) / 10 }];
  sim.data = [];
  sim.sessionId = 'mock-' + Date.now();
  sim.startedAt = new Date().toISOString();
  sim._rorSmooth = 0;
  console.log('[mock] 开始烘焙, 曲线:', p.name);
}

function logEvent(type, note = '') {
  if (sim.state !== 'ROASTING') return;
  if (sim.events.some((e) => e.type === type)) return;
  sim.events.push({
    time: Math.round(sim.elapsed * 10) / 10,
    type, note,
    temperature: Math.round(sim.pv * 10) / 10,
  });
  console.log('[mock] 事件:', type, '@', sim.elapsed.toFixed(0) + 's');
  if (type === 'drop') {
    sim.state = 'COOLING';
    console.log('[mock] 出豆 → COOLING（等待保存确认）');
  }
}

function saveAndClear() {
  if (sim.sessionId) {
    recordSeq += 1;
    records.unshift({
      session_id: sim.sessionId,
      started_at: sim.startedAt,
      ended_at: new Date().toISOString(),
      profile_id: sim.profile ? sim.profile.id : null,
      profile_name: sim.profile ? sim.profile.name : null,
      events: sim.events,
      data: sim.data,
      seq_no: recordSeq,
      display_name: 'log' + String(recordSeq).padStart(3, '0'),
      duration_sec: sim.data.length ? sim.data[sim.data.length - 1][0] : 0,
      profile_snapshot: sim.profile,
    });
    console.log('[mock] 已保存记录 log' + String(recordSeq).padStart(3, '0'));
  }
  resetToIdle();
}

function resetToIdle() {
  sim.state = 'IDLE';
  sim.profile = null;
  sim.sessionId = null;
  sim.events = [];
  sim.data = [];
  sim.elapsed = 0;
  sim.sv = 0;
  sim.ror = 0;
  sim._rorSmooth = 0;
}

function handleCommand(cmd, ws) {
  try {
    switch (cmd.cmd) {
      case 'start': startRoast(cmd.profile_id); break;
      case 'end': if (sim.state === 'ROASTING') sim.state = 'COOLING'; break;
      case 'save_and_clear': saveAndClear(); break;
      case 'discard_and_clear': resetToIdle(); break;
      case 'emergency_stop': resetToIdle(); break;
      case 'event': logEvent(String(cmd.type || ''), String(cmd.note || '')); break;
      case 'set_phase_lookahead': {
        const v = Number(cmd.value ?? (cmd.params || {}).value);
        const ph = String(cmd.phase ?? (cmd.params || {}).phase);
        if (ph in sim.phaseLookahead && Number.isFinite(v)) {
          sim.phaseLookahead[ph] = Math.max(0, Math.min(30, v));
        }
        break;
      }
      case 'set_lookahead_offset': {
        const v = Number((cmd.params || {}).value ?? cmd.value);
        if (Number.isFinite(v)) sim.lookaheadOffset = Math.max(-3, Math.min(3, v));
        break;
      }
      case 'set_lookahead': break; // 兼容入口
      default: send(ws, { error: '未知命令: ' + cmd.cmd });
    }
  } catch (e) {
    send(ws, { error: String(e.message || e) });
  }
}

// ============ 最小 WebSocket 实现（服务端无需 mask） ============
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Set();

function encodeWsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function send(sock, obj) {
  if (!sock.destroyed) sock.write(encodeWsFrame(JSON.stringify(obj)));
}

/** 解析客户端帧（小 JSON 命令，含 mask 处理） */
function makeFrameParser(sock, onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        const un = Buffer.alloc(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
        payload = un;
      }
      buf = buf.subarray(off + len);

      if (opcode === 0x8) { // close
        sock.write(Buffer.from([0x88, 0x00]));
        sock.end();
        return;
      }
      if (opcode === 0x9) { // ping → pong
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        sock.write(pong);
        continue;
      }
      if (opcode === 0x1) onMessage(payload.toString('utf8'));
    }
  };
}

// ============ HTTP 服务 ============
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') return json(res, {});
    if (path === '/api/v1/status') return json(res, statePayload());

    // 控制
    if (path === '/api/v1/control/start' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      startRoast(body.profile_id);
      return json(res, { success: true });
    }
    if (path === '/api/v1/control/end' && req.method === 'POST') {
      if (sim.state === 'ROASTING') sim.state = 'COOLING';
      return json(res, { success: true });
    }
    if (path === '/api/v1/control/save_and_clear' && req.method === 'POST') {
      saveAndClear();
      return json(res, { success: true });
    }
    if (path === '/api/v1/control/discard_and_clear' && req.method === 'POST') {
      resetToIdle();
      return json(res, { success: true });
    }
    if (path === '/api/v1/control/emergency_stop' && req.method === 'POST') {
      resetToIdle();
      return json(res, { success: true });
    }
    if (path === '/api/v1/events' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      logEvent(String(body.type || ''), String(body.note || ''));
      return json(res, { success: true });
    }

    // 曲线库
    if (path === '/api/v1/profiles' && req.method === 'GET') {
      return json(res, [...profiles.values()]);
    }
    if (path === '/api/v1/profiles' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = 'p-' + Date.now();
      profiles.set(id, { id, ...body });
      return json(res, { success: true, id });
    }
    if (path === '/api/v1/profiles/import' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      delete body.id;
      const id = 'p-' + Date.now();
      profiles.set(id, { id, ...body });
      return json(res, { success: true, id });
    }
    const pm = path.match(/^\/api\/v1\/profiles\/([^/]+)(\/export)?$/);
    if (pm) {
      const p = profiles.get(decodeURIComponent(pm[1]));
      if (!p) return json(res, { detail: '曲线不存在' }, 404);
      if (pm[2]) return json(res, p);
      if (req.method === 'DELETE') {
        profiles.delete(decodeURIComponent(pm[1]));
        return json(res, { success: true });
      }
      return json(res, p);
    }

    // 记录
    if (path === '/api/v1/records' && req.method === 'GET') {
      return json(res, records.map((r) => ({
        session_id: r.session_id, started_at: r.started_at,
        profile_name: r.profile_name, duration_sec: r.duration_sec,
        seq_no: r.seq_no, display_name: r.display_name,
      })));
    }
    const rm = path.match(/^\/api\/v1\/records\/([^/]+)(\/export\/(csv|json))?$/);
    if (rm) {
      const r = records.find((x) => x.session_id === decodeURIComponent(rm[1]));
      if (!r) return json(res, { detail: '记录不存在' }, 404);
      if (rm[3] === 'csv') {
        const csv = 'time,pv,sv,ror\n' +
          r.data.map((d) => d.join(',')).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
        return res.end(csv);
      }
      return json(res, r);
    }

    json(res, { detail: 'Not Found' }, 404);
  } catch (e) {
    json(res, { error: String(e.message || e) }, 400);
  }
});

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  wsClients.add(socket);
  console.log('[mock] WebSocket 客户端已连接 (' + wsClients.size + ')');
  send(socket, statePayload()); // 连接即推快照
  socket.on('data', makeFrameParser(socket, (text) => {
    try {
      handleCommand(JSON.parse(text), socket);
    } catch (_) { /* 忽略坏帧 */ }
  }));
  const drop = () => {
    wsClients.delete(socket);
    console.log('[mock] WebSocket 客户端断开 (' + wsClients.size + ')');
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

// 周期仿真 + 广播
setInterval(() => {
  tick();
  const payload = statePayload();
  for (const sock of wsClients) send(sock, payload);
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`[mock] 模拟后端已启动: http://localhost:${PORT}`);
  console.log('[mock] 内置曲线: ' + defaultProfile.name);
  console.log('[mock] 在 App 里点「开始烘焙」即可看到仿真烘焙过程');
});
