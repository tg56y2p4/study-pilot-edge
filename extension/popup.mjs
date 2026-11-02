import { isCourseUrl } from './core.mjs';
const $ = (id) => document.getElementById(id);
let tabId,
  valid = false,
  inFlight = false;
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (!response?.ok) throw new Error(response?.error || '连接失败。');
  return response.data;
}
function message(text, error = false) {
  $('message').textContent = text;
  $('message').className = `message ${error ? 'error' : 'success'}`;
}
async function refresh() {
  if (!valid || inFlight) return;
  const s = await send('KP_STATUS');
  const frames = Object.values(s.frames).filter((f) => Date.now() - f.time < 10000);
  $('status').classList.toggle('running', s.running);
  $('status').classList.toggle('blocked', !s.running && !!s.blocked);
  $('status').classList.toggle('completed', !s.running && !s.blocked && !!s.completed);
  const reviewing =
    s.reviewTask?.generation === s.generation && (s.running || s.manualUntil > Date.now());
  $('statusTitle').textContent = reviewing
    ? s.reviewTask.label
    : s.running
      ? '正在托管'
      : s.completed
        ? '课程任务已完成'
        : s.blocked
          ? '需要处理'
          : '准备就绪';
  $('statusDetail').textContent =
    s.blocked ||
    (!s.hasKey || !s.settings.endpoint || !s.settings.model
      ? '请先在设置中连接AI服务并选择模型。'
      : reviewing
        ? `${s.reviewTask.label} · ${s.reviewTask.model}`
        : s.running
          ? frames.find((f) => f.waiting)?.waiting ||
            '保持课程页面打开，视频自然播放结束后切换章节。'
          : '接入已保存，可以开始本轮托管。');
  $('videos').textContent =
    `${frames.reduce((n, f) => n + f.ended, 0)} / ${frames.reduce((n, f) => n + f.videos, 0)}`;
  $('calls').textContent = `${s.calls} / ${s.settings.maxCalls}`;
  $('tokens').textContent = s.tokens.toLocaleString();
  $('start').disabled = s.running;
  $('stop').disabled = !s.running && !(s.manualUntil > Date.now());
  const latest = s.results[0];
  $('result').hidden = !latest;
  $('noResult').hidden = !!latest;
  $('confidence').textContent = latest
    ? latest.platformRejected
      ? '平台已判错'
      : latest.reviewIssue
        ? '复核待处理'
        : latest.validationIssue
          ? '格式待复核'
          : `${latest.review?.status && latest.review.status !== 'single' ? '复核自评' : '模型自评'} ${Math.round(latest.confidence * 100)}%`
    : '';
  if (latest) {
    $('question').textContent = latest.text;
    $('answer').textContent = latest.answers.join('、') || '需要复核';
    $('explanation').textContent = [
      latest.validationIssue,
      latest.reviewIssue || latest.review?.reason,
      ...(latest.review?.stages || []).map(
        (stage) =>
          `${stage.label || stage.phase} · ${stage.model}：${stage.error || (stage.answers || []).join('、') + '（自评 ' + Math.round((stage.confidence || 0) * 100) + '%）'}`
      ),
      latest.explanation,
    ]
      .filter(Boolean)
      .join('\n');
  }
  $('logs').replaceChildren(
    ...s.logs.map((item) => {
      const li = document.createElement('li');
      li.dataset.level = item.level;
      const time = document.createElement('time');
      time.textContent = new Date(item.time).toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
      const text = document.createElement('span');
      text.textContent = item.text;
      li.append(time, text);
      return li;
    })
  );
}
for (const [id, type] of [
  ['start', 'KP_START'],
  ['stop', 'KP_STOP'],
  ['scan', 'KP_SCAN'],
  ['fill', 'KP_FILL'],
  ['retry', 'KP_RETRY_LOW'],
]) {
  $(id).onclick = async () => {
    inFlight = true;
    $(id).disabled = true;
    try {
      await send(type);
      message(
        {
          start: '已开始，运行状态也会显示在课程右下角。',
          stop: '已停止。',
          scan: '已发送解析请求，请在此处或课程面板查看结果。',
          fill: '已发送填写请求；只填写达到阈值且未作答的题目。',
          retry: '正在重试低分或格式异常题目；保留已有答案，不自动提交。',
        }[id]
      );
    } catch (e) {
      message(e.message, true);
    } finally {
      inFlight = false;
      $(id).disabled = false;
      await refresh().catch((e) => message(e.message, true));
    }
  };
}
$('settings').onclick = () => chrome.runtime.openOptionsPage();
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  valid = isCourseUrl(tab?.url);
  if (!valid) {
    $('statusTitle').textContent = '请打开学习通或MOOC';
    $('statusDetail').textContent =
      '进入学习通课程，或中国大学MOOC“个人中心 → 我的课程”，再打开课伴。';
    for (const id of ['start', 'stop', 'scan', 'fill', 'retry']) $(id).disabled = true;
  } else {
    await refresh();
    setInterval(() => refresh().catch((e) => message(e.message, true)), 1500);
  }
} catch (e) {
  message(e.message, true);
}
