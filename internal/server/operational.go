package server

import (
	"net/http"
	"sync/atomic"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type serverReadiness struct {
	ready atomic.Bool
}

func operationalEndpoints(next http.Handler, readiness *serverReadiness) http.Handler {
	registerCacheMetrics()
	metrics := promhttp.Handler()
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/healthz", "/livez":
			writeProbeResponse(rw, http.StatusOK, "ok")
			return
		case "/readyz":
			if readiness != nil && readiness.ready.Load() {
				writeProbeResponse(rw, http.StatusOK, "ready")
			} else {
				writeProbeResponse(rw, http.StatusServiceUnavailable, "schemas are not ready")
			}
			return
		case "/metrics":
			metrics.ServeHTTP(rw, req)
			return
		default:
			next.ServeHTTP(rw, req)
		}
	})
}

func writeProbeResponse(rw http.ResponseWriter, status int, body string) {
	rw.Header().Set("Cache-Control", "no-store")
	rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
	rw.WriteHeader(status)
	_, _ = rw.Write([]byte(body + "\n"))
}
