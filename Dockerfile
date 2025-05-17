   # Use an official Node.js image
   FROM node:18

   # Install ffmpeg
   RUN apt-get update && apt-get install -y ffmpeg

   # Set working directory
   WORKDIR /app

   # Copy package files and install dependencies
   COPY package*.json ./
   RUN npm install

   # Copy client and server code
   COPY . .

   # Build React app
   WORKDIR /app/client
   RUN npm install
   RUN npm run build

   # Move build to server root
   WORKDIR /app

   # Expose port (Render uses $PORT)
   ENV PORT 10000
   EXPOSE 10000

   # Start the server
   CMD ["node", "server.js"]
