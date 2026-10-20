FROM node:22-alpine
WORKDIR /usr/src/app

# Copy package files first so Docker can cache the install step
COPY package*.json ./
RUN npm ci --omit=dev

# Copy proto definitions and OpenAPI document
COPY proto ./proto
COPY openapi.yaml ./openapi.yaml
COPY app ./app

ENV PORT=8000
ENV GRPC_PORT=50051
ENV GRPC_METRICS_PORT=9091

EXPOSE 8000 50051 9091
USER node
CMD ["node", "app/server.js"]