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

完整浏览器套件包含原有五套检查、`stability_check.py` 和 `review_check.py`。稳定性用例覆盖未提交作答、父子框架、手动/自动确认、完整目录、折叠菜单、低分重试及调用上限。复核用例覆盖主模型自检、低分与不确定、主辅分歧、平台判错纠正、已拒绝答案、用户编辑、同服务/独立服务、图片及Key隔离。可用 `--suite review_check.py` 单独运行，但单套结果不能用于发行打包。

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
