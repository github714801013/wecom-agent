# 任务跟踪配置

- 跟踪方式：本地 Markdown 文件，用户已明确选择。
- 正式规格：`docs/engineering/specs/`。
- 任务单：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，每个任务一个文件。
- 状态词：`ready-for-agent`（待执行）、`in-progress`（执行中）、`blocked`（阻塞）、`done`（完成且验证通过）。
- 每个任务声明依赖任务编号和验收条件；按依赖顺序执行。
- 不自动创建外部 Issue，不自动提交或推送 Git。
