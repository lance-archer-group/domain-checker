# ✅ Use Node.js official image
FROM node:20-alpine

# ✅ Set working directory inside the container
WORKDIR /app

# ✅ Copy package files & install dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# ✅ Copy all project files
COPY . .

# ✅ Expose the port your app runs on
EXPOSE 3990

# ✅ Start the server
CMD ["node", "server.js"]
