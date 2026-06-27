# 2026-06-26 WeCom 项目组切换指令原始需求

## 原始需求

用户要求：

> 现在固定项目 `"projects": "oa-stock,jiuji-m,9ji-admin,MyDjangoProject,jiuji-mp,yimagz_submit,oa-order,autoTransfer,oa-pc,oa-after,oa-finance,huishou,oanew,saasoanew,oa-api,nc-segments,logistics,orginfo,StateAllowanceDeclaration,web,oa-pay,iteng-sp"`，增加支持通过指令切换项目，`/neo` 切换到 neo 项目组，`/oa` 切换到 oa 项目组。

用户补充确认：

```text
/neo: small-oa,jiuyun-oa,neo-oa,jiuyun-moa
/oa: oa-stock,jiuji-m,9ji-admin,MyDjangoProject,jiuji-mp,yimagz_submit,oa-order,autoTransfer,oa-pc,oa-after,oa-finance,huishou,oanew,saasoanew,oa-api,nc-segments,logistics,orginfo,StateAllowanceDeclaration,web,oa-pay,iteng-sp
允许在当前分支继续修改
```

后续补充：

```text
应该实现一个动态指令的项目数组配置,后续后动态增加其他项目组的指令
改为跟着 mcpServers[0].headers, mcp可以有指令来切换头的内容
这里为default, 比如现在/oa 是default配置, 应该指向引用就行, 不用重新写一遍
这样 在bot里面可以指定各个mcp的default配置, 这样更灵活
这样不对, 会有配置冲突, 有些机器人不是/oa默认就完了, 应该是头配置都在headerProfiles中, bot指定默认是哪个指令, 如果多个mcp有相同指令,自动切换对应的头内容
当前会话切换指令后, 会话生效期间都是对应的指令
```

## 需求边界

- 技术栈：Node.js + TypeScript ESM，现有脚本式 `node --loader ts-node/esm` 测试。
- 指令范围：仅处理精确 `/xxx` 指令，支持企业微信提及后仍能识别。
- 配置范围：可切换头配置统一放在 `mcpServers[].headerProfiles`，profile key 直接使用指令名，如 `"/oa"`、`"/neo"`；`bots[].defaultMcpHeaderCommand` 指定机器人默认启用哪个指令。
- 多 MCP 范围：多个 MCP server 存在同名 profile 时，发送该指令会自动切换所有对应 MCP 的 header 内容。
- 状态范围：切换后写入当前会话的 MCP header override 和 repoHints，会话生效期间后续问题持续沿用该指令对应配置，直到再次切换或清理会话。
- 不涉及数据库、SQL、接口字段、前端展示契约。

## 待核对与不适用

- `neo-oa` 当前是否已被 GitNexus 索引不在本轮代码内校验，切换指令只负责设置 repoHints。
- 真实 `config/wecom-agent.config.json` 是本地私有配置并被 `.gitignore` 忽略，本轮正式交付优先修改代码常量、模板和文档。
