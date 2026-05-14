# Design Spec: WeCom Agent Streaming & Progress Bar

## 1. Overview
Optimize the user experience in企业微信 (WeCom) by providing immediate feedback via a progress card and streaming the LLM response in-place.

## 2. Technical Approach
### 2.1 WeCom SDK Integration
- **Initialization**: Upon receiving a message, immediately call `wsClient.replyStreamWithCard`.
  - **Template Card**: A `text_notice` card with `main_title.title = "AI 正在思考中..."`.
  - **Stream ID**: Generated using `generateReqId('stream')`.
- **Streaming**: As tokens arrive from the LLM, call `wsClient.replyStream` with the same `streamId`.
  - Set `finish = false` for intermediate tokens.
  - Set `finish = true` for the final token/message.
- **SDK Methods**:
  - `replyStreamWithCard(frame, streamId, content, finish, options)`
  - `replyStream(frame, streamId, content, finish)`

### 2.2 LLM Streaming (LangChain)
- Use `agent.stream()` or `model.stream()` to receive token-by-token updates.
- Aggregate tokens and periodically update the WeCom stream to avoid rate limits or excessive frames (optional but recommended for smooth UI).

### 2.3 Replacement Logic
- Enterprise WeChat's `replyStream` with the same `streamId` *refreshes* the content of the text block in the message. This effectively "replaces" the previous text (e.g., replacing "Thinking..." with the actual answer).
- The progress card will stay at the top of the message bubble as a status indicator.

## 3. Implementation Plan
1. **Modify `wecom-adapter.ts`**:
   - Update `startBot` to handle streaming responses.
   - Implement `streamResponse` helper function.
2. **Modify `graph.ts`**:
   - Ensure the agent/model is configured for streaming.
   - Expose a streaming interface if `initializeAgent` returns a non-streaming object.
3. **Verify**:
   - Use `test-simple.ts` to simulate streaming locally (log tokens).
   - Deploy and verify in WeCom client.

## 4. UI/UX Design
- **Progress Card**:
  - `card_type`: `text_notice`
  - `title`: `任务处理中`
  - `desc`: `AI 助手正在分析您的请求并调动相关插件...`
- **Streaming Text**:
  - Markdown formatted tokens.

## 5. Security & Constraints
- No hardcoded secrets.
- Handle WeCom 5s response timeout (initial response must be fast).
- `replyStream` content limit: 20480 bytes.
