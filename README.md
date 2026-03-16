# openclaw-proxy

openclaw-proxy 是一个面向 OpenClaw 模型服务的 HTTP 反向代理，可将客户端请求原样转发到上游，并在请求头中自动注入 API Key，以保证密钥的安全。

仓库地址：
https://github.com/zongboy/openclaw-proxy

npm地址：
https://www.npmjs.com/package/openclaw-proxy

适合这些场景：

- 给 OpenClaw 模型服务提供统一入口
- 隐藏真实上游地址和密钥
- 透传流式响应、普通 JSON 响应和大部分请求头

## 功能

- 支持常见 HTTP 方法
- 保留请求路径、查询参数和请求体
- 支持流式响应透传
- 自动注入 Authorization 或自定义鉴权头
- 提供健康检查接口 `/healthz`
- 支持 `.env` 和系统环境变量两种配置方式
- 支持 `start`、`stop`、`status`、`restart` 进程管理命令

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
~/.openclaw-proxy/.env
```

## 配置

通过环境变量配置：

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TARGET_BASE_URL` | 是 | - | OpenClaw 上游地址，例如 `https://your-openclaw.example.com` |
| `API_KEY` | 否 | - | API Key，未设置 `API_KEY_VALUE` 时会自动拼接 header 值 |
| `API_KEY_VALUE` | 否 | - | 完整 header 值，例如 `Bearer your-openclaw-key` |
| `API_KEY_HEADER` | 否 | `Authorization` | 注入的 header 名称 |
| `API_KEY_PREFIX` | 否 | `Bearer` | 当只提供 `API_KEY` 且 header 为 `Authorization` 时使用 |
| `LISTEN_ADDR` | 否 | `:8080` | 监听地址，支持 `8080`、`:8080`、`127.0.0.1:8080` |

## 配置文件位置

默认配置文件路径：

```bash
~/.openclaw-proxy/.env
```

首次安装时会自动生成该文件；如果文件被删除，执行下面命令也会重新生成：

```bash
openclaw-proxy init
```

## 使用 .env

服务默认读取 `~/.openclaw-proxy/.env`；如果同名系统环境变量已经存在，则系统环境变量优先。

示例：

```bash
TARGET_BASE_URL="https://your-openclaw.example.com"
API_KEY="your-openclaw-key"
API_KEY_VALUE=""
API_KEY_HEADER="Authorization"
API_KEY_PREFIX="Bearer"
LISTEN_ADDR=":8080"
```

后台启动：

```bash
openclaw-proxy start
```

## .env 权限建议

如果你在服务器上使用 `~/.openclaw-proxy/.env` 保存 OpenClaw 密钥，建议把文件属主改为 root，并限制为仅 root 可读写：

```bash
sudo chown root:wheel ~/.openclaw-proxy/.env
sudo chmod 600 ~/.openclaw-proxy/.env
```

查看时使用：

```bash
sudo cat ~/.openclaw-proxy/.env
```

编辑时使用：

```bash
sudo vi ~/.openclaw-proxy/.env
```

> 注意：这种方式可以减少普通用户直接读取 `.env` 的风险，但不能阻止 root 访问，也不能替代专门的密钥管理方案。更稳妥的做法是让 OpenClaw 与 openclaw-proxy 分别使用独立的普通用户运行，并将各自的配置文件权限限制为仅所属用户可读写。

## 直接使用环境变量

```bash
export TARGET_BASE_URL="https://your-openclaw.example.com"
export API_KEY="your-openclaw-key"
openclaw-proxy serve
```

## 命令

```bash
openclaw-proxy start
openclaw-proxy stop
openclaw-proxy status
openclaw-proxy restart
openclaw-proxy serve
```

- `start`：后台启动代理，并将 PID 写入 `~/.openclaw-proxy/openclaw-proxy.pid`
- `stop`：停止后台代理进程
- `status`：查看运行状态
- `restart`：重启后台代理进程
- `serve`：前台运行，适合本地调试或容器启动

## 重要说明
1. 无论使用 `.env` 还是系统环境变量，都建议将 openclaw-proxy 与 OpenClaw 以不同的普通用户身份运行，并将配置文件权限限制为仅当前用户可读写。
2. 不要将代理监听在公网地址，也不要暴露不必要的对外端口。更安全的做法是仅监听 `127.0.0.1` 或内网受控地址；否则，一旦 OpenClaw 或其他本机进程具备网络访问能力，就可能绕过预期调用路径，间接滥用该代理所持有的上游密钥。

## openclaw.json 配置示例

建议在 `openclaw.json` 中为代理单独配置一个自定义 provider，并将 `baseUrl` 指向代理服务的 OpenAI 兼容入口。

示例：

```json
"models": {
  "providers": {
    "proxy": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "apiKey": "dummy",
      "api": "openai-completions",
      "models": []
    }
  }
}
```

## 请求示例

查询模型列表：

```bash
openclaw-proxy start
curl http://127.0.0.1:8080/v1/models
```

流式调用示例：

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
	-H "Content-Type: application/json" \
	-d '{
		"model": "openclaw-chat",
		"messages": [{"role": "user", "content": "hello"}],
		"stream": true
	}'
```