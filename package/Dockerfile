FROM --platform=$TARGETPLATFORM alpine:3.20
ARG TARGETARCH
LABEL maintainer="ZhangSean <zxf2342@qq.com>"
RUN apk add --no-cache ca-certificates

COPY kube-explorer-linux-${TARGETARCH} /usr/bin/kube-explorer
RUN chmod +x /usr/bin/kube-explorer
EXPOSE 9080
ENTRYPOINT ["/usr/bin/kube-explorer"]
CMD ["--http-listen-port=9080", "--https-listen-port=0"]
