import { normalizeEndpoint, validModelId, apiError } from './core.mjs';
export const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;
export const MAX_DIRECTORY_MODELS = 2000;

async function directoryJson(response) {
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    parts = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_DIRECTORY_BYTES) {
        await reader.cancel();
        throw new Error('模型目录超过4MB，请使用服务商的筛选接口或手动填写模型ID。');
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } finally {
    reader.releaseLock();
  }
}

export function resolveApiKey(draft, old) {
  if (draft.apiKey) return draft.apiKey;
  if (
    draft.endpoint &&
    old.endpoint &&
    new URL(draft.endpoint).origin === new URL(old.endpoint).origin
  )
    return old.apiKey || '';
  if (old.apiKey)
    throw new Error('更换服务地址后，请填写新服务的API Key；旧Key不会转发到其他服务。');
  return '';
}
export function modelListUrls(endpoint) {
  const base = normalizeEndpoint(endpoint),
    url = new URL(base),
    standard = base + '/models';
  const aliyun =
    url.hostname === 'dashscope.aliyuncs.com' || url.hostname.endsWith('.aliyuncs.com');
  return aliyun ? [url.origin + '/api/v1/models', standard] : [standard];
}
export function parseModelPage(data) {
  const native = Array.isArray(data?.output?.models),
    rows = native
      ? data.output.models
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : null;
  if (!rows || data?.success === false)
    throw new Error('服务没有返回模型目录；可检查Base URL，或手动填写模型ID。');
  const models = rows
    .map((row) => {
      if (typeof row === 'string') row = { id: row };
      const id = row?.id || row?.model;
      if (!validModelId(id)) return null;
      const inputs =
        row.inference_metadata?.request_modality ||
        row.architecture?.input_modalities ||
        row.input_modalities ||
        row.modalities?.input;
      const outputs =
        row.inference_metadata?.response_modality ||
        row.architecture?.output_modalities ||
        row.output_modalities ||
        row.modalities?.output;
      const caps = Array.isArray(row.capabilities) ? row.capabilities : [];
      const vision = Array.isArray(inputs)
        ? inputs.some((v) => /^image$/i.test(v))
        : caps.length
          ? caps.includes('VU') || caps.includes('Multimodal-Omni')
          : null;
      const chat = Array.isArray(outputs)
        ? outputs.some((v) => /^text$/i.test(v))
        : caps.length
          ? caps.some((v) =>
              ['TG', 'VU', 'Reasoning', 'Multimodal-Omni', 'Realtime-Chatting'].includes(v)
            )
          : null;
      return { id, name: String(row.name || id).slice(0, 160), vision, chat };
    })
    .filter(Boolean);
  return {
    models,
    count: rows.length,
    native,
    total: native ? Number(data.output.total) || rows.length : null,
    hasMore: data.has_more === true,
    lastId: data.last_id || models.at(-1)?.id,
  };
}
export async function listModels(config, fetcher = fetch, { signal, timeoutMs = 30000 } = {}) {
  if (!config.apiKey) throw new Error('请先填写这个服务的API Key。');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    if (signal?.aborted) {
      controller.abort();
      throw new Error('拉取模型已取消。');
    }
    const candidates = modelListUrls(config.endpoint);
    for (let candidate = 0; candidate < candidates.length; candidate++) {
      const base = candidates[candidate],
        native =
          /\/api\/v1\/models$/.test(new URL(base).pathname) &&
          new URL(base).hostname.endsWith('.aliyuncs.com');
      const entries = new Map();
      let after = '',
        truncated = false,
        unavailable = false;
      for (let page = 1; page <= 20; page++) {
        const url = new URL(base);
        if (native) {
          url.searchParams.set('page_size', '100');
          url.searchParams.set('page_no', String(page));
        } else if (after) url.searchParams.set('after', after);
        const response = await fetcher(url.href, {
          method: 'GET',
          headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) {
          if ([404, 405, 501].includes(response.status) && candidate < candidates.length - 1) {
            unavailable = true;
            break;
          }
          if ([404, 405, 501].includes(response.status))
            throw new Error('此服务未开放模型列表接口，请手动填写模型ID，再测试连接。');
          throw new Error(apiError(response.status));
        }
        let data;
        try {
          data = await directoryJson(response);
        } catch (error) {
          if (error.message.includes('4MB') || controller.signal.aborted) throw error;
          throw new Error('模型列表返回了非JSON内容，请检查API地址或手动填写模型ID。');
        }
        const result = parseModelPage(data);
        for (const model of result.models) {
          if (!entries.has(model.id) && entries.size >= MAX_DIRECTORY_MODELS) {
            truncated = true;
            break;
          }
          entries.set(model.id, model);
        }
        if (truncated) break;
        const more = native ? page * 100 < result.total : result.hasMore;
        if (!more || !result.count) break;
        if (page === 20) {
          truncated = true;
          break;
        }
        if (!native) {
          if (!validModelId(result.lastId) || result.lastId === after) {
            truncated = true;
            break;
          }
          after = result.lastId;
        }
      }
      if (unavailable) continue;
      return {
        models: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
        source: base,
        truncated,
      };
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(timedOut ? '拉取模型超时，请检查网络后重试。' : '拉取模型已取消。');
    if (error instanceof TypeError)
      throw new Error('无法读取模型列表，请检查地址、网络和浏览器站点权限。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
