# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# 先安装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json ./
RUN npm ci

# 编译 TypeScript + 复制控制台 UI
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime

# Chromium（采集内核）+ 中文字体（弹幕昵称/内容渲染）+ ca-certificates
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/share/doc /usr/share/man

WORKDIR /app

# 仅生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 构建产物（含控制台 UI）
COPY --from=builder /app/dist ./dist

# 轻量采集内核的抖音签名脚本（third_party/douyin-sign，AGPL 声明见其目录 README，独立分发）
COPY third_party ./third_party

ENV DYHUB_PORT=8757 \
    DYHUB_HOST=0.0.0.0 \
    DYHUB_CHROME=/usr/bin/chromium \
    NODE_ENV=production

EXPOSE 8757

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DYHUB_PORT||8757)+'/api/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
