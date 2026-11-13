FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# Copy app
COPY server.js ./
COPY public ./public
COPY lib ./lib
COPY mcp-config.json ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Create non-root user and fix ownership
RUN addgroup -S aegis && adduser -S aegis -G aegis && chown -R aegis:aegis /app

# Expose port
EXPOSE 8080

# Env
ENV OLLAMA_URL=http://ollama:11434
ENV BACKEND_TYPE=ollama
ENV BACKEND_URL=http://ollama:11434
ENV PORT=8080
ENV HOST=0.0.0.0
ENV AEGISAI_DOCKER=1

ENTRYPOINT ["./entrypoint.sh"]
