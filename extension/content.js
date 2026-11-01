(() => {
  if (globalThis.__KEBAN_INSTALLED__) return;
  globalThis.__KEBAN_INSTALLED__ = true;
  const topFrame = window === window.top;
  const adapter = globalThis.__KEBAN_ADAPTER__;
  const answers = new Map();
  const attempts = new Set();
  const retryAfter = new Map();
  const media = new WeakMap();
  const captureIds = new WeakMap();
  let visitedTaskTabs = new WeakSet();
  let snapshotNonce = '',
    snapshotControls = new Map(),
    snapshotTime = 0,
    lastVisualAttempt = 0;
  let submitClickedAt = 0,
    submissionConfirmed = false,
    seenUnfinishedCycle = false;
  let naturalVideoDone = false,
    completedPractice = false;
  let current = null,
    busy = false,
    manualRequest = false,
    fillRequest = false,
    answerContext = '';
  let lastPageContext = '',
    navigationAttempts = 0,
    lastKeepActive = 0;
  let frameContext = '',
    candidateContext = '',
    candidateSince = 0;
  let readerLastAction = 0,
    readerSignature = '',
    readerUnchanged = 0,
    readerSteps = 0;
  let runGeneration = -1,
    advanced = false,
    navigationAt = 0,
    blockedReported = false;
  let hud, hudStatus, hudAnswer, hudBadge, lastResult, hudCourseSelect, hudCoursePicker, hudPending;

  async function send(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    if (!response?.ok) {
      const error = new Error(response?.error || '扩展连接已断开，请刷新课程页面。');
      error.retryable = !!response?.retryable;
      throw error;
    }
    return response.data;
  }
  // Chaoxing marks visually displayed answer lists aria-hidden for its separate
  // accessibility UI. Use rendered visibility rather than that ARIA attribute.
  const visible = (el) =>
    !!el &&
    !el.closest('[hidden]') &&
    getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).visibility !== 'hidden' &&
    !!el.getClientRects().length;
  const clean = (text) =>
    String(text || '')
      .replace(/[\t\r ]+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();
  function all(selector, root = document) {
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  }
  const questionKey = (q) => JSON.stringify([q.type, q.text, q.options, q.visualSignature || '']);
  const selectedOption = (node) =>
    'checked' in node
      ? node.checked
      : node.matches(
          '.checked, .selected, .check_answer, .on, .cur, .active, .is-checked, .tkItem_li_cur, .ans-videoquiz-opt-checked, [aria-checked="true"], [aria-selected="true"], [data-keban-selected="true"]'
        ) ||
        !!node.querySelector(
          '.num_option.check_answer, .num_option_dx.check_answer, .check_answer, .on, .cur, .active, .is-checked, input:checked'
        );
  const taskTabs = () => all('[id^="dct"]').filter((el) => /^dct\d+$/.test(el.id) && visible(el));
  const tabKey = (el) => el.getAttribute('cardid') || el.id;
  function pageContext() {
    if (adapter) return adapter.context();
    const chapter =
      document.querySelector('#chapterIdid')?.value ||
      document.querySelector('.posCatalog_active[id^="cur"]')?.id ||
      location.pathname;
    const active = taskTabs().find((el) => el.classList.contains('active'));
    return {
      chapter: location.origin + location.pathname + '#' + chapter,
      card: active ? tabKey(active) : 'page',
    };
  }
  async function readPage() {
    makeHud();
    if (!current.running || !current.settings.autoRead || (await blockIfNeeded())) return;
    const text = clean(document.body.innerText),
      age = Date.now() - current.reading.started;
    if (
      /(?:404|页面不存在|页面已失效|资源不存在|专题已下架)/.test(
        document.title + ' ' + text.slice(0, 400)
      )
    ) {
      await send('KP_READING_RETURN', { failed: true, reason: '页面返回 404 或资源已失效' });
      return;
    }
    if (hudStatus) hudStatus.textContent = '专题阅读中 · 正在浏览和翻页';
    if (hudBadge) hudBadge.textContent = '阅读中';
    if (document.querySelector('iframe')) {
      if (age > 60000)
        await send('KP_READING_RETURN', { failed: true, reason: '嵌套阅读器未返回可读页面' });
      return;
    }
    if (!topFrame && (innerHeight < 180 || innerWidth < 250)) return;
    if (age > 45000 && text.length < 30) {
      await send('KP_READING_RETURN', { failed: true, reason: '阅读器未加载出可读内容' });
      return;
    }
    if (age < 1500 || Date.now() - readerLastAction < current.settings.readingInterval) return;
    const signature =
      location.pathname +
      '|' +
      text.slice(0, 2500) +
      '|' +
      all('input[type="number"],#pageNum,.pageIndex')
        .map((e) => e.value || e.innerText)
        .join('|');
    if (readerSignature && readerSignature === signature && readerLastAction) {
      readerUnchanged++;
    } else readerUnchanged = 0;
    if (readerUnchanged >= 3 || readerSteps >= 200) {
      await send('KP_READING_RETURN', {
        failed: true,
        reason: readerSteps >= 200 ? '达到本次阅读翻页上限' : '阅读器连续三次未响应翻页',
      });
      return;
    }
    const scroll = document.scrollingElement,
      atBottom = !scroll || scroll.scrollTop + innerHeight >= scroll.scrollHeight - 20;
    readerLastAction = Date.now();
    readerSteps++;
    if (!atBottom) {
      window.scrollBy({ top: innerHeight * 0.8, behavior: 'instant' });
      readerSignature = '';
      return;
    }
    const next = all(
      'button,a,[role="button"],input[type="button"],span[onclick],div[onclick]'
    ).find(
      (el) =>
        visible(el) &&
        !el.disabled &&
        el.getAttribute('aria-disabled') !== 'true' &&
        /^(下一页|下一章|下一篇|下一节)$/.test(clean(el.innerText || el.value || el.title))
    );
    if (next) {
      readerSignature = signature;
      next.scrollIntoView({ block: 'center' });
      next.click();
      return;
    }
    if (text.length > 40 || all('canvas,img').some(visible))
      await send('KP_READING_RETURN', { failed: false });
  }
  const fieldValue = (el) => el.value ?? el.innerText ?? el.textContent ?? '';
  function optionText(node, isInput) {
    const wrapper = isInput
      ? node.labels?.[0] ||
        node.closest(
          'li, label, .answer-item, .option, .answerOption, .tkItem_li, .ans-videoquiz-opt'
        ) ||
        node.parentElement
      : node;
    const raw = clean(
      wrapper?.innerText ||
        node.getAttribute?.('aria-label') ||
        (isInput && !/^(?:on|[A-Z])$/i.test(node.value || '') ? node.value : '')
    ).replace(/^[A-Z]\s*[.、．:：)）]\s*/, '');
    if (raw) return raw;
    if (
      wrapper?.querySelector?.(
        '.u-icon-correct, .u-icon-right, .icon-right, [data-option-boolean="true"]'
      )
    )
      return '正确';
    if (
      wrapper?.querySelector?.(
        '.u-icon-wrong, .u-icon-error, .icon-wrong, [data-option-boolean="false"]'
      )
    )
      return '错误';
    return '';
  }
  function discoverPopupQuestions(existingRoots) {
    const found = [];
    const typeHeaders = all('div, span, h1, h2, h3, h4, p, dt, legend').filter(
      (el) =>
        visible(el) &&
        !el.closest('#keban-study-assistant') &&
        /^(?:【?\s*(?:单选题|多选题|判断题|填空题)\s*】?)$/.test(clean(el.innerText)) &&
        !all('div, span, h1, h2, h3, h4, p', el).some(
          (child) =>
            visible(child) &&
            /^(?:【?\s*(?:单选题|多选题|判断题|填空题)\s*】?)$/.test(clean(child.innerText))
        )
    );
    for (const header of typeHeaders) {
      let node = header.parentElement;
      for (
        let depth = 0;
        depth < 6 && node && node !== document.body;
        depth++, node = node.parentElement
      ) {
        if (!visible(node)) continue;
        if (existingRoots.some((r) => r.contains(node) || node.contains(r))) break;
        if (found.some((r) => r.contains(node) || node.contains(r))) break;
        const hasInputs =
          all('input[type="radio"], input[type="checkbox"]', node).filter((el) => !el.disabled)
            .length >= 2;
        const hasLabeledOptions =
          all('li, label, div, p, span', node).filter((el) =>
            /^[A-Z]\s*[.、．:：)）]\s*\S/.test(clean(el.innerText))
          ).length >= 2;
        if (hasInputs || hasLabeledOptions) {
          if (
            node.parentElement &&
            node.parentElement !== document.body &&
            !/提交/.test(clean(node.innerText)) &&
            /提交/.test(clean(node.parentElement.innerText))
          )
            node = node.parentElement;
          found.push(node);
          break;
        }
      }
    }
    return found;
  }
  function inspectQuestions() {
    const videoQuizSelector =
      '.ans-videoquiz, .ans-videoquiz-wrap, #videoquiz, .tkTopic, .videoquiz, .vjs-quiz, [data-video-quiz]';
    const selector =
      (current?.settings.questionSelector ||
        '.TiMu, .question-item, .questionLi, [data-question]') +
      ', ' +
      videoQuizSelector +
      (adapter ? ', ' + adapter.questionSelector : '');
    const explicitRoots = all(selector)
      .filter(visible)
      .filter((el) => !all(selector, el).some(visible))
      .filter((el) => !adapter || adapter.inspectRoot(el));
    const heuristicRoots = adapter ? [] : discoverPopupQuestions(explicitRoots);
    const roots = [...explicitRoots, ...heuristicRoots];
    return roots.map((root) => {
      const inVideoQuiz =
        heuristicRoots.includes(root) ||
        root.matches(videoQuizSelector) ||
        !!root.closest(
          videoQuizSelector + ', .j-insetCt, [data-mooc-inset], .video-js, #video, .ans-attach-ct'
        );
      let title = root.querySelector(
        (adapter ? adapter.titleSelector + ',' : '') +
          '.Zy_TItle, .mark_name, .question-title, [data-question-title], .stem, .tkItem_title, .ans-videoquiz-title, .ans-videoquiz-stem, .video-quiz-title'
      );
      const choices = all('input[type="radio"], input[type="checkbox"]', root).filter(
        (input) =>
          !input.disabled &&
          visible(
            input.closest('li, label, .answer-item, .tkItem_li, .ans-videoquiz-opt, div') || input
          )
      );
      const customOptions = choices.length
        ? []
        : all(
            (adapter ? adapter.optionSelector + ',' : '') +
              '.Zy_ulTop li, .Zy_ulBottom li, .answerList li, .tkItem_ul li, .tkItem_li, .ans-videoquiz-opt, .ans-videoquiz ul li, [data-option], [role="radio"], [role="checkbox"]',
            root
          ).filter(visible);
      const labeledOptions =
        choices.length || customOptions.length
          ? []
          : all('li, label, div, p', root)
              .filter((el) => {
                if (!visible(el)) return false;
                const t = clean(el.innerText);
                if (!/^[A-Z]\s*[.、．:：)）]\s*\S/.test(t) || t.length > 500) return false;
                return !all('li, label, div, p', el).some(
                  (child) =>
                    visible(child) && /^[A-Z]\s*[.、．:：)）]\s*\S/.test(clean(child.innerText))
                );
              })
              .map((el) => {
                const p = el.parentElement;
                return p && p !== root && clean(p.innerText) === clean(el.innerText) ? p : el;
              })
              .filter((el, i, arr) => arr.indexOf(el) === i);
      const optionNodes = choices.length
        ? choices
        : customOptions.length
          ? customOptions
          : labeledOptions;
      const directFields = all(
        'textarea, input[type="text"], input:not([type]), [contenteditable="true"]',
        root
      ).filter((el) => visible(el) && !el.disabled && !el.readOnly);
      const editorFrames = directFields.length
        ? []
        : all('iframe', root)
            .filter(visible)
            .map((frame) => {
              try {
                const body = frame.contentDocument?.body;
                return body &&
                  (body.isContentEditable || body.getAttribute('contenteditable') === 'true')
                  ? body
                  : null;
              } catch {
                return null;
              }
            })
            .filter(Boolean);
      const fields = directFields.length ? directFields : editorFrames;
      let text;
      if (title) text = clean(title.innerText);
      else {
        const copy = root.cloneNode(true);
        all(
          'input, textarea, button, label, .answerList, .Zy_ulTop, .Zy_ulBottom, .tkItem_ul, .ans-videoquiz-opts, .tkTopic_bottom, [data-option]',
          copy
        ).forEach((el) => el.remove());
        all('li, div, p, span, a', copy).forEach((el) => {
          const t = clean(el.innerText || el.textContent);
          if (
            /^[A-Z]\s*[.、．:：)）]\s*\S/.test(t) ||
            /^(提交|提交答案|提交作业|确定提交|继续|继续学习|继续播放|关闭)$/.test(t)
          )
            el.remove();
        });
        text = clean(copy.textContent);
      }
      const options = optionNodes.map((node, i) => ({
        label: String.fromCharCode(65 + i),
        text: optionText(node, choices.length > 0),
      }));
      const typeHint =
        clean(
          root.querySelector(
            '.type, .colorShallow, .Sub_Tit, .question-type, .tkTopic_title, .ans-videoquiz-type'
          )?.innerText
        ) ||
        clean(
          all('div, span, h1, h2, h3, h4, p', root).find((el) =>
            /^(?:【?\s*(?:单选题|多选题|判断题|填空题|简答题)\s*】?)$/.test(clean(el.innerText))
          )?.innerText
        );
      const fullTitle = (typeHint ? typeHint + ' ' : '') + text;
      let type =
        /多选/.test(fullTitle) ||
        choices.some((el) => el.type === 'checkbox') ||
        !!root.querySelector('.num_option_dx')
          ? 'multiple'
          : /判断/.test(fullTitle) ||
              (options.length === 2 &&
                options.every((o) => /^(?:正确|错误|对|错|是|否|true|false|√|×)$/i.test(o.text)))
            ? 'boolean'
            : options.length
              ? 'single'
              : /填空/.test(fullTitle) || fields.length > 1
                ? 'fill'
                : 'text';
      // Pure image questions need a vision path and must not be guessed from missing text.
      const visualNodes = all('img, canvas, svg, math', root).filter(
        (el) =>
          !el.closest('.keban-ignore') &&
          !/icon|check|right|wrong|radio|checkbox/i.test(
            String(el.className?.baseVal || el.className) + ' ' + (el.getAttribute('src') || '')
          )
      );
      const secretFont = root.matches('.font-cxsecret') || !!root.querySelector('.font-cxsecret');
      const hasImages = visualNodes.length > 0 || secretFont;
      if (hasImages && text.length < 2) text = '【图片题】请根据完整题目截图解答。';
      let captureId = captureIds.get(root);
      if (!captureId) {
        captureId = crypto.randomUUID();
        captureIds.set(root, captureId);
        root.setAttribute('data-keban-capture', captureId);
      }
      const visualSignature = hasImages
        ? (secretFont ? 'font-cxsecret|' : '') +
          visualNodes
            .map(
              (el) =>
                el.getAttribute('src') || el.getAttribute('alt') || el.textContent || el.tagName
            )
            .join('|')
        : '';
      const supported =
        text.length >= 2 &&
        (!hasImages || current?.settings.useVision) &&
        (options.length > 0 || fields.length > 0);
      const answered = optionNodes.length
        ? optionNodes.some(selectedOption)
        : fields.length > 0 && fields.every((el) => clean(fieldValue(el)));
      return {
        root,
        text: text.slice(0, 10000),
        type,
        options,
        fields,
        optionNodes,
        supported,
        answered,
        inVideoQuiz,
        needsImage: hasImages,
        captureId,
        visualSignature,
      };
    });
  }
  function applyAnswer(q, answer) {
    if (
      !q.root.isConnected ||
      !q.supported ||
      answer.confidence < current.settings.minConfidence ||
      !answer.answers.length
    )
      return false;
    if (q.answered) return true;
    if (q.optionNodes.length) {
      const indexes = answer.answers.map((a) => a.charCodeAt(0) - 65);
      if (
        !answer.answers.every((a) => /^[A-Z]$/.test(a)) ||
        indexes.some((i) => i < 0 || i >= q.optionNodes.length)
      )
        return false;
      if (q.type !== 'multiple' && indexes.length !== 1) return false;
      q.optionNodes.forEach((node, index) => {
        const want = indexes.includes(index);
        const selected = selectedOption(node);
        if (selected !== want) {
          node.click();
          if ('checked' in node && node.checked !== want) {
            const wrapper =
              node.labels?.[0] ||
              node.closest('label, li, .tkItem_li, .ans-videoquiz-opt, .answer-item');
            wrapper?.click();
          } else if (!('checked' in node)) {
            const inner = node.querySelector(
              'input[type="radio"], input[type="checkbox"], label, .num_option, .num_option_dx'
            );
            if (inner && !selectedOption(node)) inner.click();
            if (want) node.dataset.kebanSelected = 'true';
            else delete node.dataset.kebanSelected;
          }
        }
      });
      return indexes.every((i) => selectedOption(q.optionNodes[i]));
    }
    if (!q.fields.length || q.fields.length !== answer.answers.length) return false;
    q.fields.forEach((field, index) => {
      if (field.isContentEditable || field.getAttribute?.('contenteditable') === 'true')
        field.textContent = answer.answers[index];
      else {
        const win = field.ownerDocument?.defaultView || window;
        const prototype =
          field.tagName === 'TEXTAREA'
            ? win.HTMLTextAreaElement.prototype
            : win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, answer.answers[index]);
      }
      const Ev = field.ownerDocument?.defaultView?.Event || Event;
      field.dispatchEvent(new Ev('input', { bubbles: true }));
      field.dispatchEvent(new Ev('change', { bubbles: true }));
      field.dispatchEvent(new Ev('blur', { bubbles: true }));
    });
    return q.fields.every((el, i) => fieldValue(el) === answer.answers[i]);
  }
  function matchesAnswer(q, answer) {
    if (!answer || answer.confidence < current.settings.minConfidence || !answer.answers.length)
      return false;
    if (q.optionNodes.length) {
      const selected = q.optionNodes.flatMap((el, i) =>
        selectedOption(el) ? [String.fromCharCode(65 + i)] : []
      );
      return JSON.stringify(selected.sort()) === JSON.stringify([...answer.answers].sort());
    }
    return (
      q.fields.length === answer.answers.length &&
      q.fields.every((el, i) => clean(fieldValue(el)) === clean(answer.answers[i]))
    );
  }
  function makeHud() {
    if (!topFrame || hud || !document.body) return;
    hud = document.createElement('div');
    hud.id = 'keban-study-assistant';
    const shadow = hud.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial;position:fixed;z-index:2147483000;right:20px;bottom:20px;font:13px/1.6 "PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;color:#0f1f38;-webkit-font-smoothing:antialiased}*{box-sizing:border-box}section{width:324px;background:#fff;border:1px solid #d5e1f2;border-radius:14px;box-shadow:0 4px 12px rgba(15,31,56,.08),0 18px 38px -8px rgba(15,31,56,.18);overflow:hidden}header{display:flex;align-items:center;padding:12px 15px;background:linear-gradient(135deg,#17366e 0%,#1d4ed8 100%);color:#fff;gap:9px}strong{font-size:15px;font-weight:700;letter-spacing:.01em}span{font-size:11px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.22);padding:2px 9px;border-radius:999px;font-weight:500;margin-right:auto}button{font:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid #c5d4e8;border-radius:8px;background:linear-gradient(180deg,#fff 0%,#f7fafd 100%);color:#1e3a6d;padding:6px 11px;box-shadow:0 1px 2px rgba(15,31,56,.04);transition:background .15s,border-color .15s}button:hover{background:#eef4fc;border-color:#98b4dc;color:#1d4ed8}header button{border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.12);color:#fff;font-size:15px;line-height:1;width:24px;height:24px;padding:0;border-radius:6px;display:grid;place-items:center;box-shadow:none}header button:hover{background:rgba(255,255,255,.24);border-color:rgba(255,255,255,.4);color:#fff}main{padding:14px 15px}main>p{margin:0 0 10px;padding:8px 11px;background:#f2f6fc;border:1px solid #dce6f5;border-left:3px solid #2563eb;border-radius:8px;font-size:12.5px;font-weight:500;color:#152945}pre{font:inherit;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:235px;overflow:auto;margin:10px 0;padding:10px 11px;background:#f8fafd;border:1px solid #e1eaf5;border-radius:9px;color:#2c4260}pre:empty{display:none}footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}footer button{flex:1}button:focus-visible{outline:3px solid #85b6f6;outline-offset:2px}section.collapsed main{display:none}`;
    const box = document.createElement('section');
    const header = document.createElement('header');
    const brand = document.createElement('strong');
    brand.textContent = '课伴';
    hudBadge = document.createElement('span');
    hudBadge.textContent = adapter?.name || '学习通助手';
    const collapse = document.createElement('button');
    collapse.textContent = '−';
    collapse.title = '收起 / 展开';
    collapse.onclick = () => {
      box.classList.toggle('collapsed');
      collapse.textContent = box.classList.contains('collapsed') ? '+' : '−';
    };
    header.append(brand, hudBadge, collapse);
    const main = document.createElement('main');
    if (adapter) {
      hudCoursePicker = document.createElement('div');
      hudCoursePicker.hidden = true;
      hudCoursePicker.style.cssText =
        'margin-bottom:10px;padding:10px;background:#f8fafd;border:1px solid #dce5f2;border-radius:9px';
      const label = document.createElement('label');
      label.textContent = '选择需要继续的MOOC课程';
      label.style.cssText = 'display:block;font-size:12px;font-weight:600;color:#1e3a6d';
      hudCourseSelect = document.createElement('select');
      hudCourseSelect.style.cssText =
        'width:100%;margin:7px 0 8px;padding:7px 9px;border:1px solid #c5d4e8;border-radius:7px;background:#fff;font:inherit;font-size:12.5px';
      const choose = document.createElement('button');
      choose.textContent = '选择课程';
      choose.onclick = () =>
        send('KP_MOOC_SELECT_COURSE', { title: hudCourseSelect.value })
          .then(() => tick())
          .catch(showError);
      label.append(hudCourseSelect);
      hudCoursePicker.append(label, choose);
      main.append(hudCoursePicker);
    }
    hudStatus = document.createElement('p');
    hudStatus.textContent = '从浏览器工具栏打开课伴，开始托管。';
    hudAnswer = document.createElement('pre');
    const footer = document.createElement('footer');
    const stop = document.createElement('button');
    stop.textContent = '停止';
    stop.onclick = () => send('KP_BLOCK', { reason: '已从课程面板停止托管。' }).catch(showError);
    const copy = document.createElement('button');
    copy.textContent = '复制解析';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(hudAnswer.textContent);
        copy.textContent = '已复制';
        setTimeout(() => (copy.textContent = '复制解析'), 1500);
      } catch {
        showError(new Error('复制失败，请在插件窗口中查看解析。'));
      }
    };
    hudPending = document.createElement('div');
    hudPending.style.cssText =
      'font-size:12px;color:#8d5329;margin:10px 0;padding:9px 11px;background:#fffbeb;border:1px solid #f5d89a;border-radius:9px;max-height:250px;overflow:auto';
    hudPending.hidden = true;
    footer.append(stop, copy);
    main.append(hudStatus, hudPending, hudAnswer, footer);
    box.append(header, main);
    shadow.append(style, box);
    document.body.append(hud);
  }
  function showError(error) {
    if (hudStatus) hudStatus.textContent = error.message;
  }
  let pendingSignature = '';
  function renderPending() {
    if (!hudPending) return;
    const course = location.origin + location.pathname,
      pending = adapter
        ? (current.moocManualTasks || []).filter((task) => task.course === course)
        : [],
      signature = JSON.stringify(pending);
    hudPending.hidden = !pending.length;
    if (signature === pendingSignature) return;
    pendingSignature = signature;
    hudPending.replaceChildren();
    if (!pending.length) return;
    const title = document.createElement('p');
    title.textContent = `需本人处理（${pending.length}项）`;
    const recheck = document.createElement('button');
    recheck.textContent = '复查本页';
    recheck.onclick = () => tick();
    title.append(' ', recheck);
    hudPending.append(title);
    for (const task of pending) {
      const row = document.createElement('div');
      row.style.cssText = 'border-top:1px solid #e2e7ef;padding:9px 0';
      const label = document.createElement('div');
      label.textContent = (task.chapter ? task.chapter + ' · ' : '') + task.title;
      const reason = document.createElement('div');
      reason.textContent = task.reason;
      reason.style.cssText = 'color:#607289;font-size:11px;margin:4px 0';
      const open = document.createElement('button');
      open.textContent = '前往处理';
      open.onclick = async () => {
        try {
          if (inspectQuestions().length && !isSubmissionConfirmed())
            throw new Error('当前仍有作答中的题目，请先保存或提交后再切换。');
          await send('KP_MOOC_REVIEW', { key: task.key });
          await tick();
        } catch (error) {
          showError(error);
        }
      };
      row.append(label, reason, open);
      hudPending.append(row);
    }
  }
  function setCourses(titles) {
    if (!hudCourseSelect) return;
    hudCoursePicker.hidden = !titles.length;
    if (
      JSON.stringify([...hudCourseSelect.options].map((option) => option.value)) ===
      JSON.stringify(titles)
    )
      return;
    const previous =
      hudCourseSelect.value || current.targetCourse || current.settings.moocCourseName;
    hudCourseSelect.replaceChildren(
      ...titles.map((title) => {
        const option = document.createElement('option');
        option.value = title;
        option.textContent = title;
        return option;
      })
    );
    if (titles.includes(previous)) hudCourseSelect.value = previous;
  }
  function courseStatus(videoReport) {
    const reports = [
      videoReport,
      ...Object.values(current.frames || {}).filter((f) => Date.now() - f.time < 9000),
    ];
    if (current.submission)
      return current.submission.phase === 'awaiting_result'
        ? '练习已确认提交，等待平台返回结果。'
        : '练习已填写，正在处理提交确认。';
    const waiting = reports.find((f) => f.waiting)?.waiting,
      playing = reports.find((f) => f.progress)?.progress;
    return (
      waiting ||
      (playing
        ? `音视频播放中 · ${playing}`
        : current.progress?.doneCards?.[current.context?.card]
          ? '当前任务已完成，准备进入下一项。'
          : '正在识别当前任务与播放器。')
    );
  }
  function displayResult(result) {
    lastResult = result;
    if (hudAnswer)
      hudAnswer.textContent = `${result.text}\n\n答案：${result.answers.join('、') || '待确认'}\n模型自评：${Math.round(result.confidence * 100)}%\n\n${result.explanation}`;
  }
  async function blockIfNeeded() {
    const captcha = all(
      '#captcha, #captchaWrap, .captcha, .yidun_popup, .geetest_panel, .nc-container, [data-study-captcha]'
    ).find(visible);
    const exam =
      /\/(?:exam|exam-ans)\//i.test(location.pathname) ||
      /(?:正在考试|考试剩余时间)/.test(document.title);
    const login = all('input[type="password"]').some(visible);
    const commitment = all('.commitment-content-dialog').some(visible);
    const platformReason = adapter?.blockReason();
    if (
      (captcha || exam || login || commitment || platformReason) &&
      (current.running || (current.manualUntil || 0) > Date.now()) &&
      !blockedReported
    ) {
      blockedReported = true;
      await send('KP_BLOCK', {
        reason: captcha
          ? '页面出现验证码，请处理后重新开始。'
          : login
            ? '登录已失效，请登录后重新开始。'
            : commitment
              ? '页面要求本人阅读并确认学习诚信承诺，请在课程页面处理。'
              : platformReason || '当前是考试页面，托管已停止。',
      });
      return true;
    }
    return !!(captcha || exam || login || commitment || platformReason);
  }
  function dismissVideoQuizOverlay() {
    if (!current?.running || adapter) return false;
    const overlays = all(
      '.ans-videoquiz, .ans-videoquiz-wrap, #videoquiz, .tkTopic, .videoquiz, .vjs-quiz, [data-video-quiz]'
    ).filter(visible);
    const scopes = overlays.length
      ? overlays
      : all('video, audio').some((el) => visible(el) || !!el.currentSrc)
        ? [document.body]
        : [];
    for (const scope of scopes) {
      const btn = all(
        '#videoquiz-continue, .ans-videoquiz-continue, .tkTopic_btn, button, a, input[type="button"], [role="button"], span, div',
        scope
      ).find((el) => {
        if (!visible(el) || el.closest('#keban-study-assistant')) return false;
        const t = clean(el.innerText || el.value);
        if (!/^(继续|继续学习|继续播放|继续观看|关闭弹窗)$/.test(t)) return false;
        return !all('button, a, span, div', el).some(
          (c) =>
            visible(c) && /^(继续|继续学习|继续播放|继续观看|关闭弹窗)$/.test(clean(c.innerText))
        );
      });
      if (btn) {
        btn.click();
        return true;
      }
    }
    return false;
  }
  async function manageVideo() {
    const videos = all('video,audio').filter(
      (el) => visible(el) || (!!el.currentSrc && el.readyState > 0)
    );
    if (videos.length) dismissVideoQuizOverlay();
    const activeVideoQuiz =
      adapter?.mediaHeld() ||
      (!adapter &&
        videos.length > 0 &&
        !isSubmissionConfirmed() &&
        inspectQuestions().some((q) => q.inVideoQuiz));
    const taskMarkers = all('.ans-job-icon.ans-job-video,.ans-job-icon.ans-job-audio');
    const otherMarkers = all('.ans-job-icon').filter(
      (el) => !el.matches('.ans-job-video,.ans-job-audio')
    );
    const jobDone = (el) =>
      el.getAttribute('aria-label') === '任务点已完成' || !!el.closest('.ans-job-finished');
    const report = {
      videos: videos.length,
      ended: 0,
      videoTasks: taskMarkers.length,
      videoTasksDone: taskMarkers.filter(jobDone).length,
      otherTasks: otherMarkers.length,
      otherTasksDone: otherMarkers.filter(jobDone).length,
      mediaTime: 0,
      progress: '',
      waiting: '',
    };
    const taskAlreadyDone =
      (report.videoTasks > 0 && report.videoTasks === report.videoTasksDone) ||
      !!current.progress?.doneCards?.[current.context?.card];
    for (const video of videos) {
      let record = media.get(video);
      if (!record || record.source !== video.currentSrc) {
        record = {
          source: video.currentSrc,
          playFailed: false,
          playAttempts: 0,
          lastPlayAttempt: 0,
          lastTime: Number(video.currentTime) || 0,
          lastMoveAt: Date.now(),
          id: crypto.randomUUID(),
        };
        media.set(video, record);
        video.setAttribute('data-keban-media', record.id);
        if (!video.ended) advanced = false;
      }
      const nowTime = Number(video.currentTime) || 0;
      report.mediaTime += nowTime;
      if (Math.abs(nowTime - (record.lastTime || 0)) >= 0.15) {
        record.lastTime = nowTime;
        record.lastMoveAt = Date.now();
      }
      if (video.ended) report.ended++;
      else if (current.running && current.settings.autoPlay && !taskAlreadyDone) {
        if (activeVideoQuiz) {
          report.waiting = '正在处理视频中的随堂题。';
          record.lastMoveAt = Date.now();
          continue;
        }
        video.muted = current.settings.muted;
        // Use normal browser playback; never seek, change completion APIs, or fake heartbeats.
        if (video.paused && !record.playFailed) {
          try {
            const loaded = await Promise.race([
              video.play().then(() => true),
              new Promise((resolve) => setTimeout(() => resolve(false), 2500)),
            ]);
            if (!loaded) report.waiting = '视频正在加载，稍后自动重试。';
          } catch {
            record.playFailed = true;
          }
        }
        const stalled =
          !video.paused &&
          Date.now() - (record.lastMoveAt || Date.now()) > 15000 &&
          Date.now() - (record.lastPlayAttempt || 0) > 10000;
        if (stalled) {
          record.lastPlayAttempt = Date.now();
          try {
            await video.play();
          } catch {
            record.playFailed = true;
          }
          report.waiting = report.waiting || '检测到音视频播放停滞，正在自检并尝试恢复。';
        }
        if (
          record.playFailed &&
          video.paused &&
          record.playAttempts < 3 &&
          Date.now() - record.lastPlayAttempt > 10000
        ) {
          record.lastPlayAttempt = Date.now();
          record.playAttempts++;
          const result = await send('KP_PLAY_MEDIA', {
            mediaId: record.id,
            generation: current.generation,
          });
          if (result.played) {
            record.playFailed = false;
            await send('KP_LOG', { text: '已通过浏览器播放操作启动音视频。' });
          }
        }
        if (record.playFailed && video.paused)
          report.waiting =
            record.playAttempts < 3
              ? '正在重试浏览器音视频播放操作。'
              : '浏览器仍未允许播放，请点击一次播放器播放按钮。';
        if (!video.paused) record.playFailed = false;
      }
      if (!video.ended && video.duration > 0)
        report.progress = `${Math.floor(video.currentTime / 60)}:${String(Math.floor(video.currentTime % 60)).padStart(2, '0')} / ${Math.floor(video.duration / 60)}:${String(Math.floor(video.duration % 60)).padStart(2, '0')}`;
    }
    return report;
  }
  function catalogNodeDone(el) {
    return (
      !!el &&
      (el.matches('.ans-job-finished,[data-completed="true"]') ||
        !!el.querySelector(
          '.icon_Completed, .catalog_points_yi, .ans-job-finished, [data-completed="true"], [aria-label="任务点已完成"]'
        ))
    );
  }
  function inspectCatalog() {
    const allCatalog = all('#coursetree [id^="cur"],.chapter_item[id^="cur"]').filter(
      (el) =>
        /^cur\d+$/.test(el.id) &&
        !el.querySelector('[id^="cur"]') &&
        !!el.querySelector('.clicktitle,a,[role="button"]')
    );
    const numberedCatalog = allCatalog.filter((el) =>
      /^\d+\.\d+/.test(clean(el.querySelector('.clicktitle')?.innerText || el.innerText))
    );
    const catalog = numberedCatalog.length ? numberedCatalog : allCatalog;
    const index = catalog.findIndex(
      (el) =>
        el.classList.contains('posCatalog_active') ||
        current.context?.chapter.endsWith('#' + el.id.replace(/^cur/, ''))
    );
    return { catalog, index };
  }
  async function nextChapter() {
    if (
      !topFrame ||
      !current.running ||
      !current.settings.autoNext ||
      Date.now() - Math.max(current.pageStarted || 0, current.started || 0) < 6000
    )
      return;
    const frames = Object.values(current.frames || {}).filter((f) => Date.now() - f.time < 9000);
    const count = frames.reduce((n, f) => n + f.videos, 0);
    const taskCount = frames.reduce((n, f) => n + (f.videoTasks || 0), 0);
    const platformVideoDone =
      taskCount > 0 &&
      taskCount >= count &&
      frames.reduce((n, f) => n + (f.videoTasksDone || 0), 0) === taskCount;
    const ended = count > 0 && frames.every((f) => f.videos === f.ended);
    const otherCount = frames.reduce((n, f) => n + (f.otherTasks || 0), 0),
      otherDone =
        count === 0 &&
        taskCount === 0 &&
        otherCount > 0 &&
        otherCount === frames.reduce((n, f) => n + (f.otherTasksDone || 0), 0);
    const { catalog, index } = adapter ? { catalog: [], index: -1 } : inspectCatalog();
    const framesIdle =
      !adapter &&
      frames.length > 0 &&
      frames.every(
        (f) =>
          f.videos === f.ended &&
          (f.videoTasks || 0) === (f.videoTasksDone || 0) &&
          (f.otherTasks || 0) === (f.otherTasksDone || 0) &&
          !f.pending &&
          !(f.questions > 0 && !f.completed)
      );
    const activeCatalogDone =
      framesIdle &&
      catalog.length > 0 &&
      (catalog.every(catalogNodeDone) || (index >= 0 && catalogNodeDone(catalog[index])));
    if (ended || platformVideoDone || otherDone || activeCatalogDone) {
      const mark = await send('KP_TASK_DONE', {
        generation: current.generation,
        kind: otherDone
          ? 'document'
          : activeCatalogDone && !ended && !platformVideoDone
            ? 'selfcheck'
            : 'media',
        catalogDone: activeCatalogDone,
      });
      if (mark.accepted) current = await send('KP_STATE');
    }
    if (
      current.submission ||
      frames.some(
        (f) =>
          (!platformVideoDone && f.videos !== f.ended) ||
          f.pending ||
          (f.waiting && (!platformVideoDone || f.questions))
      )
    )
      return;
    if (framesIdle && catalog.length > 0 && catalog.every(catalogNodeDone)) {
      await send('KP_FINISH', {
        generation: current.generation,
        allCatalogDone: true,
        reason: '自检确认课程目录中全部章节均已完成，托管已结束。',
      });
      return;
    }
    const tabs = taskTabs(),
      done = current.progress?.doneCards || {},
      active = tabs.find((el) => el.classList.contains('active'));
    const currentDone = !!done[current.context?.card || 'page'];
    if (!currentDone && !ended && !platformVideoDone && !frames.some((f) => f.completed)) return;
    if (adapter) {
      const plan = await adapter.nextTarget({ state: current, send });
      if (!plan.target) {
        if (hudStatus && plan.waiting) hudStatus.textContent = plan.waiting;
        return;
      }
      if (
        !visible(plan.target) ||
        plan.target.disabled ||
        plan.target.getAttribute('aria-disabled') === 'true'
      )
        return;
      if (advanced && Date.now() - navigationAt < 10000) return;
      if (navigationAttempts >= 3) {
        navigationAttempts = 0;
        advanced = false;
        await send('KP_SELF_CHECK', {
          generation: current.generation,
          reason: 'MOOC后续内容连续三次未切换，请检查页面提示或课程开放时间。',
        });
        return;
      }
      advanced = true;
      navigationAttempts++;
      navigationAt = Date.now();
      await send('KP_LOG', { text: plan.label });
      plan.target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      plan.target.click();
      return;
    }
    const nextTask = tabs.find((el) => !done[tabKey(el)] && el !== active);
    let target = nextTask;
    if (!target && tabs.some((el) => !done[tabKey(el)])) return;
    if (
      !nextTask &&
      index >= 0 &&
      index < catalog.length - 1 &&
      catalog.slice(index + 1).every(catalogNodeDone)
    ) {
      await send('KP_FINISH', {
        generation: current.generation,
        allCatalogDone: true,
        reason: '自检确认当前及后续章节均已完成，托管已结束。',
      });
      return;
    }
    const nextCatalogIndex =
      index >= 0 ? catalog.findIndex((el, i) => i > index && !catalogNodeDone(el)) : -1;
    const catalogTarget =
      nextCatalogIndex >= 0
        ? catalog[nextCatalogIndex].querySelector('.clicktitle,a,[role="button"]')
        : null;
    if (!target) target = all(current.settings.nextSelector).find(visible);
    if (!target)
      target = all('button, a, [role="button"]').find(
        (el) => visible(el) && /^(下一节|下一章节|下一章|下一任务点)$/.test(clean(el.innerText))
      );
    if (
      !nextTask &&
      ((!target && catalogTarget) ||
        (navigationAttempts >= 2 && catalogTarget) ||
        (nextCatalogIndex > index + 1 && catalogTarget))
    )
      target = catalogTarget;
    if (!target && index >= 0 && index === catalog.length - 1) {
      await send('KP_FINISH', { generation: current.generation });
      return;
    }
    if (
      !target ||
      target.disabled ||
      target.getAttribute('aria-disabled') === 'true' ||
      target.closest('.locked,[aria-disabled="true"]')
    )
      return;
    if (advanced && Date.now() - navigationAt < 10000) return;
    if (navigationAttempts >= 3) {
      navigationAttempts = 0;
      advanced = false;
      await send('KP_SELF_CHECK', {
        generation: current.generation,
        reason: '下一节点击后页面仍未切换，请检查课程限制或页面提示。',
      });
      return;
    }
    navigationAttempts++;
    advanced = true;
    navigationAt = Date.now();
    await send('KP_LOG', {
      text: nextTask
        ? `${platformVideoDone ? '平台已标记视频任务完成，' : '当前任务已完成，'}正在打开本章${clean(nextTask.innerText).replace(/^\d+\s*/, '')}。`
        : target === catalogTarget
          ? '正在通过课程目录进入下一节。'
          : navigationAttempts > 1
            ? '下一节尚未切换，正在重试点击。'
            : `${platformVideoDone ? '平台已标记本页视频任务完成，' : '本章任务均已确认完成，'}正在点击下一节。`,
    });
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.click();
  }
  let submitted = new Map(),
    lastActivityAt = Date.now(),
    lastActivitySignature = '',
    lastSelfCheckAt = 0;
  async function checkStall(waitingText = '') {
    if (
      !topFrame ||
      !current?.running ||
      current.blocked ||
      current.reading?.active ||
      current.moocReview
    )
      return;
    const frames = Object.values(current.frames || {}).filter((f) => Date.now() - f.time < 9000);
    const mediaSec = Math.floor(frames.reduce((n, f) => n + (Number(f.mediaTime) || 0), 0));
    const pendingCount = frames.reduce((n, f) => n + (Number(f.pending) || 0), 0);
    const doneCount = Object.keys(current.progress?.doneCards || {}).length;
    const activeReading = /正在向下浏览|正在翻阅|正在浏览当前课件/.test(waitingText);
    const signature = JSON.stringify([
      current.context,
      current.calls,
      current.actions,
      doneCount,
      mediaSec,
      pendingCount,
      Boolean(current.submission),
      activeReading ? Math.floor(Date.now() / 4000) : '',
    ]);
    if (signature !== lastActivitySignature) {
      lastActivitySignature = signature;
      lastActivityAt = Date.now();
      return;
    }
    if (
      /请在课伴面板选择|尚未开放或被锁定|开启自动阅读|不会自动加入新课程|本人参与讨论|复查本页|未找到该项目的可用入口/.test(
        waitingText
      )
    ) {
      lastActivityAt = Date.now();
      return;
    }
    const timeout = Number(current.settings?.stallTimeout) || 45000;
    if (Date.now() - lastActivityAt < timeout || Date.now() - lastSelfCheckAt < 10000) return;
    lastSelfCheckAt = Date.now();
    lastActivityAt = Date.now();
    await nextChapter();
    current = await send('KP_STATE');
    if (!current.running || current.generation !== runGeneration || current.blocked) return;
    await send('KP_SELF_CHECK', {
      generation: current.generation,
      reason: `页面超过 ${Math.round(timeout / 1000)} 秒无进展`,
    });
  }
  function isSubmissionConfirmed() {
    if (adapter?.isComplete()) return true;
    const notifications = all(
      '[role="status"], .ans-submit-success, .submit-success, .success-message, [data-study-submitted], .workFinishTip, .testTit_status_complete'
    );
    return notifications.some(
      (el) =>
        visible(el) &&
        (el.hasAttribute('data-study-submitted') ||
          /提交成功|已提交|作业已完成/.test(clean(el.innerText)) ||
          (el.matches('.testTit_status_complete') && clean(el.innerText) === '已完成'))
    );
  }
  async function confirmSubmission() {
    if (
      !current.settings.autoConfirm ||
      !current.submission ||
      current.submission.phase === 'awaiting_result' ||
      Date.now() - current.submission.time > 60000
    )
      return false;
    const dialog = all(
      '[role="dialog"], .layui-layer, .modal, .dialog, .popDiv,.ux-modal,.u-window'
    ).find(
      (el) =>
        visible(el) &&
        /提交|交卷/.test(clean(el.innerText)) &&
        !/考试|未作答|未答题|删除|支付|验证码/.test(clean(el.innerText))
    );
    if (!dialog) return false;
    const button = all('button,a,input[type="button"],[role="button"]', dialog).find(
      (el) =>
        visible(el) && /^(确认提交|确定提交|确定|确认|提交)$/.test(clean(el.innerText || el.value))
    );
    if (!button) return false;
    const claim = await send('KP_CLAIM_SUBMIT', {
      generation: current.generation,
      nonce: current.submission.nonce,
    });
    if (!claim.allowed) return false;
    button.click();
    submitClickedAt = 0;
    return true;
  }
  // Return only course controls; editable answers stay with the answer module.
  globalThis.__KEBAN_SNAPSHOT__ = () => {
    snapshotNonce = crypto.randomUUID();
    snapshotTime = Date.now();
    snapshotControls = new Map();
    const controls = [];
    const nodes = all(
      'button,a,[role="button"],input[type="button"],input[type="submit"],input[type="search"],#dct1,#dct2,[data-study-action]'
    );
    for (const node of nodes) {
      if (
        !visible(node) ||
        node.closest('#keban-study-assistant') ||
        node.closest('.TiMu,.question-item,.questionLi,[data-question]') ||
        node.disabled
      )
        continue;
      const label = clean(
        node.innerText ||
          node.value ||
          node.getAttribute('aria-label') ||
          node.title ||
          node.placeholder
      ).slice(0, 160);
      if (
        !label ||
        /删除|退课|购买|支付|充值|付费|注销|退出|密码|授权|验证码|考试|报名|上传|下载|发送|承诺|同意|协议/.test(
          label
        )
      )
        continue;
      const href = node.href || '';
      if (href && !href.startsWith('javascript:')) {
        try {
          const url = new URL(href, location.href);
          if (!(
            url.hostname === 'chaoxing.com' ||
            url.hostname.endsWith('.chaoxing.com') ||
            (adapter &&
              (url.hostname === 'icourse163.org' || url.hostname.endsWith('.icourse163.org')))
          ))
            continue;
        } catch {
          continue;
        }
      }
      if (
        !/学习|课程|章节|继续|播放|视频|测验|下一|上一|目录|返回|确定|确认|提交|完成|进入|搜索|展开|收起|更多/.test(
          label
        ) &&
        !node.hasAttribute('data-study-action') &&
        !href.includes('/mycourse/') &&
        !node.matches('a.clicktitle')
      )
        continue;
      if (
        /提交|确认|确定/.test(label) &&
        (!current?.settings.autoSubmit || Date.now() - submitClickedAt > 60000)
      )
        continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth)
        continue;
      const hit = document.elementFromPoint(
        Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)),
        Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2))
      );
      if (!hit || !node.contains(hit)) continue;
      const id = 'c' + controls.length;
      snapshotControls.set(id, node);
      controls.push({
        id,
        label,
        editable: node.type === 'search',
        disabled: false,
        tag: node.tagName.toLowerCase(),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
      if (controls.length >= 45) break;
    }
    const text = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        return p &&
          !p.closest('script,style,noscript,input,textarea,#keban-study-assistant') &&
          visible(p)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let node,
      length = 0;
    while ((node = walker.nextNode()) && length < 5000) {
      const part = clean(node.textContent);
      if (part) {
        text.push(part);
        length += part.length;
      }
    }
    return {
      url: location.href,
      title: document.title,
      text: clean(text.join('\n')).slice(0, 3500),
      controls,
      nonce: snapshotNonce,
      workflowManaged:
        !!adapter?.workflowManaged() ||
        !!document.querySelector('#chapterIdid,#dct1,#dct2') ||
        (!isSubmissionConfirmed() && inspectQuestions().length > 0),
    };
  };
  async function executeAgent(message) {
    current = await send('KP_STATE');
    if (
      !current.running ||
      current.generation !== message.generation ||
      message.nonce !== snapshotNonce ||
      Date.now() - snapshotTime > 45000 ||
      (await blockIfNeeded())
    )
      throw new Error('页面状态已变化，视觉操作已取消。');
    const plan = message.plan;
    if (plan.action === 'scroll') {
      window.scrollBy({
        top: innerHeight * (plan.direction === 'up' ? -0.7 : 0.7),
        behavior: 'instant',
      });
      snapshotNonce = '';
      return;
    }
    const target = snapshotControls.get(plan.target);
    if (!target?.isConnected || !visible(target) || target.disabled)
      throw new Error('目标控件已消失或不可点击。');
    if (plan.action === 'fill') {
      if (target.type !== 'search') throw new Error('视觉规划只可填写课程搜索框。');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
        target,
        plan.value
      );
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (plan.action === 'click') {
      if (target.tagName === 'A' && target.target === '_blank') target.target = '_self';
      target.click();
    } else throw new Error('不支持的页面动作。');
    snapshotNonce = '';
  }
  async function tick() {
    if (busy || !chrome.runtime?.id) return;
    busy = true;
    const manual = manualRequest,
      fillOnce = fillRequest;
    manualRequest = false;
    fillRequest = false;
    const retainRequest = () => {
      manualRequest = manualRequest || manual;
      fillRequest = fillRequest || fillOnce;
    };
    try {
      current = await send('KP_STATE');
      if (current.reading?.active) {
        await readPage();
        return;
      }
      if (topFrame) {
        const context = pageContext(),
          signature = JSON.stringify(context);
        if (
          signature !== lastPageContext ||
          current.context?.chapter !== context.chapter ||
          current.context?.card !== context.card
        ) {
          await send('KP_CONTEXT', { context });
          lastPageContext = signature;
        }
      }
      current = await send('KP_STATE');
      // A departing iframe can remain visible while its replacement loads.
      // Bind it once to a settled task; never let it report completion for a
      // different task after fetching that task's newer generation number.
      if (!topFrame) {
        const signature = JSON.stringify(current.context);
        const mediaChanged = adapter?.allowFrameRebind();
        if (frameContext && frameContext !== signature) {
          if (mediaChanged) frameContext = '';
          else return;
        }
        if (!frameContext) {
          if (!current.context) {
            retainRequest();
            return;
          }
          if (candidateContext !== signature) {
            candidateContext = signature;
            candidateSince = Date.now();
            retainRequest();
            return;
          }
          if (Date.now() - candidateSince < 2000) {
            retainRequest();
            return;
          }
          frameContext = signature;
          adapter?.bindFrame();
        }
      }
      if (
        topFrame &&
        current.running &&
        current.settings.keepActive &&
        document.hidden &&
        Date.now() - lastKeepActive > 10000
      ) {
        lastKeepActive = Date.now();
        await send('KP_KEEP_ACTIVE');
      }
      const context = JSON.stringify([
        current.settings.endpoint,
        current.settings.model,
        current.settings.visionModel,
        current.settings.useVision,
        current.settings.jsonMode,
      ]);
      if (context !== answerContext) {
        answers.clear();
        attempts.clear();
        answerContext = context;
      }
      if (runGeneration !== current.generation) {
        runGeneration = current.generation;
        attempts.clear();
        retryAfter.clear();
        submitted.clear();
        advanced = false;
        navigationAttempts = 0;
        navigationAt = 0;
        blockedReported = false;
        submitClickedAt = 0;
        submissionConfirmed = false;
        naturalVideoDone = false;
        completedPractice = false;
        visitedTaskTabs = new WeakSet();
        lastActivityAt = Date.now();
        lastActivitySignature = '';
      }
      makeHud();
      renderPending();
      if (hudBadge) hudBadge.textContent = current.running ? '托管中' : '已停止';
      if (current.blocked && hudStatus) hudStatus.textContent = current.blocked;
      if (await blockIfNeeded()) return;
      await adapter?.observe?.({ state: current, send, setCourses });
      const reviewStatus = await adapter?.review?.({ state: current, send, setCourses });
      const platformStatus = reviewStatus?.handled
        ? reviewStatus
        : await adapter?.run({ state: current, send, setCourses });
      if (platformStatus?.handled) {
        if (hudStatus && platformStatus.waiting) hudStatus.textContent = platformStatus.waiting;
        await send('KP_REPORT', {
          generation: runGeneration,
          context: current.context,
          report: {
            videos: 0,
            ended: 0,
            questions: 0,
            pending: 0,
            completed: false,
            waiting: platformStatus.waiting || '',
          },
        });
        await checkStall(platformStatus.waiting || '');
        return;
      }
      const videoReport = await manageVideo();
      if (platformStatus?.waiting) videoReport.waiting = platformStatus.waiting;
      submissionConfirmed =
        videoReport.videos > 0
          ? isSubmissionConfirmed()
          : submissionConfirmed || isSubmissionConfirmed();
      let questions = submissionConfirmed ? [] : inspectQuestions();
      if (!questions.length && videoReport.videos > 0) submitted.clear();
      if (
        current.running &&
        current.settings.autoRead &&
        /\/coursedata\/readjobv2\/show/.test(location.pathname) &&
        Date.now() - (current.pageStarted || 0) > 6000
      ) {
        const urls = all('a[href]')
          .map((el) => el.href)
          .filter((url) => /\/(?:zt|reader|read|book|pdf)\//i.test(url));
        if (urls.length) {
          await send('KP_READING_REGISTER', { urls });
          return;
        }
      }
      if (
        current.running &&
        /\/zt\/vote\//.test(location.pathname) &&
        Date.now() - (current.pageStarted || 0) > 15000
      ) {
        await send('KP_BLOCK', {
          reason: '当前为课程问卷，请本人填写个人反馈；插件不会代填个人情况。',
        });
        return;
      }
      // Publish the exercise before waiting for any model response. The parent
      // frame must never start navigation while the first answer is in flight.
      await send('KP_REPORT', {
        generation: runGeneration,
        context: topFrame ? current.context : JSON.parse(frameContext),
        report: {
          ...videoReport,
          questions: questions.length,
          pending: questions.filter((q) => !q.answered).length,
          completed: submissionConfirmed,
          waiting: questions.length ? '章节练习正在处理。' : videoReport.waiting,
        },
      });
      if (hudStatus && !current.blocked)
        hudStatus.textContent = current.running
          ? courseStatus(videoReport)
          : '托管已停止，可在工具栏查看状态。';
      const shouldSolve = (current.running && current.settings.autoSolve) || manual;
      let filled = 0;
      for (let q of questions) {
        if (!current.running && !manual && !fillOnce) break;
        const key = questionKey(q);
        // Reopening an already filled exercise must recover its answer proof;
        // preserve the existing fields while checking them before submission.
        if (q.answered && (!current.running || !current.settings.autoSubmit || answers.has(key))) {
          filled++;
          continue;
        }
        if (!q.supported) continue;
        if (Date.now() < (retryAfter.get(key) || 0)) continue;
        if (shouldSolve && !answers.has(key) && !attempts.has(key)) {
          attempts.add(key);
          const generation = current.generation;
          if (q.needsImage)
            await Promise.race([
              Promise.all([
                document.fonts.ready,
                ...all('img', q.root).map((image) => image.decode?.().catch(() => {})),
              ]),
              new Promise((resolve) => setTimeout(resolve, 2000)),
            ]);
          let answer;
          try {
            answer = await send('KP_SOLVE', {
              question: {
                text: q.text,
                type: q.type,
                options: q.options,
                needsImage: q.needsImage,
                captureId: q.captureId,
              },
              generation,
            });
          } catch (error) {
            if (error.retryable) {
              attempts.delete(key);
              retryAfter.set(key, Date.now() + 4000);
              if (hudStatus) hudStatus.textContent = '接口暂时不可用，稍后自动重试。';
              return;
            }
            throw error;
          }
          const fresh = await send('KP_STATE');
          current = fresh;
          if (
            fresh.generation !== generation ||
            !(fresh.running || (fresh.manualUntil || 0) > Date.now())
          )
            break;
          answers.set(key, answer);
          displayResult({ text: q.text, ...answer });
          q = inspectQuestions().find((candidate) => questionKey(candidate) === key);
          if (!q) continue;
        }
        const answer = answers.get(key);
        if (answer && ((current.running && current.settings.autoFill) || fillOnce)) {
          if (applyAnswer(q, answer)) {
            filled++;
            await send('KP_LOG', { text: `已填写：${q.text.slice(0, 45)}` });
          }
        }
      }
      // Re-read the DOM: only actually selected/written fields count as resolved.
      questions = isSubmissionConfirmed() ? [] : inspectQuestions();
      const remaining = questions.filter((q) => !q.answered).length;
      const incomplete = questions.some((q) => !q.supported && !q.answered);
      const reviewReason = questions.some(
        (q) =>
          q.answered &&
          answers.has(questionKey(q)) &&
          !matchesAnswer(q, answers.get(questionKey(q)))
      )
        ? '已有答案与模型解析不一致或把握不足，请复核后继续。'
        : questions.some(
              (q) =>
                !q.answered &&
                answers.has(questionKey(q)) &&
                answers.get(questionKey(q)).confidence < current.settings.minConfidence
            )
          ? '有题目未达到自动填写阈值，请复核后继续。'
          : '';
      submissionConfirmed = submissionConfirmed || isSubmissionConfirmed();
      await send('KP_REPORT', {
        generation: runGeneration,
        context: topFrame ? current.context : JSON.parse(frameContext),
        report: {
          ...videoReport,
          questions: questions.length,
          pending: remaining,
          completed: submissionConfirmed,
          waiting:
            videoReport.waiting ||
            reviewReason ||
            (remaining
              ? incomplete
                ? '含暂不支持的交互题型，请手动处理。'
                : '题目待解析、填写或复核。'
              : questions.length && !submissionConfirmed
                ? '练习已填写，等待提交成功。'
                : ''),
        },
      });
      // Stopping from the toolbar can happen during any awaited operation above.
      current = await send('KP_STATE');
      if (current.generation !== runGeneration || (await blockIfNeeded())) return;
      if (reviewReason && current.running && current.settings.autoSubmit) {
        await send('KP_BLOCK', { reason: reviewReason });
        return;
      }
      const inVideoQuiz = questions.some((q) => q.inVideoQuiz);
      if (
        current.running &&
        (current.settings.autoSubmit || inVideoQuiz) &&
        questions.length &&
        !remaining
      ) {
        const signature = questions.map(questionKey).join('|');
        const allReliable = questions.every((q) => matchesAnswer(q, answers.get(questionKey(q))));
        // Confirm only the dialog produced by this explicit exercise submission.
        const submitSelector =
          'button, a, input[type="button"], input[type="submit"], [role="button"], .tkTopic_btn, .tkTopic_sub, .ans-videoquiz-submit, #videoquiz-submit, .j-submit, span, div';
        const isSubmitBtn = (el) =>
          visible(el) &&
          !el.closest('#keban-study-assistant') &&
          /^(提交|提交答案|提交作业|确定提交)$/.test(clean(el.innerText || el.value)) &&
          !all('button, a, span, div', el).some(
            (c) => visible(c) && /^(提交|提交答案|提交作业|确定提交)$/.test(clean(c.innerText))
          );
        const button =
          questions.map((q) => all(submitSelector, q.root).find(isSubmitBtn)).find(Boolean) ||
          all(submitSelector).find(isSubmitBtn);
        const previous = submitted.get(signature);
        if (allReliable && button && (!previous || Date.now() - previous.time >= 12000)) {
          if ((previous?.attempts || 0) >= 3) {
            await send('KP_BLOCK', { reason: '练习提交三次后仍未出现完成状态，请检查平台提示。' });
            return;
          }
          const intent = await send('KP_SUBMIT_INTENT', {
            generation: current.generation,
            inVideo: inVideoQuiz,
          });
          if (intent.allowed) {
            submitted.set(signature, { time: Date.now(), attempts: (previous?.attempts || 0) + 1 });
            submitClickedAt = Date.now();
            await send('KP_LOG', {
              text: inVideoQuiz
                ? '已提交视频随堂测验弹窗答案。'
                : previous
                  ? '练习尚未确认完成，正在重试提交。'
                  : '已点击本页练习的提交按钮。',
            });
            button.click();
          }
        }
      }
      if (current.running && (await confirmSubmission()))
        await send('KP_LOG', { text: '已确认章节练习提交。' });
      await nextChapter();
      if (
        topFrame &&
        current.running &&
        current.settings.visualAgent &&
        Date.now() - lastVisualAttempt > current.settings.agentInterval &&
        Date.now() - Math.max(current.started || 0, current.pageStarted || 0) > 8000
      ) {
        const reports = Object.values(current.frames || {}).filter(
          (report) => Date.now() - report.time < 9000
        );
        if (
          !current.submission &&
          !document.querySelector('#chapterIdid,#dct1,#dct2') &&
          !reports.some(
            (report) =>
              report.videos > report.ended ||
              report.pending > 0 ||
              report.waiting ||
              (report.questions > 0 && !report.completed)
          )
        ) {
          lastVisualAttempt = Date.now();
          await send('KP_AGENT', { generation: current.generation });
        }
      }
      if (topFrame && current.running && advanced && Date.now() - navigationAt > 15000 && hudStatus)
        hudStatus.textContent = '正在验证下一节是否加载，未生效将自动重试。';
      await checkStall(courseStatus(videoReport));
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      if (manualRequest || fillRequest) setTimeout(tick, 300);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'KP_RESULT') {
      makeHud();
      displayResult(message.result);
    }
    if (message.type === 'KP_SOLVE_PAGE') {
      manualRequest = true;
      tick();
    }
    if (message.type === 'KP_FILL_PAGE') {
      fillRequest = true;
      tick();
    }
    if (message.type === 'KP_WAKE') tick();
    if (message.type === 'KP_CAPTURE_VISIBILITY' && hud)
      hud.style.visibility = message.hidden ? 'hidden' : 'visible';
    if (message.type === 'KP_AGENT_ACTION') {
      executeAgent(message)
        .then(() => respond({ ok: true }))
        .catch((error) => respond({ ok: false, error: error.message }));
      return true;
    }
    respond({ ok: true });
  });
  send('KP_HELLO')
    .then(tick)
    .catch(() => {});
  const tickTimer = setInterval(() => {
    if (!chrome.runtime?.id) {
      clearInterval(tickTimer);
      clearInterval(guardTimer);
      return;
    }
    tick();
  }, 1800);
  // A CAPTCHA can appear while the model is still responding.
  const guardTimer = setInterval(() => {
    if (!chrome.runtime?.id) {
      clearInterval(tickTimer);
      clearInterval(guardTimer);
      return;
    }
    if (busy && current && (current.running || (current.manualUntil || 0) > Date.now()))
      blockIfNeeded().catch(() => {});
  }, 600);
})();
