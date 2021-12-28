# syntax=docker/dockerfile:experimental
FROM node:16-alpine as builder_base

ARG NPM_TOKEN

RUN apk --no-cache add \
  #autoconf \
  #automake \
  #python \
  #make \
  #g++ \
  yarn

WORKDIR /app

COPY package.json yarn.lock ./


FROM builder_base as builder_development

ENV NODE_ENV development

RUN \
  # This is for the yarn cache. We have to use different caches otherwise both
  # this and the production stage will use the same cache and clobber each
  # other if they are run in parallel.
  --mount=type=cache,id=builder_development_yarn,target=/usr/local/share/.cache/yarn \
  # This is to keep the node_modules dir around between builds otherwise yarn
  # has to do a fresh install + build whenever the lock file changes.
  --mount=type=cache,id=builder_development_node_modules,target=/app/node_modules \
  # Defaults to installing all (prod + dev) packages.
  yarn --no-progress && \
  # The node_modules dir ceases to exist after the build so unless it's copied
  # off it can't be copied into the below stages.
  cp -r /app/node_modules/ /app/node_modules.sav


# This is used for both staging and production builds so we can't solely rely
# on the NODE_ENV env var.
FROM builder_base as builder_production

ENV NODE_ENV production

RUN \
  --mount=type=cache,id=builder_production_yarn,target=/usr/local/share/.cache/yarn \
  --mount=type=cache,id=builder_production_node_modules,target=/app/node_modules \
  yarn --prod --no-progress && \
  cp -r /app/node_modules/ /app/node_modules.sav


FROM node:16-alpine as base

ARG UID=2001

ARG USER=ngapps

RUN adduser --disabled-password --uid ${UID} --shell /bin/ash ${USER}

ENV PATH /app/node_modules/.bin:$PATH


FROM base as development

RUN mkdir /app && \
    chown ${USER}:${USER} /app

WORKDIR /app

ARG NPM_TOKEN

ENV DEBUG manager:*

ENV NODE_ENV development

ENV NPM_TOKEN=${NPM_TOKEN}

COPY --from=builder_development --chown=${USER}:${USER} \
  /app/node_modules.sav node_modules

USER ${USER}

CMD ["nodemon", "-r", "source-map-support/register", "--delay", "1", "-e", "js", "dist/demo.js"]


FROM base as tsc_watch

ENV NODE_ENV development

WORKDIR /app

USER ${USER}

# Not using tsc's actual watch command here because it clears the screen.
# CMD ["nodemon", "--watch", "/app/src/server", "--watch", "/app/src/test", "-e", "ts,js", "--exec", "tsc -p tsconfig.development.json"]
CMD ["tsc", "-w", "--preserveWatchOutput", "-p", "tsconfig.json"]


# FROM base as testwatch
# 
# ENV NODE_ENV test
# 
# RUN mkdir /app && \
#     chown ${USER}:${USER} /app
# 
# WORKDIR /app
# 
# COPY --from=builder_development --chown=${USER}:${USER} \
#   /app/node_modules.sav node_modules
# 
# USER ${USER}
# 
# CMD ["nodemon", "--exec", "tap", "src/**/*.test.js"]
# 
# 
# FROM base as test
# 
# ENV NODE_ENV test
# 
# RUN mkdir /app && \
#     chown ${USER}:${USER} /app
# 
# WORKDIR /app
# 
# COPY --from=builder_development --chown=${USER}:${USER} \
#   /app/node_modules.sav node_modules
# 
# USER ${USER}
# 
# RUN \
#   --mount=type=bind,source=package.json,target=package.json \
#   --mount=type=bind,source=src,target=src \
#   npm test
# 
# 
# FROM base as production
# 
# EXPOSE 3000
# 
# WORKDIR /app
# 
# COPY --from=builder_production /app/node_modules.sav node_modules
# 
# COPY src/ src/
# 
# ARG NODE_ENV=production
# 
# ENV NODE_ENV ${NODE_ENV}
# 
# USER ${USER}
# 
# CMD ["node", "src/server.js"]
