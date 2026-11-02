import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, publicSettings } from '../extension/core.mjs';
import {
  answerSignature,
  usableAnswer,
  reviewConnections,
  reviewRequestBody,
  reviewAnswer,
} from '../extension/review.mjs';

const question = {
  text: '【判断题】离线样例中甲概念与乙概念完全相同。',
  type: 'boolean',
  options: [
    { label: 'A', text: '对' },
    { label: 'B', text: '错' },
  ],
};
const answer = (choice = 'A', confidence = 0.96, extra = {}) => ({
  answers: [choice],
  confidence,
  explanation: '独立推导',
  tokens: 3,
  ...extra,
});
const config = (extra = {}) =>
  normalizeSettings({
    endpoint: 'https://primary.example.test/v1',
    apiKey: 'fixture-primary-key',
    model: 'primary',
    visionModel: 'primary-vision',
    reviewProfiles: [{ id: 'assistant', model: 'helper', visionModel: 'helper-vision' }],
    ...extra,
  });
async function run(responses, extra = {}, feedback = {}) {
  const calls = [];
  const result = await reviewAnswer({
    settings: config(extra),
    question,
    feedback,
    call: async (settings, phase, context) => {
      calls.push({ model: settings.model, phase, context });
      const value = responses[calls.length - 1];
      if (value instanceof Error) throw value;
      assert.ok(value, 'Unexpected additional model call');
      return value;
    },
  });
  return { result, calls };
}

test('辅助配置校验数量、模型和独立服务地址', () => {
  assert.throws(
    () => config({ reviewProfiles: Array.from({ length: 4 }, (_, i) => ({ id: 'a' + i })) }),
    /最多/
  );
  assert.throws(() => config({ reviewProfiles: [{ model: '<script>' }] }), /模型ID/);
  assert.throws(
    () =>
      config({ reviewProfiles: [{ inheritConnection: false, endpoint: 'http://remote.test' }] }),
    /HTTPS/
  );
  assert.throws(() => config({ reviewProfiles: [{ id: 'same' }, { id: 'same' }] }), /重复/);
});

test('内容脚本公开配置不能包含任何辅助Key或记忆标记', () => {
  const safe = publicSettings(
    config({
      reviewProfiles: [
        {
          inheritConnection: false,
          endpoint: 'https://helper.example.test/v1',
          apiKey: 'fixture-private-helper',
          rememberKey: true,
        },
      ],
    })
  );
  assert.ok(!JSON.stringify(safe).includes('fixture-'));
  assert.ok(!('apiKey' in safe.reviewProfiles[0]));
  assert.ok(!('rememberKey' in safe.reviewProfiles[0]));
});

test('共用连接和独立连接分别解析正确Key，图片使用独立模型', () => {
  const settings = config({
    reviewProfiles: [
      { id: 'shared', model: 'helper', visionModel: 'helper-vision' },
      {
        id: 'separate',
        inheritConnection: false,
        endpoint: 'https://helper.example.test/v1',
        model: 'other',
        apiKey: 'fixture-other',
      },
    ],
  });
  const { primary, assistants } = reviewConnections(settings, true);
  assert.equal(primary.model, 'primary-vision');
  assert.equal(assistants[0].model, 'helper-vision');
  assert.equal(assistants[0].apiKey, settings.apiKey);
  assert.equal(assistants[1].model, 'other');
  assert.equal(assistants[1].apiKey, 'fixture-other');
});

test('高分题仍先自检，一致时不调用辅助，取两次较低自评', async () => {
  const { result, calls } = await run([answer('A', 0.98), answer('A', 0.94)]);
  assert.deepEqual(
    calls.map((item) => item.phase),
    ['solve', 'self-check']
  );
  assert.equal(result.review.status, 'self_checked');
  assert.equal(result.confidence, 0.94);
  assert.equal(result.tokens, 6);
});

test('初答85分必须启动独立辅助，不能仅靠自检抬到阈值', async () => {
  const { result, calls } = await run([answer('A', 0.85), answer('A', 0.97), answer('A', 0.95)]);
  assert.equal(calls[2].phase, 'assistant');
  assert.deepEqual(result.answers, ['A']);
  assert.equal(result.confidence, 0.95);
  assert.equal(result.review.status, 'assisted');
});

test('显式不确定即使自评98%也需要辅助复核', async () => {
  const { calls, result } = await run([answer('A', 0.98, { uncertain: true }), answer(), answer()]);
  assert.equal(calls.length, 3);
  assert.equal(result.review.status, 'assisted');
});

test('主辅分歧触发一次最终判别，裁定需与独立辅助一致', async () => {
  const { result, calls } = await run([
    answer('A', 0.85),
    answer('A'),
    answer('B'),
    answer('B', 0.97),
  ]);
  assert.deepEqual(
    calls.map((item) => item.phase),
    ['solve', 'self-check', 'assistant', 'final']
  );
  assert.deepEqual(result.answers, ['B']);
  assert.equal(result.review.status, 'adjudicated');
});

test('最终判别仍分歧时，高自评分也不允许填写', async () => {
  const { result } = await run([answer('A', 0.85), answer('A'), answer('B'), answer('A', 0.99)]);
  assert.equal(result.review.status, 'unresolved');
  assert.equal(usableAnswer(result, 0.9), false);
});

test('自检改口后不能拿已被修正的初答冒充主辅一致', async () => {
  const { result, calls } = await run([answer('A', 0.98), answer('B'), answer('A'), answer('A')]);
  assert.equal(
    calls.length,
    4,
    'Compare the latest conclusion per model before skipping final adjudication'
  );
  assert.equal(result.review.status, 'adjudicated');
});

test('平台明确否定的答案不能靠所有模型自评99%重新通过', async () => {
  const { result } = await run(
    [answer('B'), answer('B'), answer('B'), answer('B')],
    {},
    { needsReview: true, rejectedAnswers: [['B']] }
  );
  assert.equal(result.review.status, 'unresolved');
  assert.equal(usableAnswer(result, 0.9), false);
});

test('辅助服务失败可继续下一辅助，不吞掉致命取消或额度错误', async () => {
  const extra = {
    reviewProfiles: [
      { id: 'one', model: 'one' },
      { id: 'two', model: 'two' },
    ],
  };
  const { result, calls } = await run(
    [answer('A', 0.85), answer(), new Error('服务不可用'), answer()],
    extra
  );
  assert.equal(calls.length, 4);
  assert.equal(result.review.status, 'assisted');
  const fatal = Object.assign(new Error('本轮请求上限'), { fatal: true });
  await assert.rejects(() => run([answer(), fatal]), /请求上限/);
});

test('与主模型相同的配置不能冒充独立辅助模型', async () => {
  const { result, calls } = await run([answer('A', 0.85), answer()], {
    reviewProfiles: [{ model: 'primary' }, { id: 'duplicate', model: 'primary' }],
  });
  assert.equal(calls.length, 2);
  assert.equal(result.review.status, 'unresolved');
});

test('没有辅助时保留低分阻断和原阈值，不伪造已通过复核', async () => {
  const { result } = await run([answer('A', 0.85), answer('A', 0.85)], { reviewProfiles: [] });
  assert.equal(result.confidence, 0.85);
  assert.equal(result.review.status, 'unresolved');
  assert.match(result.reviewIssue, /添加/);
});

test('可显式保留单模型模式，仍拒绝已判错答案', async () => {
  const { result, calls } = await run([answer()], { reviewEnabled: false });
  assert.equal(calls.length, 1);
  assert.equal(result.review.status, 'single');
  const rejected = await run([answer()], { reviewEnabled: false }, { rejectedAnswers: [['A']] });
  assert.equal(usableAnswer(rejected.result, 0.9), false);
});

test('图片复核保留同一截图，独立阶段不泄露主模型候选或Key', () => {
  const image = 'data:image/png;base64,AAAA';
  const body = reviewRequestBody(
    config(),
    question,
    'assistant',
    { candidates: [answer('B')], feedback: { needsReview: true, rejectedAnswers: [['B']] } },
    [image]
  );
  assert.equal(body.messages[1].content[1].image_url.url, image);
  const input = JSON.parse(body.messages[1].content[0].text);
  assert.deepEqual(input.review.candidates, []);
  assert.deepEqual(input.review.rejectedAnswers, [['B']]);
  assert.ok(!JSON.stringify(body).includes('fixture-primary-key'));
});

test('多选答案比较忽略选项顺序，填空保留顺序', () => {
  assert.equal(answerSignature(['B', 'A'], 'multiple'), answerSignature(['A', 'B'], 'multiple'));
  assert.notEqual(answerSignature(['B', 'A'], 'fill'), answerSignature(['A', 'B'], 'fill'));
});
