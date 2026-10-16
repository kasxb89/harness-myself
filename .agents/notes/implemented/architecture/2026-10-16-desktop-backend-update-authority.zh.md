# Agent Note: Bind Desktop update discovery to a packaged backend authority

Status: implemented

[English](2026-10-16-desktop-backend-update-authority.md) | 中文

## 问题

产品运营需要在 harnes-api 中调整各平台的更新目录，而无需重新构建应用。若允许产品渲染进程或继承环境选择后台，无关代码就能替换受信更新配置。后台不可用或禁用更新时，旧的可用目标不能继续接受操作。

## 决策

签名应用 manifest 固定 harnes-api 服务地址。Electron 主进程每次常规版本清单检查前读取公开状态，只接受经过校验的当前平台 generic Nightly 目录。远程管理可选择目录，但不能更换配置服务、发布者身份、安装命令或降级策略。[Desktop 参考](../../../../apps/desktop/README.zh.md#updates)负责配置与请求限制。

发现失败会撤销旧的可用候选并发布分类失败，不能变成“已是最新”，也不能回落至包内发布 URL。正在下载、已验证与正在安装的目标继续绑定已选 provider；后台修改在该操作结束后生效。开发环境显式绑定回环地址，读取同一状态字段，不在未打包应用中启用安装。

[打包决策](2026-08-25-electron-desktop-packaging-and-updates.zh.md)继续负责发布产物、上传、签名与恢复，其中嵌入的 feed 属于发布元数据，不决定运行时来源。[壳配置决策](2026-10-08-desktop-shell-configuration.zh.md)继续生效：此受信地址不依赖可用的 Host，也不直接求值 Cordis patch。

## 考虑过的替代方案

**始终使用包内 feed。** 每次路由调整都需要新安装包，也无法满足后台管理要求。

**从渲染进程、Host 或运行环境解析受信地址。** 这些来源无法提供已安装更新客户端需要的固定信任决策。依赖 Host 还会使其不可用时无法检查。

**发现失败后回落。** 禁用或撤销的来源仍可能被使用，既掩盖运营决策，也将旧的可用状态呈现为当前状态。

## 影响

发布操作人员必须在打包时显式配置受信后台，后台操作人员必须在所配目录发布兼容的签名产物。缺少地址影响更新检查，不阻止应用启动。后台目录控制和开发 HTTP 例外都不会放宽产物验证，也不授予安装权限。
