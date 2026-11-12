ARG PNPM_VERSION=10.6.5

FROM node:18-slim as build
WORKDIR /app

RUN apt update && apt -y install --no-install-recommends curl python3 make g++ cmake
RUN npm --no-update-notifier --no-fund --global install pnpm@${PNPM_VERSION}

COPY . .
RUN pnpm install --config.dangerouslyAllowAllBuilds=true
RUN mkdir -p /app/apps/api/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build/Release && \
    cp /app/apps/api/node_modules/.ignored/node-pty/build/Release/pty.node \
       /app/apps/api/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build/Release/pty.node 2>/dev/null || true
RUN pnpm build

# Production build
FROM node:18-slim
WORKDIR /app
ENV NODE_ENV production
ARG TARGETPLATFORM

ARG DOCKER_VERSION=20.10.18
ARG DOCKER_COMPOSE_VERSION=2.6.1
ARG PACK_VERSION=0.27.0

RUN apt update && apt -y install --no-install-recommends ca-certificates git git-lfs openssh-client curl jq cmake sqlite3 openssl rclone psmisc python3 vim make g++
RUN apt-get clean autoclean && apt-get autoremove --yes && rm -rf /var/lib/{apt,dpkg,cache,log}/
RUN npm --no-update-notifier --no-fund --global install pnpm@${PNPM_VERSION}
RUN npm install -g npm@${PNPM_VERSION}

RUN mkdir -p ~/.docker/cli-plugins/
RUN curl -SL https://cdn.coollabs.io/bin/$TARGETPLATFORM/docker-$DOCKER_VERSION -o /usr/bin/docker
RUN curl -SL https://cdn.coollabs.io/bin/$TARGETPLATFORM/docker-compose-linux-$DOCKER_COMPOSE_VERSION -o ~/.docker/cli-plugins/docker-compose
RUN curl -SL https://cdn.coollabs.io/bin/$TARGETPLATFORM/pack-$PACK_VERSION -o /usr/local/bin/pack
RUN chmod +x ~/.docker/cli-plugins/docker-compose /usr/bin/docker /usr/local/bin/pack

COPY --from=build /app/apps/api/build/ .
COPY --from=build /app/apps/ui/build/ ./public
COPY --from=build /app/apps/api/prisma/ ./prisma
COPY --from=build /app/apps/api/package.json .
COPY --from=build /app/docker-compose.yaml .
COPY --from=build /app/apps/api/tags.json .
COPY --from=build /app/apps/api/templates.json .

RUN pnpm install -p --config.dangerouslyAllowAllBuilds=true
RUN cd /app/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty && npm rebuild

EXPOSE 3000
ENV CHECKPOINT_DISABLE=1
CMD pnpm start
