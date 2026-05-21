FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production --silent
COPY index.js .
CMD ["node", "index.js"]
