FROM node:18

RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

WORKDIR /app/client
RUN npm install
RUN npm run build

WORKDIR /app

ENV PORT 10000
EXPOSE 10000

CMD ["node", "server.js"]