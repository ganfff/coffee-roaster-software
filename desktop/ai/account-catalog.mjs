// Account-specific catalogs. Secrets remain inside the AI host.
const urls = {openai:'https://api.openai.com/v1/models','kimi-coding':'https://api.kimi.com/coding/v1/models'};
const positive = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback;

export function chatGPTPayload(payload) {
  const result = {...payload, store:false, stream:true};
  for (const key of ['max_output_tokens','temperature','top_p','background','conversation','previous_response_id','metadata','prompt_cache_retention','truncation','user']) delete result[key];
  result.input = (result.input || []).map(item => item.role === 'system' ? {...item,role:'developer'} : item);
  const functions = (result.tools || []).filter(tool => tool.type === 'function');
  if (functions.length) result.tools = [...(result.tools || []).filter(tool => tool.type !== 'function'),{type:'namespace',name:'roaster',description:'Read-only roasting analysis and reviewable proposals',tools:functions}];
  return result;
}

export async function discoverAccountModels(provider, auth, {fetcher=fetch, signal, baseline=[]}={}) {
  if (!urls[provider]) throw Error('此服务尚未提供账户模型目录');
  if (!auth?.apiKey) throw Object.assign(Error('请重新登录账户'),{code:'AUTH'});
  const headers = new Headers(auth.headers || {});
  headers.set('Authorization','Bearer '+auth.apiKey);
  headers.set('Accept','application/json');
  let response;
  try {response = await fetcher(urls[provider],{headers,signal});}
  catch(error) {if(signal?.aborted)throw error;throw Object.assign(Error('暂时无法连接服务商的模型目录，请检查网络后重试'),{code:'CATALOG'});}
  if (!response.ok) throw Object.assign(Error(response.status === 401 || response.status === 403 ? '账户授权已失效或没有访问权限，请重新登录' : `模型目录暂时无法加载（${response.status}），请重试`),{code:response.status === 401 || response.status === 403 ? 'AUTH':'CATALOG'});
  const body = await response.json();
  const rows = provider === 'openai' ? body.models : body.data;
  if (!Array.isArray(rows)) throw Object.assign(Error('服务返回的模型目录格式无法识别，请重试'),{code:'CATALOG'});
  const seen = new Set();
  return rows.filter(row => provider !== 'openai' || row.visibility === 'list').flatMap(row => {
    const id = provider === 'openai' ? row.slug : row.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || seen.has(id)) return [];
    seen.add(id);
    const known = baseline.find(model => model.id === id);
    return [{...known,id,name:String(row.display_name || known?.name || id).slice(0,200),provider,
      api:provider === 'openai' ? 'openai-responses':'anthropic-messages',
      baseUrl:provider === 'openai' ? 'https://api.openai.com/v1':'https://api.kimi.com/coding',
      input:row.supports_image_in === true ? ['text','image'] : known?.input || ['text'],
      reasoning:row.supports_reasoning ?? known?.reasoning ?? false,
      contextWindow:positive(row.context_length,known?.contextWindow || 32768),
      maxTokens:positive(row.max_output_tokens,known?.maxTokens || 4096),
      cost:known?.cost || {input:0,output:0,cacheRead:0,cacheWrite:0}}];
  });
}
