# 发布步骤

## 发布内容

`npm run build` 在 `dist/` 输出安装 ZIP、源码 ZIP 和 `SHA256SUMS.txt`。构建要求当前源码的完整离线检查通过。ZIP 条目使用固定时间、排序与文件权限；相同源码、检查摘要和 Python/zlib 构建环境生成相同字节。

不同系统或压缩库版本可能生成不同的 ZIP 压缩字节。已验证 Windows 与 Linux 构建的解压内容逐文件一致，但两份 ZIP 的校验值并不一定相同。校验时使用对应下载产物附带的 `SHA256SUMS.txt`，不要混用不同构建的校验文件。

源码包使用公开文件白名单，不依赖开发电脑的整个目录。也可执行 `python tools/export_source.py` 仅导出待审阅源码。

## 发布前

1. 更新 `extension/manifest.json`、`package.json`、`package-lock.json`（含根包）和弹窗中的版本，并同步 README。版本采用三段数字，例如 `0.7.0`。
2. 更新 `CHANGELOG.md`。
3. 运行开发文档中的完整检查。
4. 用独立浏览器从安装 ZIP 加载扩展，确认首次配置为空。
5. 执行 `python tools/prepare_release.py --tag v0.7.0 --artifacts dist --output .release-notes.md`，核对源码包清单、包内文件、检查摘要与 SHA-256。将示例版本换成实际版本。

## GitHub

推送到 `main`、创建 `v*` 标签或手动触发时，GitHub Actions 会运行离线检查并上传构建产物。普通提交与 PR 的检查只有只读权限。

正式发布时先提交源码和文档，确认 `main` 检查通过，再推送与源码版本一致的标签：

```sh
git push origin main
git tag -a v0.7.0 -m "Release v0.7.0"
git push origin v0.7.0
```

标签会重新运行完整检查。通过后，独立的发布任务取得本次构建产物，重新核对版本、公开文件清单、检查摘要和校验和，从 `CHANGELOG.md` 的当前版本生成说明，以草稿方式上传三个附件，最后公开 Release。发布任务使用 GitHub 自动提供的令牌，不需要维护者额外保存 PAT、模型 Key 或课程账号。只有此任务具备 `contents: write` 权限。

如果检查失败，修复后使用新的版本标签；不要移动已经公开发布的标签。上传中断时，可以重新运行标签工作流以补全尚未公开的草稿。工作流遇到已公开 Release 时保留历史附件，不用 `--clobber` 覆盖公开文件。

安装附件名称为 `study-pilot-edge-v版本号.zip`，源码附件为 `study-pilot-edge-source-v版本号.zip`，第三个文件为 `SHA256SUMS.txt`。GitHub 另外提供的 “Source code (zip/tar.gz)” 由平台自动生成，不是扩展安装目录。

可用 `Get-FileHash 文件名.zip -Algorithm SHA256`（PowerShell）或 `sha256sum -c SHA256SUMS.txt`（Linux）核对同次发布的文件。

参考：[GitHub 工作流产物](https://docs.github.com/en/actions/tutorials/store-and-share-data)、[GitHub CLI 发布命令](https://cli.github.com/manual/gh_release_create)。

不要直接上传开发目录或 `test-results/`。真实 API 调用和私人课程现场记录不属于发行材料。

目前许可证尚未选定；确定后再添加 `LICENSE` 并更新 README。不要把“公开仓库”描述为已经授予某个开源许可证。
