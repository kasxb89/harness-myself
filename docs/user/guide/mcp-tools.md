# Connect common MCP tools

English | [中文](mcp-tools.zh.md)

These optional configurations connect documentation search, GitHub, web research, and document reading through the [MCP client](../../../packages/mcp/mcp-client/README.md). They do not change the default tools or require a new application build. This reference covers the supplied overlays and their prerequisites.

## Choose a connection

Each file under [`apps/cli/config/examples/mcp-tools/`](../../../apps/cli/config/examples/mcp-tools/) adds one connection. Hosted services control their own tool lists, availability, quotas, and charges; selecting an overlay does not include a subscription.

| Overlay | Use | Prerequisite | Official setup |
|---|---|---|---|
| `context7.cordis.yml` | Library documentation and version-specific examples | `CONTEXT7_API_KEY` | [Context7](https://github.com/upstash/context7#installation) |
| `github-readonly.cordis.yml` | Read repositories, issues, and pull requests | `GITHUB_MCP_PAT` with access to the intended repositories; the overlay selects GitHub's read-only endpoint | [GitHub remote MCP](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) |
| `firecrawl.cordis.yml` | Search, scrape, and parse web material | Keyless in the supplied overlay; set `FIRECRAWL_API_KEY` and add the account header below to use your account | [Firecrawl MCP](https://github.com/firecrawl/firecrawl-mcp-server#installation) |
| `tavily.cordis.yml` | Search and extract current web information | `TAVILY_API_KEY` | [Tavily MCP](https://github.com/tavily-ai/tavily-mcp#remote-mcp-server) |
| `markitdown.cordis.yml` | Convert local or remote documents to Markdown for reading | Separately installed `markitdown-mcp` executable, version `0.0.1a8`, on the launch environment's `PATH` | [MarkItDown MCP](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp), [pinned distribution](https://pypi.org/project/markitdown-mcp/0.0.1a8/) |

Context7, GitHub, Firecrawl, and Tavily use official hosted Streamable HTTP endpoints. The Context7, GitHub, and Tavily overlays read required tokens from the Host launch environment into individual Authorization header values. The supplied Firecrawl overlay sends no Authorization header; setting `FIRECRAWL_API_KEY` alone does not enable account authentication. Add the header below to use that account. The files contain no credentials and never put a token in a URL. Missing required tokens produce a configuration error naming the environment variable before connecting.

MarkItDown uses local stdio. DSH starts and stops the preinstalled executable; it does not install Python packages or check the executable's installed version. The converter can access files and network locations available to that process. Its Markdown output helps the model read a document; it does not edit or render Office deliverables. See the provider's setup for format-specific dependencies and optional cloud features.

## Enable an overlay

For a token-based connection, set the chosen provider's environment variable in the environment that launches DSH, then pass its overlay from the repository root. The supplied Firecrawl keyless configuration needs no environment variable. For example, after configuring `CONTEXT7_API_KEY`:

```sh
pnpm dsh web --patch "$PWD/apps/cli/config/examples/mcp-tools/context7.cordis.yml"
```

Replace the filename with another row from the table. Omitting the overlay leaves these connections disabled. For an existing profile, merge its single `insert` patch into the profile's user patch file instead of replacing that file; [profile patch layers](../../../apps/cli/README.md) own persistence across launches. Give every configured connection a distinct `id` and `serverName` when copying a row.

After discovery, the model sees names such as `mcp__context7__<tool>` or `mcp__github__<tool>`. Enable only the connections needed for the task: every discovered tool adds its description and parameter schema to model requests. A failed optional connection reports its error without terminating the Host; the [MCP client](../../../packages/mcp/mcp-client/README.md#use-this-package) defines reconnection and timeouts.

### Use a Firecrawl account

The supplied Firecrawl overlay always uses keyless mode. To use your account, copy its connection row and replace `headers: {}` under `config` with this mapping. Set `FIRECRAWL_API_KEY` before adding the header:

```yaml
headers:
  Authorization: !!js >-
    (() => {
      const token = process.env.FIRECRAWL_API_KEY?.trim()
      if (!token) throw new Error('Firecrawl MCP requires FIRECRAWL_API_KEY')
      return `Bearer ${token}`
    })()
```

This uses the MCP client's supported per-header value configuration. A missing key for the configured header fails explicitly before connection instead of sending an empty Bearer. Keep `headers: {}` to continue using keyless mode.

## Verify the connection

Confirm that the expected server's tools appear before asking the model to use them. For a remote connection, begin with a read-only query, such as finding documentation or reading a public repository. For MarkItDown, convert a small document you intend the process to read. A successful result must identify the tool and contain the requested data; a listed tool alone does not confirm that credentials or the service work.

Repository checks parse these exact overlays, evaluate their token expressions with synthetic credentials, validate the MCP configuration, and discover tools through local stdio or HTTP fixtures. Those checks do not install MarkItDown, contact the hosted services, verify user accounts, or establish provider availability. If tools are absent, check the connection diagnostic, required environment variable, or executable before restarting a task.

## Reuse browser tools and account integrations

The existing [Playwright MCP adapter](../../../packages/experimental/browser-use-playwright-mcp/README.md) and [Chrome DevTools MCP adapter](../../../packages/experimental/browser-use-chrome-devtools-mcp/README.md) provide browser operation with Session-owned state. Use the selected browser adapter instead of adding a second generic connection for the same browser; [browser-use](../../../packages/browser-use/browser-use/README.md) permits one provider at a time.

The generic HTTP client accepts configured headers but does not implement an interactive OAuth login or token refresh. These overlays therefore use API keys or a GitHub PAT. Adding the URL of an OAuth-only service, such as hosted [Notion MCP](https://developers.notion.com/guides/mcp/overview), does not complete account authorization; no Notion overlay is supplied.

For cross-session recall, use the separate [memory MCP examples](mcp-memory.md). Shared memory stores facts; it does not send messages to another live session.
