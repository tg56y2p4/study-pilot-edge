import {
  DEFAULTS,
  normalizeSettings,
  publicSettings,
  isCourseUrl,
  coursePlatform,
  validateQuestion,
  requestBody,
  parseAnswer,
  apiError,
  parsePlan,
  planRequest,
  endpointPermission,
} from './core.mjs';
import {
  questionIdentity,
  answerSignature,
  usableAnswer,
  reviewConnections,
  reviewRequestBody,
  reviewAnswer,
  REVIEW_PHASES,
} from './review.mjs';
import { resolveApiKey, listModels } from './api.mjs';
import { mergeTasks, normalizeTask, clearTask, pendingSummary, taskKey } from './mooc-tasks.mjs';
import { captureCourse, playCourseMedia, activateMoocCourse } from './vision.mjs';

// Content scripts never read these storage areas directly. Nothing uses storage.sync.
function apiOrigin(endpoint) {
  try {
    return new URL(endpoint).origin;
  } catch {
    return '';
  }
}
const ready = (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]);
  const [{ settings: saved }, session] = await Promise.all([
    chrome.storage.local.get('settings'),
    chrome.storage.session.get(['apiKey', 'apiKeyOrigin']),
  ]);
  // Bind an existing pre-0.8 session Key before any settings read/write can run.
  if (session.apiKey && !session.apiKeyOrigin)
    await chrome.storage.session.set({ apiKeyOrigin: apiOrigin(saved?.endpoint) });
})();
const queues = new Map();
const cache = new Map();
const activeRequests = new Map();
const catalogRequests = new Map();

async function settings() {
  await ready;
  return queue('settings', readSettings);
}
async function readSettings() {
  const [{ settings: saved }, { apiKey: sessionKey, apiKeyOrigin, reviewApiKeys = {} }] =
    await Promise.all([
      chrome.storage.local.get('settings'),
      chrome.storage.session.get(['apiKey', 'apiKeyOrigin', 'reviewApiKeys']),
    ]);
  const s = normalizeSettings(saved || DEFAULTS);
  if (!s.rememberKey)
    s.apiKey =
      apiOrigin(s.endpoint) && apiKeyOrigin === apiOrigin(s.endpoint) ? sessionKey || '' : '';
  for (const profile of s.reviewProfiles)
    if (!profile.inheritConnection && !profile.rememberKey)
      profile.apiKey =
        reviewApiKeys[profile.id]?.origin === apiOrigin(profile.endpoint)
          ? reviewApiKeys[profile.id].key || ''
          : '';
  return s;
}
const stateKey = (id) => `tab:${id}`;
async function state(id) {
  const key = stateKey(id);
  return (
    (await chrome.storage.session.get(key))[key] || {
      running: false,
      generation: 0,
      calls: 0,
      tokens: 0,
      logs: [],
      results: [],
      frames: {},
    }
  );
}
async function saveState(id, value) {
  await chrome.storage.session.set({ [stateKey(id)]: value });
}
function queue(id, task) {
  const previous = queues.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(id, next);
  next
    .finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    })
    .catch(() => {});
  return next;
}
function log(s, text, level = 'info') {
  s.logs.unshift({ time: Date.now(), text: String(text).slice(0, 500), level });
  s.logs = s.logs.slice(0, 50);
}
async function broadcast(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    /* no accessible frame yet */
  }
}
function trusted(sender) {
  // Edge includes sender.tab for an options page opened in a browser tab.
  // Authenticate the extension-owned page URL rather than the presence of a tab.
  return (
    sender.id === chrome.runtime.id &&
    ['options.html', 'popup.html'].some((page) => sender.url === chrome.runtime.getURL(page))
  );
}
function courseSender(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab &&
    (isCourseUrl(sender.url) || (sender.url?.startsWith('about:') && isCourseUrl(sender.tab.url)))
  );
}
async function courseTab(id) {
  const tab = await chrome.tabs.get(Number(id));
  if (!isCourseUrl(tab.url)) throw new Error('请先打开学习通或中国大学MOOC的课程页面。');
  return tab;
}

async function apiPermission(endpoint) {
  if (!endpoint) throw new Error('请先填写API Host或Base URL。');
  if (!(await chrome.permissions.contains({ origins: [endpointPermission(endpoint)] })))
    throw new Error('尚未授权访问此API服务，请在设置页点击拉取模型或测试连接并允许访问。');
}
async function rawApi(s, body, controller) {
  if (!s.apiKey) throw new Error('请在设置中填写API Key。');
  await apiPermission(s.endpoint);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 45000);
  try {
    const response = await fetch(`${s.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`模型接口没有返回 JSON（HTTP ${response.status}）。`);
    }
    if (!response.ok) {
      const error = new Error(apiError(response.status, data));
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      const failure = new Error(timedOut ? '接口响应超过45秒，将重试。' : '请求已取消。');
      failure.retryable = timedOut;
      throw failure;
    }
    if (error instanceof TypeError) {
      const failure = new Error('无法连接模型服务，请检查API地址、网络和浏览器权限。');
      failure.retryable = true;
      throw failure;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callApi(s, question, test, controller, images = []) {
  const data = await rawApi(s, requestBody(s, question, test, images), controller);
  if (test) {
    if (typeof data?.choices?.[0]?.message?.content !== 'string')
      throw new Error('接口返回内容不完整。');
    let result;
    try {
      result = JSON.parse(
        data.choices[0].message.content
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
      );
    } catch {}
    if (result?.ok !== true)
      throw new Error('模型未通过JSON输出检查，请更换模型或调整JSON格式约束后重试。');
    return { ok: true, model: data.model || s.model };
  }
  return {
    ...parseAnswer(data, question),
    tokens: Math.max(0, Number(data?.usage?.total_tokens) || 0),
    visual: images.length > 0,
  };
}
async function testVisionConnection(s) {
  const canvas = new OffscreenCanvas(240, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 240, 100);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText('2 + 2 = ?', 10, 66);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const answer = await callApi(
    s,
    { text: '请识别图片中的算式并求解。', type: 'text', options: [] },
    false,
    new AbortController(),
    [`data:image/png;base64,${btoa(binary)}`]
  );
  if (!answer.answers.some((value) => /4/.test(value)))
    throw new Error('模型未通过图片算式检查，请检查视觉模型权限。');
  return { ok: true, model: s.visionModel, answer: answer.answers.join('、') };
}

async function imageDigest(image) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function recordAnswer(id, generation, question, answer, cached = false, accounted = false) {
  const questionId = await imageDigest(questionIdentity(question));
  await queue(id, async () => {
    const st = await state(id);
    if (st.generation !== generation || st.blocked) throw new Error('解析已停止。');
    if (!cached && !accounted) st.tokens += answer.tokens;
    st.lastFailure = null;
    st.results.unshift({
      text: question.text.slice(0, 500),
      ...answer,
      questionId,
      cached,
      time: Date.now(),
    });
    st.results = st.results.slice(0, 20);
    log(st, `${cached ? '已读取缓存' : '已解析'}：${question.text.slice(0, 45)}`);
    await saveState(id, st);
  });
  await broadcast(id, {
    type: 'KP_RESULT',
    result: { text: question.text.slice(0, 500), ...answer },
  });
  return { ...answer, cached, generation };
}

function feedbackScope(st) {
  return JSON.stringify(st.context || null);
}
function feedbackFor(st, questionId) {
  const scope = feedbackScope(st);
  const item = (st.answerFeedback || []).find(
    (entry) => entry.scope === scope && entry.questionId === questionId
  );
  return item ? { needsReview: true, rejectedAnswers: item.rejected, revision: item.count } : {};
}
async function submissionProofs(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 80)
    throw new Error('未建立本次作答记录，请刷新课程页后继续。');
  return Promise.all(
    rows.map(async (row) => {
      const question = validateQuestion(row.question);
      if (
        !Array.isArray(row.answers) ||
        !row.answers.length ||
        row.answers.length > 26 ||
        row.answers.some(
          (answer) => typeof answer !== 'string' || !answer.trim() || answer.length > 5000
        )
      )
        throw new Error('本次作答记录格式不正确。');
      return {
        questionId: await imageDigest(questionIdentity(question)),
        type: question.type,
        answers: row.answers.map((answer) => answer.trim()),
      };
    })
  );
}
async function submissionSignature(proofs) {
  return imageDigest(
    JSON.stringify(
      proofs
        .map((proof) => [proof.questionId, answerSignature(proof.answers, proof.type)])
        .sort((a, b) => a[0].localeCompare(b[0]))
    )
  );
}
async function solve(message, sender) {
  const id = sender.tab.id;
  const snapshot = await state(id);
  const generation = snapshot.generation;
  return queue(`solve:${id}`, async () => {
    const s = await settings();
    let current = await state(id);
    const allowed = (current.running && s.autoSolve) || (current.manualUntil || 0) > Date.now();
    if (!allowed || current.generation !== generation || message.generation !== generation)
      throw new Error('解析已停止。');
    if (current.blocked) throw new Error(current.blocked);
    const question = validateQuestion(message.question);
    const questionId = await imageDigest(questionIdentity(question));
    const knownFeedback = feedbackFor(current, questionId);
    const feedback =
      message.existingFeedback === true && !knownFeedback.needsReview
        ? { needsReview: true, unverified: true, rejectedAnswers: [] }
        : knownFeedback;
    let images = [];
    if (question.needsImage) {
      if (!s.useVision) throw new Error('当前关闭了图片识别，请在设置中启用。');
      images = [await captureCourse(id, question.captureId)];
    }
    const { primary, assistants } = reviewConnections(s, images.length > 0);
    const fingerprint = JSON.stringify([
      s.endpoint,
      primary.model,
      s.jsonMode,
      s.reviewEnabled,
      assistants.map((config) => [config.endpoint, config.model, config.jsonMode]),
      questionId,
      feedback,
      images.length ? await imageDigest(images[0]) : '',
    ]);
    const cached = cache.get(fingerprint);
    if (usableAnswer(cached, s.minConfidence, feedback.rejectedAnswers, question.type))
      return recordAnswer(id, generation, question, cached, true);
    const controller = new AbortController();
    activeRequests.set(id, controller);
    let delivered = false;
    const stopped = () => Object.assign(new Error('解析已停止或配置已改变。'), { fatal: true });
    async function call(config, phase, context) {
      if (controller.signal.aborted) throw stopped();
      if (!config.apiKey) throw new Error('辅助服务尚未填写对应Key，请在设置中补全。');
      await apiPermission(config.endpoint);
      current = await state(id);
      const live = await settings();
      const gap = Math.max(0, live.requestGap - (Date.now() - (current.lastCall || 0)));
      if (gap) await new Promise((resolve) => setTimeout(resolve, gap));
      await queue(id, async () => {
        const st = await state(id);
        const latest = await settings();
        if (
          controller.signal.aborted ||
          st.generation !== generation ||
          st.blocked ||
          !((st.running && latest.autoSolve) || (st.manualUntil || 0) > Date.now())
        )
          throw stopped();
        if (st.calls >= latest.maxCalls) {
          st.running = false;
          st.manualUntil = 0;
          st.generation++;
          st.reviewTask = null;
          st.blocked = '已达到本轮 API 请求上限，点击开始可开启新一轮。';
          log(st, st.blocked, 'warn');
          await saveState(id, st);
          throw Object.assign(new Error(st.blocked), { fatal: true });
        }
        st.calls++;
        st.lastCall = Date.now();
        if (!st.running) st.manualUntil = Date.now() + 120000;
        st.reviewTask = {
          generation,
          frame: sender.frameId,
          phase,
          model: config.model,
          label: REVIEW_PHASES[phase],
        };
        await saveState(id, st);
      });
      const data = await rawApi(
        config,
        reviewRequestBody(config, question, phase, context, images),
        controller
      );
      const tokens = Math.max(0, Number(data?.usage?.total_tokens) || 0);
      await queue(id, async () => {
        const st = await state(id);
        if (st.generation !== generation || controller.signal.aborted) throw stopped();
        st.tokens += tokens;
        await saveState(id, st);
      });
      try {
        return { ...parseAnswer(data, question), tokens, visual: images.length > 0 };
      } catch (error) {
        if (!s.reviewEnabled) throw error;
        return {
          answers: [],
          confidence: 0,
          uncertain: true,
          validationIssue: error.message,
          explanation: '',
          tokens,
          visual: images.length > 0,
        };
      }
    }
    try {
      const answer = {
        ...(await reviewAnswer({
          settings: s,
          question,
          visual: images.length > 0,
          feedback,
          call,
        })),
        feedbackRevision: feedback.revision || 0,
      };
      const after = await state(id);
      if (after.generation !== generation || after.blocked || controller.signal.aborted)
        throw stopped();
      const result = await recordAnswer(id, generation, question, answer, false, true);
      if (usableAnswer(answer, s.minConfidence, feedback.rejectedAnswers, question.type))
        cache.set(fingerprint, { ...answer, questionId });
      else cache.delete(fingerprint);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      delivered = true;
      return result;
    } catch (error) {
      await queue(id, async () => {
        const st = await state(id);
        if (st.generation === generation) {
          const attempts = st.lastFailure?.key === questionId ? st.lastFailure.attempts + 1 : 1;
          if (error.retryable && st.running && attempts < 3) {
            st.lastFailure = { key: questionId, attempts };
            log(st, `接口暂时不可用，将进行第 ${attempts + 1} 次尝试。`, 'warn');
          } else {
            error.retryable = false;
            st.running = false;
            st.manualUntil = 0;
            st.generation++;
            st.blocked = error.message;
            log(st, error.message, 'error');
          }
          await saveState(id, st);
        }
      });
      await broadcast(id, { type: 'KP_WAKE' });
      throw error;
    } finally {
      if (activeRequests.get(id) === controller) activeRequests.delete(id);
      await queue(id, async () => {
        const st = await state(id);
        if (st.reviewTask?.generation === generation && st.reviewTask.frame === sender.frameId) {
          st.reviewTask =
            delivered && st.generation === generation
              ? { ...st.reviewTask, phase: 'awaiting_page', label: REVIEW_PHASES.awaiting_page }
              : null;
          await saveState(id, st);
        }
      });
    }
  });
}

async function visualStep(message, sender) {
  const id = sender.tab.id;
  return queue(`solve:${id}`, async () => {
    const s = await settings();
    let st = await state(id);
    const generation = st.generation;
    if (!st.running || !s.visualAgent || generation !== message.generation || st.blocked)
      return { skipped: true };
    if (Date.now() - (st.lastAgent || 0) < s.agentInterval) return { skipped: true };
    if ((st.actions || 0) >= s.maxActions || st.calls >= s.maxCalls)
      throw new Error('已达到本轮视觉操作或 API 请求上限。');
    const reports = Object.values(st.frames || {}).filter((f) => Date.now() - f.time < 10000);
    if (
      st.submission ||
      reports.some(
        (f) => f.videos > f.ended || f.pending > 0 || f.waiting || (f.questions > 0 && !f.completed)
      )
    )
      return { skipped: true };
    const results = await chrome.scripting.executeScript({
      target: { tabId: id, allFrames: true },
      func: () => globalThis.__KEBAN_SNAPSHOT__?.() || null,
    });
    const frames = results.filter((r) => r.result && isCourseUrl(r.result.url));
    if (frames.some((frame) => frame.result.workflowManaged)) return { skipped: true };
    const controls = frames
      .flatMap((frame) =>
        frame.result.controls.map((control) => ({
          ...control,
          id: `${frame.frameId}:${control.id}`,
        }))
      )
      .slice(0, 100);
    const snapshot = {
      pages: frames.map((frame) => ({
        frame: frame.frameId,
        title: frame.result.title,
        text: frame.result.text,
      })),
      controls,
      previous: st.lastAgentReason || '',
    };
    const signature =
      JSON.stringify(snapshot.pages.map((page) => [page.title, page.text])) +
      JSON.stringify(controls);
    const unchanged = signature === st.agentSignature ? (st.agentUnchanged || 0) + 1 : 0;
    if (unchanged >= 3) {
      await pauseTab(id, '页面连续三次没有变化，已停止以避免重复点击。');
      return { paused: true };
    }
    const image = await captureCourse(id);
    st = await state(id);
    if (
      !st.running ||
      st.generation !== generation ||
      st.submission ||
      Object.values(st.frames || {}).some(
        (f) => Date.now() - f.time < 10000 && (f.waiting || (f.questions > 0 && !f.completed))
      )
    )
      return { skipped: true };
    await queue(id, async () => {
      const current = await state(id);
      current.calls++;
      current.lastCall = Date.now();
      current.lastAgent = Date.now();
      current.agentSignature = signature;
      current.agentUnchanged = unchanged;
      await saveState(id, current);
    });
    const controller = new AbortController();
    activeRequests.set(id, controller);
    try {
      const data = await rawApi(s, planRequest(s, snapshot, image), controller);
      const plan = parsePlan(data, controls);
      const fresh = await state(id);
      if (
        !fresh.running ||
        fresh.generation !== generation ||
        controller.signal.aborted ||
        fresh.submission ||
        Object.values(fresh.frames || {}).some(
          (f) => Date.now() - f.time < 10000 && (f.waiting || (f.questions > 0 && !f.completed))
        )
      )
        return { skipped: true };
      await queue(id, async () => {
        const current = await state(id);
        current.tokens += Number(data.usage?.total_tokens) || 0;
        current.lastAgentReason = plan.reason;
        log(current, `视觉判断：${plan.reason}`);
        await saveState(id, current);
      });
      if (plan.action === 'pause' || plan.confidence < s.minConfidence) {
        await pauseTab(id, plan.reason || '视觉判断需要手动确认。');
        return { paused: true };
      }
      if (plan.action === 'done') {
        await pauseTab(id, `课程流程已结束：${plan.reason}`);
        return { done: true };
      }
      if (plan.action === 'wait') return { waiting: true };
      let frameId = 0,
        target = null;
      if (plan.target) {
        const split = plan.target.indexOf(':');
        frameId = Number(plan.target.slice(0, split));
        target = plan.target.slice(split + 1);
      }
      const frame = frames.find((frame) => frame.frameId === frameId);
      if (!frame) throw new Error('视觉操作目标所在的页面已离开。');
      const execution = await chrome.tabs.sendMessage(
        id,
        {
          type: 'KP_AGENT_ACTION',
          nonce: frame.result.nonce,
          plan: { ...plan, target },
          generation,
        },
        { frameId }
      );
      if (!execution?.ok) throw new Error(execution?.error || '页面没有确认操作结果。');
      await queue(id, async () => {
        const current = await state(id);
        if (current.generation !== generation) return;
        current.actions = (current.actions || 0) + 1;
        log(current, `已执行视觉操作：${plan.reason}`);
        await saveState(id, current);
      });
      return { executed: true, plan };
    } finally {
      if (activeRequests.get(id) === controller) activeRequests.delete(id);
    }
  });
}
async function pauseTab(id, reason) {
  activeRequests.get(id)?.abort();
  await queue(id, async () => {
    const st = await state(id);
    st.running = false;
    st.manualUntil = 0;
    st.generation++;
    st.blocked = reason;
    log(st, reason, 'warn');
    await saveState(id, st);
  });
  await broadcast(id, { type: 'KP_WAKE' });
}

async function route(m, sender) {
  await ready;
  if (!m || typeof m.type !== 'string') throw new Error('无效请求。');
  if (
    m.type === 'KP_RETRY_LOW' &&
    (trusted(sender) || (courseSender(sender) && sender.frameId === 0))
  ) {
    const tab = await courseTab(trusted(sender) ? m.tabId : sender.tab.id);
    const config = await settings();
    if (!config.apiKey || !config.endpoint || !config.model)
      throw new Error('请先保存API地址、Key和文字模型。');
    await queue(tab.id, async () => {
      const st = await state(tab.id);
      if (st.submission) throw new Error('请先处理当前提交确认或等待平台返回结果。');
      st.running = false;
      st.blocked = '';
      st.generation++;
      st.manualUntil = Date.now() + 120000;
      log(st, '正在重新解析未达到阈值的题目；保留已有作答，不自动提交。');
      await saveState(tab.id, st);
    });
    activeRequests.get(tab.id)?.abort();
    await broadcast(tab.id, { type: 'KP_SOLVE_PAGE' });
    return { ok: true };
  }
  if (trusted(sender)) {
    if (m.type === 'KP_GET_SETTINGS') {
      const s = await settings();
      return {
        ...s,
        apiKey: '',
        hasKey: !!s.apiKey,
        reviewProfiles: s.reviewProfiles.map((profile) => ({
          ...profile,
          apiKey: '',
          hasKey: profile.inheritConnection ? !!s.apiKey : !!profile.apiKey,
        })),
      };
    }
    if (m.type === 'KP_SAVE_SETTINGS') {
      return queue('settings', async () => {
        const old = await readSettings();
        const s = normalizeSettings(m.settings);
        s.apiKey = m.clearKey ? '' : resolveApiKey(s, old);
        const clearReviewKeys = new Set(Array.isArray(m.clearReviewKeys) ? m.clearReviewKeys : []);
        const reviewApiKeys = Object.create(null);
        for (const profile of s.reviewProfiles) {
          const previous = old.reviewProfiles.find((item) => item.id === profile.id) || {};
          profile.apiKey =
            m.clearKey || clearReviewKeys.has(profile.id) || profile.inheritConnection
              ? ''
              : resolveApiKey(profile, previous);
          if (
            s.reviewEnabled &&
            !m.clearKey &&
            !clearReviewKeys.has(profile.id) &&
            (!profile.model ||
              (!profile.inheritConnection && (!profile.endpoint || !profile.apiKey)))
          )
            throw new Error('请补全辅助模型、独立服务地址及对应Key，或删除未使用的配置。');
          if (!profile.inheritConnection && !profile.rememberKey)
            reviewApiKeys[profile.id] = {
              origin: apiOrigin(profile.endpoint),
              key: profile.apiKey,
            };
        }
        await chrome.storage.local.set({
          settings: {
            ...s,
            apiKey: s.rememberKey ? s.apiKey : '',
            reviewProfiles: s.reviewProfiles.map((profile) => ({
              ...profile,
              apiKey: profile.rememberKey ? profile.apiKey : '',
            })),
          },
        });
        await chrome.storage.session.set({
          apiKey: s.rememberKey ? '' : s.apiKey,
          apiKeyOrigin: apiOrigin(s.endpoint),
          reviewApiKeys,
        });
        const connectionState = (value) =>
          JSON.stringify([
            value.endpoint,
            value.model,
            value.visionModel,
            value.useVision,
            value.apiKey,
            value.jsonMode,
            value.reviewEnabled,
            value.reviewProfiles,
          ]);
        if (m.clearKey || connectionState(old) !== connectionState(s))
          for (const controller of activeRequests.values()) controller.abort();
        cache.clear();
        return {
          hasKey: !!s.apiKey,
          reviewKeys: s.reviewProfiles.map((profile) => ({
            id: profile.id,
            hasKey: profile.inheritConnection ? !!s.apiKey : !!profile.apiKey,
            endpoint: profile.endpoint,
          })),
        };
      });
    }
    if (m.type === 'KP_LIST_MODELS') {
      const s = normalizeSettings(m.connection);
      const saved = await settings();
      s.apiKey = resolveApiKey(
        s,
        m.profileId
          ? saved.reviewProfiles.find((profile) => profile.id === m.profileId) || {}
          : saved
      );
      await apiPermission(s.endpoint);
      const owner = sender.documentId || (sender.tab ? 'tab:' + sender.tab.id : sender.url);
      catalogRequests.get(owner)?.controller.abort();
      const controller = new AbortController();
      catalogRequests.set(owner, { controller, tabId: sender.tab?.id });
      try {
        return await listModels(s, fetch, { signal: controller.signal });
      } finally {
        if (catalogRequests.get(owner)?.controller === controller) catalogRequests.delete(owner);
      }
    }
    if (m.type === 'KP_CANCEL_MODELS') {
      const owner = sender.documentId || (sender.tab ? 'tab:' + sender.tab.id : sender.url);
      catalogRequests.get(owner)?.controller.abort();
      return { ok: true };
    }
    if (m.type === 'KP_TEST_API')
      return callApi(await settings(), null, true, new AbortController());
    if (m.type === 'KP_TEST_REVIEW') {
      const s = await settings();
      const profile = s.reviewProfiles.find((item) => item.id === m.profileId);
      if (!profile) throw new Error('请先保存辅助模型配置。');
      const { assistants } = reviewConnections(
        { ...s, reviewProfiles: [profile], model: '', visionModel: '' },
        !!m.visual
      );
      const connection = assistants[0];
      if (!connection) throw new Error('请先选择辅助模型。');
      if (!m.visual) return callApi(connection, null, true, new AbortController());
      return testVisionConnection(connection);
    }
    if (m.type === 'KP_TEST_VISION') return testVisionConnection(await settings());
    if (m.type === 'KP_STATUS') {
      const s = await settings();
      return { ...(await state(m.tabId)), settings: publicSettings(s), hasKey: !!s.apiKey };
    }
    if (['KP_START', 'KP_STOP', 'KP_SCAN', 'KP_FILL'].includes(m.type)) {
      const tab = await courseTab(m.tabId);
      if (m.type === 'KP_START' || m.type === 'KP_SCAN') {
        const config = await settings();
        if (
          (config.autoSolve || m.type === 'KP_SCAN') &&
          (!config.apiKey || !config.endpoint || !config.model)
        )
          throw new Error('请先在设置中保存API地址、Key和文字模型。');
        if (
          (config.visualAgent && !config.visionModel) ||
          (config.autoSolve && config.useVision && !config.visionModel)
        )
          throw new Error('请先选择图片模型，或关闭图片识题与视觉操作。');
      }
      if (m.type === 'KP_STOP') activeRequests.get(tab.id)?.abort();
      await queue(tab.id, async () => {
        const st = await state(tab.id);
        if (m.type === 'KP_START') {
          st.running = true;
          st.completed = false;
          st.blocked = '';
          st.generation++;
          st.calls = 0;
          st.tokens = 0;
          st.actions = 0;
          st.lastAgent = 0;
          st.agentUnchanged = 0;
          st.agentSignature = '';
          st.submission = null;
          st.reviewTask = null;
          st.frames = {};
          st.refreshCount = 0;
          st.refreshContext = '';
          st.lastRefreshAt = 0;
          st.started = Date.now();
          log(st, '已开始本轮托管。');
        }
        if (m.type === 'KP_STOP') {
          st.running = false;
          st.manualUntil = 0;
          st.generation++;
          log(st, '已停止托管。');
        }
        if (m.type === 'KP_SCAN') {
          st.blocked = '';
          st.manualUntil = Date.now() + 120000;
          log(st, '正在解析本页可识别的题目。');
        }
        await saveState(tab.id, st);
      });
      // Re-injection is idempotent and covers tabs opened before installing the extension.
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files:
            coursePlatform(tab.url) === 'mooc' ? ['mooc-adapter.js', 'content.js'] : ['content.js'],
        });
      } catch {
        /* static content scripts may already exist */
      }
      await broadcast(tab.id, {
        type:
          m.type === 'KP_SCAN'
            ? 'KP_SOLVE_PAGE'
            : m.type === 'KP_FILL'
              ? 'KP_FILL_PAGE'
              : 'KP_WAKE',
      });
      return { ok: true };
    }
  }
  if (courseSender(sender)) {
    const id = sender.tab.id;
    if (m.type === 'KP_INLINE_DONE')
      return queue(id, async () => {
        const st = await state(id);
        if (st.running && st.generation === m.generation && st.submission?.nonce === m.nonce) {
          st.submission = null;
          await saveState(id, st);
        }
        return { ok: true };
      });
    if (coursePlatform(sender.tab.url) === 'mooc' && sender.frameId === 0) {
      if (m.type === 'KP_MOOC_ACTIVATE_COURSE') {
        const st = await state(id);
        if (
          !st.running ||
          st.generation !== m.generation ||
          !/^[a-zA-Z0-9_-]{8,80}$/.test(m.controlId || '')
        )
          return { clicked: false };
        return activateMoocCourse(id, m.controlId);
      }
      if (m.type === 'KP_MOOC_SELECT_COURSE')
        return queue(id, async () => {
          const st = await state(id);
          st.targetCourse = String(m.title || '')
            .trim()
            .slice(0, 200);
          log(st, '已选择MOOC课程：' + st.targetCourse);
          await saveState(id, st);
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_OPEN_INTENT')
        return queue(id, async () => {
          const st = await state(id);
          if (st.running) {
            st.openIntent = {
              started: Date.now(),
              expires: Date.now() + 30000,
              title: String(m.title || st.targetCourse || '')
                .trim()
                .slice(0, 200),
            };
            await saveState(id, st);
          }
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_CURSOR')
        return queue(id, async () => {
          const st = await state(id);
          if (st.running && st.generation === m.generation) {
            st.moocResume = {
              course: new URL(sender.tab.url).origin + new URL(sender.tab.url).pathname,
              key: String(m.key || '').slice(0, 200),
              chapter: String(m.chapter || st.moocSelected?.chapter || '').slice(0, 160),
            };
            const course = st.moocResume.course,
              key = taskKey(m.key);
            const selectedLesson =
              key.startsWith('lesson:') &&
              st.moocSelected?.course === course &&
              st.moocSelected.key === key;
            if (
              st.progress?.doneCards?.[st.context?.card] &&
              (key === st.context.card || selectedLesson)
            ) {
              const proof = { course, key, chapter: st.moocResume.chapter };
              st.moocCompletedUnits = [
                ...(st.moocCompletedUnits || []).filter(
                  (item) =>
                    !(item.course === course && item.key === key && item.chapter === proof.chapter)
                ),
                proof,
              ].slice(-3000);
            }
            await saveState(id, st);
          }
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_SELECT_UNIT')
        return queue(id, async () => {
          const st = await state(id);
          if (st.running && st.generation === m.generation) {
            st.moocSelected = {
              key: String(m.key || '').slice(0, 200),
              chapter: String(m.chapter || '').slice(0, 160),
              course: new URL(sender.tab.url).origin + new URL(sender.tab.url).pathname,
            };
            await saveState(id, st);
          }
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_MANUAL_TASK')
        return queue(id, async () => {
          const st = await state(id);
          if (st.running && st.generation === m.generation) {
            const course = new URL(sender.tab.url).origin + new URL(sender.tab.url).pathname,
              key = taskKey(m.key),
              title = String(m.title || '测验').slice(0, 160),
              existed = (st.moocManualTasks || []).some(
                (task) => task.course === course && taskKey(task.key) === key
              );
            st.moocManualTasks = mergeTasks(
              st.moocManualTasks || [],
              { ...m, key, title, chapter: m.chapter || st.moocSelected?.chapter },
              course
            );
            if (!existed) log(st, '已保留待本人处理项：' + title + '；继续其他学习内容。', 'warn');
            st.moocResume = {
              course,
              key,
              chapter: String(m.chapter || st.moocSelected?.chapter || '').slice(0, 160),
            };
            await saveState(id, st);
          }
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_TASK_META')
        return queue(id, async () => {
          const st = await state(id),
            course = new URL(sender.tab.url).origin + new URL(sender.tab.url).pathname;
          if (
            st.generation === m.generation &&
            (st.moocManualTasks || []).some(
              (task) => task.course === course && taskKey(task.key) === taskKey(m.key)
            )
          ) {
            st.moocManualTasks = mergeTasks(
              st.moocManualTasks,
              { ...m, checkedAt: Date.now() },
              course
            );
            await saveState(id, st);
          }
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_MANUAL_CLEARED')
        return queue(id, async () => {
          const st = await state(id),
            course = new URL(sender.tab.url).origin + new URL(sender.tab.url).pathname;
          if (st.generation === m.generation) {
            const before = st.moocManualTasks || [],
              after = clearTask(before, course, m.key, m.proof);
            if (after.length < before.length) {
              st.moocManualTasks = after;
              const pending = after.filter((task) => task.course === course);
              if (
                st.moocAutoFinishedCourse === course ||
                /^视频和课件已处理/.test(st.blocked || '')
              ) {
                st.moocAutoFinishedCourse = course;
                st.completed = !pending.length;
                st.blocked = pending.length
                  ? '视频和课件已处理，' + pendingSummary(pending) + '。可在下方逐项处理。'
                  : '';
              }
              log(st, '已根据平台完成记录清除待处理项：' + String(m.title || m.key).slice(0, 160));
              await saveState(id, st);
            }
          }
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_REVIEW')
        return queue(id, async () => {
          const st = await state(id),
            course = new URL(sender.tab.url).origin + new URL(sender.tab.url).pathname,
            task = (st.moocManualTasks || []).find(
              (task) => task.course === course && taskKey(task.key) === taskKey(m.key)
            );
          if (!task) throw new Error('该待处理项已消除或属于其他课程。');
          if (st.submission) throw new Error('请等待当前练习提交完成后再切换。');
          activeRequests.get(id)?.abort();
          st.running = false;
          st.manualUntil = 0;
          st.generation++;
          st.frames = {};
          st.moocReview = { key: taskKey(task.key), course, started: Date.now(), phase: 'locate' };
          log(st, '正在打开待处理项：' + task.title);
          await saveState(id, st);
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_REVIEW_READY')
        return queue(id, async () => {
          const st = await state(id);
          if (st.generation === m.generation && st.moocReview?.key === m.key) {
            st.moocReview.phase = 'view';
            await saveState(id, st);
          }
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_DOCUMENT_DONE')
        return queue(id, async () => {
          const st = await state(id),
            s = await settings();
          if (
            st.running &&
            s.autoRead &&
            st.generation === m.generation &&
            st.context &&
            m.context?.chapter === st.context.chapter &&
            m.context?.card === st.context.card &&
            !st.submission &&
            Number(m.readingMs) >= s.readingInterval
          ) {
            st.progress.doneCards[st.context.card] = true;
            log(st, '已浏览当前课件，准备进入后续内容。');
            await saveState(id, st);
          }
          return { ok: true };
        });
      if (m.type === 'KP_MOOC_FINISH')
        return queue(id, async () => {
          const st = await state(id);
          const course = new URL(sender.tab.url).origin + new URL(sender.tab.url).pathname;
          st.moocManualTasks = mergeTasks(st.moocManualTasks || []);
          const pending = st.moocManualTasks.filter((task) => task.course === course);
          if (
            st.running &&
            st.generation === m.generation &&
            m.catalogChecked === true &&
            (m.allLearned === true || pending.length > 0)
          ) {
            st.moocAutoFinishedCourse = course;
            st.running = false;
            st.completed = !pending.length && m.allLearned === true;
            st.blocked = pending.length
              ? '视频和课件已处理，' + pendingSummary(pending) + '。可在下方逐项处理。'
              : '';
            st.generation++;
            log(
              st,
              st.blocked ||
                String(
                  m.reason || '所选MOOC课程的可访问学习内容已处理完毕，请以平台成绩和任务要求为准。'
                ).slice(0, 160),
              pending.length ? 'warn' : 'info'
            );
            await saveState(id, st);
          }
          return { ok: true };
        });
    }
    if (m.type === 'KP_PLAY_MEDIA') {
      const st = await state(id),
        s = await settings();
      if (
        !st.running ||
        st.generation !== m.generation ||
        !s.autoPlay ||
        !/^[a-zA-Z0-9_-]{8,80}$/.test(m.mediaId || '')
      )
        return { played: false };
      try {
        return await playCourseMedia(id, m.mediaId);
      } catch {
        return { played: false };
      }
    }
    if (m.type === 'KP_KEEP_ACTIVE' && sender.frameId === 0) {
      const st = await state(id),
        s = await settings();
      if (st.running && s.keepActive) await chrome.tabs.update(id, { active: true });
      return { ok: true };
    }
    if (m.type === 'KP_FINISH' && sender.frameId === 0)
      return queue(id, async () => {
        const st = await state(id);
        if (
          st.running &&
          st.generation === m.generation &&
          st.progress?.doneCards[st.context?.card]
        ) {
          st.running = false;
          st.completed = true;
          st.blocked = '';
          st.generation++;
          log(st, String(m.reason || '当前课程最后一节已确认完成，托管已结束。').slice(0, 160));
          await saveState(id, st);
        }
        return { ok: true };
      });
    if (m.type === 'KP_HELLO')
      return queue(id, async () => {
        const st = await state(id);
        if (sender.frameId === 0) {
          st.frames = {};
          if (!st.readingReturn?.active) st.context = null;
          st.pageStarted = Date.now();
          await saveState(id, st);
        }
        return { ok: true };
      });
    if (m.type === 'KP_CONTEXT' && sender.frameId === 0)
      return queue(id, async () => {
        const st = await state(id);
        const context = {
          chapter: String(m.context?.chapter || '').slice(0, 300),
          card: String(m.context?.card || 'page').slice(0, 160),
        };
        if (!context.chapter) throw new Error('无法识别当前章节。');
        if (st.context?.chapter === context.chapter && st.context.card === context.card)
          return { changed: false };
        activeRequests.get(id)?.abort();
        st.generation++;
        st.context = context;
        if (st.refreshContext && st.refreshContext !== JSON.stringify(context)) {
          st.refreshCount = 0;
          st.refreshContext = JSON.stringify(context);
        }
        st.frames = {};
        st.submission = null;
        st.pageStarted = Date.now();
        if (st.progress?.chapter !== context.chapter)
          st.progress = { chapter: context.chapter, doneCards: {} };
        st.lastAgent = 0;
        st.agentSignature = '';
        st.agentUnchanged = 0;
        await saveState(id, st);
        return { changed: true };
      });
    if (m.type === 'KP_TASK_DONE' && sender.frameId === 0)
      return queue(id, async () => {
        const st = await state(id);
        if (
          !st.running ||
          m.generation !== st.generation ||
          !st.context ||
          st.reviewTask?.generation === st.generation
        )
          return { accepted: false };
        const frames = Object.values(st.frames || {}).filter((f) => Date.now() - f.time < 9000);
        const videos = frames.reduce((n, f) => n + f.videos, 0),
          tasks = frames.reduce((n, f) => n + (f.videoTasks || 0), 0);
        const ended = videos > 0 && frames.every((f) => f.videos === f.ended);
        const marked =
          tasks > 0 &&
          tasks >= videos &&
          tasks === frames.reduce((n, f) => n + (f.videoTasksDone || 0), 0);
        const other = frames.reduce((n, f) => n + (f.otherTasks || 0), 0),
          otherDone =
            m.kind === 'document' &&
            videos === 0 &&
            tasks === 0 &&
            other > 0 &&
            other === frames.reduce((n, f) => n + (f.otherTasksDone || 0), 0);
        const selfChecked =
          m.kind === 'selfcheck' &&
          m.catalogDone === true &&
          frames.length > 0 &&
          frames.every(
            (f) =>
              f.videos === f.ended &&
              (f.videoTasks || 0) === (f.videoTasksDone || 0) &&
              (f.otherTasks || 0) === (f.otherTasksDone || 0) &&
              !f.pending &&
              !(f.questions > 0 && !f.completed)
          );
        if (!ended && !marked && !otherDone && !selfChecked) return { accepted: false };
        st.progress.doneCards[st.context.card] = true;
        st.refreshCount = 0;
        await saveState(id, st);
        return { accepted: true };
      });
    if (m.type === 'KP_STATE') {
      const [st, s] = await Promise.all([state(id), settings()]);
      return {
        running: st.running,
        blocked: st.blocked,
        generation: st.generation,
        manualUntil: st.manualUntil,
        settings: publicSettings(s),
        frames: st.frames,
        pageStarted: st.pageStarted,
        started: st.started,
        submission: st.submission,
        reviewTask: st.reviewTask?.generation === st.generation ? st.reviewTask : null,
        answerFeedback: (st.answerFeedback || [])
          .filter((entry) => entry.scope === feedbackScope(st))
          .map(({ questionId, rejected, count, previous }) => ({
            questionId,
            rejected,
            count,
            previous,
          })),
        context: st.context,
        progress: st.progress,
        reading: st.readingReturn?.active
          ? { active: true, started: st.readingReturn.started }
          : null,
        targetCourse: st.targetCourse,
        moocResume: st.moocResume,
        moocCompletedUnits: st.moocCompletedUnits,
        moocManualTasks: st.moocManualTasks,
        moocSelected: st.moocSelected,
        moocReview: st.moocReview,
      };
    }
    if (m.type === 'KP_READING_REGISTER')
      return queue(id, async () => {
        const st = await state(id),
          s = await settings();
        if (!st.running || !s.autoRead || !st.progress || st.readingReturn?.active)
          return { opened: false };
        const urls = (Array.isArray(m.urls) ? m.urls : [])
          .slice(0, 20)
          .filter(
            (url) =>
              typeof url === 'string' &&
              url.length < 4000 &&
              isCourseUrl(url) &&
              /\/(?:zt|reader|read|book|pdf)\//i.test(new URL(url).pathname)
          );
        st.progress.readings = st.progress.readings || {};
        for (const url of urls)
          if (!st.progress.readings[url]) st.progress.readings[url] = { status: 'new' };
        const next = Object.keys(st.progress.readings).find(
          (url) => st.progress.readings[url].status === 'new'
        );
        if (next) {
          st.progress.readings[next] = { status: 'opening' };
          const returnUrl = new URL(sender.tab.url),
            chapter = st.context.chapter.split('#').pop().replace(/^cur/, '');
          if (/\/mycourse\/studentstudy/.test(returnUrl.pathname) && /^\d+$/.test(chapter))
            returnUrl.searchParams.set(
              returnUrl.searchParams.has('knowledgeId') ? 'knowledgeId' : 'chapterId',
              chapter
            );
          st.readingReturn = {
            active: true,
            url: returnUrl.href,
            resource: next,
            started: Date.now(),
          };
          st.generation++;
          st.frames = {};
          st.submission = null;
          log(st, '正在打开专题阅读资源。');
          await saveState(id, st);
          await chrome.tabs.update(id, { url: next, active: s.keepActive });
          return { opened: true };
        }
        const readings = Object.values(st.progress.readings);
        if (readings.length && readings.every((r) => r.status === 'failed')) {
          st.running = false;
          st.generation++;
          st.blocked = `${readings.length} 个专题阅读资源均无法打开，请检查课程资源；未标记阅读任务完成。`;
          log(st, st.blocked, 'warn');
        } else if (
          readings.length &&
          readings.every((r) => ['visited', 'failed'].includes(r.status))
        ) {
          const pending = Object.values(st.frames || {}).some(
            (f) => Date.now() - f.time < 10000 && (f.otherTasks || 0) > (f.otherTasksDone || 0)
          );
          if (!pending) {
            st.progress.doneCards[st.context.card] = true;
            log(st, '阅读页面已浏览，当前页面未见待完成的任务标记。');
          }
        }
        await saveState(id, st);
        return { opened: false };
      });
    if (m.type === 'KP_READING_RETURN')
      return queue(id, async () => {
        const st = await state(id);
        if (!st.running || !st.readingReturn?.active) return { ok: false };
        const reading = st.readingReturn;
        st.progress.readings[reading.resource] = { status: m.failed ? 'failed' : 'visited' };
        log(
          st,
          m.failed
            ? `阅读资源不可用：${String(m.reason || '页面未加载').slice(0, 150)}，正在返回并尝试其他专题。`
            : '已浏览当前阅读页面，正在返回课程检查任务状态。',
          m.failed ? 'warn' : 'info'
        );
        st.readingReturn = null;
        st.generation++;
        st.frames = {};
        await saveState(id, st);
        await chrome.tabs.update(id, { url: reading.url, active: true });
        return { ok: true };
      });
    if (m.type === 'KP_ANSWER_REJECTED')
      return queue(id, async () => {
        const st = await state(id);
        const submission = st.submission;
        if (
          !st.running ||
          st.generation !== m.generation ||
          !submission ||
          submission.nonce !== m.nonce ||
          submission.frame !== sender.frameId ||
          submission.generation !== st.generation ||
          !submission.proofs?.length
        )
          return { accepted: false };
        const scope = feedbackScope(st);
        const requested = Array.isArray(m.questionIds) ? new Set(m.questionIds) : new Set();
        const precise = submission.proofs.filter((proof) => requested.has(proof.questionId));
        const affected = precise.length ? precise : submission.proofs;
        st.answerFeedback ||= [];
        for (const proof of affected) {
          let item = st.answerFeedback.find(
            (entry) => entry.scope === scope && entry.questionId === proof.questionId
          );
          if (!item) {
            item = { scope, questionId: proof.questionId, rejected: [], count: 0 };
            st.answerFeedback.push(item);
          }
          item.count++;
          item.previous = proof.answers;
          for (const result of st.results || [])
            if (result.questionId === proof.questionId) {
              result.platformRejected = !!precise.length;
              result.reviewIssue = precise.length
                ? '平台已否定这组答案，正在重新复核。'
                : '本次提交未通过，正在重新核对各题。';
            }
          if (
            precise.length &&
            !item.rejected.some(
              (answer) =>
                answerSignature(answer, proof.type) === answerSignature(proof.answers, proof.type)
            )
          )
            item.rejected.push(proof.answers);
          item.rejected = item.rejected.slice(-3);
          for (const [key, cached] of cache)
            if (cached.questionId === proof.questionId) cache.delete(key);
        }
        st.answerFeedback = st.answerFeedback.slice(-80);
        st.rejectedBatches = [
          ...(st.rejectedBatches || []),
          { scope, signature: submission.signature },
        ].slice(-80);
        st.submission = null;
        st.reviewTask = null;
        const config = await settings();
        const exhausted = affected.some(
          (proof) =>
            st.answerFeedback.find(
              (item) => item.scope === scope && item.questionId === proof.questionId
            )?.count >= 3
        );
        if (!config.reviewEnabled || exhausted) {
          st.running = false;
          st.manualUntil = 0;
          st.generation++;
          st.blocked = exhausted
            ? '平台多次判错，自动纠正已停止；请核对课程语境或平台答案。已拒绝答案不会原样重交。'
            : '平台提示回答错误；已停止重复提交。请启用自检并配置辅助模型后重新开始。';
          log(st, st.blocked, 'warn');
        } else log(st, '平台提示回答错误，已排除本次答案并启动重新作答和辅助复核。', 'warn');
        await saveState(id, st);
        const latest = st.results?.find((result) =>
          affected.some((proof) => proof.questionId === result.questionId)
        );
        if (latest) await broadcast(id, { type: 'KP_RESULT', result: latest });
        return {
          accepted: true,
          questionIds: affected.map((proof) => proof.questionId),
          previous: affected,
          precise: !!precise.length,
          running: st.running,
        };
      });
    if (m.type === 'KP_SUBMIT_INTENT' || m.type === 'KP_CLAIM_SUBMIT')
      return queue(id, async () => {
        const st = await state(id),
          s = await settings();
        if (!st.running || st.generation !== m.generation) return { allowed: false };
        if (m.type === 'KP_SUBMIT_INTENT') {
          if (!s.autoSubmit && !m.inVideo) return { allowed: false };
          const proofs = await submissionProofs(m.proofs);
          const signature = await submissionSignature(proofs);
          const scope = feedbackScope(st);
          if (
            (st.rejectedBatches || []).some(
              (entry) => entry.scope === scope && entry.signature === signature
            )
          )
            return { allowed: false, reason: '复核结果仍与平台已判错的答案相同，已阻止重复提交。' };
          if (
            proofs.some((proof) =>
              feedbackFor(st, proof.questionId).rejectedAnswers?.some(
                (answer) =>
                  answerSignature(answer, proof.type) === answerSignature(proof.answers, proof.type)
              )
            )
          )
            return { allowed: false, reason: '当前选择包含平台已否定的答案，请复核后继续。' };
          st.submission = {
            nonce: crypto.randomUUID(),
            generation: st.generation,
            time: Date.now(),
            frame: sender.frameId,
            inVideo: !!m.inVideo,
            proofs,
            signature,
            phase: 'awaiting_confirmation',
          };
          await saveState(id, st);
          return { allowed: true, nonce: st.submission.nonce };
        }
        if (
          (!s.autoSubmit && !st.submission?.inVideo) ||
          !s.autoConfirm ||
          !st.submission ||
          st.submission.phase === 'awaiting_result' ||
          st.submission.nonce !== m.nonce ||
          st.submission.generation !== st.generation ||
          Date.now() - st.submission.time > 60000
        )
          return { allowed: false };
        st.submission.phase = 'awaiting_result';
        st.submission.confirmedAt = Date.now();
        await saveState(id, st);
        return { allowed: true };
      });
    if (m.type === 'KP_SOLVE') {
      try {
        return await solve(m, sender);
      } catch (error) {
        const st = await state(id);
        if (!error.retryable && st.running && st.generation === m.generation)
          await pauseTab(id, error.message);
        throw error;
      }
    }
    if (m.type === 'KP_AGENT' && sender.frameId === 0) {
      try {
        return await visualStep(m, sender);
      } catch (error) {
        await pauseTab(id, error.message);
        throw error;
      }
    }
    if (m.type === 'KP_REPORT')
      return queue(id, async () => {
        const st = await state(id);
        if (m.generation !== st.generation) return { accepted: false };
        if (m.context?.chapter !== st.context?.chapter || m.context?.card !== st.context?.card)
          return { accepted: false };
        st.frames[sender.frameId] = { ...m.report, time: Date.now() };
        if (
          st.reviewTask?.phase === 'awaiting_page' &&
          st.reviewTask.frame === sender.frameId &&
          st.reviewTask.generation === st.generation
        )
          st.reviewTask = null;
        if (m.report.completed && st.context && st.progress) {
          st.progress.doneCards[st.context.card] = true;
          st.submission = null;
        } else if (
          st.submission?.inVideo &&
          st.submission.frame === sender.frameId &&
          m.report.questions === 0
        ) {
          st.submission = null;
        }
        await saveState(id, st);
        return { ok: true };
      });
    if (m.type === 'KP_LOG')
      return queue(id, async () => {
        const st = await state(id);
        log(st, m.text, m.level);
        await saveState(id, st);
        return { ok: true };
      });
    if (m.type === 'KP_SELF_CHECK' && sender.frameId === 0) {
      if (activeRequests.has(id)) return { refreshed: false, busy: true };
      const outcome = await queue(id, async () => {
        const st = await state(id),
          s = await settings();
        if (!st.running || st.generation !== m.generation) return { refreshed: false };
        // Keep even an older form report until its context changes or it reports completion.
        // Background throttling must not turn an unsubmitted form into a reloadable blank page.
        if (
          st.submission ||
          st.reviewTask?.generation === st.generation ||
          Object.values(st.frames || {}).some((frame) => frame.questions > 0 && !frame.completed)
        )
          return { refreshed: false, protected: true };
        const reason = String(m.reason || '页面长时间无响应').slice(0, 120);
        const ctxKey = JSON.stringify(st.context || sender.tab.url);
        if (st.refreshContext !== ctxKey) {
          st.refreshContext = ctxKey;
          st.refreshCount = 0;
        }
        if (!s.autoRefresh || (st.refreshCount || 0) >= 2) {
          st.running = false;
          st.manualUntil = 0;
          st.generation++;
          st.blocked = s.autoRefresh
            ? `${reason}（已自动刷新 2 次仍未恢复，请检查课程是否已学完或网络状态）。`
            : reason;
          log(st, st.blocked, 'warn');
          await saveState(id, st);
          return { refreshed: false, paused: true };
        }
        st.refreshCount = (st.refreshCount || 0) + 1;
        st.lastRefreshAt = Date.now();
        st.pageStarted = Date.now();
        st.generation++;
        st.frames = {};
        st.submission = null;
        log(st, `自检：${reason}，正在自动刷新页面恢复（第 ${st.refreshCount}/2 次）。`, 'warn');
        await saveState(id, st);
        return { refreshed: true, count: st.refreshCount };
      });
      if (outcome.refreshed) await chrome.tabs.reload(id);
      else if (outcome.paused) await broadcast(id, { type: 'KP_WAKE' });
      return outcome;
    }
    if (m.type === 'KP_BLOCK') {
      activeRequests.get(id)?.abort();
      await queue(id, async () => {
        const st = await state(id);
        st.running = false;
        st.manualUntil = 0;
        st.generation++;
        st.blocked = String(m.reason || '页面需要手动处理。').slice(0, 120);
        log(st, st.blocked, 'warn');
        await saveState(id, st);
      });
      await broadcast(id, { type: 'KP_WAKE' });
      return { ok: true };
    }
  }
  throw new Error('此页面无权执行该操作。');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  route(message, sender)
    .then((data) => respond({ ok: true, data }))
    .catch((error) =>
      respond({ ok: false, error: error.message || '操作失败。', retryable: !!error.retryable })
    );
  return true;
});
chrome.tabs.onRemoved.addListener((id) => {
  activeRequests.get(id)?.abort();
  chrome.storage.session.remove(stateKey(id));
});

// Course cards use window.open(). Transfer only a running, explicitly chosen
// MOOC navigation to its child tab; login/pop-up/other-site tabs never inherit it.
const moocChildren = new Map();
const moocCreated = new Map();
async function handoffMooc(childId, tab) {
  const parentId = moocChildren.get(childId);
  if (
    !parentId ||
    coursePlatform(tab.url) !== 'mooc' ||
    !/^\/(?:mooc\/learn|spoc\/learn|learn|course)\//.test(new URL(tab.url).pathname)
  )
    return;
  await queue(`handoff:${childId}`, async () => {
    if (!moocChildren.has(childId)) return;
    const source = await queue(parentId, async () => {
      const old = await state(parentId);
      if (!old.running || !old.openIntent || old.openIntent.expires < Date.now()) return null;
      const snapshot = structuredClone(old);
      old.running = false;
      old.openIntent = null;
      log(old, '已将MOOC托管交给新打开的课程标签。');
      await saveState(parentId, old);
      return snapshot;
    });
    if (!source) {
      moocChildren.delete(childId);
      return;
    }
    const moved = structuredClone(source);
    moved.generation++;
    moved.frames = {};
    moved.context = null;
    moved.progress = null;
    moved.openIntent = null;
    moved.pageStarted = Date.now();
    log(moved, '已接管新打开的MOOC课程标签。');
    await saveState(childId, moved);
    moocChildren.delete(childId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: childId, allFrames: true },
        files: ['mooc-adapter.js', 'content.js'],
      });
    } catch {}
    await chrome.tabs.update(childId, { active: true });
    await broadcast(childId, { type: 'KP_WAKE' });
  });
}
async function considerMoocChild(tab) {
  if (!moocCreated.has(tab.id)) return;
  if (tab.openerTabId && !moocChildren.has(tab.id)) {
    const source = await state(tab.openerTabId);
    if (source.running && source.openIntent?.expires > Date.now())
      moocChildren.set(tab.id, tab.openerTabId);
  }
  // Some MOOC links deliberately discard window.opener. In that case require
  // exactly one recent intent with the selected title, plus a new MOOC tab.
  if (!moocChildren.has(tab.id) && coursePlatform(tab.url) === 'mooc' && tab.title) {
    const stored = await chrome.storage.session.get(null),
      created = moocCreated.get(tab.id);
    const matches = Object.entries(stored).filter(
      ([key, st]) =>
        /^tab:\d+$/.test(key) &&
        st?.running &&
        st.openIntent?.title &&
        st.openIntent.expires > Date.now() &&
        created >= st.openIntent.started - 1000 &&
        String(tab.title).includes(st.openIntent.title)
    );
    if (matches.length === 1) moocChildren.set(tab.id, Number(matches[0][0].slice(4)));
  }
  if (moocChildren.has(tab.id)) await handoffMooc(tab.id, tab);
}
chrome.tabs.onCreated.addListener((tab) => {
  moocCreated.set(tab.id, Date.now());
  if (moocCreated.size > 100) moocCreated.delete(moocCreated.keys().next().value);
  considerMoocChild(tab).catch(() => {});
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (moocCreated.has(id) && (change.url || change.title || change.status === 'complete'))
    considerMoocChild(tab).catch(() => {});
  if (change.status === 'complete' && isCourseUrl(tab?.url)) {
    state(id)
      .then(async (st) => {
        if (!st.running || !st.lastRefreshAt || Date.now() - st.lastRefreshAt > 30000) return;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: id, allFrames: true },
            files:
              coursePlatform(tab.url) === 'mooc'
                ? ['mooc-adapter.js', 'content.js']
                : ['content.js'],
          });
        } catch {}
        await broadcast(id, { type: 'KP_WAKE' });
      })
      .catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  moocChildren.delete(id);
  moocCreated.delete(id);
});
