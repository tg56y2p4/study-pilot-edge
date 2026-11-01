import { DEFAULTS, normalizeSettings, normalizeEndpoint, endpointPermission } from './core.mjs';
const $ = (id) => document.getElementById(id);
const regions = {
  qianwen: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
  beijing: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  singapore: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  us: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  openai: 'https://api.openai.com/v1',
};
const bools = Object.keys(DEFAULTS).filter((key) => typeof DEFAULTS[key] === 'boolean');
let hasKey = false,
  savedEndpoint = '',
  catalog = [],
  catalogSource = '',
  revision = 0,
  busy = false,
  catalogInFlight = false;
async function send(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || '连接失败。');
  return r.data;
}
function show(text, error = false, target = 'message') {
  $(target).textContent = text;
  $(target).className = `message ${error ? 'error' : 'success'}`;
}
function reusableKey() {
  try {
    return (
      hasKey &&
      new URL(normalizeEndpoint($('endpoint').value)).origin === new URL(savedEndpoint).origin
    );
  } catch {
    return false;
  }
}
function keyStatus() {
  const reuse = reusableKey();
  $('keyStatus').textContent = reuse
    ? '当前服务的Key已保存；留空会沿用。'
    : hasKey
      ? '服务地址已改变，请填写这个服务的Key。'
      : '尚未设置；请填写这个服务的Key。';
  $('apiKey').placeholder = reuse ? '已保存，留空沿用' : '填写这个服务的 API Key';
}
function summary() {
  let host = '尚未填写';
  try {
    host = new URL($('endpoint').value).host;
  } catch {}
  $('summaryHost').textContent = host;
  $('summaryModel').textContent = $('model').value || '尚未选择';
  $('summaryVision').textContent = $('visionModel').value || '尚未选择';
  $('summaryCatalog').textContent = catalogSource ? catalog.length + ' 个模型' : '等待拉取';
  const selected = catalog.find((m) => m.id === $('visionModel').value);
  $('visionHint').textContent =
    selected?.vision === true
      ? '服务目录声明支持图片输入，请完成图片识别测试。'
      : selected?.vision === false
        ? '此模型的目录未声明图片输入，建议另选图片模型。'
        : '模型目录未声明图片能力时，以图片识别测试为准。';
}
function renderModels() {
  const search = $('modelSearch').value.trim().toLowerCase();
  for (const [id, input, vision] of [
    ['modelSelect', 'model', false],
    ['visionModelSelect', 'visionModel', true],
  ]) {
    const select = $(id),
      placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = catalogSource
      ? '请选择模型，或在下方手动填写'
      : '请先拉取模型，或在下方手动填写';
    const models = catalog.filter(
      (m) =>
        m.chat !== false &&
        (!vision || m.vision !== false) &&
        (m.id + ' ' + m.name).toLowerCase().includes(search)
    );
    select.replaceChildren(
      placeholder,
      ...models.map((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.id + (model.vision === true ? ' · 支持图片' : '');
        return option;
      })
    );
    if (models.some((m) => m.id === $(input).value)) select.value = $(input).value;
  }
  summary();
}
function setBadge(text, state = '') {
  $('connectionBadge').textContent = text;
  $('connectionBadge').className = state ? `tag ${state}` : 'tag';
}
function invalidate() {
  revision++;
  if (catalogInFlight) send('KP_CANCEL_MODELS').catch(() => {});
  catalog = [];
  catalogSource = '';
  $('catalogStatus').textContent = '接入信息已改变，请重新拉取模型，或手动填写模型 ID。';
  show('接入信息已改变，请重新拉取模型。', false, 'modelMessage');
  renderModels();
  keyStatus();
  setBadge('配置有改动', 'dirty');
}
function load(s) {
  for (const key of Object.keys(DEFAULTS)) {
    const el = $(key);
    if (!el || key === 'apiKey') continue;
    if (bools.includes(key)) el.checked = s[key];
    else el.value = s[key];
  }
  $('region').value =
    Object.entries(regions).find(([, value]) => value === s.endpoint)?.[0] || 'custom';
  $('sameModel').checked = s.model === s.visionModel;
  renderModels();
  keyStatus();
  const ready = Boolean(hasKey && s.endpoint && s.model);
  setBadge(ready ? '接入已保存' : '等待配置', ready ? 'ready' : '');
}
function collect() {
  const values = {};
  for (const key of Object.keys(DEFAULTS)) {
    const el = $(key);
    values[key] = bools.includes(key) ? el.checked : el.value;
  }
  for (const key of ['questionSelector', 'nextSelector'])
    try {
      document.querySelector(values[key]);
    } catch {
      throw new Error('CSS选择器格式不正确，请检查页面适配设置。');
    }
  return normalizeSettings(values);
}
async function access(endpoint) {
  const granted = await chrome.permissions.request({ origins: [endpointPermission(endpoint)] });
  if (!granted) throw new Error('未获得此服务的访问权限。请重新点击，并在浏览器提示中允许访问。');
}
function setBusy(value) {
  busy = value;
  for (const id of ['fetchModels', 'test', 'testVision']) $(id).disabled = value;
}
async function save(mode = 'all') {
  const s = collect();
  if (!s.endpoint) throw new Error('请填写API Host或Base URL。');
  if (!s.apiKey && !reusableKey()) throw new Error('请填写这个服务的API Key。');
  if ((s.autoSolve || mode === 'text') && !s.model)
    throw new Error('请先选择文字模型，或手动填写模型ID。');
  if ((mode === 'vision' || (mode === 'all' && (s.useVision || s.visualAgent))) && !s.visionModel)
    throw new Error('请选择图片模型，或关闭图片识题与视觉操作。');
  const permission = access(s.endpoint);
  await permission;
  const result = await send('KP_SAVE_SETTINGS', { settings: s });
  hasKey = result.hasKey;
  savedEndpoint = s.endpoint;
  $('endpoint').value = s.endpoint;
  $('apiKey').value = '';
  $('apiKey').type = 'password';
  $('showKey').textContent = '显示';
  $('showKey').setAttribute('aria-pressed', 'false');
  keyStatus();
  summary();
  setBadge('接入已保存', 'ready');
  show('设置已保存。课程托管会使用你选择的模型。');
}
$('fetchModels').onclick = async () => {
  if (busy) return;
  let currentRevision;
  try {
    const endpoint = normalizeEndpoint($('endpoint').value),
      apiKey = $('apiKey').value.trim();
    if (!apiKey && !reusableKey()) throw new Error('请填写这个服务的API Key。');
    currentRevision = revision;
    const permission = access(endpoint);
    setBusy(true);
    show('正在读取服务的模型目录…', false, 'modelMessage');
    await permission;
    if (currentRevision !== revision) return;
    catalogInFlight = true;
    const result = await send('KP_LIST_MODELS', { connection: { endpoint, apiKey } });
    if (currentRevision !== revision) return;
    catalog = result.models;
    catalogSource = result.source;
    $('endpoint').value = endpoint;
    renderModels();
    $('catalogStatus').textContent = catalog.length
      ? `${catalog.length} 个模型 · 来源 ${result.source}`
      : '目录为空，可手动填写模型 ID。';
    show(
      catalog.length
        ? `已读取 ${catalog.length} 个模型${result.truncated ? '（目录较大，仅载入部分）' : ''}，请选择后测试连接。`
        : '服务返回了空目录，可手动填写模型ID后测试。',
      false,
      'modelMessage'
    );
  } catch (error) {
    if (currentRevision === undefined || currentRevision === revision)
      show(error.message, true, 'modelMessage');
  } finally {
    catalogInFlight = false;
    setBusy(false);
  }
};
addEventListener('pagehide', () => {
  if (catalogInFlight) send('KP_CANCEL_MODELS').catch(() => {});
});
$('region').onchange = () => {
  if (regions[$('region').value]) {
    $('endpoint').value = regions[$('region').value];
    invalidate();
  }
};
$('endpoint').oninput = () => {
  $('region').value =
    Object.entries(regions).find(([, v]) => v === $('endpoint').value)?.[0] || 'custom';
  invalidate();
};
$('apiKey').oninput = invalidate;
$('modelSearch').oninput = renderModels;
function modelChanged() {
  if ($('sameModel').checked) $('visionModel').value = $('model').value;
  renderModels();
}
$('model').oninput = modelChanged;
$('visionModel').oninput = () => {
  $('sameModel').checked = false;
  renderModels();
};
$('modelSelect').onchange = () => {
  if ($('modelSelect').value) {
    $('model').value = $('modelSelect').value;
    modelChanged();
  }
};
$('visionModelSelect').onchange = () => {
  if ($('visionModelSelect').value) {
    $('sameModel').checked = false;
    $('visionModel').value = $('visionModelSelect').value;
    summary();
  }
};
$('sameModel').onchange = () => {
  if ($('sameModel').checked) {
    $('visionModel').value = $('model').value;
    renderModels();
  }
};
$('showKey').onclick = () => {
  const showing = $('apiKey').type === 'password';
  $('apiKey').type = showing ? 'text' : 'password';
  $('showKey').textContent = showing ? '隐藏' : '显示';
  $('showKey').setAttribute('aria-pressed', String(showing));
};
$('form').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  try {
    await save();
  } catch (error) {
    show(error.message, true);
  }
};
for (const [id, type, mode] of [
  ['test', 'KP_TEST_API', 'text'],
  ['testVision', 'KP_TEST_VISION', 'vision'],
])
  $(id).onclick = async () => {
    if (busy) return;
    setBusy(true);
    show(
      mode === 'text' ? '正在测试文字输出…' : '正在测试图片中的算式识别…',
      false,
      'connectionMessage'
    );
    try {
      await save(mode);
      const result = await send(type);
      show(
        mode === 'text'
          ? `连接成功，模型：${result.model}`
          : `图片识别通过：${result.model}，算式答案 ${result.answer}`,
        false,
        'connectionMessage'
      );
    } catch (error) {
      show(error.message, true, 'connectionMessage');
    } finally {
      setBusy(false);
    }
  };
$('clearKey').onclick = async () => {
  try {
    const s = await send('KP_GET_SETTINGS');
    await send('KP_SAVE_SETTINGS', { settings: s, clearKey: true });
    hasKey = false;
    $('apiKey').value = '';
    invalidate();
    show('Key已从本机扩展存储与会话中删除。');
  } catch (error) {
    show(error.message, true);
  }
};
$('reset').onclick = () => {
  load({
    ...DEFAULTS,
    endpoint: $('endpoint').value.trim(),
    model: $('model').value.trim(),
    visionModel: $('visionModel').value.trim(),
    rememberKey: $('rememberKey').checked,
    jsonMode: $('jsonMode').checked,
  });
  show('行为设置已恢复默认，点击保存后生效。');
};
try {
  const s = await send('KP_GET_SETTINGS');
  hasKey = s.hasKey;
  savedEndpoint = s.endpoint;
  load(s);
} catch (error) {
  show(error.message, true);
}
