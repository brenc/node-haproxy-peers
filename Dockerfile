# syntax=docker/dockerfile:experimental
FROM oven/bun:1.3.14-alpine AS base

ARG UID=2001
ARG USER=ngapps

RUN adduser --disabled-password --uid ${UID} --shell /bin/ash ${USER}

WORKDIR /app


FROM base AS deps

# Build toolchain for the inet_xtoy native addon in case no prebuilt binary is
# available for this platform.
RUN apk --no-cache add python3 make g++

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile


FROM base AS development

ENV NODE_ENV=development

COPY --from=deps --chown=${USER}:${USER} /app/node_modules ./node_modules
COPY --chown=${USER}:${USER} . .

USER ${USER}

CMD ["bun", "run", "--watch", "src/demo.ts"]


FROM base AS tsc_watch

ENV NODE_ENV=development

COPY --from=deps --chown=${USER}:${USER} /app/node_modules ./node_modules
COPY --chown=${USER}:${USER} . .

USER ${USER}

CMD ["bunx", "tsc", "-w", "--noEmit", "--preserveWatchOutput", "-p", "tsconfig.json"]


FROM base AS test_watch

ENV NODE_ENV=test

COPY --from=deps --chown=${USER}:${USER} /app/node_modules ./node_modules
COPY --chown=${USER}:${USER} . .

USER ${USER}

CMD ["bun", "test", "--watch"]
