// Hardware-free arithmetic shared by the AI worker and protocol simulator.
export function target(profile, time) {
  const ns = profile.nodes;
  if (time <= ns[0].time) return ns[0].temperature;
  for (let i = 1; i < ns.length; i++) {
    if (time > ns[i].time) continue;
    const u = (time - ns[i-1].time) / (ns[i].time - ns[i-1].time);
    const p1 = ns[i-1].temperature, p2 = ns[i].temperature;
    if (ns.length < 4 || i === 1 || i === ns.length-1) return p1+(p2-p1)*u;
    const p0=ns[i-2].temperature, p3=ns[i+1].temperature;
    return .5*(2*p1+(-p0+p2)*u+(2*p0-5*p1+4*p2-p3)*u*u+(-p0+3*p1-3*p2+p3)*u*u*u);
  }
  return ns.at(-1).temperature;
}

export function validateCandidate(profile, maximum, source, lockedUntil) {
  const errors=[];
  try {
    const ns=profile.nodes;
    if (!Number.isFinite(maximum) || maximum<=0) throw Error('设备温度限制无效');
    maximum=Math.min(300,maximum);
    if (!profile.name?.trim() || !Array.isArray(ns) || ns.length<2 || ns.length>64 || ns[0].time!==0) throw Error('名称不能为空；曲线从 0 秒开始，需 2–64 个节点');
    if (ns.some((n,i)=>!Number.isFinite(n.time)||!Number.isFinite(n.temperature)||n.time<0||n.temperature<0||n.temperature>300||(i>0&&n.time<=ns[i-1].time))) throw Error('节点数值或时间顺序无效');
    const values=ns.map(n=>n.temperature);
    for(let i=2;i<ns.length-1;i++) {
      const [p0,p1,p2,p3]=ns.slice(i-2,i+2).map(n=>n.temperature);
      const a=.5*(-p0+3*p1-3*p2+p3),b=.5*(2*p0-5*p1+4*p2-p3),c=.5*(-p0+p2), roots=[];
      if(Math.abs(a)<1e-12) { if(Math.abs(b)>1e-12) roots.push(-c/(2*b)); }
      else { const disc=4*b*b-12*a*c; if(disc>=0) roots.push((-2*b+Math.sqrt(disc))/(6*a),(-2*b-Math.sqrt(disc))/(6*a)); }
      for(const u of roots) if(u>0&&u<1) values.push(((a*u+b)*u+c)*u+p1);
    }
    const min=Math.min(...values),max=Math.max(...values);
    if(min < -1e-8 || max>maximum+1e-8) errors.push(`插值范围 ${min.toFixed(2)}–${max.toFixed(2)}°C 超出设备限制 ${maximum}°C`);
    if(!Number.isFinite(profile.end_temp)||profile.end_temp<0||profile.end_temp>maximum||(profile.end_temp>0&&profile.end_temp>max)) errors.push('自动结束温度无效或无法达到');
    if(lockedUntil != null) {
      if(!source||!Number.isFinite(lockedUntil)||lockedUntil<0||lockedUntil>source.nodes.at(-1).time||lockedUntil>ns.at(-1).time) throw Error('锁定区段无效');
      if(source.nodes.length>64) throw Error('锁定来源曲线不超过 64 个节点');
      if(Math.abs(target(source,0)-target(profile,0))>1e-6) errors.push('候选改变了锁定起点');
      const cuts=[...new Set([0,lockedUntil,...source.nodes.concat(ns).map(n=>n.time).filter(t=>t<=lockedUntil)])].sort((a,b)=>a-b);
      for(let i=1;i<cuts.length;i++) if([0,1/3,2/3,1].some(u=>Math.abs(target(source,cuts[i-1]+(cuts[i]-cuts[i-1])*u)-target(profile,cuts[i-1]+(cuts[i]-cuts[i-1])*u))>1e-6)) { errors.push('候选改变了锁定区段（含插值）'); break; }
    }
    return {valid:!errors.length,errors,min_temperature:min,max_temperature:max,max_safe_temperature_c:maximum};
  } catch(e) {return {valid:false,errors:[e.message]};}
}

export function metrics(context) {
  const record=context.record || {};
  const raw=record.data || context.samples || [];
  const rows=raw.filter(r=>Array.isArray(r)&&r.length===4&&r.every(Number.isFinite));
  const warnings=[];
  if(rows.length!==raw.length) warnings.push('包含无效采样');
  if(rows.some((r,i)=>i&&r[0]<=rows[i-1][0])) warnings.push('采样时间非递增');
  const profile=record.profile_snapshot || context.active_profile || null;
  if(!profile) warnings.push('缺少当时的目标曲线快照');
  const events=record.events || context.status?.events || [];
  const event=t=>events.find(e=>e.type===t)?.time;
  const charge=event('charge'),yellow=event('yellowing'),crack=event('first_crack'),drop=event('drop');
  const phases={};
  if([charge,yellow,crack,drop].every(Number.isFinite)&&charge<=yellow&&yellow<=crack&&crack<=drop&&drop>charge) {
    phases.drying_sec=yellow-charge;phases.maillard_sec=crack-yellow;phases.development_sec=drop-crack;phases.dtr_percent=100*(drop-crack)/(drop-charge);
  } else warnings.push('事件未齐全，不能计算完整阶段比例');
  const deviations=profile ? rows.map(r=>Math.abs(r[1]-target(profile,r[0]))) : [];
  const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
  const recent=rows.filter(r=>r[0]>=(rows.at(-1)?.[0]||0)-30);
  const rorValues=rows.map(r=>r[3]);
  return {sample_count:rows.length,duration_sec:rows.at(-1)?.[0]??null,phases,
    ror_min:rorValues.length?Math.min(...rorValues):null,ror_max:rorValues.length?Math.max(...rorValues):null,
    ror_change_last_30s:recent.length>1?recent.at(-1)[3]-recent[0][3]:null,
    target_mae_c:mean(deviations),target_max_error_c:deviations.length?Math.max(...deviations):null,
    control_mae_c:mean(rows.map(r=>Math.abs(r[1]-r[2]))),
    last_sample:rows.at(-1)??null,temperature_source:'bean',warnings};
}

export function modelContext(context) {
  const copy=structuredClone(context);
  if(copy.reference_record) copy.reference_record=modelContext({record:copy.reference_record});
  const raw=copy.record?.data || copy.samples || [];
  // Five-second buckets retain temperature/ROR extrema and their times.
  const buckets=new Map();
  for(const row of raw) {
    if(!Array.isArray(row)||!row.every(Number.isFinite)) continue;
    const key=Math.floor(row[0]/5);
    if(!buckets.has(key)) buckets.set(key,[]);
    buckets.get(key).push(row);
  }
  const summary=[...buckets.values()].map(rs=>({from:rs[0][0],to:rs.at(-1)[0],last:rs.at(-1),pv_min:Math.min(...rs.map(r=>r[1])),pv_max:Math.max(...rs.map(r=>r[1])),ror_min:Math.min(...rs.map(r=>r[3])),ror_max:Math.max(...rs.map(r=>r[3]))}));
  if(copy.record) delete copy.record.data;
  delete copy.samples;
  copy.sample_buckets=summary;
  copy.metrics=metrics(context);
  return copy;
}
