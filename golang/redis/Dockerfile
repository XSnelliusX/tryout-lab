FROM golang:1.27-trixie AS build
LABEL authors="markus_goetz"

WORKDIR /usr/local/app
COPY . .
RUN CGO_ENABLED=0 go build -o /redis-server .

FROM alpine

RUN adduser -D redis-server
USER redis-server

COPY --from=build /redis-server /redis-server
EXPOSE 6379
ENTRYPOINT ["/redis-server"]