FROM node:lts AS build

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/public ./public
COPY frontend/src ./src
COPY frontend/angular.json .
COPY frontend/tsconfig*.json .

ARG BUILD_MODE

RUN npm run build -- --configuration ${BUILD_MODE}

# Production stage
FROM nginx:alpine

# Copy built files to nginx (Angular 17+ uses browser subdirectory)
COPY --from=build /frontend/dist/akgent-app/browser /usr/share/nginx/html

# Copy nginx configuration for SPA routing
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Replace with caddy !
# https://medium.com/@remast/simplest-webserver-for-angular-in-6-lines-e8dc12eddd42
# https://betterstack.com/community/guides/web-servers/caddy/
# https://dev.to/rensjaspers/how-to-containerize-an-angular-app-for-production-20ba

CMD ["nginx", "-g", "daemon off;"]