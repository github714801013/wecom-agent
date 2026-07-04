import assert from "node:assert/strict";
import { ensureVisionMarkedFocusSections, VISION_ANALYSIS_PROMPT } from "../vision-analyzer.js";

const minimalResult = ensureVisionMarkedFocusSections(`【图片识别结果】
图片位置：引用图片
图片标题：订单异常截图
关键字段/按钮/列名：sku_id`);

assert.match(minimalResult, /用户标注重点：未识别清楚/);
assert.match(minimalResult, /用户关注点：未识别清楚/);
assert.match(minimalResult, /用户想解决的问题：未识别清楚/);
assert.match(minimalResult, /未识别清楚：未识别清楚/);

const completeResult = ensureVisionMarkedFocusSections(`【图片识别结果】
图片位置：引用图片
图片标题：订单异常截图
用户标注重点：红圈标注 sku_id 值
用户关注点：字段类型转换异常
用户想解决的问题：确认哪个字段导致 nvarchar 转 bigint
关键字段/按钮/列名：sku_id
原因分析/调用链/代码位置：JdProductConfigMapper
错误码/状态码含义：类型转换异常
根本原因/排查方向：核对字段类型
与当前问题相关的信息：标注区域指向 sku_id
未识别清楚：无`);

assert.equal(completeResult.split(/\r?\n/).filter(line => line.startsWith("用户标注重点：")).length, 1);
assert.match(VISION_ANALYSIS_PROMPT, /最高优先级/);
assert.match(VISION_ANALYSIS_PROMPT, /用户标注区域/);
assert.match(VISION_ANALYSIS_PROMPT, /用户关注点/);
assert.match(VISION_ANALYSIS_PROMPT, /用户想解决的问题/);

console.log("vision marked focus 验证通过");
