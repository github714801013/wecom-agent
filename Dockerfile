# 使用 node:20-slim (Debian) 确保二进制兼容性 (glibc)，这是 Claude SDK 的运行要求
FROM node:20-slim AS builder

WORKDIR /app

# 安装构建依赖
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml* package-lock.json* ./

RUN npm install --legacy-peer-deps

COPY . .

RUN npx tsc

# --- 运行阶段 ---
FROM node:20-slim

WORKDIR /app

# 安装运行时依赖
# Claude Agent SDK (Claude Code) 强依赖 git 进行代码分析和工具执行
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    procps \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN npm install --production --legacy-peer-deps

COPY --from=builder /app/dist ./dist
COPY src/prompts ./src/prompts
# 必须包含 .claude 目录，里面存放了我们的 Skill SOP
COPY .claude ./.claude

RUN chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
