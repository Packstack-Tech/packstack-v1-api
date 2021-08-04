FROM node:12.7.0-alpine

WORKDIR /usr/api

COPY package*.json ./
RUN npm install -g yarn
RUN yarn install

COPY . .

COPY wait-for-postgres.sh /wait-for-postgres.sh
RUN chmod +x /wait-for-postgres.sh

CMD ["/wait-for-postgres.sh", "postgres", "yarn", "run", "dev"]