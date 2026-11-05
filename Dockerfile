ARG NODE_BASE_IMAGE=node:24-alpine
ARG NGINX_BASE_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine
FROM ${NODE_BASE_IMAGE} AS build
ARG GIT_SHA=local
ENV GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY package.json index.html ./
COPY src ./src
COPY tools/build.mjs ./tools/build.mjs
RUN node tools/build.mjs

FROM ${NGINX_BASE_IMAGE}
ARG GIT_SHA=local
LABEL org.opencontainers.image.revision=$GIT_SHA
COPY deploy/app.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
