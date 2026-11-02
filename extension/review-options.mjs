import { normalizeEndpoint } from './core.mjs';

// Values from providers and saved profiles are assigned as text/value, never HTML.
export function createReviewEditor({
  root,
  addButton,
  send,
  primary,
  access,
  busy,
  setBusy,
  save,
  changed,
}) {
  let cards = [];
  function note(card, text, error = false) {
    card.message.textContent = text;
    card.message.className = `message ${error ? 'error' : 'success'}`;
  }
  function value(card) {
    return {
      id: card.id,
      name: card.fields.name.value,
      inheritConnection: card.fields.inheritConnection.checked,
      endpoint: card.fields.endpoint.value,
      apiKey: card.fields.apiKey.value,
      rememberKey: card.fields.rememberKey.checked,
      jsonMode: card.fields.jsonMode.checked,
      model: card.fields.model.value,
      visionModel: card.fields.visionModel.value,
    };
  }
  function reusable(card) {
    try {
      return (
        card.hasKey &&
        new URL(normalizeEndpoint(card.fields.endpoint.value)).origin ===
          new URL(card.savedEndpoint).origin
      );
    } catch {
      return false;
    }
  }
  function renderModels(card) {
    const shared = card.fields.inheritConnection.checked;
    const models = shared ? primary().catalog : card.catalog;
    const search = card.fields.search.value.toLowerCase().trim();
    for (const [field, select, vision] of [
      ['model', 'modelSelect', false],
      ['visionModel', 'visionSelect', true],
    ]) {
      const list = models.filter(
        (model) =>
          model.chat !== false &&
          (!vision || model.vision !== false) &&
          `${model.id} ${model.name || ''}`.toLowerCase().includes(search)
      );
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '选择目录模型，或在下方填写ID';
      card.fields[select].replaceChildren(
        empty,
        ...list.map((model) => {
          const option = document.createElement('option');
          option.value = model.id;
          option.textContent = model.id + (model.vision === true ? ' · 支持图片' : '');
          return option;
        })
      );
      card.fields[select].value = list.some((model) => model.id === card.fields[field].value)
        ? card.fields[field].value
        : '';
    }
    card.node.querySelector('[data-connection]').hidden = shared;
    card.node.querySelector('[data-key-status]').textContent = reusable(card)
      ? '此服务Key已保存，留空沿用。'
      : '独立服务需要自己的Key；切换服务不会沿用旧Key。';
  }
  function updateButtons() {
    addButton.disabled = busy() || cards.length >= 3;
    for (const card of cards)
      for (const button of card.node.querySelectorAll('button')) button.disabled = busy();
  }
  function invalidate(card) {
    card.revision++;
    card.catalog = [];
    if (card.loading) send('KP_CANCEL_MODELS').catch(() => {});
    renderModels(card);
    changed();
  }
  function add(profile = {}) {
    if (cards.length >= 3) return;
    const node = document.createElement('section');
    node.className = 'review-card';
    const id = profile.id || 'helper-' + crypto.randomUUID();
    node.dataset.profileId = id;
    node.innerHTML = `<div class="review-profile-heading"><h3>辅助模型</h3><button type="button" data-action="remove">移除</button></div>
      <label class="field"><span>名称</span><input data-field="name" maxlength="80" autocomplete="off"></label>
      <label class="check"><input data-field="inheritConnection" type="checkbox"><span><b>共用主模型的服务地址和Key</b><small>只选择不同的模型；无需重复填写Key。</small></span></label>
      <div data-connection>
        <label class="field"><span>辅助服务 Base URL</span><input data-field="endpoint" type="url" autocomplete="off" spellcheck="false" placeholder="https://你的辅助服务/v1"></label>
        <label class="field"><span>辅助服务 API Key</span><div class="keyrow"><input data-field="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="已保存时可留空"><button type="button" data-action="showKey" aria-pressed="false">显示</button></div><small data-key-status></small></label>
        <label class="check"><input data-field="rememberKey" type="checkbox"><span>在此浏览器记住这个辅助Key<small>未勾选时只在当前浏览器会话保存，不同步到其他设备。</small></span></label>
        <label class="check"><input data-field="jsonMode" type="checkbox"><span>辅助服务使用JSON格式约束</span></label>
        <button type="button" data-action="clearKey" class="danger">删除这个辅助Key</button>
      </div>
      <label class="field"><span>搜索此服务的模型</span><input data-field="search" type="search" autocomplete="off" placeholder="模型名称或ID"></label>
      <label class="field"><span>文字复核模型</span><select data-field="modelSelect"></select><input data-field="model" class="model-id" maxlength="200" autocomplete="off" spellcheck="false" placeholder="辅助模型ID"></label>
      <label class="field"><span>图片复核模型（可选）</span><select data-field="visionSelect"></select><input data-field="visionModel" class="model-id" maxlength="200" autocomplete="off" spellcheck="false" placeholder="留空时使用上方辅助模型"><small>图片题会把同一张题目截图交给这个模型，请选择支持图片输入的模型并测试。</small></label>
      <div class="actions"><button type="button" data-action="fetch">拉取此服务模型</button><button type="button" data-action="test">测试文字</button><button type="button" data-action="testVision">测试图片</button></div>
      <p class="message" data-message role="status"></p>`;
    const fields = Object.fromEntries(
      [...node.querySelectorAll('[data-field]')].map((field) => [field.dataset.field, field])
    );
    for (const [key, field] of Object.entries(fields)) {
      if (field.type === 'checkbox')
        field.checked =
          key === 'inheritConnection' || key === 'jsonMode'
            ? profile[key] !== false
            : profile[key] === true;
      else field.value = profile[key] || '';
    }
    fields.name.value ||= `辅助模型 ${cards.length + 1}`;
    node.querySelector('h3').textContent = fields.name.value;
    fields.name.oninput = () => {
      node.querySelector('h3').textContent = fields.name.value || '辅助模型';
    };
    const card = {
      id,
      node,
      fields,
      message: node.querySelector('[data-message]'),
      hasKey: !!profile.hasKey,
      savedEndpoint: profile.endpoint || '',
      catalog: [],
      revision: 0,
      loading: false,
    };
    cards.push(card);
    root.append(node);
    for (const field of Object.values(fields)) field.addEventListener('input', () => changed());
    for (const key of ['endpoint', 'apiKey', 'inheritConnection'])
      fields[key].addEventListener('input', () => invalidate(card));
    fields.search.oninput = () => renderModels(card);
    for (const [select, field] of [
      ['modelSelect', 'model'],
      ['visionSelect', 'visionModel'],
    ])
      fields[select].onchange = () => {
        if (fields[select].value) fields[field].value = fields[select].value;
        changed();
      };
    for (const field of ['model', 'visionModel'])
      fields[field].oninput = () => {
        renderModels(card);
        changed();
      };
    node.querySelector('[data-action="showKey"]').onclick = (event) => {
      const visible = fields.apiKey.type === 'password';
      fields.apiKey.type = visible ? 'text' : 'password';
      event.currentTarget.textContent = visible ? '隐藏' : '显示';
      event.currentTarget.setAttribute('aria-pressed', String(visible));
    };
    node.querySelector('[data-action="remove"]').onclick = () => {
      card.revision++;
      if (card.loading) send('KP_CANCEL_MODELS').catch(() => {});
      cards = cards.filter((item) => item !== card);
      node.remove();
      updateButtons();
      changed();
    };
    node.querySelector('[data-action="fetch"]').onclick = async () => {
      if (busy()) return;
      const revision = card.revision;
      try {
        const shared = fields.inheritConnection.checked;
        const connection = shared ? primary() : value(card);
        const endpoint = normalizeEndpoint(connection.endpoint);
        if (!connection.apiKey && !(shared ? connection.reusableKey : reusable(card)))
          throw new Error('请填写这个服务的Key。');
        const permission = access(endpoint);
        setBusy(true);
        card.loading = true;
        note(card, '正在读取辅助模型目录…');
        await permission;
        if (revision !== card.revision || !node.isConnected) return;
        const result = await send('KP_LIST_MODELS', {
          connection: { endpoint, apiKey: connection.apiKey },
          ...(shared ? {} : { profileId: id }),
        });
        if (revision !== card.revision || !node.isConnected) return;
        if (shared) primary().setCatalog(result);
        else {
          card.catalog = result.models;
          fields.endpoint.value = endpoint;
        }
        renderModels(card);
        note(
          card,
          result.models.length
            ? `已读取 ${result.models.length} 个模型，请选择并测试。`
            : '目录为空，可手动填写模型ID。'
        );
      } catch (error) {
        if (revision === card.revision && node.isConnected) note(card, error.message, true);
      } finally {
        card.loading = false;
        setBusy(false);
      }
    };
    for (const [action, visual] of [
      ['test', false],
      ['testVision', true],
    ])
      node.querySelector(`[data-action="${action}"]`).onclick = async () => {
        if (busy()) return;
        setBusy(true);
        try {
          await save('review');
          note(card, visual ? '正在测试图片识别…' : '正在测试文字连接…');
          const result = await send('KP_TEST_REVIEW', { profileId: id, visual });
          note(card, `${visual ? '图片识别通过' : '连接成功'}：${result.model}`);
        } catch (error) {
          note(card, error.message, true);
        } finally {
          setBusy(false);
        }
      };
    node.querySelector('[data-action="clearKey"]').onclick = async () => {
      try {
        const saved = await send('KP_GET_SETTINGS');
        await send('KP_SAVE_SETTINGS', { settings: saved, clearReviewKeys: [id] });
        card.hasKey = false;
        fields.apiKey.value = '';
        renderModels(card);
        note(card, '这个辅助Key已从本机和会话存储删除。');
      } catch (error) {
        note(card, error.message, true);
      }
    };
    renderModels(card);
    updateButtons();
    changed();
  }
  addButton.onclick = () => add();
  return {
    collect: () => cards.map(value),
    load(profiles) {
      for (const card of cards) if (card.loading) send('KP_CANCEL_MODELS').catch(() => {});
      cards = [];
      root.replaceChildren();
      for (const profile of profiles) add(profile);
      updateButtons();
    },
    validate() {
      for (const card of cards) {
        if (!card.fields.model.value.trim())
          throw new Error('请填写每个辅助模型的ID，或移除未使用的配置。');
        if (
          !card.fields.inheritConnection.checked &&
          (!card.fields.endpoint.value.trim() ||
            (!card.fields.apiKey.value.trim() && !reusable(card)))
        )
          throw new Error('请补全辅助服务地址及对应Key。');
      }
    },
    markSaved(keys) {
      for (const card of cards) {
        const saved = keys.find((item) => item.id === card.id);
        card.hasKey = !!saved?.hasKey;
        card.savedEndpoint = saved?.endpoint || '';
        card.fields.apiKey.value = '';
        card.fields.apiKey.type = 'password';
        card.fields.endpoint.value = saved?.endpoint || card.fields.endpoint.value;
        card.node.querySelector('[data-action="showKey"]').textContent = '显示';
        card.node.querySelector('[data-action="showKey"]').setAttribute('aria-pressed', 'false');
        renderModels(card);
      }
    },
    refreshSharedCatalog(invalidate = false) {
      for (const card of cards)
        if (card.fields.inheritConnection.checked) {
          if (invalidate) {
            card.revision++;
            if (card.loading) send('KP_CANCEL_MODELS').catch(() => {});
          }
          renderModels(card);
        }
    },
    setBusy: updateButtons,
  };
}
