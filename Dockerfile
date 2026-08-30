FROM node:20-alpine

# Install FFmpeg and required media libraries
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application source
COPY . .

EXPOSE 7000

ENV PORT=7000
ENV NODE_ENV=production

CMD ["node", "server.js"]
