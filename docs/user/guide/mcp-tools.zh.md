# 接入常用 MCP 工具

[English](mcp-tools.md) | 中文

这些可选配置通过 [MCP 客户端](../../../packages/mcp/mcp-client/README.zh.md)接入文档搜索、GitHub、网页研究和文档读取。它们不改变默认工具，也不要求重新构建应用。本参考说明随附覆盖配置及其使用前提。

## 选择连接

[`apps/cli/config/examples/mcp-tools/`](../../../apps/cli/config/examples/mcp-tools/) 中的每个文件添加一个连接。托管服务自行决定工具列表、可用性、配额和费用；选择覆盖配置不包含服务订阅。

| 覆盖配置 | 用途 | 前提 | 官方配置说明 |
|---|---|---|---|
| `context7.cordis.yml` | 库文档和指定版本的示例 | `CONTEXT7_API_KEY` | [Context7](https://github.com/upstash/context7#installation) |
| `github-readonly.cordis.yml` | 读取仓库、Issue 和 PR（Pull Request） | `GITHUB_MCP_PAT` 需具备目标仓库的访问权限；覆盖配置选择 GitHub 的只读端点 | [GitHub 远程 MCP](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) |
| `firecrawl.cordis.yml` | 搜索、抓取和解析网页资料 | 随附配置使用免密钥服务；使用账号时需设置 `FIRECRAWL_API_KEY` 并添加下文的账号请求头 | [Firecrawl MCP](https://github.com/firecrawl/firecrawl-mcp-server#installation) |
| `tavily.cordis.yml` | 搜索和提取最新网页信息 | `TAVILY_API_KEY` | [Tavily MCP](https://github.com/tavily-ai/tavily-mcp#remote-mcp-server) |
| `markitdown.cordis.yml` | 将本地或远程文档转为 Markdown 供模型阅读 | 单独安装 `0.0.1a8` 版 `markitdown-mcp` 可执行文件，并加入启动环境的 `PATH` | [MarkItDown MCP](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp)、[固定版本发行包](https://pypi.org/project/markitdown-mcp/0.0.1a8/) |

Context7、GitHub、Firecrawl 和 Tavily 使用官方托管的 Streamable HTTP 端点。Context7、GitHub 和 Tavily 的覆盖配置从 Host 启动环境读取必填令牌，通过单个 Authorization 请求头值发送。Firecrawl 的随附配置不发送 Authorization；即使设置了 `FIRECRAWL_API_KEY`，也需要按下文添加请求头才能使用账号。文件不包含凭据，也不会把令牌放进 URL。缺少必填令牌时，连接前的配置错误会指出所需的环境变量。

MarkItDown 使用本地 stdio。DSH 启动和停止预先安装的可执行文件，不安装 Python 包，也不检查已安装的版本。转换器能访问该进程有权读取的文件和网络地址。Markdown 输出帮助模型读取文档，不负责编辑或渲染 Office 产物。各格式所需依赖和可选云功能见提供方的配置说明。

## 启用覆盖配置

需要令牌的连接应先在启动 DSH 的环境中设置对应环境变量，再从仓库根目录传入覆盖配置。随附 Firecrawl 免密钥配置不需要环境变量。例如，配置好 `CONTEXT7_API_KEY` 后运行：

```sh
pnpm dsh web --patch "$PWD/apps/cli/config/examples/mcp-tools/context7.cordis.yml"
```

将文件名替换为表中的其他配置即可。不传入覆盖配置时，这些连接保持关闭。对于已有配置档案，将其中唯一的 `insert` 补丁合入档案的用户补丁文件，不要覆盖整个文件；跨次启动的持久配置方式见[档案补丁层](../../../apps/cli/README.zh.md)。复制配置项时，为每个连接设置不同的 `id` 和 `serverName`。

工具发现完成后，模型能看到 `mcp__context7__<tool>` 或 `mcp__github__<tool>` 等名称。只启用当前任务需要的连接：每个已发现工具都会把描述和参数 schema 加入模型请求。可选连接失败会报告错误，不会终止 Host；重连和超时行为见 [MCP 客户端](../../../packages/mcp/mcp-client/README.zh.md#use-this-package)。

### 使用 Firecrawl 账号

随附 Firecrawl 配置始终使用免密钥模式。要使用账号，请复制它的配置项，并在 `config` 下将 `headers: {}` 替换为以下映射；添加请求头之前先设置 `FIRECRAWL_API_KEY`：

```yaml
headers:
  Authorization: !!js >-
    (() => {
      const token = process.env.FIRECRAWL_API_KEY?.trim()
      if (!token) throw new Error('Firecrawl MCP requires FIRECRAWL_API_KEY')
      return `Bearer ${token}`
    })()
```

这使用 MCP 客户端支持的逐个请求头值配置方式。已配置的请求头缺少密钥时会在连接前明确报错，不会发送空 Bearer。保留 `headers: {}` 即可继续使用免密钥模式。

## 验证连接

先确认预期服务器的工具已出现，再让模型调用。远程连接先用查询文档或读取公开仓库等只读请求验证。MarkItDown 则转换一份允许该进程读取的小文档。成功结果应明确调用的工具并包含所需数据；仅看到工具名称不代表凭据或服务已经可用。

仓库检查会解析这些原始覆盖配置，以合成凭据求值令牌表达式，验证 MCP 配置，并通过本地 stdio 或 HTTP fixture（测试前置数据）发现工具。这些检查不安装 MarkItDown、不连接托管服务、不验证用户账号，也不证明提供方当时可用。工具未出现时，先检查连接诊断、所需环境变量或可执行文件，再重新启动任务。

## 复用浏览器工具和账号集成

已有的 [Playwright MCP 适配器](../../../packages/experimental/browser-use-playwright-mcp/README.zh.md)和 [Chrome DevTools MCP 适配器](../../../packages/experimental/browser-use-chrome-devtools-mcp/README.zh.md)提供浏览器操作，并由各 Session 持有状态。复用选定的浏览器适配器，不要为同一个浏览器再添加第二个通用连接；[browser-use](../../../packages/browser-use/browser-use/README.zh.md)一次只允许一个提供方。

通用 HTTP 客户端接受配置好的请求头，但未实现交互式 OAuth 登录或令牌刷新。因此这些覆盖配置使用 API 密钥或 GitHub PAT。仅添加托管 [Notion MCP](https://developers.notion.com/guides/mcp/overview) 等只支持 OAuth 的服务 URL，并不能完成账号授权；这里不提供 Notion 覆盖配置。

需要跨会话回忆时，使用独立的[记忆 MCP 示例](mcp-memory.zh.md)。共享记忆存储事实，不负责向另一个正在运行的会话发送消息。
