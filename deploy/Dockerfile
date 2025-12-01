FROM node:24-bookworm-slim AS node
FROM oven/bun:1.3.14-debian
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agent
COPY . .
ENV HUSKY=0 RIGOVO_SOURCE=1 RIGOVO_HOME=/data/runtime
RUN bun install --frozen-lockfile && mkdir -p /data/runtime /workspace && chown -R bun:bun /data /workspace /opt/agent
USER bun
WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["bun", "run", "--conditions=browser", "/opt/agent/packages/rigovo/src/main.ts"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
