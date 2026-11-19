FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun build --compile packages/cli/src/main.ts --outfile /navvied

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /navvied /usr/local/bin/navvied
WORKDIR /work
ENTRYPOINT ["navvied"]
