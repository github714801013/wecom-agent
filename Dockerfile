# 使用 Node.js 20 官方镜像
FROM node:20-alpine AS builder

WORKDIR /app

# 复制依赖配置
COPY package.json pnpm-lock.yaml* package-lock.json* ./

# 安装依赖
RUN npm install --legacy-peer-deps

# 复制源码
COPY . .

# 编译 TypeScript
RUN npx tsc

# --- 运行阶段 ---
FROM node:20-alpine

WORKDIR /app

# 仅复制生产依赖
COPY package.json pnpm-lock.yaml* package-lock.json* ./
RUN npm install --production --legacy-peer-deps

# 复制编译后的代码
COPY --from=builder /app/dist ./dist
# 复制必要的静态资源（提示词文件）
COPY src/prompts ./src/prompts

# 暴露端口（如果有 Web 服务的话，虽然目前主要是 WebSocket）
# EXPOSE 8080

# 启动命令
CMD ["node", "dist/index.js"]
