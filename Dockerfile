FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY . .
EXPOSE 3001
CMD ["node", "proxy.js"]
