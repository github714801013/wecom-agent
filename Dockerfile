# 使用 Node.js 22 官方镜像（Pi Agent Core 0.85 要求 Node >=22.19）
FROM node:22.19-alpine AS builder

WORKDIR /app

# 复制依赖配置
COPY package.json pnpm-lock.yaml* package-lock.json* ./

# 安装依赖
RUN npm ci --legacy-peer-deps

# 复制源码与编译配置
COPY tsconfig.json ./
COPY src ./src

# 编译 TypeScript
RUN npx tsc

# --- 运行阶段 ---
FROM node:22.19-alpine

WORKDIR /app

# 仅复制生产依赖
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN npm install --production --legacy-peer-deps

# 复制编译后的代码
COPY --from=builder /app/dist ./dist
# 复制必要的静态资源（提示词文件）
COPY src/prompts ./src/prompts

# 为非 root 运行用户准备媒体下载目录
RUN mkdir -p /app/downloads && chown node:node /app/downloads

# 启动命令
USER node
CMD ["node", "dist/index.js"]
