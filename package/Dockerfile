FROM --platform=$TARGETPLATFORM alpine:3.20
ARG TARGETARCH
LABEL maintainer="ZhangSean <zxf2342@qq.com>"
RUN apk add --no-cache ca-certificates

# Copy the prebuilt binary produced by CI into the image. CI must place
# architecture-specific binaries into package/ with names like:
#   package/kube-explorer-linux-amd64
#   package/kube-explorer-linux-arm64
# When using BuildKit/buildx, TARGETARCH will be set for each platform build,
# so the correct binary will be copied for each platform.
COPY package/kube-explorer-linux-${TARGETARCH} /usr/bin/kube-explorer
RUN chmod +x /usr/bin/kube-explorer
EXPOSE 9080
ENTRYPOINT ["/usr/bin/kube-explorer"]
CMD ["--http-listen-port=9080", "--https-listen-port=0"]
