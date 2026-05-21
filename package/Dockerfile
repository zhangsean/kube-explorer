FROM alpine:3.20
LABEL maintainer="ZhangSean <zxf2342@qq.com>"
ARG TARGETARCH=amd64
ARG TARGETOS=linux
ARG VERSION=v0.5
ENV KUBE_EXPLORER_VERSION=${VERSION}
COPY kube-explorer-${TARGETOS}-${TARGETARCH} /usr/bin/kube-explorer
RUN chmod +x /usr/bin/kube-explorer
EXPOSE 9080
ENTRYPOINT ["/usr/bin/kube-explorer"]
CMD ["--http-listen-port=9080", "--https-listen-port=0"]
