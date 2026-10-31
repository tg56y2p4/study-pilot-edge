import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelListUrls,
  parseModelPage,
  resolveApiKey,
  listModels,
  MAX_DIRECTORY_BYTES,
  MAX_DIRECTORY_MODELS,
} from '../extension/api.mjs';
import { endpointPermission } from '../extension/core.mjs';
const config = { endpoint: 'https://api.example.test/custom/v1', apiKey: 'fixture-api-only' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('模型目录与权限严格使用所选服务，兼容百炼独立目录', () => {
  assert.deepEqual(modelListUrls(config.endpoint), [config.endpoint + '/models']);
  assert.deepEqual(modelListUrls('https://work.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), [
    'https://work.cn-beijing.maas.aliyuncs.com/api/v1/models',
    'https://work.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models',
  ]);
  assert.equal(endpointPermission('http://127.0.0.1:8788/v1'), 'http://127.0.0.1/*');
});
test('解析标准目录与明确的图片能力，不根据模型名猜测', () => {
  const result = parseModelPage({
    data: [
      { id: 'text-chat', input_modalities: ['text'], output_modalities: ['text'] },
      {
        id: 'opaque-vision-name',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
      { id: 'unknown-model' },
      { id: '<script>bad</script>' },
    ],
  });
  assert.deepEqual(
    result.models.map((m) => m.vision),
    [false, true, null]
  );
  assert.equal(result.models.length, 3);
});
test('百炼目录保留文本与图片输入元数据，排除生成图片模型', () => {
  const result = parseModelPage({
    output: {
      total: 2,
      models: [
        {
          model: 'visual',
          capabilities: ['TG', 'VU'],
          inference_metadata: { request_modality: ['Text', 'Image'], response_modality: ['Text'] },
        },
        {
          model: 'image-generation',
          capabilities: ['IG'],
          inference_metadata: { request_modality: ['Text'], response_modality: ['Image'] },
        },
      ],
    },
  });
  assert.equal(result.models[0].vision, true);
  assert.equal(result.models[1].chat, false);
  assert.equal(result.total, 2);
});
test('切换域名或端口不得沿用旧Key，显式新Key才可使用', () => {
  const old = { endpoint: config.endpoint, apiKey: 'fixture-old-key' };
  assert.equal(resolveApiKey({ ...config, apiKey: '' }, old), old.apiKey);
  assert.throws(
    () => resolveApiKey({ endpoint: 'https://another.test/v1', apiKey: '' }, old),
    /旧Key不会/
  );
  assert.throws(
    () => resolveApiKey({ endpoint: 'https://api.example.test:8443/v1', apiKey: '' }, old),
    /旧Key不会/
  );
  assert.equal(
    resolveApiKey({ endpoint: 'https://another.test/v1', apiKey: 'fixture-new-key' }, old),
    'fixture-new-key'
  );
});
test('拉取只发送Bearer认证，不带Cookie，不跟随重定向', async () => {
  const result = await listModels(config, async (url, options) => {
    assert.equal(url, config.endpoint + '/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer ' + config.apiKey);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return json({ data: [{ id: 'model-a' }] });
  });
  assert.equal(result.models[0].id, 'model-a');
  assert.equal(result.source, config.endpoint + '/models');
});
test('标准目录逐页读取并去重，不访问响应提供的外部next链接', async () => {
  const calls = [];
  const result = await listModels(config, async (url) => {
    calls.push(url);
    return calls.length === 1
      ? json({
          data: [{ id: 'a' }, { id: 'b' }],
          has_more: true,
          last_id: 'b',
          next: 'https://untrusted.test/leak',
        })
      : json({ data: [{ id: 'b' }, { id: 'c' }], has_more: false });
  });
  assert.deepEqual(
    result.models.map((m) => m.id),
    ['a', 'b', 'c']
  );
  assert.equal(calls[1], config.endpoint + '/models?after=b');
});
test('百炼按服务总数读取后续页，保留同一认证域名', async () => {
  const calls = [];
  const result = await listModels(
    { ...config, endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    async (url) => {
      calls.push(url);
      return json({
        output: {
          total: 101,
          models:
            calls.length === 1
              ? Array.from({ length: 100 }, (_, i) => ({ model: 'm' + i }))
              : [{ model: 'last-model' }],
        },
      });
    }
  );
  assert.equal(result.models.length, 101);
  assert.match(calls[1], /page_no=2/);
  assert.ok(calls.every((url) => new URL(url).origin === 'https://dashscope-intl.aliyuncs.com'));
});
test('目录404可尝试同域兼容路径，鉴权失败不会继续尝试', async () => {
  const s = { ...config, endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' };
  let calls = 0;
  const result = await listModels(s, async () =>
    ++calls === 1 ? json({}, 404) : json({ data: [{ id: 'fallback-model' }] })
  );
  assert.equal(result.models.length, 1);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    listModels(s, async () => {
      calls++;
      return json({ error: { message: config.apiKey } }, 401);
    }),
    (error) => /401/.test(error.message) && !error.message.includes(config.apiKey)
  );
  assert.equal(calls, 1);
});
test('空目录保持为空，不提供预置或伪造模型', async () => {
  const result = await listModels(config, async () => json({ data: [] }));
  assert.deepEqual(result.models, []);
  await assert.rejects(
    listModels(config, async () => json({}, 404)),
    /手动填写/
  );
});
test('缺少Key不会发送网络请求，服务器错误不回显正文', async () => {
  let calls = 0;
  await assert.rejects(
    listModels({ ...config, apiKey: '' }, async () => {
      calls++;
    }),
    /Key/
  );
  assert.equal(calls, 0);
  await assert.rejects(
    listModels(config, async () =>
      json({ error: { message: config.apiKey, code: config.apiKey } }, 429)
    ),
    (error) => /429/.test(error.message) && !error.message.includes(config.apiKey)
  );
});
test('非JSON及结构无效目录给出可操作提示', async () => {
  await assert.rejects(
    listModels(config, async () => new Response('<html>login</html>')),
    /非JSON/
  );
  await assert.rejects(
    listModels(config, async () => json({ error: 'private content' })),
    /手动填写/
  );
  await assert.rejects(
    listModels(config, async () => {
      throw new TypeError('private network details');
    }),
    /网络和浏览器站点权限/
  );
});
test('错误分页游标不能循环请求，过大目录明确截断', async () => {
  let calls = 0;
  const repeated = await listModels(config, async () => {
    calls++;
    return json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' });
  });
  assert.equal(calls, 2);
  assert.equal(repeated.truncated, true);
  calls = 0;
  const huge = await listModels(config, async () =>
    json({ data: [{ id: 'm' + ++calls }], has_more: true, last_id: 'm' + calls })
  );
  assert.equal(calls, 20);
  assert.equal(huge.truncated, true);
});
test('空JSON响应报告目录格式错误，而非网络故障', async () => {
  await assert.rejects(
    listModels(config, async () => json(null)),
    /没有返回模型目录/
  );
});
test('修改连接可主动取消读取，预先取消不发送网络请求', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = listModels(
    config,
    (_url, opts) => {
      calls++;
      return new Promise((_resolve, reject) =>
        opts.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        )
      );
    },
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(pending, /已取消/);
  assert.equal(calls, 1);
  await assert.rejects(
    listModels(
      config,
      async () => {
        calls++;
      },
      { signal: controller.signal }
    ),
    /已取消/
  );
  assert.equal(calls, 1);
});
test('超时与主动取消给出不同原因', async () => {
  await assert.rejects(
    listModels(
      config,
      (_url, opts) =>
        new Promise((_r, reject) =>
          opts.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        ),
      { timeoutMs: 10 }
    ),
    /超时/
  );
});
test('限制目录响应大小与可展示模型数量，明确提示截断', async () => {
  await assert.rejects(
    listModels(config, async () => json({ data: [], padding: 'x'.repeat(MAX_DIRECTORY_BYTES) })),
    /4MB/
  );
  const result = await listModels(config, async () =>
    json({ data: Array.from({ length: MAX_DIRECTORY_MODELS + 20 }, (_, i) => ({ id: 'm' + i })) })
  );
  assert.equal(result.models.length, MAX_DIRECTORY_MODELS);
  assert.equal(result.truncated, true);
});
