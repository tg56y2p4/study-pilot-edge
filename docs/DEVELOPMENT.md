# 开发与测试

环境：Node.js 22 或更新版本、Python 3.11 或更新版本。CI 使用 Node.js 24、Python 3.13，并分别在 Linux Chromium 和 Windows Edge 运行完整离线回归。

```sh
npm ci --ignore-scripts
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
npm run check
npm run test:unit
npm run test:release
python tools/run_browser_checks.py --browser chromium --jobs 2
npm run build
```

Linux 首次配置浏览器系统依赖可使用 `python -m playwright install --with-deps chromium`。

`npm run test:unit` 会输出 `test-results/unit-report.json`。浏览器检查全部使用独立临时配置与模拟 API/课程，不需要 Key，不访问个人浏览器，不操作真实账号。

MOOC列表接管检查会人为延迟新页初始状态写入，验证与接管状态串行提交，避免间歇性丢失运行状态。

完整浏览器套件包含原有五套检查、`stability_check.py` 、`review_check.py` 和 `assessments_check.py`。稳定性用例覆盖未提交作答、父子框架、手动/自动确认、完整目录、折叠菜单、低分重试及调用上限。复核用例覆盖主模型自检、低分与不确定、主辅分歧、平台判错纠正、已拒绝答案、用户编辑、同服务/独立服务、图片及Key隔离。可用 `--suite review_check.py` 单独运行，但单套结果不能用于发行打包。

原有解题流程夹具显式选择单模型模式，保留其原断言；新复核套件验证默认开启的多阶段流程。所有阶段都按真实请求计数，停止或代次变更后不得继续发起辅助调用，也不得登记旧结果。

## 选择浏览器

默认使用支持扩展侧载的 Playwright Chromium 通道。在本机验证 Edge 可运行：

```sh
python tools/run_browser_checks.py --browser edge --jobs 2
```

Windows 自动查找常用安装位置；其他环境可设置 `STUDY_PILOT_EDGE_EXECUTABLE` 指向 Edge 可执行文件。支持单套运行，例如 `--suite models_browser_check.py`，但部分检查报告不能用于发行打包。

参考：[Playwright 扩展测试](https://playwright.dev/python/docs/chrome-extensions)、[Playwright CI](https://playwright.dev/python/docs/ci)。

## 项目布局

- `extension/`：Manifest V3 扩展，无运行时 npm/Python 依赖。
- `tests/`：Node 单元测试与离线浏览器夹具。
- `tools/`：仓库检查、测试与可复现构建工具。
- `docs/`：面向用户与维护者的说明。
- `.github/`：CI、依赖更新与反馈模板。

`npm run format` 整理公开前端与文档格式，`npm run format:check` 检查格式。Python 工具使用标准库，浏览器检查依赖锁定在 `requirements-dev.txt`。

## 变更要求

为行为变化增加能复现问题的测试；避免只测试实现细节。页面结构变化用离线夹具重现，不提交真实题目或学生回复。截图、课件链接和 API 错误正文不要直接放进 Issue。

发布检查采用源码摘要确认测试对应当前代码，不以“机器上曾通过”代替当前版本的检查。`npm run check` 还会核对版本、锁文件与当前更新记录；`python tools/prepare_release.py --artifacts dist` 比对两个 ZIP 的内容及校验值，防止错传旧包。新增公开文件需更新 `tools/release_lib.py` 的白名单。

选项准确性回归覆盖DOM/显示顺序颠倒、原生与自定义控件、被判错B改A、缺少平台选中证据、延迟改选、提交许可期间改选、多选精确集合、重复字母及未通过复核的候选提示。

0.8.4删除分数门槛、严格模式及低分重试。回归覆盖旧阈值配置被忽略、低分和缺少自评分自动选答、分歧后的最终判别、单模型作答、已有不同选择的自动替换、人工编辑保护、解析入口自动填写与提交、实际选项核对和平台拒绝后的去重纠正。

考试与作业套件覆盖新版题块、普通文本框、原生可编辑正文、UEditor实际提交字段同步、多个编辑器、字数复核、分页、交卷确认、只填不提交、编辑器就绪等待与停止、人工编辑竞争和已提交只读状态。所有测试均使用独立配置与模拟页面，不接触真实作业或考试。

UEditor接口依据：[官方Editor源码](https://github.com/fex-team/ueditor/blob/master/_src/core/Editor.js)。页面世界仅运行预先定义的编辑器写入函数；模型输出按纯文本构造正文，不作为HTML或脚本执行。

提交前再次同步富文本提交字段；已有正文使用仅同步路径，保留原HTML与人工排版，不重新调用setContent。同步后重读题目及作答，再建立本轮提交许可。

0.8.5多选回归覆盖check_answer_dx章节/作业控件、原生隐藏checkbox、字母顺序颠倒、已有错误选项清除、整组选项重绘、延迟状态更新，以及点击期间停止和人工改动。只有实际勾选集合匹配才提交；单独隐藏答案字段不作为选中证据。

0.8.6增加answer_adapters_check.py套件，覆盖旧版题型元数据与选项结构、模型答案归一化、判断图标语义、填空数量/空项/缓存/混合编辑器顺序，以及整题重绘期间继续作答和人工编辑保护。完整浏览器回归现含9套；详见[答题适配核查](ANSWER_ADAPTERS.md)。

0.8.7新增分录/资料、下拉连线slots协议、Chosen显示同步与合法值验证；题目身份和提交proof均携带slots。局部保存置于翻页/整页提交之前，并等待确认、处理有限重试；停止广播撤销嵌套文档中的旧字段标记。回归同时覆盖延迟保存、人工改动、停止竞争、禁用填写/提交开关和相同答案分页保存。
