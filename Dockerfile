FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY assets ./assets

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
