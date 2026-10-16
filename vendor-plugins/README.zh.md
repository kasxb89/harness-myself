# 产品插件发布产物

[English](README.md) | 中文

`deepseek-ivideo-0.5.0-62ee529e.tgz` 包含产品已安装的完整 Video Studio 发布包，共 649 个文件。上游源码为 [`Devin-AXIS/deepseek-design` 的提交 `62ee529e84423ba63e823b23860293a43b6eb03b`](https://github.com/Devin-AXIS/deepseek-design/tree/62ee529e84423ba63e823b23860293a43b6eb03b/packages/deepseek-ivideo)。仓库保留该产物，是因为 npm 不提供 0.5.0 版本，安装时也无需下载完整上游仓库。

web-app 的发布清单声明不可变的远端依赖 `github:Devin-AXIS/deepseek-design#62ee529e84423ba63e823b23860293a43b6eb03b&path:/packages/deepseek-ivideo`。根目录 `pnpm-workspace.yaml` 仅将 `@deepseek-ai/dsh-web-app@0.2.1-alpha.2>deepseek-ivideo` 覆盖为 `file:./vendor-plugins/deepseek-ivideo-0.5.0-62ee529e.tgz`。因此，本仓库安装经过校验的发布包镜像，发布清单则保留可解析的上游来源。覆盖规则不改变发布文件或已有的元数据补丁。

原桌面 profile 锁文件记录的源码归档 SHA-512 integrity 保存在 `deepseek-ivideo-0.5.0.files.json` 中。每个发布文件均取自该确切提交的 pnpm 已构建包缓存，并分别核对缓存中的 SHA-512 摘要。文件清单记录每个摘要、大小和可执行权限。原包的 `LICENSE` 保留在 tarball 中，也单独提供为 [deepseek-ivideo.LICENSE](deepseek-ivideo.LICENSE)。

2026-10-16，项目所有者确认持有 `deepseek-ivideo` 0.5.0、源码提交 `62ee529e84423ba63e823b23860293a43b6eb03b` 的商业及品牌书面授权。声明检查仅接受这一包名、版本、`SEE LICENSE IN LICENSE` 许可声明、源码 pin 及已校验的发布包镜像。这项确认不改变包的许可，也不覆盖其他发布版本。原始 iPolloWork 许可证、Different AI 版权、归属和第三方声明继续保留；本地包元数据兼容性修改记录在[补丁](../patches/deepseek-ivideo@0.5.0.patch)及[生成声明](../THIRD_PARTY_NOTICES.md#video-studio-release-with-owner-authorization)中。

要从同一发布包的解压副本重现该产物，运行 `python3 vendor-plugins/repack.py /path/to/package`。脚本校验全部清单文件，保留原始字节与可执行权限，并固定 tar 的所有者、时间戳和 gzip 元数据。脚本不执行包内代码。根锁文件记录重新打包的 tarball integrity，依赖安装会正常校验它。包元数据的兼容性调整继续保留为 `patches/` 下显式的 pnpm 补丁。

更新时，选择不可变的上游版本，审查发布包及许可证，替换文件清单，重现 tarball，并同时更新 bundle 依赖、镜像覆盖规则和根锁文件。
