# 原始需求归档

## 原始文本需求

> /dev-spec-gen 下面提问已经提供地址和参数，回答没有给出有效信息： 针对“【用户追问整合】
> 原问题：
> curl 'https://oawcf2.ch999.cn/kcApi/doSendWuLiu' \
>  -H 'Accept: /' \
>  -H 'Accept-Language: zh-CN,zh-Hans;q=0.9' \
>  -H 'Platform: iOS/6.6.8' \
>  -H 'Content-Type: application/x-www-form-urlencoded' \
>  -H 'User-Agent: CH999OA/1 CFNetwork/3860.200.71 Darwin/25.1.0' \
>  -H 'phoneName: iPhone 12' \
>  -H 'app_uuid: F2A810B6-F2D3-4BDD-AD73-57BEAF3EADB1' \
>  -H 'appidentifier: 356876216533086' \
>  -H 'SVersion: iOS/26.1' \
>  -H 'Connection: keep-alive' \
>  --data-raw 'wlcount=1&pwd=B9BA924BFCBFDA49850372CA35FDC100&area=YNws3&ch999id=2761&wlCompany=shunfeng&nextAreaId=0&boxNumber=&expressCategory=&parcelValue=&wlIds=42836554&wlNum=&clientNo=' \
>  --compressed
>
> 用户追问：
> 这个提交顺丰物流单，默认是标快还是特快
>
> 处理要求：
> 请把“用户追问”作为对“原问题”的补充或修正，先整合成同一个问题再继续回答；不要只回答追问中的片段。
> 已确认锚点必须优先继承：如果原问题或上一轮回答里已经确认项目、仓库、接口路径、入口文件、入口方法、类名、方法名、符号、表名或字段名，继续检索时必须优先带着这些锚点查；不要重新放宽到其它项目、其它技术栈或宽泛业务词。”，当前还没有足够证据直接下结论。
>
> 请补充以下任一信息后我继续查：
> 1. 所在系统、项目、页面、菜单路径或接口地址。
> 2. 截图中的完整文字、URL、字段名或按钮/表格列名。
> 3. 你说的“这里”具体指页面上的哪个字段或区域。

## 来源

- 对话/链接：当前 Codex 对话
- Jira/Yuque/文档：

## 附件语义化记录

| 附件 | 来源/文件名 | 可见内容语义化描述 | 待确认点 |
| :--- | :--- | :--- | :--- |
| 无 | 无 | 无 | 无 |

## 初步验收断言

- [ ] `curl` 中的完整 URL、接口路径 `kcApi/doSendWuLiu` 和关键表单参数必须被抽取为强锚点。
- [ ] 用户追问“默认是标快还是特快”时，历史整合文本必须继承接口和参数锚点，不得重新要求补充接口地址。
- [ ] 审核兜底文案在已识别 URL/接口/参数时，不得输出“请补充接口地址/页面/字段”这种错误引导。
- [ ] planner 规则必须要求把 curl/URL/form 参数中的接口路径、字段和值放入检索计划或上下文判断。

## 不适用或暂缓项

- 无
