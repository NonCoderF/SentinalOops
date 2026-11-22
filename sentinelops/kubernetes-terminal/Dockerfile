FROM node:22-bookworm-slim

ARG KUBECTL_VERSION=v1.34.1
ARG HELM_VERSION=v3.19.0
ARG KIND_VERSION=v0.29.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git coreutils procps iproute2 less nano docker.io python3 make g++ \
  && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
  && chmod 0755 /usr/local/bin/kubectl \
  && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" | tar -xz -C /tmp \
  && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
  && chmod 0755 /usr/local/bin/helm \
  && curl -fsSL -o /usr/local/bin/kind "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64" \
  && chmod 0755 /usr/local/bin/kind \
  && rm -rf /tmp/linux-amd64 /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
COPY docker-entrypoint.sh /usr/local/bin/docker-terminal-entrypoint.sh

RUN useradd --create-home --shell /bin/bash terminal \
  && mkdir -p /workspace /home/terminal/.kube \
  && chmod 0755 /usr/local/bin/docker-terminal-entrypoint.sh \
  && chown -R terminal:terminal /workspace /home/terminal /app
WORKDIR /workspace
ENV HOME=/home/terminal TERM=xterm-256color TERMINAL_WORKSPACE=/workspace
EXPOSE 8787
CMD ["node", "/app/server.mjs"]
ENTRYPOINT ["/usr/local/bin/docker-terminal-entrypoint.sh"]
