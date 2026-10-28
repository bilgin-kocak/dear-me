FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production DB_PATH=/data/dear-me.db PORT=3000
EXPOSE 3000
CMD ["node", "src/main.ts"]
