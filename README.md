# openclaw-proxy

openclaw-proxy 是一个面向 OpenClaw 模型服务的 HTTP 反向代理，可将客户端请求原样转发到上游，并把请求里的虚拟 api-key 替换成真实上游 api-key，以保证密钥安全。

仓库地址：
https://github.com/zongboy/openclaw-proxy

npm 地址：
https://www.npmjs.com/package/openclaw-proxy

适合这些场景：

- 给 OpenClaw 模型服务提供统一入口
- 隐藏真实上游地址和密钥
- 通过虚拟 api-key 将请求路由到不同服务商
- 透传流式响应、普通 JSON 响应和大部分请求头

## 功能

- 支持常见 HTTP 方法
- 保留请求路径、查询参数和请求体
- 支持流式响应透传
- 支持通过 Authorization、x-api-key、api-key、查询参数 api_key 中的虚拟 api-key 选择不同 provider
- 只替换虚拟 api-key，其他请求头、请求体、路径和查询参数保持原样透传
- 支持 WebSocket upgrade 透传，兼容需要长连接的 CLI 场景
- 提供健康检查接口 /healthz
- 使用 config.json 管理多 provider 配置
- 支持 start、stop、status、restart 进程管理命令

## 安装

全局安装：

```bash
npm install -g openclaw-proxy
```

临时运行：

```bash
npx openclaw-proxy serve
```

本地开发：

```bash
npm install
npm run build
npm start
```

安装完成后会自动创建配置目录和默认配置文件：

```bash
~/.openclaw-proxy/config.json
```

## 配置

通过 JSON 文件配置：

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| listenAddr | 否 | 127.0.0.1:8080 | 监听地址，支持 8080、:8080、127.0.0.1:8080 |
| providers[].name | 是 | - | provider 名称，用于日志定位 |
| providers[].virtualApiKey | 否 | - | 单个虚拟 api-key，兼容旧配置 |
| providers[].virtualApiKeys | 否 | - | 多个虚拟 api-key，任意一个命中即可 |
| providers[].targetBaseUrl | 是 | - | 对应服务商的上游基础地址，建议优先只配置域名或根地址 |
| providers[].apiKey | 是 | - | 真实上游 API Key。代理会按请求原本的凭据位置替换虚拟 key |

## 配置文件位置

默认配置文件路径：

```bash
~/.openclaw-proxy/config.json
```

首次安装时会自动生成该文件；如果文件被删除，执行下面命令也会重新生成：

```bash
openclaw-proxy init
```

示例：

```json
{
  "listenAddr": "127.0.0.1:8080",
  "providers": [
    {
      "name": "aliyuncs",
      "virtualApiKey": "proxy-aliyuncs-demo",
      "targetBaseUrl": "https://dashscope.aliyuncs.com",
      "apiKey": "your-real-aliyuncs-key"
    },
    {
      "name": "openai",
      "virtualApiKeys": ["proxy-openai-demo", "proxy-openai-codex-demo"],
      "targetBaseUrl": "https://api.openai.com",
      "apiKey": "your-real-openai-key"
    },
    {
      "name": "anthropic",
      "virtualApiKey": "proxy-anthropic-demo",
      "targetBaseUrl": "https://api.anthropic.com",
      "apiKey": "your-real-anthropic-key"
    }
  ]
}
```

说明：

- 代理内置识别这几个常见虚拟 key 位置：Authorization、x-api-key、api-key、查询参数 api_key。
- 命中后只在原位置替换虚拟 key。例如客户端原本发 Authorization: Bearer proxy-key，代理就替换成 Authorization: Bearer real-key；如果原本发 x-api-key: proxy-key，代理就替换成 x-api-key: real-key。
- 除虚拟 key 替换外，其他请求头、请求体、路径和查询参数都原样透传。
- targetBaseUrl 建议优先只配置真实上游域名；具体路由前缀由客户端请求决定。
- 当上游地址是 http 或 https 时，WebSocket upgrade 会自动映射到 ws 或 wss。
- 若上游本身要求某个额外请求头，例如 Anthropic 的 anthropic-version，应由客户端自己发送，代理不会主动补充。

后台启动：

```bash
openclaw-proxy start
```

## config.json 权限建议

如果你在服务器上使用 ~/.openclaw-proxy/config.json 保存真实上游密钥，建议把文件属主改为 root，并限制为仅 root 可读写：

```bash
sudo chown root:wheel ~/.openclaw-proxy/config.json
sudo chmod 600 ~/.openclaw-proxy/config.json
```

查看时使用：

```bash
sudo cat ~/.openclaw-proxy/config.json
```

编辑时使用：

```bash
sudo vi ~/.openclaw-proxy/config.json
```

> 注意：这种方式可以减少普通用户直接读取 config.json 的风险，但不能阻止 root 访问，也不能替代专门的密钥管理方案。更稳妥的做法是让 OpenClaw 与 openclaw-proxy 分别使用独立的普通用户运行，并将各自的配置文件权限限制为仅所属用户可读写。

## 命令

```bash
openclaw-proxy start
openclaw-proxy stop
openclaw-proxy status
openclaw-proxy restart
openclaw-proxy serve
```

- start：后台启动代理，并将 PID 写入 ~/.openclaw-proxy/openclaw-proxy.pid
- stop：停止后台代理进程
- status：查看运行状态
- restart：重启后台代理进程
- serve：前台运行，适合本地调试或容器启动

## 兼容性

- OpenAI Chat Completions：透传 /v1/chat/completions
- OpenAI Responses：透传 /v1/responses
- Anthropic Messages：透传 /v1/messages
- WebSocket upgrade：透传需要长连接的请求，适用于 Codex CLI 一类客户端

本代理只负责虚拟 key 替换与传输层转发，不负责在 OpenAI 与 Anthropic 协议之间转换请求体，也不会主动补充额外上游请求头。

## 重要说明

1. 建议将 openclaw-proxy 与 OpenClaw 以不同的普通用户身份运行，并将 config.json 权限限制为仅当前用户可读写。
2. 不要将代理监听在公网地址，也不要暴露不必要的对外端口。更安全的做法是仅监听 127.0.0.1 或内网受控地址；否则，一旦 OpenClaw 或其他本机进程具备网络访问能力，就可能绕过预期调用路径，间接滥用该代理所持有的上游密钥。

## openclaw.json 配置示例

建议在 openclaw.json 中为每个需要走代理的服务商单独配置一个 provider，并将 baseUrl 指向代理服务入口。apiKey 不再是真实上游密钥，而是写入 config.json 中对应的 virtualApiKey。

示例：

```json
"models": {
  "providers": {
    "aliyuncs-proxy": {
      "baseUrl": "http://127.0.0.1:8080/compatible-mode/v1",
      "apiKey": "proxy-aliyuncs-demo",
      "api": "openai-completions",
      "models": []
    },
    "openai-proxy": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "apiKey": "proxy-openai-demo",
      "api": "openai-completions",
      "models": []
    },
    "anthropic-proxy": {
      "baseUrl": "http://127.0.0.1:8080",
      "apiKey": "proxy-anthropic-demo",
      "api": "anthropic",
      "models": []
    }
  }
}
```

如果你希望代理对路由完全透明，也可以把 baseUrl 只写到代理根地址，然后由上游客户端自行携带完整路径。是否需要在客户端上带 /v1，取决于客户端本身的请求拼接方式。

## 请求示例

查询模型列表：

```bash
openclaw-proxy start
curl http://127.0.0.1:8080/v1/models \
  -H "Authorization: Bearer proxy-openai-demo"
```

流式调用示例：

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer proxy-openai-demo" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openclaw-chat",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

Anthropic Messages 示例：

```bash
curl http://127.0.0.1:8080/v1/messages \
  -H "x-api-key: proxy-anthropic-demo" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

OpenAI Responses 示例：

```bash
curl http://127.0.0.1:8080/v1/responses \
  -H "Authorization: Bearer proxy-openai-codex-demo" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5",
    "input": "hello"
  }'
```
