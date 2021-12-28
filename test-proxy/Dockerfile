# syntax=docker/dockerfile:experimental
#FROM haproxy:2.5
FROM debian:buster-slim

USER root

ENTRYPOINT ["/usr/bin/env"]

EXPOSE 8100
EXPOSE 8101
EXPOSE 8102
EXPOSE 8103

RUN set -eux; \
  apt-get update && \
  apt-get install -y --no-install-recommends \
  ca-certificates \
  #gcc \
  #iputils-ping \
  liblua5.3-0 \
  #lua5.3-dev \
  #make \
  libpcre2-posix0 \
  nodejs \
  #procps \
  yarnpkg && \
  #unzip \
  #wget && \
  rm -rf /var/lib/apt/lists/*
#
#RUN set -eux; \
#  wget https://luarocks.org/releases/luarocks-3.5.0.tar.gz && \
#  tar zxpf luarocks-3.5.0.tar.gz && \
#  cd luarocks-3.5.0 && \
#  ./configure && \
#  make && \
#  make install && \
#  rm -rf /luarocks-*
#
##RUN set -eux; luarocks install http
##RUN set -eux; luarocks install lua-cjson 2.1.0-1
#RUN \
#  --mount=type=cache,id=test_proxy_root_cache,target=/root/.cache \
#  set -eux; \
#  luarocks install lunajson 1.2.3-1
#
#RUN \
#  --mount=type=cache,id=test_proxy_root_cache,target=/root/.cache \
#  set -eux; \
#  luarocks install penlight 1.9.2-1

ENV PATH /app/node_modules/.bin:$PATH

STOPSIGNAL SIGTERM

WORKDIR /app

USER ${USER}

COPY package.json yarn.lock ./

ENV NODE_ENV development

RUN \
  --mount=type=cache,id=test_proxy_yarn_cache,target=/usr/local/share/.cache \
  yarnpkg --no-progress

RUN useradd -r --shell /bin/bash haproxy

USER haproxy

CMD ["nodemon", "--watch", "/usr/local/etc/haproxy", "-e", "lua,cfg,pem,http", "--signal", "SIGUSR1", "--exec", "haproxy", "--", "-V", "-f", "/usr/local/etc/haproxy/haproxy.cfg"]
