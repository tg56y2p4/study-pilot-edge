# 发布步骤

## 发布内容

`npm run build` 在 `dist/` 输出安装 ZIP、源码 ZIP 和 `SHA256SUMS.txt`。构建要求当前源码的完整离线检查通过。ZIP 条目使用固定时间、排序与文件权限；相同源码和检查摘要生成相同字节。

源码包使用公开文件白名单，不依赖开发电脑的整个目录。也可执行 `python tools/export_source.py` 仅导出待审阅源码。

## 发布前

1. 更新 `extension/manifest.json`、`package.json` 和弹窗中的版本。
2. 更新 `CHANGELOG.md`。
3. 运行开发文档中的完整检查。
4. 用独立浏览器从安装 ZIP 加载扩展，确认首次配置为空。
5. 核对源码包清单与 SHA-256。

## GitHub

推送到 `main`、创建 `v*` 标签或手动触发时，GitHub Actions 会运行离线检查并上传构建产物。CI 默认只读权限，不自动发布 Release；维护者审阅通过后再创建 Release 并附上安装包、源码包和校验文件。

不要直接上传开发目录或 `test-results/`。真实 API 调用和私人课程现场记录不属于发行材料。

目前许可证尚未选定；确定后再添加 `LICENSE` 并更新 README。不要把“公开仓库”描述为已经授予某个开源许可证。
