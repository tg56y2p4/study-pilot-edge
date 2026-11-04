(() => {
  if (globalThis.__KEBAN_INSTALLED__) return;
  globalThis.__KEBAN_INSTALLED__ = true;
  const topFrame = window === window.top;
  const adapter = globalThis.__KEBAN_ADAPTER__;
  const answers = new Map();
  const answerBaselines = new Map();
  const localSaves = new WeakMap();
  const savedEditorFields = new WeakMap();
  const attempts = new Set();
  const retryAfter = new Map();
  const questionDigests = new Map();
  const corrections = new Map();
  let pageCorrection = null;
  let assessmentMove = null;
  const handledRejections = new Set();
  let lastSubmitted = null;
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
  const questionKey = (q) =>
    JSON.stringify([
      q.type,
      q.text,
      q.options.map((option, index) => ({
        label: String.fromCharCode(65 + index),
        text: String(option.text || '').slice(0, 2000),
      })),
      String(q.visualSignature || '').slice(0, 2000),
      ...(q.slots ? [q.slots] : []),
      ...(q.blankCount ? [q.blankCount] : []),
      ...(q.minLength ? [q.minLength] : []),
    ]);
  async function questionDigest(q) {
    const key = questionKey(q);
    if (!questionDigests.has(key)) {
      if (questionDigests.size > 500) questionDigests.clear();
      questionDigests.set(
        key,
        crypto.subtle
          .digest('SHA-256', new TextEncoder().encode(key))
          .then((hash) =>
            [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
          )
      );
    }
    return questionDigests.get(key);
  }
  function selectedAnswers(q) {
    return q.optionNodes.length
      ? q.optionNodes.flatMap((node, i) =>
          selectedOption(node) ? [String.fromCharCode(65 + i)] : []
        )
      : q.fields.map((field) => clean(fieldValue(field)));
  }
  function answerSignature(values, type) {
    const normalized = values.map((value) =>
      String(value).normalize('NFKC').replace(/\s+/g, ' ').trim()
    );
    return JSON.stringify(
      ['single', 'multiple', 'boolean'].includes(type) ? normalized.sort() : normalized
    );
  }
  function answerReliable(answer) {
    const adopted = answer?.review?.status === 'best_effort';
    return !!(
      answer?.answers?.length &&
      (!answer.validationIssue || answer.validationKind === 'confidence') &&
      (adopted || !answer.uncertain) &&
      !answer.reviewIssue &&
      !answer.platformRejected
    );
  }
  const selectedOption = (node) =>
    'checked' in node
      ? node.checked
      : node.matches(
          '.checked, .selected, .check_answer, .check_answer_dx, .on, .cur, .active, .is-checked, .tkItem_li_cur, .ans-videoquiz-opt-checked, [aria-checked="true"], [aria-selected="true"]'
        ) ||
        !!node.querySelector(
          '.num_option.check_answer, .num_option_dx.check_answer, .check_answer, .check_answer_dx, .on, .cur, .active, .is-checked, input:checked'
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
  const fieldValue = (el) => {
    const value = el.value ?? el.innerText ?? el.textContent ?? '';
    return richField(el) ? value.replace(/[\u200b\ufeff]/g, '') : value;
  };
  const editorUi =
    '.edui-editor-toolbarbox,.edui-toolbar,.edui-popup,.edui-dialog,.cke_top,.tox-toolbar,[role=toolbar]';
  const richField = (el) =>
    el.isContentEditable || (el.tagName === 'BODY' && el.ownerDocument.designMode === 'on');
  const localSaveSucceeded = (scope) =>
    all('.save-status,[data-answer-save-status],.savebtndiv [role="status"]', scope).some(
      (node) => visible(node) && /保存成功|已保存|暂存成功/.test(clean(node.innerText))
    );
  const fieldMatches = (el, value) => {
    const normalize = (text) =>
      clean(text)
        .normalize('NFKC')
        .replace(/[\u200b\ufeff]/g, '')
        .replace(/\s+/g, ' ');
    return normalize(fieldValue(el)) === normalize(value);
  };
  function optionWrapper(node, isInput) {
    return isInput
      ? [...(node.labels || [])].find(visible) ||
          node.closest(
            'li, label, .answer-item, .option, .answerOption, .tkItem_li, .ans-videoquiz-opt'
          ) ||
          (node.parentElement?.querySelectorAll('input[type="radio"],input[type="checkbox"]')
            .length === 1
            ? node.parentElement
            : node)
      : node;
  }
  function orderOptions(nodes, isInput) {
    const letters = nodes.map((node) => {
      const wrapper = optionWrapper(node, isInput);
      const text = clean(wrapper?.innerText || node.getAttribute('aria-label')).normalize('NFKC');
      const printed = text.match(/^([A-Z])(?:\s*[.、:：)）]|\n|$)/i)?.[1];
      const marker = clean(
        wrapper?.querySelector('.num_option,.num_option_dx,[data-option-label],[name^="answer"]')
          ?.textContent
      );
      return (
        printed ||
        (/^[A-Z]$/i.test(marker) ? marker : '') ||
        (isInput && /^[A-Z]$/.test(node.value) ? node.value : '')
      ).toUpperCase();
    });
    if (!letters.some(Boolean)) return { nodes, issue: '' };
    const valid =
      letters.every((letter) => /^[A-Z]$/.test(letter)) &&
      new Set(letters).size === nodes.length &&
      [...letters].sort().every((letter, index) => letter === String.fromCharCode(65 + index));
    return valid
      ? {
          nodes: nodes
            .map((node, index) => ({ node, letter: letters[index] }))
            .sort((a, b) => a.letter.localeCompare(b.letter))
            .map((item) => item.node),
          issue: '',
        }
      : { nodes, issue: '选项字母缺失、重复或不连续，无法确认答案与控件的对应关系。' };
  }
  function optionText(node, isInput) {
    const wrapper = optionWrapper(node, isInput);
    let raw = clean(
      wrapper?.innerText ||
        node.getAttribute?.('aria-label') ||
        (isInput && !/^(?:on|[A-Z])$/i.test(node.value || '') ? node.value : '')
    );
    const marker = clean(
      wrapper?.querySelector('.num_option,.num_option_dx,[data-option-label],[name^="answer"]')
        ?.textContent
    );
    if (/^[A-Z]$/i.test(marker) && raw.startsWith(marker))
      raw = raw
        .slice(marker.length)
        .trim()
        .replace(/^[.、．:：)）]\s*/, '');
    else raw = raw.replace(/^[A-Z]\s*[.、．:：)）]\s*/, '');
    if (raw && !/^[A-Z]$/i.test(raw)) return raw;
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
    return raw;
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
      ', .mark_item, .newTiMu, .singleQuesId' +
      (adapter ? ', ' + adapter.questionSelector : '');
    const explicitRoots = all(selector)
      .filter(visible)
      .filter((el) => !all(selector, el).some(visible))
      .filter((el) => !adapter || adapter.inspectRoot(el));
    const heuristicRoots = adapter ? [] : discoverPopupQuestions(explicitRoots);
    const roots = [...explicitRoots, ...heuristicRoots];
    return roots.map((root) => {
      const questionId = root.querySelector('input[name^="questionId"]')?.value;
      const typeInput =
        !adapter &&
        (root.querySelector('input[id^="answertype"],input[name^="answertype"]') ||
          (questionId && all('input', root).find((input) => input.name === 'type' + questionId)));
      const typeCode = typeInput?.value?.trim();
      const matchingSelector =
        '.beautiSelect .thirdUlList select,.line-match select,[data-match-select]';
      const matching = typeCode === '11' && !!root.querySelector(matchingSelector);
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
      const choices = matching
        ? []
        : all('input[type="radio"], input[type="checkbox"]', root).filter(
            (input) =>
              !input.disabled &&
              visible(
                input.closest('li, label, .answer-item, .tkItem_li, .ans-videoquiz-opt, div') ||
                  input
              )
          );
      const candidates =
        matching || choices.length
          ? []
          : all(
              (adapter ? adapter.optionSelector + ',' : '') +
                '.Zy_ulTop li, .Zy_ulBottom li, .answerList li, .tkItem_ul li, .tkItem_li, .mark_letter li, .mark_options li, .before-after, .before-after-checkbox, .answerBg, .ans-videoquiz-opt, .ans-videoquiz ul li, [data-option], [role="radio"], [role="checkbox"]',
              root
            ).filter(visible);
      const customOptions = candidates.filter(
        (node) => !candidates.some((other) => other !== node && other.contains(node))
      );
      const labeledOptions =
        matching || choices.length || customOptions.length
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
      const unorderedOptions = choices.length
        ? choices
        : customOptions.length
          ? customOptions
          : labeledOptions;
      const ordered = orderOptions(unorderedOptions, choices.length > 0);
      const optionNodes = ordered.nodes;
      const directFields = all(
        matching
          ? matchingSelector
          : 'textarea, input[type="text"], input:not([type]), [contenteditable]:not([contenteditable="false"])',
        root
      ).filter(
        (el) =>
          (visible(el) ||
            (matching && visible(el.closest('.beautiSelect,.line-match,[data-match-row]')))) &&
          (matching || !el.disabled) &&
          !el.readOnly &&
          !el.closest(editorUi)
      );
      const editorFrames = all('iframe', root)
        .filter(
          (frame) =>
            visible(frame) ||
            localSaveSucceeded(frame.closest('.blankItemDiv,.Answer,.stem_answer') || root) ||
            (savedEditorFields.get(root)?.generation === runGeneration &&
              savedEditorFields
                .get(root)
                .fields.some(
                  (field) => field.ownerDocument === frame.contentDocument && field.isConnected
                ))
        )
        .map((frame) => {
          try {
            const body = frame.contentDocument?.body;
            return body && richField(body) ? body : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const fields = [...directFields, ...editorFrames].filter(
        (el, index, nodes) =>
          nodes.indexOf(el) === index && !nodes.some((other) => other !== el && other.contains(el))
      );
      fields.sort((a, b) => {
        const anchor = (field) =>
          field.ownerDocument === document ? field : field.ownerDocument.defaultView?.frameElement;
        const first = anchor(a),
          second = anchor(b);
        if (!first || !second || first === second) return 0;
        return first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      const stems = all('.B_stem > .order_answer,.line-stem,[data-match-stem]', root);
      const slots = matching
        ? fields.map((field, index) => ({
            prompt: (() => {
              const row = field.closest('li')?.cloneNode(true);
              if (row)
                all(
                  'select,.chosen-single,.chosen-container,.chosen-drop,input,button',
                  row
                ).forEach((node) => node.remove());
              return clean(stems[index]?.innerText || row?.textContent || String(index + 1)).slice(
                0,
                400
              );
            })(),
            options: [...field.options]
              .filter((option) => option.value && !option.disabled)
              .map((option) => ({
                value: option.value,
                text: clean(option.textContent).slice(0, 500),
              })),
          }))
        : undefined;
      const slotIssue = slots?.some(
        (slot) =>
          !slot.options.length ||
          slot.options.length > 26 ||
          new Set(slot.options.map((option) => option.value)).size !== slot.options.length
      )
        ? '连线下拉选项尚未完整加载，无法确认每空的可选值。'
        : '';
      let text;
      if (title) text = clean(title.innerText);
      else {
        const copy = root.cloneNode(true);
        all(
          'input, textarea, iframe, [contenteditable], .edui-editor, button, label, .answerList, .Zy_ulTop, .Zy_ulBottom, .tkItem_ul, .ans-videoquiz-opts, .tkTopic_bottom, [data-option]',
          copy
        ).forEach((el) => el.remove());
        all('li, div, p, span, a', copy).forEach((el) => {
          const t = clean(el.innerText || el.textContent);
          if (
            /^[A-Z]\s*[.、．:：)）]\s*\S/.test(t) ||
            isWrongFeedbackText(t) ||
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
      const typeCodes = {
        0: 'single',
        1: 'multiple',
        2: 'fill',
        3: 'boolean',
        4: 'text',
        5: 'text',
        6: 'text',
        7: 'text',
        8: 'text',
        9: 'fill',
        10: 'fill',
        ...(matching ? { 11: 'fill' } : {}),
      };
      const unknownType =
        typeInput && /^\d+$/.test(typeCode) && !Object.hasOwn(typeCodes, typeCode);
      let type =
        (Object.hasOwn(typeCodes, typeCode) && typeCodes[typeCode]) ||
        (/多选/.test(fullTitle) ||
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
                : 'text');
      // Pure image questions need a vision path and must not be guessed from missing text.
      const visualNodes = all('img, canvas, svg, math', root).filter(
        (el) =>
          !el.closest('.keban-ignore') &&
          !el.closest(editorUi) &&
          !fields.some((field) => field.contains(el)) &&
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
        !slotIssue &&
        !unknownType &&
        !ordered.issue &&
        text.length >= 2 &&
        (!hasImages || current?.settings.useVision) &&
        (options.length > 0 || fields.length > 0);
      const answered = optionNodes.length
        ? optionNodes.some(selectedOption)
        : fields.length > 0 && fields.every((el) => clean(fieldValue(el)));
      const limits = root.cloneNode(true);
      all('input,textarea,[contenteditable],iframe', limits).forEach((node) => node.remove());
      const textMinimum = /(?:不少于|不低于|至少|最少)\s*([0-9,]+)\s*字/.exec(
        clean(limits.textContent).normalize('NFKC')
      );
      const minLength =
        type === 'text' && fields.length === 1
          ? Math.max(
              Number(fields[0].minLength) || 0,
              Number(textMinimum?.[1]?.replace(/,/g, '')) || 0
            )
          : 0;
      return {
        root,
        text: text.slice(0, 10000),
        type,
        options,
        fields,
        optionNodes,
        optionIssue: unknownType
          ? `当前${{ 11: '连线题', 14: '完形填空', 15: '阅读组合题' }[typeCode] || '交互题型'}需要单独适配，暂不支持自动作答。`
          : slotIssue || ordered.issue,
        supported,
        answered,
        inVideoQuiz,
        needsImage: hasImages,
        captureId,
        visualSignature,
        ...(type === 'fill' && fields.length ? { blankCount: fields.length } : {}),
        ...(slots ? { slots } : {}),
        ...(minLength > 0 && minLength <= 20000 ? { minLength } : {}),
      };
    });
  }
  async function writeEditorField(q, field, value, syncOnly = false) {
    const generation = current.generation,
      running = current.running;
    const expected = fieldValue(field),
      token = crypto.randomUUID();
    field.setAttribute('data-keban-editor', token);
    for (let attempt = 0; attempt < 24; attempt++) {
      const fresh = await send('KP_STATE');
      if (fresh.generation !== generation || (running && !fresh.running) || !q.root.isConnected)
        return false;
      const result = await send('KP_EDITOR_WRITE', {
        generation,
        fieldToken: token,
        value,
        expected,
        syncOnly,
      });
      if (result.changed || result.stopped) return false;
      if (result.written) return true;
      if (!result.retryable) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const reason = '文本编辑器尚未就绪或未同步提交内容，已保留页面作答。';
    await send('KP_BLOCK', { reason });
    throw new Error(reason);
  }
  async function applyAnswer(q, answer, replaceRejected = false) {
    if (!q.root.isConnected || !q.supported || !answerReliable(answer)) return false;
    if (q.answered && matchesAnswer(q, answer)) return true;
    if (q.answered && !replaceRejected) return false;
    if (q.optionNodes.length) {
      const indexes = answer.answers.map((a) => a.charCodeAt(0) - 65);
      if (
        !answer.answers.every((a) => /^[A-Z]$/.test(a)) ||
        indexes.some((i) => i < 0 || i >= q.optionNodes.length)
      )
        return false;
      if (q.type !== 'multiple' && indexes.length !== 1) return false;
      const generation = current.generation;
      const running = current.running;
      const originalKey = questionKey(q);
      const refreshOptions = () => {
        const questions = inspectQuestions();
        let fresh = questions.find((candidate) => candidate.root === q.root);
        if (!fresh && !q.root.isConnected) {
          const matching = questions.filter((candidate) => questionKey(candidate) === originalKey);
          if (matching.length === 1) fresh = matching[0];
        }
        if (!fresh?.supported || questionKey(fresh) !== originalKey) return false;
        q.root = fresh.root;
        q.optionNodes = fresh.optionNodes;
        return true;
      };
      const inputGuard = new AbortController();
      let userEdited = false;
      for (const event of ['pointerdown', 'keydown'])
        document.addEventListener(
          event,
          (event) => {
            if (event.isTrusted && (!q.root.isConnected || q.root.contains(event.target)))
              userEdited = true;
          },
          { capture: true, signal: inputGuard.signal }
        );
      const settled = async (index, want) => {
        const started = Date.now();
        let stableSince = 0;
        let sawPending = false;
        do {
          await new Promise((resolve) => setTimeout(resolve, q.type === 'multiple' ? 60 : 180));
          const fresh = await send('KP_STATE');
          if (
            userEdited ||
            fresh.generation !== generation ||
            (running && !fresh.running) ||
            !refreshOptions()
          )
            return false;
          const node = q.optionNodes[index];
          const pendingSelector = '[aria-busy="true"],[data-saving="true"],.is-loading,.saving';
          const pending = !!(node.closest(pendingSelector) || node.querySelector(pendingSelector));
          sawPending ||= pending;
          if (pending) {
            stableSince = 0;
            continue;
          }
          if (q.type !== 'multiple') return true;
          if (selectedOption(q.optionNodes[index]) === want) {
            stableSince ||= Date.now();
            if (Date.now() - stableSince >= 180) return true;
          } else stableSince = 0;
        } while (Date.now() - started < (sawPending ? 15000 : 1200));
        if (sawPending) {
          const reason = '页面仍在保存选项，已停止补点，避免反向取消选择。';
          await send('KP_BLOCK', { reason });
          throw new Error(reason);
        }
        // Only try another target after the page has had time to apply this click.
        return true;
      };
      try {
        for (let recovery = 0; recovery < (replaceRejected ? 3 : 1); recovery++) {
          if (userEdited) return false;
          for (let index = 0; index < q.optionNodes.length; index++) {
            if (!refreshOptions()) return false;
            let node = q.optionNodes[index];
            const want = indexes.includes(index);
            // A single-choice click deselects its siblings. Never click them to clear them.
            if (q.type !== 'multiple' && !want) continue;
            const selected = selectedOption(node);
            if (selected !== want) {
              delete node.dataset.kebanSelected;
              const target =
                q.type === 'multiple' && !('checked' in node)
                  ? node.querySelector('.num_option_dx,[name^="answercheck"]') || node
                  : node;
              const targetWasInner = target !== node;
              target.click();
              if (!(await settled(index, want))) return false;
              node = q.optionNodes[index];
              if (selectedOption(node) !== want && 'checked' in node) {
                const wrapper =
                  node.labels?.[0] ||
                  node.closest('label, li, .tkItem_li, .ans-videoquiz-opt, .answer-item');
                if (wrapper && wrapper !== node) {
                  wrapper.click();
                  if (!(await settled(index, want))) return false;
                }
              } else if (selectedOption(node) !== want && !('checked' in node)) {
                const alternate = targetWasInner
                  ? node
                  : node.querySelector(
                      'input[type="radio"], input[type="checkbox"], label, .num_option, .num_option_dx, [name^="answer"]'
                    );
                if (alternate) {
                  alternate.click();
                  if (!(await settled(index, want))) return false;
                }
              }
            }
          }
          if (matchesAnswer(q, answer)) {
            if (recovery)
              await send('KP_LOG', { text: '已自动重试选项点击，并确认新答案已选中。' });
            return true;
          }
        }
      } finally {
        inputGuard.abort();
      }
      if (!matchesAnswer(q, answer)) {
        const reason = `选项点击${replaceRejected ? '重试后仍' : ''}未通过核对：解析答案 ${answer.answers.join('、')}，页面实际选择 ${selectedAnswers(q).join('、') || '未确认'}。已停止提交，请检查页面控件。`;
        await send('KP_BLOCK', { reason });
        throw new Error(reason);
      }
      return true;
    }
    if (!q.fields.length || q.fields.length !== answer.answers.length) return false;
    const snapshots = q.fields.map(fieldValue);
    for (const [index, field] of q.fields.entries()) {
      if (!fieldMatches(field, snapshots[index])) return false;
      if (fieldMatches(field, answer.answers[index])) continue;
      if (field.tagName === 'SELECT') {
        const token = crypto.randomUUID();
        field.setAttribute('data-keban-select', token);
        const result = await send('KP_SELECT_WRITE', {
          generation: current.generation,
          fieldToken: token,
          value: answer.answers[index],
          expected: snapshots[index],
        });
        if (result.changed) {
          await send('KP_BLOCK', { reason: '填写期间下拉答案被修改，已保留页面选择。' });
          return false;
        }
        if (!result.written) return false;
        if (!(await waitSelectReady(field))) return false;
      } else if (richField(field)) {
        if (!(await writeEditorField(q, field, answer.answers[index]))) return false;
      } else {
        const win = field.ownerDocument?.defaultView || window;
        const prototype =
          field.tagName === 'TEXTAREA'
            ? win.HTMLTextAreaElement.prototype
            : win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, answer.answers[index]);
        const Ev = field.ownerDocument?.defaultView?.Event || Event;
        field.dispatchEvent(new Ev('input', { bubbles: true }));
        field.dispatchEvent(new Ev('change', { bubbles: true }));
        field.dispatchEvent(new Ev('blur', { bubbles: true }));
      }
    }
    return q.fields.every((el, i) => fieldMatches(el, answer.answers[i]));
  }
  function matchesAnswer(q, answer) {
    if (!answerReliable(answer)) return false;
    if (q.optionNodes.length) {
      const selected = q.optionNodes.flatMap((el, i) =>
        selectedOption(el) ? [String.fromCharCode(65 + i)] : []
      );
      return JSON.stringify(selected.sort()) === JSON.stringify([...answer.answers].sort());
    }
    return (
      q.fields.length === answer.answers.length &&
      q.fields.every((el, i) => fieldMatches(el, answer.answers[i]))
    );
  }
  async function waitSelectReady(field) {
    const generation = current.generation,
      started = Date.now();
    while (
      field.disabled ||
      field.closest('[aria-busy="true"],[data-saving="true"],.is-loading,.saving')
    ) {
      if (!field.isConnected) return false;
      if (Date.now() - started > 15000) {
        await send('KP_BLOCK', { reason: '下拉控件仍在保存，请等待页面响应后继续。' });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const state = await send('KP_STATE');
      if (!state.running || state.generation !== generation) return false;
    }
    return field.isConnected;
  }
  async function saveLocalAnswers(questions) {
    const generation = current.generation;
    for (const q of questions) {
      if (!q.fields.length) continue;
      for (const field of q.fields.filter((field) => field.tagName === 'SELECT'))
        if (!(await waitSelectReady(field))) return false;
      const key = questionKey(q),
        answer = answers.get(key);
      if (!matchesAnswer(q, answer)) return false;
      const signature = answerSignature(selectedAnswers(q), q.type);
      const buttons = all('.savebtndiv .saveButtonClass', q.root).filter(visible);
      for (const button of buttons) {
        const previous = localSaves.get(button);
        if (
          previous?.generation === generation &&
          previous.key === key &&
          previous.signature === signature
        )
          continue;
        const scope = button.closest('.blankItemDiv,.Answer,.stem_answer') || button.parentElement;
        const baseline = answerBaselines.get(key);
        if (
          button.disabled &&
          localSaveSucceeded(scope) &&
          baseline &&
          q.fields.every((field, i) => fieldMatches(field, baseline[i]))
        )
          continue;
        let complete = false;
        for (let attempt = 0; attempt < 3 && !complete; attempt++) {
          let retryable = false;
          const fresh = await send('KP_STATE');
          if (
            !fresh.running ||
            fresh.generation !== generation ||
            !q.root.isConnected ||
            !matchesAnswer(q, answer)
          )
            return false;
          for (const field of q.fields.filter(richField))
            if (!(await writeEditorField(q, field, fieldValue(field), true))) return false;
          if (button.disabled || button.getAttribute('aria-disabled') === 'true') break;
          button.click();
          savedEditorFields.set(q.root, { generation, fields: q.fields.slice() });
          const started = Date.now();
          while (Date.now() - started < 10000) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            const state = await send('KP_STATE');
            if (!state.running || state.generation !== generation) return false;
            const currentQuestion = inspectQuestions().find((item) => item.root === q.root);
            if (
              !currentQuestion ||
              questionKey(currentQuestion) !== key ||
              !matchesAnswer(currentQuestion, answer)
            ) {
              await send('KP_BLOCK', { reason: '本题保存期间答案发生变化，已保留页面内容。' });
              return false;
            }
            if (Date.now() - started < 300) continue;
            const pending =
              button.getAttribute('aria-busy') === 'true' ||
              !!scope.querySelector('[aria-busy="true"],.saving,.is-loading');
            if (pending) continue;
            const error = all(
              '.save-status,[data-answer-save-status],[role="status"],.error',
              scope
            ).some(
              (node) => visible(node) && /保存失败|暂存失败|保存出错/.test(clean(node.innerText))
            );
            if (error) {
              retryable = true;
              break;
            }
            if (
              localSaveSucceeded(scope) ||
              /已保存|保存成功/.test(clean(button.innerText)) ||
              !button.isConnected ||
              !visible(button)
            ) {
              complete = true;
              break;
            }
          }
          if (!complete && !retryable) break;
        }
        if (!complete) {
          await send('KP_BLOCK', { reason: '页面未确认本题保存，已停止整页提交并保留作答。' });
          return false;
        }
        localSaves.set(button, { generation, key, signature });
        await send('KP_LOG', { text: '已处理本题保存，正在继续后续作答。' });
      }
    }
    return true;
  }
  function makeHud() {
    if (!topFrame || hud || !document.body) return;
    hud = document.createElement('div');
    hud.id = 'keban-study-assistant';
    const shadow = hud.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial;position:fixed;z-index:2147483000;right:20px;bottom:20px;font:13px/1.6 "PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;color:#f1f5f9;-webkit-font-smoothing:antialiased}*{box-sizing:border-box}section{width:332px;background:radial-gradient(240px 160px at 90% 0%,rgba(14,165,233,.24),transparent 70%),linear-gradient(160deg,#081226 0%,#0f2147 58%,#162f63 100%);border:1px solid #23468a;border-radius:16px;box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 8px 20px rgba(7,16,34,.28),0 24px 48px -10px rgba(7,16,34,.45);overflow:hidden}header{display:flex;align-items:center;padding:12px 15px;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(148,163,184,.18);color:#fff;gap:9px}strong{font-size:15px;font-weight:800;letter-spacing:.01em}span{font-size:11px;background:rgba(56,189,248,.18);border:1px solid rgba(125,211,252,.35);color:#bae6fd;padding:2px 9px;border-radius:999px;font-weight:600;margin-right:auto}button{position:relative;overflow:hidden;font:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid rgba(148,163,184,.28);border-radius:9px;background:linear-gradient(180deg,rgba(255,255,255,.14) 0%,rgba(255,255,255,.07) 100%);color:#f8fafc;padding:7px 12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 -2px 0 rgba(0,0,0,.28);transition:background .18s,border-color .18s,color .18s,box-shadow .18s,transform .14s}button::after{content:"";position:absolute;top:-20%;bottom:-20%;left:0;width:45%;background:linear-gradient(112deg,transparent 15%,rgba(255,255,255,.28) 48%,rgba(255,255,255,.55) 50%,rgba(255,255,255,.28) 52%,transparent 85%);transform:translateX(-180%) skewX(-20deg);transition:transform .5s cubic-bezier(.22,1,.36,1);pointer-events:none}button:hover{background:linear-gradient(135deg,#2563eb 0%,#0ea5e9 100%);border-color:#60a5fa;color:#fff;transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 14px -2px rgba(14,165,233,.38)}button:hover::after{transform:translateX(300%) skewX(-20deg)}button:active{transform:translateY(1px) scale(.985)}header button{border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.1);color:#fff;font-size:15px;line-height:1;width:24px;height:24px;padding:0;border-radius:7px;display:grid;place-items:center;box-shadow:none}header button:hover{background:rgba(255,255,255,.22);border-color:rgba(255,255,255,.4);color:#fff;transform:none;box-shadow:none}main{padding:14px 15px}main>p{margin:0 0 10px;padding:9px 12px;background:rgba(15,23,42,.58);border:1px solid rgba(96,165,250,.28);border-left:3.5px solid #38bdf8;border-radius:10px;font-size:12.5px;font-weight:500;color:#e2e8f0}pre{font:inherit;font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:235px;overflow:auto;margin:10px 0;padding:10px 12px;background:rgba(9,19,38,.62);border:1px solid rgba(148,163,184,.22);border-radius:10px;color:#cbd5e1}pre:empty{display:none}footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}footer button{flex:1}button:focus-visible{outline:3px solid #38bdf8;outline-offset:2px}section.collapsed main{display:none}`;
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
        'margin-bottom:10px;padding:10px;background:rgba(15,23,42,.55);border:1px solid rgba(148,163,184,.24);border-radius:10px';
      const label = document.createElement('label');
      label.textContent = '选择需要继续的MOOC课程';
      label.style.cssText = 'display:block;font-size:12px;font-weight:600;color:#bae6fd';
      hudCourseSelect = document.createElement('select');
      hudCourseSelect.style.cssText =
        'width:100%;margin:7px 0 8px;padding:7px 9px;border:1px solid rgba(148,163,184,.32);border-radius:8px;background:#0f172a;color:#f8fafc;font:inherit;font-size:12.5px';
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
      'font-size:12px;color:#fde68a;margin:10px 0;padding:10px 12px;background:rgba(120,53,15,.42);border:1px solid rgba(251,191,36,.35);border-radius:10px;max-height:250px;overflow:auto';
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
      row.style.cssText = 'border-top:1px solid rgba(251,191,36,.22);padding:9px 0';
      const label = document.createElement('div');
      label.textContent = (task.chapter ? task.chapter + ' · ' : '') + task.title;
      const reason = document.createElement('div');
      reason.textContent = task.reason;
      reason.style.cssText = 'color:#fcd34d;font-size:11px;margin:4px 0';
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
    if (current.reviewTask) return `${current.reviewTask.label} · ${current.reviewTask.model}`;
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
    if (hudAnswer) {
      const candidates = inspectQuestions().filter(
        (q) => q.text.slice(0, 500) === result.text.slice(0, 500)
      );
      const frameSelections = Object.values(current?.frames || {})
        .filter((frame) => Date.now() - frame.time < 10000)
        .flatMap((frame) => frame.selections || [])
        .filter((selection) => selection.questionId === result.questionId);
      const actual =
        candidates.length === 1
          ? selectedAnswers(candidates[0]).join('、') || '未检测到选中项'
          : frameSelections.length === 1
            ? frameSelections[0].answers.join('、') || '未检测到选中项'
            : '当前页面无法核对';
      const label =
        current && answerReliable(result)
          ? result.review?.status === 'best_effort'
            ? '自动采用的候选答案'
            : '解析答案'
          : '候选答案（未通过复核）';
      const rating =
        result.review?.status === 'platform_inferred'
          ? '依据：平台判错后的唯一剩余选项'
          : result.validationIssue
            ? (result.validationKind === 'confidence' ? '评分提示：' : '结果校验：') +
              result.validationIssue
            : '模型自评：' + Math.round(result.confidence * 100) + '%';
      hudAnswer.textContent = `${result.text}\n\n${label}：${result.answers.join('、') || '待确认'}\n页面当前选择：${actual}\n${rating}\n${result.reviewIssue || result.review?.reason || ''}\n${(result.review?.stages || []).map((stage) => `${stage.model} · ${stage.label || stage.phase}：${stage.error || (stage.answers || []).join('、') + '（' + Math.round((stage.confidence || 0) * 100) + '%）'}`).join('\n')}\n\n${result.explanation}`;
    }
  }
  async function blockIfNeeded() {
    const captcha = all(
      '#captcha, #captchaWrap, .captcha, .yidun_popup, .geetest_panel, .nc-container, [data-study-captcha]'
    ).find(visible);
    const exam =
      !current.settings.autoAssessments &&
      (/\/(?:exam|exam-ans)\//i.test(location.pathname) ||
        /(?:正在考试|考试剩余时间)/.test(document.title) ||
        current.assessment);
    const login = all('input[type="password"]').some(visible);
    const commitment = all('.commitment-content-dialog').some(visible);
    const platformReason = adapter?.blockReason(current.settings);
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
              : platformReason || '当前是考试或作业页面，已关闭自动处理。',
      });
      return true;
    }
    return !!(captcha || exam || login || commitment || platformReason);
  }
  function dismissVideoQuizOverlay() {
    if (!current?.running || adapter) return false;
    if (wrongFeedbackSignals().nodes.length) return false;
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
    if (current.assessment && current.settings.autoAssessments) return;
    if (
      !topFrame ||
      !current.running ||
      !current.settings.autoNext ||
      current.reviewTask ||
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
    const laterIndex =
      index >= 0 ? catalog.findIndex((el, i) => i > index && !catalogNodeDone(el)) : -1;
    const nextCatalogIndex =
      laterIndex >= 0
        ? laterIndex
        : index >= 0
          ? catalog.findIndex((el, i) => i < index && !catalogNodeDone(el))
          : -1;
    if (!nextTask && index >= 0 && catalog.length && nextCatalogIndex < 0 && currentDone) {
      await send('KP_FINISH', {
        generation: current.generation,
        allCatalogDone: true,
        reason: '自检确认当前任务和全目录其他章节均已完成，托管已结束。',
      });
      return;
    }
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
        (nextCatalogIndex !== index + 1 && catalogTarget))
    )
      target = catalogTarget;
    if (!target && index >= 0 && index === catalog.length - 1 && nextCatalogIndex < 0) {
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
    if (
      current.submission ||
      Object.values(current.frames || {}).some((f) => f.questions > 0 && !f.completed)
    ) {
      lastActivityAt = Date.now();
      return;
    }
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
  function isWrongFeedbackText(value) {
    const text = clean(value);
    return (
      text.length < 140 &&
      /^(?:(?:回答|答案|作答|答题)(?:错误|不正确|有误)|答错了|本题回答错误)(?:$|[，,。.!！\s:：])/.test(
        text
      )
    );
  }
  const feedbackNodes = new Set();
  const feedbackVersions = new WeakMap();
  let feedbackNodeId = 0;
  const feedbackObserver = new MutationObserver((records) => {
    for (const node of feedbackNodes) {
      if (!node.isConnected) {
        feedbackNodes.delete(node);
        continue;
      }
      const state = feedbackVersions.get(node);
      const nowVisible = visible(node);
      if (
        records.some(
          (record) =>
            node === record.target ||
            node.contains(record.target) ||
            (record.type === 'attributes' &&
              record.target.contains?.(node) &&
              nowVisible !== state.visible)
        )
      )
        state.version++;
      state.visible = nowVisible;
    }
  });
  feedbackObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'data-study-incorrect'],
  });
  function wrongFeedbackSignals() {
    const nodes = all(
      '[data-study-incorrect],.ans-videoquiz-error,.tkTopic_error,[role="alert"],span,p,div'
    )
      .filter(
        (node) =>
          visible(node) &&
          !node.closest(
            '#keban-study-assistant,.Zy_TItle,.question-title,.ans-videoquiz-title,label,[data-option]'
          ) &&
          (isWrongFeedbackText(node.innerText) ||
            (node.hasAttribute('data-study-incorrect') &&
              node.getAttribute('data-study-incorrect') !== 'false'))
      )
      .filter(
        (node, _, allNodes) => !allNodes.some((child) => child !== node && node.contains(child))
      );
    for (const node of nodes) {
      if (!feedbackVersions.has(node))
        feedbackVersions.set(node, { id: ++feedbackNodeId, version: 0, visible: true });
      feedbackNodes.add(node);
    }
    return {
      nodes,
      signature: nodes
        .map((node) => {
          const version = feedbackVersions.get(node);
          return `${version.id}:${version.version}:${clean(node.innerText)}`;
        })
        .join('|'),
    };
  }
  async function handleWrongAnswer(questions) {
    if (
      !current.running ||
      !current.submission ||
      !questions.length ||
      handledRejections.has(current.submission.nonce)
    )
      return false;
    const signals = wrongFeedbackSignals();
    if (
      !signals.nodes.length ||
      (lastSubmitted?.nonce === current.submission.nonce &&
        lastSubmitted.errorBaseline === signals.signature)
    )
      return false;
    const affected = questions.filter(
      (q) => questions.length === 1 || signals.nodes.some((node) => q.root.contains(node))
    );
    const response = await send('KP_ANSWER_REJECTED', {
      generation: current.generation,
      nonce: current.submission.nonce,
      questionIds: await Promise.all(affected.map(questionDigest)),
    });
    if (!response.accepted) return false;
    handledRejections.add(current.submission.nonce);
    if (handledRejections.size > 100) handledRejections.clear();
    for (const q of questions) {
      const id = await questionDigest(q);
      const previous = response.previous.find((proof) => proof.questionId === id);
      if (!previous) continue;
      const key = questionKey(q);
      corrections.set(key, previous.answers);
      answers.delete(key);
      attempts.delete(key);
      retryAfter.delete(key);
    }
    current = await send('KP_STATE');
    return true;
  }
  function isSubmissionConfirmed() {
    if (adapter?.isComplete()) return true;
    const notifications = all(
      '[role="status"], .ans-submit-success, .submit-success, .success-message, [data-study-submitted], .workFinishTip, .testTit_status_complete, .work-status, .exam-status, [data-assessment-complete]'
    );
    return notifications.some(
      (el) =>
        visible(el) &&
        (el.hasAttribute('data-study-submitted') ||
          /提交成功|已提交|作业已完成|交卷成功|考试已完成|已批阅/.test(clean(el.innerText)) ||
          (el.matches('.testTit_status_complete') && clean(el.innerText) === '已完成'))
    );
  }
  async function assessmentStep(questions) {
    if (!current.running || !current.settings.autoAssessments || !current.assessment) return false;
    const controls = all(
      'button,a,input[type=button],input[type=submit],[role=button],span[onclick],div[onclick]'
    ).filter(
      (node) =>
        visible(node) &&
        !node.closest('#keban-study-assistant') &&
        !node.disabled &&
        !node.matches('.disabled,.disable,[aria-disabled=true]')
    );
    if (isSubmissionConfirmed()) {
      const result = await send('KP_ASSESSMENT_DONE', { generation: current.generation });
      if (result.completed) {
        current = await send('KP_STATE');
        if (hudStatus)
          hudStatus.textContent =
            current.assessment === 'exam' ? '本次考试已交卷。' : '本次作业已提交。';
      }
      return true;
    }
    let target, action;
    if (!questions.length && !current.submission) {
      const entries = controls.filter((node) =>
        /^(开始考试|进入考试|继续考试|开始作答|继续作答|开始答题|开始作业|进入作业)$/.test(
          clean(node.innerText || node.value)
        )
      );
      if (entries.length === 1) {
        target = entries[0];
        action = '进入答题页';
      } else {
        if (hudStatus)
          hudStatus.textContent =
            entries.length > 1 ? '请选择本次要处理的考试或作业。' : '正在等待考试或作业题目加载。';
        await checkStall('考试或作业题目尚未加载。');
        return true;
      }
    } else if (
      current.settings.autoSubmit &&
      !current.submission &&
      questions.length &&
      questions.every((q) => matchesAnswer(q, answers.get(questionKey(q))))
    ) {
      target = controls.find((node) =>
        /^(下一题|下一小题|下一页|保存并下一题)$/.test(clean(node.innerText || node.value))
      );
      action = '进入下一题';
    }
    if (!target) return false;
    const signature = JSON.stringify([
      action,
      questions.map((q) => [q.captureId, questionKey(q), selectedAnswers(q)]),
    ]);
    if (assessmentMove?.signature === signature) {
      if (Date.now() - assessmentMove.time < 3000) return true;
      if (assessmentMove.attempts >= 3) {
        await send('KP_BLOCK', { reason: '考试或作业页面切换未响应，已保留当前作答。' });
        return true;
      }
    } else assessmentMove = { signature, attempts: 0, time: 0 };
    const fresh = await send('KP_STATE');
    if (
      !fresh.running ||
      fresh.generation !== current.generation ||
      !target.isConnected ||
      !visible(target)
    )
      return true;
    if (
      questions.length &&
      inspectQuestions().some((q) => !matchesAnswer(q, answers.get(questionKey(q))))
    )
      return true;
    assessmentMove.attempts++;
    assessmentMove.time = Date.now();
    target.click();
    await send('KP_LOG', {
      text:
        action === '进入下一题'
          ? '本页作答已核对，正在进入下一题。'
          : '正在进入已打开的考试或作业答题页。',
    });
    return true;
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
        (current.assessment || !/考试/.test(clean(el.innerText))) &&
        !/未作答|未答题|删除|支付|验证码/.test(clean(el.innerText))
    );
    if (!dialog) return false;
    const button = all('button,a,input[type="button"],[role="button"]', dialog).find(
      (el) =>
        visible(el) &&
        (/^(确认提交|确定提交|确定|确认|提交)$/.test(clean(el.innerText || el.value)) ||
          (current.assessment &&
            /^(确认交卷|确定交卷|交卷|提交试卷)$/.test(clean(el.innerText || el.value))))
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
        current.settings.reviewEnabled,
        current.settings.reviewProfiles,
      ]);
      if (context !== answerContext) {
        answers.clear();
        answerBaselines.clear();
        attempts.clear();
        answerContext = context;
      }
      const newRun = runGeneration !== current.generation;
      if (newRun) {
        runGeneration = current.generation;
        attempts.clear();
        retryAfter.clear();
        submitted.clear();
        lastSubmitted = null;
        corrections.clear();
        answerBaselines.clear();
        pageCorrection = null;
        assessmentMove = null;
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
      if (lastResult) displayResult(lastResult);
      if (hudBadge)
        hudBadge.textContent = current.running
          ? '托管中'
          : current.completed && current.assessmentCompleted
            ? '已完成'
            : '已停止';
      if (current.blocked && hudStatus) hudStatus.textContent = current.blocked;
      if (await blockIfNeeded()) return;
      await adapter?.observe?.({ state: current, send, setCourses });
      const assessmentActive = current.settings.autoAssessments && current.assessment;
      const reviewStatus = assessmentActive
        ? null
        : await adapter?.review?.({ state: current, send, setCourses });
      const platformStatus = reviewStatus?.handled
        ? reviewStatus
        : assessmentActive
          ? null
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
      await handleWrongAnswer(questions);
      if (current.generation !== runGeneration) return;
      if (hudStatus && !current.blocked)
        hudStatus.textContent = current.running
          ? courseStatus(videoReport)
          : current.completed && current.assessmentCompleted
            ? current.assessmentCompleted === 'exam'
              ? '本次考试已交卷。'
              : '本次作业已提交。'
            : '托管已停止，可在工具栏查看状态。';
      const shouldSolve = (current.running && current.settings.autoSolve) || manual;
      const pageErrors = wrongFeedbackSignals();
      if (
        shouldSolve &&
        current.running &&
        !lastSubmitted &&
        !current.submission &&
        pageErrors.nodes.length &&
        !pageCorrection
      ) {
        pageCorrection = {
          generation: current.generation,
          feedback: pageErrors.signature,
          selections: new Map(questions.map((q) => [questionKey(q), selectedAnswers(q)])),
        };
        for (const q of questions) {
          const key = questionKey(q);
          answers.delete(key);
          attempts.delete(key);
          retryAfter.delete(key);
        }
      }
      const pageCorrectionCurrent = () =>
        pageCorrection?.generation === current.generation &&
        pageCorrection.feedback === wrongFeedbackSignals().signature &&
        pageCorrection.selections.size === questions.length &&
        questions.every((q) => pageCorrection.selections.has(questionKey(q)));
      let filled = 0;
      for (let q of questions) {
        if (!current.running && !manual && !fillOnce) break;
        if (q.optionIssue) {
          await send('KP_BLOCK', { reason: q.optionIssue });
          return;
        }
        const key = questionKey(q);
        if (!answerBaselines.has(key)) answerBaselines.set(key, selectedAnswers(q));
        const questionId = await questionDigest(q);
        const feedback = current.answerFeedback?.find((entry) => entry.questionId === questionId);
        const rejectedPrevious = corrections.get(key) || feedback?.previous;
        const pagePrevious = pageCorrectionCurrent() ? pageCorrection.selections.get(key) : null;
        const previousAnswer = rejectedPrevious || pagePrevious;
        const correctionPending =
          previousAnswer &&
          answerSignature(selectedAnswers(q), q.type) === answerSignature(previousAnswer, q.type);
        if (shouldSolve && feedback && (answers.get(key)?.feedbackRevision || 0) < feedback.count) {
          answers.delete(key);
          attempts.delete(key);
          retryAfter.delete(key);
        }
        const needsReparse =
          shouldSolve &&
          (manual || newRun) &&
          answers.has(key) &&
          (!answerReliable(answers.get(key)) ||
            (manual && answers.get(key).review?.status === 'best_effort'));
        if (needsReparse) {
          answers.delete(key);
          attempts.delete(key);
          retryAfter.delete(key);
        }
        // Reopening an already filled exercise must recover its answer proof;
        // preserve the existing fields while checking them before submission.
        if (
          q.answered &&
          !needsReparse &&
          !correctionPending &&
          (!current.running || !current.settings.autoSubmit)
        ) {
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
              existingFeedback: !current.submission && wrongFeedbackSignals().nodes.length > 0,
              question: {
                text: q.text,
                type: q.type,
                options: q.options,
                needsImage: q.needsImage,
                captureId: q.captureId,
                visualSignature: q.visualSignature,
                minLength: q.minLength,
                blankCount: q.blankCount,
                slots: q.slots,
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
          displayResult({ text: q.text, ...answer, questionId });
          q = inspectQuestions().find((candidate) => questionKey(candidate) === key);
          if (!q) continue;
        }
        const answer = answers.get(key);
        if (answer && ((current.running && current.settings.autoFill) || fillOnce)) {
          const baseline = answerBaselines.get(key);
          if (
            !q.optionNodes.length &&
            baseline?.length === q.fields.length &&
            q.fields.some(
              (field, i) =>
                !fieldMatches(field, baseline[i]) &&
                !fieldMatches(field, answer.answers[i]) &&
                !(previousAnswer && fieldMatches(field, previousAnswer[i]))
            )
          ) {
            await send('KP_BLOCK', { reason: '模型处理期间你修改了部分答案，已保留当前作答。' });
            return;
          }
          const replaceRejected =
            (current.running &&
              answerBaselines.has(key) &&
              answerSignature(selectedAnswers(q), q.type) ===
                answerSignature(answerBaselines.get(key), q.type)) ||
            (previousAnswer &&
              (rejectedPrevious ||
                (pageCorrectionCurrent() &&
                  ['assisted', 'adjudicated', 'best_effort'].includes(answer.review?.status))) &&
              answerSignature(selectedAnswers(q), q.type) ===
                answerSignature(previousAnswer, q.type));
          if (await applyAnswer(q, answer, !!replaceRejected)) {
            filled++;
            await send('KP_LOG', { text: `已填写：${q.text.slice(0, 45)}` });
          }
        }
      }
      // Re-read the DOM: only actually selected/written fields count as resolved.
      questions = isSubmissionConfirmed() ? [] : inspectQuestions();
      if (lastResult) displayResult(lastResult);
      const remaining = questions.filter((q) => !q.answered).length;
      const incomplete = questions.some((q) => !q.supported && !q.answered);
      const reviewReason = questions.some(
        (q) =>
          q.answered &&
          answers.has(questionKey(q)) &&
          !matchesAnswer(q, answers.get(questionKey(q)))
      )
        ? '当前页面作答未通过提交核对，请查看具体原因。'
        : questions.some(
              (q) =>
                !q.answered &&
                answers.has(questionKey(q)) &&
                !answerReliable(answers.get(questionKey(q)))
            )
          ? '模型尚未返回符合题型或字数要求的有效答案。'
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
          selections: await Promise.all(
            questions
              .filter((q) => q.optionNodes.length)
              .slice(0, 20)
              .map(async (q) => ({
                questionId: await questionDigest(q),
                answers: selectedAnswers(q),
              }))
          ),
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
      if (
        reviewReason &&
        current.running &&
        (current.settings.autoSubmit || questions.some((q) => q.inVideoQuiz))
      ) {
        const details = questions.flatMap((q, i) => {
          const answer = answers.get(questionKey(q));
          if (!answer || (q.answered && matchesAnswer(q, answer)) || answerReliable(answer))
            return [];
          const issue = [
            answer.reviewIssue,
            answer.validationIssue,
            answer.uncertain ? '模型标记不确定' : '',
          ]
            .filter(Boolean)
            .join('；');
          return [`本区域第 ${i + 1} 题：${q.text.slice(0, 65)}（${issue}）`];
        });
        await send('KP_BLOCK', {
          reason: details.length
            ? `${reviewReason}${details.slice(0, 3).join('；')}。`
            : reviewReason,
        });
        return;
      }
      if (
        current.running &&
        current.settings.autoSubmit &&
        questions.length &&
        questions.every((q) => matchesAnswer(q, answers.get(questionKey(q))))
      ) {
        if (!(await saveLocalAnswers(questions))) return;
        questions = inspectQuestions();
      }
      if (await assessmentStep(questions)) return;
      const inVideoQuiz = questions.some((q) => q.inVideoQuiz);
      if (
        current.running &&
        (current.settings.autoSubmit || inVideoQuiz) &&
        questions.length &&
        !remaining
      ) {
        const signature = JSON.stringify(
          questions.map((q) => [questionKey(q), selectedAnswers(q)])
        );
        const allReliable = questions.every((q) => matchesAnswer(q, answers.get(questionKey(q))));
        // Confirm only the dialog produced by this explicit exercise submission.
        const submitSelector =
          'button, a, input[type="button"], input[type="submit"], [role="button"], .tkTopic_btn, .tkTopic_sub, .ans-videoquiz-submit, #videoquiz-submit, .j-submit, span, div';
        const submitText = (value) =>
          /^(提交|提交答案|提交作业|确定提交)$/.test(value) ||
          (current.assessment && /^(交卷|提交试卷|提交考试)$/.test(value));
        const isSubmitBtn = (el) =>
          visible(el) &&
          !el.closest('#keban-study-assistant') &&
          submitText(clean(el.innerText || el.value)) &&
          !all('button, a, span, div', el).some(
            (c) => visible(c) && submitText(clean(c.innerText))
          );
        const button =
          questions.map((q) => all(submitSelector, q.root).find(isSubmitBtn)).find(Boolean) ||
          all(submitSelector).find(isSubmitBtn);
        const previous = submitted.get(signature);
        const errors = wrongFeedbackSignals();
        if (errors.nodes.length && !lastSubmitted && !current.submission) {
          const ids = await Promise.all(questions.map(questionDigest));
          const verified = ids.some((id) =>
            current.answerFeedback?.some((entry) => entry.questionId === id && entry.count > 0)
          );
          const revised =
            pageCorrectionCurrent() &&
            questions.every((q) => {
              const answer = answers.get(questionKey(q));
              return (
                answerReliable(answer) &&
                matchesAnswer(q, answer) &&
                ['assisted', 'adjudicated', 'best_effort'].includes(answer.review?.status)
              );
            }) &&
            questions.some(
              (q) =>
                answerSignature(selectedAnswers(q), q.type) !==
                answerSignature(pageCorrection.selections.get(questionKey(q)), q.type)
            );
          if (!verified && !revised) {
            await send('KP_BLOCK', {
              reason:
                '页面已有错误提示，但对应的提交记录不明。已阻止原样重交；请核对已有作答或重新打开题目后继续。',
            });
            return;
          }
        }
        if (previous && errors.nodes.length) {
          if (Date.now() - previous.time > 45000)
            await send('KP_BLOCK', {
              reason: '平台仍显示上一次错误提示，尚未确认本次结果；已停止重复提交，请核对页面。',
            });
          return;
        }
        if (allReliable && button && (!previous || Date.now() - previous.time >= 12000)) {
          if ((previous?.attempts || 0) >= 3) {
            await send('KP_BLOCK', { reason: '练习提交三次后仍未出现完成状态，请检查平台提示。' });
            return;
          }
          if (questions.some((q) => q.fields.some(richField))) {
            for (const q of questions)
              for (const field of q.fields.filter(richField))
                if (!(await writeEditorField(q, field, fieldValue(field), true))) return;
            if (isSubmissionConfirmed()) return;
            const afterSync = inspectQuestions();
            if (
              JSON.stringify(afterSync.map((q) => [questionKey(q), selectedAnswers(q)])) !==
                signature ||
              !afterSync.every((q) => matchesAnswer(q, answers.get(questionKey(q))))
            ) {
              await send('KP_BLOCK', {
                reason: '提交前正文发生变化，已保留页面内容，请核对后继续。',
              });
              return;
            }
          }
          const intent = await send('KP_SUBMIT_INTENT', {
            generation: current.generation,
            inVideo: inVideoQuiz,
            proofs: questions.map((q) => ({
              question: {
                text: q.text,
                type: q.type,
                options: q.options,
                needsImage: q.needsImage,
                captureId: q.captureId,
                visualSignature: q.visualSignature,
                minLength: q.minLength,
                blankCount: q.blankCount,
                slots: q.slots,
              },
              answers: selectedAnswers(q),
            })),
          });
          if (intent.allowed) {
            const beforeSubmit = await send('KP_STATE');
            if (!beforeSubmit.running || beforeSubmit.generation !== runGeneration) return;
            const actualQuestions = inspectQuestions();
            if (
              !button.isConnected ||
              !visible(button) ||
              button.disabled ||
              JSON.stringify(actualQuestions.map((q) => [questionKey(q), selectedAnswers(q)])) !==
                signature ||
              !actualQuestions.every((q) => matchesAnswer(q, answers.get(questionKey(q))))
            ) {
              await send('KP_BLOCK', {
                reason: '提交前选项状态发生变化，已停止提交并保留页面当前选择，请核对后继续。',
              });
              return;
            }
            const entry = {
              time: Date.now(),
              attempts: (previous?.attempts || 0) + 1,
              nonce: intent.nonce,
              errorBaseline: '',
            };
            submitted.set(signature, entry);
            submitClickedAt = Date.now();
            entry.errorBaseline = wrongFeedbackSignals().signature;
            lastSubmitted = entry;
            button.click();
            await send('KP_LOG', {
              text: inVideoQuiz
                ? '已提交视频随堂测验弹窗答案。'
                : previous
                  ? '练习尚未确认完成，正在重试提交。'
                  : '已点击本页练习的提交按钮。',
            });
          } else if (intent.reason) await send('KP_BLOCK', { reason: intent.reason });
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
      if (lastResult) displayResult(lastResult);
      showError(error);
    } finally {
      busy = false;
      if (manualRequest || fillRequest) setTimeout(tick, 300);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (
      (message.type === 'KP_WAKE' || message.type === 'KP_SOLVE_PAGE') &&
      typeof message.generation === 'number' &&
      (message.generation !== current?.generation || message.fieldWritesAllowed === false)
    ) {
      const documents = [document];
      for (let i = 0; i < documents.length && i < 32; i++) {
        all('[data-keban-select],[data-keban-editor]', documents[i]).forEach((field) => {
          field.removeAttribute('data-keban-select');
          field.removeAttribute('data-keban-editor');
        });
        for (const frame of all('iframe', documents[i]))
          try {
            if (frame.contentDocument && !documents.includes(frame.contentDocument))
              documents.push(frame.contentDocument);
          } catch {}
      }
    }
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
