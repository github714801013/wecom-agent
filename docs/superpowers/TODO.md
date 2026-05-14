# Project TODO - WeCom Agent Streaming Upgrade

## Phase 1: Research & Design
- [x] Explore project context (SDK, LangChain, Config)
- [x] Research LLM streaming in LangChain JS
- [x] Propose design approach (Scheme 1: Card + Stream)
- [x] Write design specification (`docs/superpowers/specs/2026-05-14-wecom-streaming-design.md`)
- [x] User approval of design spec

## Phase 2: Planning
- [x] Create implementation plan (`docs/superpowers/plans/2026-05-14-wecom-streaming-implementation.md`)

## Phase 3: Implementation
- [ ] Modify `graph.ts` to support `.stream()` output
- [ ] Modify `wecom-adapter.ts` to use `replyStreamWithCard` and `replyStream`
- [ ] Add buffering/throttling logic

## Phase 4: Verification
- [ ] Local build and type check
- [ ] Local simulation of streaming
- [ ] Final deployment and client verification
