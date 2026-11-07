FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# Copy app
COPY server.js ./
COPY public ./public
COPY mcp-config.json ./

# Expose port
EXPOSE 8080

# Env
ENV OLLAMA_URL=http://ollama:11434
ENV PORT=8080

CMD ["node", "server.js"]
