# syntax=docker/dockerfile:1
#
# Confid — single-process deployment: the Go binary serves both the
# built frontend (dist) and the WebSocket signaling endpoint.
#
#   docker build -t confid .
#   docker run -p 8787:8787 confid

# --- Stage 1: build the frontend ----------------------------------------
FROM node:22-alpine AS client
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# --- Stage 2: build the signaling binary ---------------------------------
FROM golang:1.23-alpine AS server
WORKDIR /src
COPY signaling/go.mod signaling/go.sum ./
RUN go mod download
COPY signaling/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/signaling ./cmd/server

# --- Stage 3: minimal runtime --------------------------------------------
# scratch: the binary is static (CGO_ENABLED=0), makes no outbound TLS/DNS
# calls (STUN is browser-side), and keeps the image ~20MB.
FROM scratch
COPY --from=server /out/signaling /signaling
COPY --from=client /app/dist /static
EXPOSE 8787
ENTRYPOINT ["/signaling", "-addr", ":8787", "-static", "/static"]
