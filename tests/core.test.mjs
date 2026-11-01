import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  normalizeSettings,
  normalizeEndpoint,
  publicSettings,
  isCourseUrl,
  requestBody,
  parseAnswer,
  apiError,
  parsePlan,
  planRequest,
} from '../extension/core.mjs';
const question = {
  text: '以下哪一项等于 2 + 2？',
  type: 'single',
  options: [
    { label: 'A', text: '3' },
    { label: 'B', text: '4' },
  ],
};
const configured = {
  ...DEFAULTS,
  endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'fixture-chat',
  visionModel: 'fixture-vision',
};
const response = (answer) => ({
  choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }],
});

test('支持百炼原域名与业务空间域名，规范化完整 endpoint', () => {
  assert.equal(
    normalizeEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1'
  );
  assert.equal(
    normalizeEndpoint('https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'),
    'https://maas.qianwenaiapi.com/compatible-mode/v1'
  );
  assert.equal(
    normalizeEndpoint('https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/'),
    'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
  );
});
test('图片请求选择视觉模型，包含图文数组而不暴露截图标记', () => {
  const body = requestBody(
    { ...configured, visionModel: 'qwen3-vl-plus' },
    { ...question, needsImage: true, captureId: 'fixture-question-identifier' },
    false,
    ['data:image/png;base64,aGVsbG8=']
  );
  assert.equal(body.model, 'qwen3-vl-plus');
  assert.equal(body.messages[1].content[1].type, 'image_url');
  assert.doesNotMatch(body.messages[1].content[0].text, /captureId/);
  const input = JSON.parse(body.messages[1].content[0].text);
  assert.equal(input.imageIsAuthoritative, true);
  assert.equal(input.options[0].text, undefined);
  assert.doesNotMatch(input.text, /以下哪一项/);
});
test('拒绝非内嵌图片，避免模型自行访问带凭据的图片 URL', () => {
  assert.throws(
    () => requestBody(configured, question, false, ['https://example.test/question?token=x']),
    /截图/
  );
});
test('视觉操作只接受快照中的有效目标，拒绝删除与任意动作', () => {
  const controls = [
    { id: '0:c1', label: '继续学习', editable: false },
    { id: '0:c2', label: '删除课程', editable: false },
  ];
  const reply = (plan) => ({ choices: [{ message: { content: JSON.stringify(plan) } }] });
  const plan = parsePlan(
    reply({ action: 'click', target: '0:c1', confidence: 0.98, reason: '继续课程' }),
    controls
  );
  assert.equal(plan.target, '0:c1');
  assert.throws(() =>
    parsePlan(reply({ action: 'click', target: '0:c2', confidence: 1 }), controls)
  );
  assert.throws(() =>
    parsePlan(reply({ action: 'click', target: '0:missing', confidence: 1 }), controls)
  );
  assert.throws(() => parsePlan(reply({ action: 'evaluate', script: 'doSomething()' }), controls));
  assert.throws(() =>
    parsePlan(reply({ action: 'fill', target: '0:c1', value: 'test' }), controls)
  );
});
test('视觉规划使用截图、课程目标与有限动作协议', () => {
  const body = planRequest(
    { ...configured, courseName: '数学入门' },
    { controls: [], pages: [] },
    'data:image/png;base64,aGVsbG8='
  );
  assert.equal(body.model, configured.visionModel);
  assert.equal(body.messages[1].content[1].type, 'image_url');
  assert.match(body.messages[1].content[0].text, /数学入门/);
});
test('拒绝携带凭据、远程HTTP和URL查询参数的地址', () => {
  for (const url of [
    'http://remote.test/v1',
    'https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1?key=test',
    'https://api.test/v1#key',
    'file:///models',
  ])
    assert.throws(() => normalizeEndpoint(url));
});
test('接受自定义服务、Host、完整请求路径及本机代理', () => {
  assert.equal(normalizeEndpoint('https://api.example.test'), 'https://api.example.test/v1');
  assert.equal(
    normalizeEndpoint('https://api.example.test/gateway/v1/chat/completions'),
    'https://api.example.test/gateway/v1'
  );
  assert.equal(normalizeEndpoint('http://127.0.0.1:8788/v1/models'), 'http://127.0.0.1:8788/v1');
  assert.equal(
    normalizeEndpoint('https://dashscope-intl.aliyuncs.com'),
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
  );
  assert.throws(() => normalizeEndpoint('https://api.test/apps/anthropic'), /Anthropic/);
});
test('首次安装没有个人服务、模型、Key或课程目标', () => {
  for (const key of ['endpoint', 'model', 'visionModel', 'apiKey', 'courseName', 'moocCourseName'])
    assert.equal(DEFAULTS[key], '');
  assert.doesNotThrow(() => normalizeSettings({}));
  assert.throws(() => requestBody(DEFAULTS, question), /文字模型/);
});
test('通用请求不包含千问专属参数，JSON约束可关闭', () => {
  const body = requestBody(
    { ...configured, endpoint: 'https://api.example.test/v1', jsonMode: false },
    question
  );
  assert.equal('enable_thinking' in body, false);
  assert.equal('response_format' in body, false);
  const reasoning = requestBody(
    { ...configured, endpoint: 'https://api.example.test/v1', model: 'openai/gpt-5-fixture' },
    question
  );
  assert.equal('temperature' in reasoning, false);
  assert.equal('max_tokens' in reasoning, false);
  assert.ok(reasoning.max_completion_tokens > 0);
});
test('返回页面的设置不包含 API Key', () => {
  const s = publicSettings({ ...DEFAULTS, apiKey: 'fixture-not-a-real-key' });
  assert.equal('apiKey' in s, false);
  assert.equal('rememberKey' in s, false);
});
test('填写阈值和调用上限有边界，非布尔值不能开启自动提交', () => {
  const s = normalizeSettings({ minConfidence: 0.1, maxCalls: 99999, autoSubmit: 'true' });
  assert.equal(s.minConfidence, 0.8);
  assert.equal(s.maxCalls, 300);
  assert.equal(s.autoSubmit, false);
});
test('仅匹配学习通与中国大学MOOC域名，排除伪装 URL', () => {
  assert.equal(isCourseUrl('https://mooc1.chaoxing.com/mycourse/studentstudy'), true);
  assert.equal(isCourseUrl('https://chaoxing.com.evil.test/'), false);
  assert.equal(isCourseUrl('https://evil.test/?url=chaoxing.com'), false);
  assert.equal(isCourseUrl('https://www.icourse163.org/home.htm#/home/course'), true);
  assert.equal(isCourseUrl('https://www.icourse163.org/mooc/learn/ZJU-1/content'), true);
  assert.equal(isCourseUrl('https://icourse163.org.evil.test/home.htm'), false);
  assert.equal(isCourseUrl('https://evil.test/?url=icourse163.org'), false);
});

test('两个平台的课程目标分别保存，不会把学习通课程名当成MOOC目标', () => {
  const s = normalizeSettings({ courseName: '数学大观', moocCourseName: ' 大学物理 ' });
  assert.equal(s.courseName, '数学大观');
  assert.equal(s.moocCourseName, '大学物理');
  assert.equal(DEFAULTS.moocCourseName, '');
});
test('题目放入用户数据，请求不包含页面 Cookie、Key 或整个页面', () => {
  const body = requestBody(configured, question);
  assert.equal(body.enable_thinking, false);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.messages[1].role, 'user');
  assert.deepEqual(JSON.parse(body.messages[1].content), question);
  assert.equal('apiKey' in body, false);
});
test('正确解析答案及解释，兼容判断题文字与符号选项映射', () => {
  const parsed = parseAnswer(
    response({ answers: ['B'], explanation: '2+2=4', confidence: 0.96 }),
    question
  );
  assert.deepEqual(parsed.answers, ['B']);
  assert.equal(parsed.confidence, 0.96);
  const judgeReversed = {
    text: '判断：地球绕太阳转',
    type: 'boolean',
    options: [
      { label: 'A', text: '错误' },
      { label: 'B', text: '正确' },
    ],
  };
  const mapped = parseAnswer(
    response({ answers: ['正确'], explanation: '公转', confidence: 0.95 }),
    judgeReversed
  );
  assert.deepEqual(mapped.answers, ['B']);
  assert.equal(mapped.confidence, 0.95);
  const judgeImage = {
    text: '【图片题】判断正误',
    type: 'boolean',
    options: [
      { label: 'A', text: '' },
      { label: 'B', text: '' },
    ],
  };
  assert.deepEqual(
    parseAnswer(response({ answers: ['错误'], confidence: 0.92 }), judgeImage).answers,
    ['B']
  );
});
test('不存在的选项和不完整的自评分数不能自动填写', () => {
  assert.equal(parseAnswer(response({ answers: ['Z'], confidence: 1 }), question).confidence, 0);
  assert.equal(parseAnswer(response({ answers: ['B'] }), question).confidence, 0);
  assert.equal(parseAnswer(response({ answers: [], confidence: 1 }), question).confidence, 0);
  assert.equal(
    parseAnswer(response({ answers: ['A', 'B'], confidence: 1 }), question).confidence,
    0
  );
});
test('截断或无法解析的模型回复明确失败', () => {
  assert.throws(
    () =>
      parseAnswer({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }, question),
    /截断/
  );
  assert.throws(
    () => parseAnswer({ choices: [{ message: { content: '答案 B' } }] }, question),
    /JSON/
  );
});
test('错误只显示状态和错误代码，不回显接口原始正文', () => {
  const text = apiError(401, {
    error: { code: 'InvalidApiKey', message: 'should not echo this body' },
  });
  assert.match(text, /401/);
  assert.doesNotMatch(text, /should not echo/);
});
test('自检与超时自动刷新配置规范化边界值', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.autoRefresh, true);
  assert.equal(defaults.stallTimeout, 45000);
  const custom = normalizeSettings({ autoRefresh: false, stallTimeout: 5000 });
  assert.equal(custom.autoRefresh, false);
  assert.equal(custom.stallTimeout, 15000);
  const capped = normalizeSettings({ autoRefresh: true, stallTimeout: 999999 });
  assert.equal(capped.stallTimeout, 300000);
});

test('格式异常与模型正常低分提供不同的复核原因', () => {
  const invalid = parseAnswer(response({ answers: ['B'], confidence: '0.95' }), question);
  assert.equal(invalid.confidence, 0);
  assert.match(invalid.validationIssue, /数值自评分/);
  const low = parseAnswer(response({ answers: ['B'], confidence: 0.2 }), question);
  assert.equal(low.confidence, 0.2);
  assert.equal(low.validationIssue, '');
});

test('无效选项不能以高自评分绕过答案校验', () => {
  const parsed = parseAnswer(response({ answers: ['不存在的选项'], confidence: 1 }), question);
  assert.equal(parsed.confidence, 0);
  assert.match(parsed.validationIssue, /选项字母/);
});
