---
kind: upgrade-guide
description: "图片编辑请求必须携带实际参考图，不再退化成文生图生成。"
---
# 为图片生成声明输入模式

[English](guide.md) | 中文

## 变更

`generate_image` 接受可选的 `generation_mode`，取值为 `text-to-image` 或 `image-to-image`。省略时，原调用仍根据非空 `reference_images` 推导编辑模式。明确的编辑模式或当前真人请求中肯定的“图生图”要求在提交前提供实际参考图，缺图不再退化成付费文生图。明确的文生图模式与生成参考图同时出现会返回参数冲突。较早聊天中出现过图片不代表本次选择了参考图。

`list_image_models` 公布 `generation_modes` 和适用的编辑规格。标准编辑专用接口只提供图生图。没有受支持参考图协议的自定义图片接口不能宣称可用参考图，也不能静默丢弃生成参考图。编辑请求先使用兼容规格子集，再填全省略的维度。

## 迁移

1. 读取 `list_image_models` 中精确型号的信息，保留用户明确选择。编辑时使用该型号的编辑规格，通过 `reference_images` 提供获准使用的原图；输入方式明确时，将 `generation_mode` 设为 `image-to-image`。
2. 提交前返回 `IMAGE_REFERENCE_REQUIRED` 时补充本次需要的原图，不要为了绕过错误删除引用或改为文生图。
3. 确认受理请求保留了所需模式和参考图。原任务处于处理中或结果未知时，继续使用已有查询与恢复工具；本次改动不授权重新提交。已有任务和登录状态无需迁移。
