# 配置模型服务

## 连接

打开插件设置，填写服务商提供的 OpenAI 兼容 Chat Completions Base URL 和匹配的 API Key。

- Host 示例：`https://api.example.com`，规范为 `https://api.example.com/v1`。
- 自定义路径：`https://api.example.com/gateway/v1`，保留原路径。
- 粘贴完整 `/chat/completions` 或 `/models` 地址时，会还原为 Base URL。
- 本机代理支持 `http://localhost:端口/v1` 和 `http://127.0.0.1:端口/v1`；远程服务使用 HTTPS。
- URL 不接受账号密码、Key 查询参数或片段。原生 Anthropic Messages 不是当前接入协议。

首次访问自定义服务时，按浏览器提示允许访问。每个来源使用自己的 Key；切换来源后留空不会把旧 Key 转发过去。

## 模型目录

点击“拉取模型”，从填写的服务读取目录。官方地址对应官方目录，第三方兼容服务对应其自己的目录。通用接口为 `GET BaseURL/models`；百炼还适配同域的独立目录与分页。

选择文字模型，再选择图片模型。勾选“图片识题也使用这个模型”可让图片任务跟随文字模型。服务没有声明图片能力时，以实际图片测试为准；模型出现在目录中不等于账号已开通调用权限。

目录为空或服务没有开放目录时，可直接手动填写模型 ID。修改接入信息会取消旧目录请求；异常响应大小限制为 4MB，最多展示 2000 个模型，达到上限时会提示目录已截断。

## 测试与保存

文字测试检查所选模型能否返回规定的 JSON；图片测试检查对应模型能否识别一张生成的算式图片。两者会实际调用服务，由使用者的 API 账户计费。

部分服务不接受 `response_format` 参数，可在高级设置关闭“请求服务使用 JSON 格式输出”。即使关闭该参数，模型仍需按提示返回 JSON 答案。

只使用文字模型时，可关闭图片识题与视觉入口定位。课程中的普通播放器和目录控制由平台适配执行。

默认 Key 只存本次浏览器会话；“记住 Key”会保存在本机扩展存储，不跨设备同步。具体范围见 [隐私说明](PRIVACY.md)。

接口参考：[OpenAI 模型目录](https://developers.openai.com/api/reference/cli/resources/models/methods/list)、[百炼模型目录](https://help.aliyun.com/zh/model-studio/list-models)。
