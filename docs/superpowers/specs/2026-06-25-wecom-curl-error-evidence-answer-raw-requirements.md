# 原始需求归档

## 原始文本需求

> [$my-skill-creator](D:\workplace\skills\my-skills\my-skill-creator\SKILL.md) 这个是claude找到正确答案, 需要优化web-com也能找到正确答案, 测试问题: curl -k -i --raw -o 0.dat -X POST -d "sub_id=18117666&sub_check=2&TakeMobile=&mobile_basket_id=&confirmInfo=" "https://oa.dev.9ji.com/addOrder/subCheckOp" ... 这个接口报这个异常是什么原因 SN校验不通过，000002 不可售,未查到

## 来源

- 对话/链接：当前 Codex 会话
- Jira/Yuque/文档：

## 附件语义化记录

| 附件 | 来源/文件名 | 可见内容语义化描述 | 待确认点 |
| :--- | :--- | :--- | :--- |
| PixPin_2026-06-24_20-01-15.png | D:/Documents/WXWork/1688856756296123/Cache/Image/2026-06/PixPin_2026-06-24_20-01-15.png | Claude 正确答案截图。标题“原因分析”；指出错误“SN校验不通过，000002 不可售,未查到”来自国补（政府补贴）SN 校验流程。调用链：subCheckOp(sub_check=2) -> CheckSubKcGovSn -> payGatewayServices.SnQuery() -> 返回 re.FriendlyMessage = “000002 不可售,未查到”。代码位置：oanew / oa999DAL / orderServices.cs:6516。根本原因：订单 18117666 是国补订单，执行出库操作 sub_check=2 时，用订单商品 SN 码 imei3 查询国补系统状态；网关返回表示该 SN 在国补系统中未登记或被标记为不可售，导致 OA 拦截出库。 | 需让 wecom-agent 能通过 curl、错误文案、截图证据和代码核实找到同类正确答案，不能只硬编码当前样本。 |

## 初步验收断言

- [x] curl/form-urlencoded 请求中的 URL、路径、POST 参数、Referer 和错误文案应进入 planner 高优先级锚点。
- [x] 截图中出现“原因分析/调用链/代码位置/根本原因/排查方向”时，图片识别应提取这些结构化证据。
- [x] 业务节点应把截图中的调用链和代码位置作为高可信候选证据，用代码核实后回答，不得忽略或泛化为让用户补充。
- [x] 不将 sub_id=18117666、subCheckOp、CheckSubKcGovSn 等单样本写死为唯一规则。

## 不适用或暂缓项

- 不直接改业务系统代码；本次只优化 wecom-agent 的提示词和测试护栏。
