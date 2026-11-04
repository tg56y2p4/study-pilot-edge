import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  normalizeSettings,
  normalizeEndpoint,
  publicSettings,
  validateQuestion,
  assessmentKind,
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
test('调用上限有边界，旧阈值被忽略，非布尔值不能开启自动提交', () => {
  const s = normalizeSettings({ minConfidence: 0.1, maxCalls: 99999, autoSubmit: 'true' });
  assert.ok(!('minConfidence' in s));
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
  assert.equal(
    parseAnswer(response({ answers: ['错误'], confidence: 0.92 }), judgeImage).validationKind,
    'answer'
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

test('选择答案兼容全角、小写、连写和重复字母，拒绝含糊说明', () => {
  const multi = {
    ...question,
    type: 'multiple',
    options: 'ABCD'.split('').map((label) => ({ label, text: '选项' + label })),
  };
  for (const values of [['ａ，Ｃ，Ｄ', 'A'], ['acd'], ['A', 'C', 'D', 'A']]) {
    const result = parseAnswer(response({ answers: values, confidence: 0.8 }), multi);
    assert.deepEqual(result.answers, ['A', 'C', 'D']);
    assert.equal(result.validationKind, '');
  }
  assert.equal(
    parseAnswer(response({ answers: ['A错了，应选B'] }), multi).validationKind,
    'answer'
  );
  assert.deepEqual(parseAnswer(response({ answers: ['ｂ'], confidence: 1 }), question).answers, [
    'B',
  ]);
  const ambiguous = {
    ...multi,
    options: multi.options.map((option) =>
      option.label === 'A' ? { ...option, text: 'BAD' } : option
    ),
  };
  assert.equal(
    parseAnswer(response({ answers: ['BAD'], confidence: 1 }), ambiguous).validationKind,
    'answer'
  );
});

test('无语义的判断选项不按位置猜对错，仍接受明确字母', () => {
  const q = {
    text: '离线图示判断题',
    type: 'boolean',
    options: [
      { label: 'A', text: '' },
      { label: 'B', text: '' },
    ],
  };
  assert.equal(
    parseAnswer(response({ answers: ['正确'], confidence: 1 }), q).validationKind,
    'answer'
  );
  assert.deepEqual(parseAnswer(response({ answers: ['b'], confidence: 1 }), q).answers, ['B']);
});

test('填空空位不被过滤或错位，答案数量必须匹配', () => {
  const q = { text: '三个离线空位', type: 'fill', options: [], blankCount: 3 };
  const missing = parseAnswer(response({ answers: ['first', '', 'third'], confidence: 1 }), q);
  assert.deepEqual(missing.answers, ['first', '', 'third']);
  assert.equal(missing.validationKind, 'answer');
  assert.equal(
    parseAnswer(response({ answers: ['first'], confidence: 1 }), q).validationKind,
    'answer'
  );
  assert.equal(
    parseAnswer(response({ answers: ['first', 'second', 'third'], confidence: 1 }), q)
      .validationIssue,
    ''
  );
});

test('填空数量经过校验并在文字及图片请求中保留', () => {
  const q = { text: '两个离线空位', type: 'fill', options: [], blankCount: 2 };
  assert.equal(validateQuestion(q).blankCount, 2);
  for (const value of [0, -1, 1.5, 31])
    assert.throws(() => validateQuestion({ ...q, blankCount: value }), /填空/);
  assert.equal(JSON.parse(requestBody(configured, q).messages[1].content).blankCount, 2);
  const visual = requestBody(
    configured,
    { ...q, needsImage: true, captureId: 'offline-capture' },
    false,
    ['data:image/png;base64,AAAA']
  );
  assert.equal(JSON.parse(visual.messages[1].content[0].text).blankCount, 2);
});

test('连线下拉保留每空的题干和合法值，文字及截图请求均携带', () => {
  const slots = [
    {
      prompt: '左侧甲',
      options: [
        { value: 'A', text: '定义甲' },
        { value: 'B', text: '定义乙' },
      ],
    },
    {
      prompt: '左侧乙',
      options: [
        { value: 'A', text: '定义甲' },
        { value: 'B', text: '定义乙' },
      ],
    },
  ];
  const q = { text: '离线连线', type: 'fill', options: [], blankCount: 2, slots };
  assert.deepEqual(validateQuestion(q).slots, slots);
  assert.deepEqual(JSON.parse(requestBody(configured, q).messages[1].content).slots, slots);
  const body = requestBody(
    configured,
    { ...q, needsImage: true, captureId: 'offline-capture' },
    false,
    ['data:image/png;base64,AAAA']
  );
  assert.deepEqual(
    JSON.parse(body.messages[1].content[0].text).slots.map((slot) =>
      slot.options.map((o) => o.value)
    ),
    [
      ['A', 'B'],
      ['A', 'B'],
    ]
  );
  assert.equal(JSON.parse(body.messages[1].content[0].text).slots[0].options[0].text, '定义甲');
  const encoded = requestBody(
    configured,
    {
      ...q,
      needsImage: true,
      captureId: 'offline-capture',
      visualSignature: 'font-cxsecret|offline',
    },
    false,
    ['data:image/png;base64,AAAA']
  );
  assert.equal(
    'text' in JSON.parse(encoded.messages[1].content[0].text).slots[0].options[0],
    false
  );
  assert.throws(() => validateQuestion({ ...q, slots: slots.slice(0, 1) }), /空位/);
  assert.throws(
    () =>
      validateQuestion({
        ...q,
        slots: [
          {
            ...slots[0],
            options: [
              { value: 'A', text: '甲' },
              { value: 'A', text: '乙' },
            ],
          },
          slots[1],
        ],
      }),
    /选项/
  );
});

test('连线答案按各空合法值映射，重复选择保留，不允许不存在的值', () => {
  const q = {
    text: '离线连线',
    type: 'fill',
    options: [],
    blankCount: 2,
    slots: [
      {
        prompt: '甲',
        options: [
          { value: 'A', text: '定义甲' },
          { value: 'B', text: '定义乙' },
        ],
      },
      {
        prompt: '乙',
        options: [
          { value: 'A', text: '定义甲' },
          { value: 'B', text: '定义乙' },
        ],
      },
    ],
  };
  assert.deepEqual(
    parseAnswer(response({ answers: ['b', '定义甲'], confidence: 0.5 }), q).answers,
    ['B', 'A']
  );
  assert.deepEqual(parseAnswer(response({ answers: ['A', 'A'], confidence: 0.5 }), q).answers, [
    'A',
    'A',
  ]);
  assert.equal(
    parseAnswer(response({ answers: ['C', 'A'], confidence: 1 }), q).validationKind,
    'answer'
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

test('识别已打开的学习通与MOOC考试作业，不把外部网页视为答题页', () => {
  assert.equal(
    assessmentKind('https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?case=offline'),
    'homework'
  );
  assert.equal(assessmentKind('https://mooc1.chaoxing.com/exam-ans/exam/test'), 'exam');
  assert.equal(assessmentKind('https://www.icourse163.org/learn/offline#/learn/exam?id=1'), 'exam');
  assert.equal(
    assessmentKind('https://www.icourse163.org/learn/offline#/learn/homework'),
    'homework'
  );
  assert.equal(assessmentKind('https://mooc1.chaoxing.com/mycourse/studentstudy'), '');
  assert.equal(assessmentKind('https://outside.example.test/exam/test'), '');
});

test('考试作业支持默认开启，可以关闭并保存', () => {
  assert.equal(normalizeSettings({}).autoAssessments, true);
  assert.equal(normalizeSettings({ autoAssessments: false }).autoAssessments, false);
});

test('文本题字数要求规范化并拒绝无效长度', () => {
  const essay = { text: '离线写作题', type: 'text', options: [], minLength: 800 };
  assert.equal(validateQuestion(essay).minLength, 800);
  assert.throws(() => validateQuestion({ ...essay, minLength: 20001 }), /字数要求/);
  assert.throws(() => validateQuestion({ ...essay, minLength: -1 }), /字数要求/);
  assert.ok(!('minLength' in validateQuestion({ ...essay, type: 'single' })));
});

test('文字和截图复核均携带正文最低字数', () => {
  const essay = { text: '离线写作题', type: 'text', options: [], minLength: 800 };
  assert.equal(JSON.parse(requestBody(configured, essay).messages[1].content).minLength, 800);
  const body = requestBody(
    { ...configured, visionModel: 'fixture-vision' },
    { ...essay, needsImage: true, captureId: 'offline-essay-image' },
    false,
    ['data:image/png;base64,AAAA']
  );
  assert.equal(JSON.parse(body.messages[1].content[0].text).minLength, 800);
});

test('正文不能以空白或编辑器占位符凑够字数，完整正文保留', () => {
  const essay = { text: '离线写作题', type: 'text', options: [], minLength: 800 };
  const short = parseAnswer(
    response({ answers: ['甲'.repeat(799) + ' \n\u200b'.repeat(50)], confidence: 0.99 }),
    essay
  );
  assert.equal(short.validationKind, 'answer');
  assert.match(short.validationIssue, /799.*800/);
  assert.equal(
    parseAnswer(response({ answers: ['甲'.repeat(800)], confidence: 0.96 }), essay).validationIssue,
    ''
  );
});
