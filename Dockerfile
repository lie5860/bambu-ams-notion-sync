FROM node:22-alpine

WORKDIR /app

ENV ADMIN_HOST=0.0.0.0 \
    ADMIN_PORT=3030 \
    APP_CONFIG_FILE=/app/data/app-config.json \
    BAMBU_CLOUD_TOKEN_FILE=/app/data/bambu-cloud.json \
    LOG_LEVEL=info

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/data

EXPOSE 3030

CMD ["npm", "start"]
